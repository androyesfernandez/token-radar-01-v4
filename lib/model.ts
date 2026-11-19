// Token Launch Radar v4 — the model (Node side; dashboard/model.js is its twin).
//
// One snapshot in, one ranked board out. The board ranks ONLY pre-token candidates:
// every protocol that records no token, minus the house-rule exclusions (bridges, liquid
// staking/restaking, exchange custody, versioned names, wrapped/staked names). Tokened
// protocols are never ranked; they are the comparison set the value model is fitted on.
//
//   value_if_launched = sizeCurve(TVL) x category x growthCarry x tenure x breadth x kin
//   expected_value    = value_if_launched x launchOdds(age, TVL)     <- the rank key
//
// sizeCurve is a Huber-robust log-log fit on the traded comps. Every further term is
// fitted, then KEPT only if it improves BOTH the leave-one-out and the walk-forward
// median miss; the ablation ladder (kept and dropped terms alike) is printed on the
// dashboard's Method view. Bands come from the local leave-one-out residual spread;
// rank ranges from 200 seeded bootstrap refits. All randomness is a seeded PRNG, so
// two runs write identical bytes, and the dashboard re-runs the same code in the
// browser and prints whether its board matches board.json (checkBoard()).

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** A protocol with the fields the model derives once: tracked age and token status. */
export interface Proto extends SnapshotProtocol {
  age: number | null;
  tokened: boolean;
}

export const MODEL_VERSION = 'radar-4';

/** The candidate terms, in the order the pipeline fits them (the curve is not a term). */
export const TERM_ORDER = ['category', 'growth', 'tenure', 'breadth'] as const;
export type Term = (typeof TERM_ORDER)[number];

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A whole day count from `listedAt` to `asOf`, clamped at zero; null when either is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** mulberry32: a tiny seeded PRNG, identical in Node and in the browser. */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The median of a non-empty list (a copy is sorted; the input is untouched). */
export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 === 1 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
}

/** The q-quantile of a non-empty list, linear interpolation on the sorted copy. */
export function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 1) return s[0]!;
  const at = q * (s.length - 1);
  const lo = Math.floor(at);
  return s[lo]! + (s[Math.min(lo + 1, s.length - 1)]! - s[lo]!) * (at - lo);
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

// ------------------------------------------------------------------ universe

const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
const EXCHANGES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/** The house-rule exclusion a pre-token protocol falls under, or null when it is a candidate. */
export function exclusionReason(p: SnapshotProtocol): string | null {
  if (p.category === 'Bridge' || p.category === 'Canonical Bridge') return 'bridge';
  if (p.category === 'Liquid Staking' || p.category === 'Liquid Restaking' || p.category === 'Restaked BTC') return 'staking';
  if (p.category === 'CEX' || EXCHANGES.some((x) => p.name.startsWith(x))) return 'exchange';
  if (VERSIONED.test(p.name)) return 'versioned';
  if (WRAPPED_WORD.test(p.name)) return 'wrapped';
  return null;
}

/** A name reduced to the stem kinship is judged on: no version suffix, no punctuation, lowercase. */
export function nameStem(name: string): string {
  return name.replace(VERSIONED, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Whether a candidate is kin to a token that already trades (its stem matches a tokened stem). */
export function isKin(p: SnapshotProtocol, tokenedStems: Set<string>, tokenedSymbols: Set<string>): boolean {
  const stem = nameStem(p.name);
  if (tokenedStems.has(stem)) return true;
  for (const t of tokenedStems) {
    if (t.length >= 5 && (stem.startsWith(t) || t.startsWith(stem)) && Math.min(stem.length, t.length) >= 5) return true;
  }
  const words = p.name.toLowerCase().split(/[^a-z0-9]+/);
  return words.some((w) => w.length >= 3 && tokenedSymbols.has(w));
}

/**
 * The traded comparison set: tokened, a market cap in the plausibility band (a cap the
 * market plausibly sets from TVL), a tracking start on record (the tenure term and the
 * walk-forward both read it), not an exchange's own token (a CEX cap prices the
 * exchange's earnings, not the protocol), one per symbol, largest cap kept.
 */
export function pickComps(protos: Proto[]): Proto[] {
  const inBand = protos.filter(
    (p) => p.tokened && p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0 && p.listed_at !== null && p.category !== 'CEX' && p.mcap_usd / p.tvl_usd >= 0.005 && p.mcap_usd / p.tvl_usd <= 20,
  );
  const best = new Map<string, Proto>();
  for (const p of inBand) {
    const key = p.symbol ?? p.slug;
    const cur = best.get(key);
    if (cur === undefined || (p.mcap_usd ?? 0) > (cur.mcap_usd ?? 0)) best.set(key, p);
  }
  return [...best.values()].sort((a, b) => (a.slug < b.slug ? -1 : 1));
}

// ------------------------------------------------------------------ the fit

/** A fitted pricing pipeline: the curve plus whichever terms survived the ablation. */
export interface Fit {
  a: number;
  b: number;
  terms: Term[];
  catOffset: Map<string, number>;
  gamma: number;
  tenureLo: number;
  tenureTau: number;
  breadthDelta: number;
  medianChg: number;
  medianAge: number;
}

/** Weighted least squares of y on x. */
function wls(xs: number[], ys: number[], ws: number[]): { a: number; b: number } {
  let sw = 0, sx = 0, sy = 0;
  for (let i = 0; i < xs.length; i++) { sw += ws[i]!; sx += ws[i]! * xs[i]!; sy += ws[i]! * ys[i]!; }
  const mx = sx / sw, my = sy / sw;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < xs.length; i++) { const dx = xs[i]! - mx; sxy += ws[i]! * dx * (ys[i]! - my); sxx += ws[i]! * dx * dx; }
  const b = sxx > 0 ? sxy / sxx : 0;
  return { a: my - b * mx, b };
}

/** The size curve: Huber-robust (IRLS, k = 1.345) regression of log10(mcap) on log10(TVL). */
export function fitSizeCurve(comps: Proto[]): { a: number; b: number } {
  const xs = comps.map((p) => Math.log10(p.tvl_usd));
  const ys = comps.map((p) => Math.log10(p.mcap_usd!));
  let { a, b } = wls(xs, ys, xs.map(() => 1));
  for (let iter = 0; iter < 8; iter++) {
    const resid = ys.map((y, i) => y - (a + b * xs[i]!));
    const mad = median(resid.map((r) => Math.abs(r - median(resid))));
    const s = Math.max(1.4826 * mad, 1e-6);
    const ws = resid.map((r) => { const u = Math.abs(r) / (1.345 * s); return u <= 1 ? 1 : 1 / u; });
    ({ a, b } = wls(xs, ys, ws));
  }
  return { a, b };
}

/** The growth carry factor for a 7-day change, against the field's median week. */
export function growthFactor(change7d: number | null, medianChg: number, gamma: number): number {
  const chg = change7d === null ? medianChg : change7d;
  const excess = (chg - medianChg) / 100;
  const f = Math.pow(1 + Math.max(excess, -0.9), gamma);
  return Math.min(1.25, Math.max(0.75, f));
}

/** The tenure factor: how settled a protocol's record is after `age` days with no token. */
export function tenureFactor(age: number | null, medianAge: number, lo: number, tau: number): number {
  const d = age === null ? medianAge : age;
  return lo + (1 - lo) * (1 - Math.exp(-d / tau));
}

/**
 * Fit the pipeline on `comps` with the given terms, sequentially: curve, then each term
 * fitted on the residuals the previous stages leave. Returns the fit; priceWith applies it.
 */
export function fitPipeline(comps: Proto[], terms: Term[]): Fit {
  const { a, b } = fitSizeCurve(comps);
  const fit: Fit = {
    a, b, terms: [...terms],
    catOffset: new Map(), gamma: 0, tenureLo: 1, tenureTau: 400, breadthDelta: 0,
    medianChg: median(comps.map((p) => p.change_7d ?? Number.NaN).filter((x) => Number.isFinite(x))),
    medianAge: median(comps.map((p) => p.age ?? Number.NaN).filter((x) => Number.isFinite(x))),
  };
  const resid = () => comps.map((p) => Math.log10(p.mcap_usd!) - Math.log10(priceWith(fit, p, false).value));
  if (terms.includes('category')) {
    const r = resid();
    const byCat = new Map<string, number[]>();
    comps.forEach((p, i) => {
      const key = p.category ?? '(none)';
      if (!byCat.has(key)) byCat.set(key, []);
      byCat.get(key)!.push(r[i]!);
    });
    for (const [cat, rs] of byCat) {
      const off = median(rs) * (rs.length / (rs.length + 16));
      fit.catOffset.set(cat, Math.min(0.9, Math.max(-0.9, off)));
    }
  }
  if (terms.includes('growth')) {
    const r = resid();
    let best = { gamma: 0, score: Number.POSITIVE_INFINITY };
    for (let g = -1; g <= 1.0001; g += 0.125) {
      const score = median(comps.map((p, i) => Math.abs(r[i]! - Math.log10(growthFactor(p.change_7d, fit.medianChg, g)))));
      if (score < best.score) best = { gamma: g, score };
    }
    fit.gamma = best.gamma;
  }
  if (terms.includes('tenure')) {
    const r = resid();
    let best = { lo: 1, tau: 400, score: Number.POSITIVE_INFINITY };
    for (const lo of [0.5, 0.65, 0.8]) {
      for (const tau of [200, 400, 800, 1600]) {
        const score = median(comps.map((p, i) => Math.abs(r[i]! - Math.log10(tenureFactor(p.age, fit.medianAge, lo, tau)))));
        if (score < best.score) best = { lo, tau, score };
      }
    }
    fit.tenureLo = best.lo;
    fit.tenureTau = best.tau;
  }
  if (terms.includes('breadth')) {
    const r = resid();
    let best = { delta: 0, score: Number.POSITIVE_INFINITY };
    for (const d of [0, 0.01, 0.02, 0.03, 0.05]) {
      const score = median(comps.map((p, i) => Math.abs(r[i]! - d * (Math.min(p.chains.length, 10) - 1))));
      if (score < best.score) best = { delta: d, score };
    }
    fit.breadthDelta = best.delta;
  }
  return fit;
}

/** One protocol's value-if-launched under a fit, with its factor decomposition. */
export function priceWith(fit: Fit, p: SnapshotProtocol & { age: number | null }, kin: boolean): { value: number; factors: Record<string, number> } {
  const curve = Math.pow(10, fit.a + fit.b * Math.log10(Math.max(p.tvl_usd, 1)));
  const factors: Record<string, number> = { curve, category: 1, growth: 1, tenure: 1, breadth: 1, kin: 1 };
  let v = curve;
  if (fit.terms.includes('category')) { factors.category = Math.pow(10, fit.catOffset.get(p.category ?? '(none)') ?? 0); v *= factors.category; }
  if (fit.terms.includes('growth')) { factors.growth = growthFactor(p.change_7d, fit.medianChg, fit.gamma); v *= factors.growth; }
  if (fit.terms.includes('tenure')) { factors.tenure = tenureFactor(p.age, fit.medianAge, fit.tenureLo, fit.tenureTau); v *= factors.tenure; }
  if (fit.terms.includes('breadth')) { factors.breadth = Math.pow(10, fit.breadthDelta * (Math.min(p.chains.length, 10) - 1)); v *= factors.breadth; }
  if (kin) { factors.kin = 0.5; v *= 0.5; }
  return { value: v, factors };
}

/** impliedValue(): the one function that prices every row — curve x kept terms x kin. */
export function impliedValue(fit: Fit, p: Proto, kin: boolean): { value: number; factors: Record<string, number> } {
  return priceWith(fit, p, kin);
}

// ------------------------------------------------------------------ validation

/** Signed log10 errors of a fit's prices against the comps' real caps: log10(pred) - log10(actual). */
function looErrors(comps: Proto[], terms: Term[]): number[] {
  return comps.map((c, i) => {
    const rest = comps.filter((_, j) => j !== i);
    const fit = fitPipeline(rest, terms);
    return Math.log10(priceWith(fit, c, false).value) - Math.log10(c.mcap_usd!);
  });
}

/** Walk-forward errors: fit on the oldest share, price the next block, five origins. */
function wfErrors(comps: Proto[], terms: Term[]): number[] {
  const dated = comps.filter((p) => p.listed_at !== null).sort((x, y) => (x.listed_at! < y.listed_at! ? -1 : 1));
  const errs: number[] = [];
  const origins = [0.5, 0.6, 0.7, 0.8, 0.9];
  for (let k = 0; k < origins.length; k++) {
    const cut = Math.floor(dated.length * origins[k]!);
    const end = k + 1 < origins.length ? Math.floor(dated.length * origins[k + 1]!) : dated.length;
    if (cut < 10 || end <= cut) continue;
    const fit = fitPipeline(dated.slice(0, cut), terms);
    for (let i = cut; i < end; i++) errs.push(Math.log10(priceWith(fit, dated[i]!, false).value) - Math.log10(dated[i]!.mcap_usd!));
  }
  return errs;
}

const missOf = (errs: number[]): number => Math.pow(10, median(errs.map((e) => Math.abs(e))));
const within3Of = (errs: number[]): number => errs.filter((e) => Math.abs(e) <= Math.log10(3)).length / errs.length;

/** Spearman's rank correlation between two equal-length series. */
function spearman(xs: number[], ys: number[]): number {
  const rank = (vs: number[]): number[] => {
    const order = vs.map((v, i) => [v, i] as const).sort((p, q) => p[0] - q[0]);
    const out = new Array<number>(vs.length);
    order.forEach(([, i], r) => { out[i] = r; });
    return out;
  };
  const rx = rank(xs), ry = rank(ys);
  const mx = median(rx), my = median(ry);
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < xs.length; i++) { cov += (rx[i]! - mx) * (ry[i]! - my); vx += (rx[i]! - mx) ** 2; vy += (ry[i]! - my) ** 2; }
  return vx > 0 && vy > 0 ? cov / Math.sqrt(vx * vy) : 0;
}

/** Flat-multiple errors: price = TVL x the fit set's median mcap/TVL (the ladder's first rung). */
function flatErrors(comps: Proto[], loo: boolean): number[] {
  if (loo) {
    return comps.map((c, i) => {
      const rest = comps.filter((_, j) => j !== i);
      const mult = median(rest.map((p) => p.mcap_usd! / p.tvl_usd));
      return Math.log10(c.tvl_usd * mult) - Math.log10(c.mcap_usd!);
    });
  }
  const dated = comps.filter((p) => p.listed_at !== null).sort((x, y) => (x.listed_at! < y.listed_at! ? -1 : 1));
  const errs: number[] = [];
  const origins = [0.5, 0.6, 0.7, 0.8, 0.9];
  for (let k = 0; k < origins.length; k++) {
    const cut = Math.floor(dated.length * origins[k]!);
    const end = k + 1 < origins.length ? Math.floor(dated.length * origins[k + 1]!) : dated.length;
    if (cut < 10 || end <= cut) continue;
    const mult = median(dated.slice(0, cut).map((p) => p.mcap_usd! / p.tvl_usd));
    for (let i = cut; i < end; i++) errs.push(Math.log10(dated[i]!.tvl_usd * mult) - Math.log10(dated[i]!.mcap_usd!));
  }
  return errs;
}

/**
 * Placebo control errors: the growth term fitted exactly as in the ladder, but priced
 * with each comp's 7-day change sign-flipped around the fit set's median week — the
 * same machinery with its signal destroyed. A real term must beat this control, not
 * just the curve; a placebo that scores like a term exposes the term as noise.
 */
function placeboErrors(comps: Proto[], loo: boolean): number[] {
  const flipped = (fit: Fit, c: Proto): number => {
    const chg = c.change_7d === null ? fit.medianChg : 2 * fit.medianChg - c.change_7d;
    return Math.log10(priceWith(fit, { ...c, change_7d: chg }, false).value) - Math.log10(c.mcap_usd!);
  };
  if (loo) {
    return comps.map((c, i) => flipped(fitPipeline(comps.filter((_, j) => j !== i), ['growth']), c));
  }
  const dated = comps.filter((p) => p.listed_at !== null).sort((x, y) => (x.listed_at! < y.listed_at! ? -1 : 1));
  const errs: number[] = [];
  const origins = [0.5, 0.6, 0.7, 0.8, 0.9];
  for (let k = 0; k < origins.length; k++) {
    const cut = Math.floor(dated.length * origins[k]!);
    const end = k + 1 < origins.length ? Math.floor(dated.length * origins[k + 1]!) : dated.length;
    if (cut < 10 || end <= cut) continue;
    const fit = fitPipeline(dated.slice(0, cut), ['growth']);
    for (let i = cut; i < end; i++) errs.push(flipped(fit, dated[i]!));
  }
  return errs;
}

export interface LadderStep {
  label: string;
  terms: Term[];
  loo_miss: number;
  wf_miss: number;
  within3_pct: number;
  kept: boolean | null;
}

export interface Validation {
  ladder: LadderStep[];
  kept_terms: Term[];
  dropped_terms: Term[];
  loo_miss: number;
  wf_miss: number;
  flat_loo_miss: number;
  flat_wf_miss: number;
  within3_pct: number;
  rank_rho: number;
  band50_realised: number;
  band80_realised: number;
  top20_stable: number;
  median_rank_width: number;
  rows_moving_5: number;
  placebo_loo_miss: number;
  placebo_wf_miss: number;
  placebo_within3_pct: number;
  cohorts: { label: string; n: number; within3_pct: number; band_n: number; band_pct: number }[];
  worst_cat: { category: string; n: number; miss: number; flat_miss: number } | null;
  self_critique: string;
}

/**
 * compareModels(): the ablation ladder. Each candidate term is fitted, then kept only
 * when it improves BOTH the leave-one-out and the walk-forward median miss against the
 * model without it. Returns the ladder (for the Method view) and the surviving term set.
 */
export function compareModels(comps: Proto[]): { ladder: LadderStep[]; kept: Term[]; dropped: Term[] } {
  const cache = new Map<string, { loo: number[]; wf: number[] }>();
  const evalSpec = (terms: Term[]): { loo: number[]; wf: number[] } => {
    const key = terms.join(',');
    if (!cache.has(key)) cache.set(key, { loo: looErrors(comps, terms), wf: wfErrors(comps, terms) });
    return cache.get(key)!;
  };
  const ladder: LadderStep[] = [];
  const flatLoo = flatErrors(comps, true);
  const flatWf = flatErrors(comps, false);
  ladder.push({ label: 'One flat multiple of TVL', terms: [], loo_miss: round2(missOf(flatLoo)), wf_miss: round2(missOf(flatWf)), within3_pct: Math.round(within3Of(flatLoo) * 100), kept: null });
  const curve = evalSpec([]);
  ladder.push({ label: 'Size curve (Huber log-log fit)', terms: [], loo_miss: round2(missOf(curve.loo)), wf_miss: round2(missOf(curve.wf)), within3_pct: Math.round(within3Of(curve.loo) * 100), kept: null });
  let current: Term[] = [];
  const dropped: Term[] = [];
  for (const term of TERM_ORDER) {
    const cand = TERM_ORDER.filter((t) => t === term || current.includes(t));
    const before = evalSpec(current);
    const after = evalSpec(cand);
    const keep = missOf(after.loo) < missOf(before.loo) && missOf(after.wf) < missOf(before.wf);
    ladder.push({
      label: `+ ${term} term`, terms: cand,
      loo_miss: round2(missOf(after.loo)), wf_miss: round2(missOf(after.wf)),
      within3_pct: Math.round(within3Of(after.loo) * 100), kept: keep,
    });
    if (keep) current = cand; else dropped.push(term);
  }
  return { ladder, kept: current, dropped };
}

// ------------------------------------------------------------------ launch odds

const AGE_EDGES = [180, 365, 730, 1095, 1825];
const TVL_EDGES = [10_000_000, 50_000_000, 200_000_000, 1_000_000_000];

export function ageBucket(age: number | null): number {
  if (age === null) return -1;
  let b = 0;
  while (b < AGE_EDGES.length && age >= AGE_EDGES[b]!) b++;
  return b;
}
export function tvlBand(tvl: number): number {
  let b = 0;
  while (b < TVL_EDGES.length && tvl >= TVL_EDGES[b]!) b++;
  return b;
}

export interface OddsModel {
  oddsFor: (p: Proto) => number;
  baseRate: number;
  hitPct: number;
  baseHitPct: number;
  auc: number;
  reliability: { bin: string; n: number; predicted: number; realised: number }[];
}

/**
 * launchOdds(): the share of look-alikes that record a token, fitted on the snapshot
 * itself — smoothed cells of age bucket x TVL band over all 758 protocols (Laplace
 * smoothing; a cell with fewer than 20 protocols falls back to its age bucket, then
 * its TVL band, then the field's base rate). Calibrated on a seeded 70/30 split.
 */
export function fitOdds(protos: Proto[]): OddsModel {
  const build = (set: Proto[]) => {
    const cell = new Map<string, { n: number; tok: number }>();
    const byAge = new Map<number, { n: number; tok: number }>();
    const byBand = new Map<number, { n: number; tok: number }>();
    let tok = 0;
    const bump = (m: Map<unknown, { n: number; tok: number }>, k: unknown, t: boolean) => {
      const e = m.get(k) ?? { n: 0, tok: 0 };
      e.n++; if (t) e.tok++;
      m.set(k, e);
    };
    for (const p of set) {
      if (p.tokened) tok++;
      bump(cell as Map<unknown, { n: number; tok: number }>, `${ageBucket(p.age)}|${tvlBand(p.tvl_usd)}`, p.tokened);
      bump(byAge as Map<unknown, { n: number; tok: number }>, ageBucket(p.age), p.tokened);
      bump(byBand as Map<unknown, { n: number; tok: number }>, tvlBand(p.tvl_usd), p.tokened);
    }
    const share = (e: { n: number; tok: number } | undefined): number | null =>
      e !== undefined && e.n >= 20 ? (e.tok + 1) / (e.n + 2) : null;
    const global = (tok + 1) / (set.length + 2);
    return {
      oddsFor: (p: Proto): number =>
        share(cell.get(`${ageBucket(p.age)}|${tvlBand(p.tvl_usd)}`)) ??
        share(byAge.get(ageBucket(p.age))) ??
        share(byBand.get(tvlBand(p.tvl_usd))) ??
        global,
      baseRate: global,
    };
  };
  const full = build(protos);
  // Discrimination of the fitted odds over the whole snapshot (outcome: records a
  // token), Mann-Whitney with ties at half credit — the AUC the dashboard prints
  // beside the hit rate when it clears 0.65.
  const posScores = protos.filter((p) => p.tokened).map((p) => full.oddsFor(p));
  const negScores = protos.filter((p) => !p.tokened).map((p) => full.oddsFor(p));
  let wins = 0, ties = 0;
  for (const a of posScores) {
    for (const b of negScores) {
      if (a > b) wins++;
      else if (a === b) ties++;
    }
  }
  const auc = (wins + 0.5 * ties) / (posScores.length * negScores.length);
  const rng = mulberry32(758_2026);
  const idx = protos.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [idx[i], idx[j]] = [idx[j]!, idx[i]!]; }
  const cut = Math.floor(idx.length * 0.7);
  const train = idx.slice(0, cut).map((i) => protos[i]!);
  const test = idx.slice(cut).map((i) => protos[i]!);
  const trainModel = build(train);
  let hits = 0;
  for (const p of test) if ((trainModel.oddsFor(p) >= 0.5) === p.tokened) hits++;
  const testTokShare = test.filter((p) => p.tokened).length / test.length;
  const bins = [[0, 0.2], [0.2, 0.4], [0.4, 0.6], [0.6, 0.8], [0.8, 1.01]] as const;
  const reliability = bins.map(([lo, hi]) => {
    const inBin = protos.filter((p) => { const o = full.oddsFor(p); return o >= lo && o < hi; });
    return {
      bin: `${Math.round(lo * 100)}–${Math.min(100, Math.round(hi * 100))}%`,
      n: inBin.length,
      predicted: inBin.length ? round4(inBin.reduce((s, p) => s + full.oddsFor(p), 0) / inBin.length) : 0,
      realised: inBin.length ? round4(inBin.filter((p) => p.tokened).length / inBin.length) : 0,
    };
  });
  return {
    oddsFor: full.oddsFor,
    baseRate: round4(full.baseRate),
    hitPct: Math.round((hits / test.length) * 100),
    baseHitPct: Math.round(Math.max(testTokShare, 1 - testTokShare) * 100),
    auc: round4(auc),
    reliability,
  };
}

// ------------------------------------------------------------------ bands

/** Residual quantiles (log10) of the comps near a TVL, from signed LOO residuals. */
export function bandMultipliers(tvl: number, comps: Proto[], looResid: number[]): { p10: number; p25: number; p75: number; p90: number } {
  const lt = Math.log10(Math.max(tvl, 1));
  let w = 0.5;
  let near: number[] = [];
  for (;;) {
    near = comps.map((c, i) => ({ d: Math.abs(Math.log10(c.tvl_usd) - lt), r: looResid[i]! })).filter((x) => x.d <= w).map((x) => x.r);
    if (near.length >= 25 || w >= 1.5) break;
    w += 0.25;
  }
  if (near.length < 5) near = looResid;
  return {
    p10: Math.pow(10, quantile(near, 0.1)), p25: Math.pow(10, quantile(near, 0.25)),
    p75: Math.pow(10, quantile(near, 0.75)), p90: Math.pow(10, quantile(near, 0.9)),
  };
}

// ------------------------------------------------------------------ farm plans

/** A stated fee prior per hands-on action, by the chain the action happens on (USD). */
export const CHAIN_FEE: Record<string, number> = {
  Ethereum: 6.0, Solana: 0.1, Base: 0.35, Arbitrum: 0.45, Optimism: 0.4, Polygon: 0.15,
  BSC: 0.3, Avalanche: 0.5, 'Hyperliquid L1': 0.2, Ink: 0.35, Linea: 0.4, Scroll: 0.4,
};
export const DEFAULT_CHAIN_FEE = 1.5;
export const TICKET_LADDER = [250, 500, 1000, 2500, 5000, 10000, 25000];

export interface PlanStep { label: string; text: string; fee: number; min: number }
export interface Plan { steps: PlanStep[]; weeks: number; fees: number; minutes: number }

/** The plan's hold, from the protocol's age: younger protocols get a longer qualifying window. */
export function holdWeeks(age: number | null): number {
  if (age === null || age < 180) return 12;
  if (age < 365) return 10;
  return 8;
}

/** The category's one main action, in words a farmer can follow. */
export function actionFor(p: SnapshotProtocol, ticket: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const n = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${ticket.toLocaleString('en-US')} of USDC to ${n} on ${chain} and keep the position open; do not borrow against it in week one.`;
  if (c.includes('dex')) return `Provide $${ticket.toLocaleString('en-US')} of liquidity to ${n}'s main USDC pool on ${chain} and keep the LP position open.`;
  if (c.includes('yield') || c.includes('curator') || c.includes('allocator')) return `Deposit $${ticket.toLocaleString('en-US')} of USDC into a ${n} vault on ${chain} and keep the vault shares in the same wallet.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${ticket.toLocaleString('en-US')} of the chain's staking asset through ${n} on ${chain} and keep the receipt token.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Deposit $${ticket.toLocaleString('en-US')} of USDC as margin on ${n} and open one small hedged position, then leave it untouched.`;
  if (c.includes('rwa') || c.includes('stable')) return `Mint or deposit $${ticket.toLocaleString('en-US')} of the protocol's yield asset through ${n} on ${chain} and hold it.`;
  if (c.includes('prediction')) return `Fund $${ticket.toLocaleString('en-US')} on ${n} and place one position in a liquid market; do not chase losses.`;
  if (c.includes('insurance')) return `Buy $${ticket.toLocaleString('en-US')} of cover from ${n} on ${chain} and keep the policy for the full term.`;
  return `Deposit $${ticket.toLocaleString('en-US')} of USDC into ${n} on ${chain} and keep the position open.`;
}

/**
 * farmPlan(): a dated plan of six steps over the hold window. Every step carries its
 * own fee and hands-on minutes from the chain's stated fee prior; the ledger totals
 * are the sums, and the economics below read only this ledger.
 */
export function farmPlan(p: Proto, ticket: number): Plan {
  const chain = p.chains.length > 0 ? p.chains[0]! : 'its main chain';
  const fee = CHAIN_FEE[chain] ?? DEFAULT_CHAIN_FEE;
  const weeks = holdWeeks(p.age);
  const chgTxt = p.change_7d === null ? 'not reported' : `${p.change_7d > 0 ? '+' : ''}${p.change_7d.toFixed(1)}%`;
  const steps: PlanStep[] = [
    { label: 'Day 1', text: `Fund a fresh wallet on ${chain} with $${ticket.toLocaleString('en-US')} of USDC plus a little spare for gas; keep the seed phrase offline and use this wallet for nothing else.`, fee, min: 25 },
    { label: 'Day 1', text: actionFor(p, ticket, chain), fee, min: 20 },
    { label: `Weeks 2-${weeks}`, text: `Repeat one qualifying action a week — a top-up of about $${Math.max(25, Math.round(ticket / 10)).toLocaleString('en-US')}, a swap or a vote — on a different weekday each time; steady wallets outrank one-day bursts.`, fee: fee * (weeks - 1), min: 10 * (weeks - 1) },
    { label: 'Monthly', text: `Check the 7-day TVL change (${chgTxt} now): if it falls under -20%, withdraw half the same day and write the reason in the farm log.`, fee: 0, min: 15 * Math.ceil(weeks / 4) },
    { label: `Week ${weeks}`, text: `Log every transaction hash, then watch only ${p.name}'s own site and docs for a points or claim page; never pay or sign a 'claim fee' — a real claim costs nothing.`, fee: 0, min: 15 },
    { label: `Week ${weeks}`, text: `If nothing is announced by the end of week ${weeks}, withdraw the whole position in one transaction and record the final balance in the farm log.`, fee, min: 15 },
  ];
  return { steps, weeks, fees: steps.reduce((s, x) => s + x.fee, 0), minutes: steps.reduce((s, x) => s + x.min, 0) };
}

export interface Econ {
  slice: number; costs: number; net_launch: number; exp_net: number;
  breakeven: number; verdict: 'FARM' | 'THIN' | 'SKIP'; net_hour: number; pays_from: number | null;
}

/**
 * The plan's economics at a ticket, a drop share and a T-bill yield. Slice is the
 * pro-rata share of the launch value; costs are the ledger's fees plus the T-bill
 * yield the capital gives up over the hold. The verdict is the break-even launch
 * odds: FARM when a 10% chance repays every cost, THIN at 33%, else SKIP.
 */
export function farmEconomics(valueIf: number, odds: number, tvl: number, plan: Plan, ticket: number, share: number, tbill: number): Econ {
  const sliceAt = (t: number) => share * valueIf * (t / (tvl + t));
  const costsAt = (t: number) => plan.fees + t * tbill * (plan.weeks / 52);
  const slice = sliceAt(ticket);
  const costs = costsAt(ticket);
  const breakeven = slice > 0 ? costs / slice : Number.POSITIVE_INFINITY;
  const verdict = breakeven <= 0.1 ? 'FARM' : breakeven <= 0.33 ? 'THIN' : 'SKIP';
  let paysFrom: number | null = null;
  for (const t of TICKET_LADDER) if (sliceAt(t) >= costsAt(t)) { paysFrom = t; break; }
  const expNet = odds * slice - costs;
  return {
    slice, costs, net_launch: slice - costs, exp_net: expNet,
    breakeven, verdict, net_hour: expNet / (plan.minutes / 60), pays_from: paysFrom,
  };
}

/** Whether the verdict is FARM at all nine points of the share x T-bill grid. */
export function robustFarm(valueIf: number, odds: number, tvl: number, plan: Plan): boolean {
  for (const share of [0.05, 0.1, 0.2]) {
    for (const tbill of [0, 0.04, 0.08]) {
      if (farmEconomics(valueIf, odds, tvl, plan, 1000, share, tbill).verdict !== 'FARM') return false;
    }
  }
  return true;
}

/** Snapshot-only risk tags for a row. */
export function riskTags(p: Proto, kin: boolean): string[] {
  const tags: string[] = [];
  if (p.chains.length === 1) tags.push('SINGLE-CHAIN');
  if (p.change_7d !== null && p.change_7d <= -20) tags.push('FALLING');
  if (p.age !== null && p.age < 180) tags.push('NEW');
  if (kin) tags.push('SIBLING');
  return tags;
}

/**
 * The traded comps a row's price leans on: only comps within ±1 dex of the row's TVL
 * (a $2.8B row is not priced off an $11M comp), same category first, then nearest TVL.
 * When fewer than five comps sit inside the window, the list is filled with the
 * nearest remaining comps, same category first.
 */
export function peerSet(p: Proto, comps: Proto[]): { name: string; symbol: string | null; tvl_usd: number; mcap_usd: number; multiple: number }[] {
  const lt = Math.log10(Math.max(p.tvl_usd, 1));
  const dist = (c: Proto): number => Math.abs(Math.log10(Math.max(c.tvl_usd, 1)) - lt);
  const order = (x: Proto, y: Proto): number => {
    const cx = x.category === p.category ? 0 : 1, cy = y.category === p.category ? 0 : 1;
    if (cx !== cy) return cx - cy;
    return dist(x) - dist(y) || (x.slug < y.slug ? -1 : 1);
  };
  const inDex = comps.filter((c) => dist(c) <= 1).sort(order);
  const picked = inDex.slice(0, 5);
  if (picked.length < 5) {
    const rest = comps.filter((c) => !picked.includes(c)).sort(order);
    picked.push(...rest.slice(0, 5 - picked.length));
  }
  return picked.map((c) => ({ name: c.name, symbol: c.symbol, tvl_usd: c.tvl_usd, mcap_usd: c.mcap_usd!, multiple: round4(c.mcap_usd! / c.tvl_usd) }));
}

// ------------------------------------------------------------------ the board

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  value_if_launched_usd: number;
  launch_odds: number;
  band_p10_usd: number;
  band_p25_usd: number;
  band_p75_usd: number;
  band_p90_usd: number;
  rank_lo: number;
  rank_hi: number;
  verdict: string;
  slice_usd_at_1000: number;
  net_usd_at_1000: number;
  net_per_hour_at_1000: number;
  breakeven_odds: number;
  pays_from_usd: number | null;
  robust_farm: boolean;
  risk_tags: string[];
  model: Record<string, number>;
  farm_steps: string[];
}

/** Everything the dashboard renders: the board plus the data its own model re-runs on. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  kept_terms: Term[];
  dropped_terms: Term[];
  fit: { a: number; b: number; gamma: number; tenure_lo: number; tenure_tau: number; breadth_delta: number; median_chg: number; median_age: number; cat_offsets: Record<string, number> };
  validation: Validation;
  odds: { base_rate: number; hit_pct: number; base_hit_pct: number; auc: number; reliability: { bin: string; n: number; predicted: number; realised: number }[] };
  accounting: { ranked: number; tokened_mcap: number; tokened_nomcap: number; comps: number; groups: { key: string; label: string; count: number; examples: string[] }[] };
  watchlist: string[];
  protocols: unknown[];
  rows: Record<string, unknown>[];
  stats: { ranked: number; products: number; tokened: number };
}

const GROUP_LABELS: Record<string, string> = {
  bridge: 'Bridges & canonical bridges',
  staking: 'Liquid staking & restaking',
  exchange: 'Exchange custody & CEX',
  versioned: 'Versioned deployments',
  wrapped: 'Wrapped or staked by name',
};

/** buildBoard(): fit, validate, price, rank — the whole radar from one snapshot. */
export function buildBoard(snapshot: Snapshot): { board: BoardRow[]; data: RadarData } {
  const protos: Proto[] = snapshot.protocols.map((p) => ({
    ...p,
    age: ageDays(snapshot.as_of, p.listed_at),
    tokened: p.gecko_id !== null || p.symbol !== null,
  }));
  const tokenedStems = new Set(protos.filter((p) => p.tokened).map((p) => nameStem(p.name)));
  const tokenedSymbols = new Set(protos.filter((p) => p.tokened && p.symbol !== null).map((p) => p.symbol!.toLowerCase()));
  const candidates = protos.filter((p) => !p.tokened && exclusionReason(p) === null);
  const kinOf = new Map(candidates.map((p) => [p.slug, isKin(p, tokenedStems, tokenedSymbols)]));
  const comps = pickComps(protos);

  const { ladder, kept, dropped } = compareModels(comps);
  const fit = fitPipeline(comps, kept);
  const odds = fitOdds(protos);

  // Leave-one-out residuals of the final model: the bands and their calibration.
  const looPred = comps.map((c, i) => {
    const rest = comps.filter((_, j) => j !== i);
    return priceWith(fitPipeline(rest, kept), c, false).value;
  });
  const looResid = comps.map((c, i) => Math.log10(c.mcap_usd!) - Math.log10(looPred[i]!));
  const looErrs = looResid.map((r) => -r);
  let in50 = 0, in80 = 0;
  const inBand50: boolean[] = comps.map(() => false);
  comps.forEach((c, i) => {
    const others = comps.filter((_, j) => j !== i);
    const resOthers = looResid.filter((_, j) => j !== i);
    const m = bandMultipliers(c.tvl_usd, others, resOthers);
    if (c.mcap_usd! >= looPred[i]! * m.p25 && c.mcap_usd! <= looPred[i]! * m.p75) { in50++; inBand50[i] = true; }
    if (c.mcap_usd! >= looPred[i]! * m.p10 && c.mcap_usd! <= looPred[i]! * m.p90) in80++;
  });

  // The placebo control and the range-honesty cohorts: the growth machinery with its
  // signal sign-flipped, scored like any term; and the printed bands' realised
  // coverage split by the comps' listing cohort (older half vs newer half).
  const placeboLoo = placeboErrors(comps, true);
  const placeboWf = placeboErrors(comps, false);
  const byListing = comps.map((_, i) => i).sort((x, y) => (comps[x]!.listed_at! < comps[y]!.listed_at! ? -1 : 1));
  const half = Math.floor(byListing.length / 2);
  const cohortOf = (label: string, idxs: number[]): Validation['cohorts'][number] => ({
    label,
    n: idxs.length,
    within3_pct: Math.round(idxs.filter((i) => Math.abs(looErrs[i]!) <= Math.log10(3)).length / idxs.length * 100),
    band_n: idxs.filter((i) => inBand50[i]).length,
    band_pct: Math.round(idxs.filter((i) => inBand50[i]).length / idxs.length * 100),
  });
  const cohorts = [cohortOf('Older half', byListing.slice(0, half)), cohortOf('Newer half', byListing.slice(half))];

  // The worst category, named: per-category median miss of the shipped model on the
  // left-out comps (categories with at least 8 comps), against flat's miss there.
  const flatLoo = flatErrors(comps, true);
  const catIdx = new Map<string, number[]>();
  comps.forEach((c, i) => {
    const key = c.category ?? '(none)';
    if (!catIdx.has(key)) catIdx.set(key, []);
    catIdx.get(key)!.push(i);
  });
  let worstCat: Validation['worst_cat'] = null;
  for (const [cat, idxs] of catIdx) {
    if (idxs.length < 8) continue;
    const miss = round2(missOf(idxs.map((i) => looErrs[i]!)));
    if (worstCat === null || miss > worstCat.miss) {
      worstCat = { category: cat, n: idxs.length, miss, flat_miss: round2(missOf(idxs.map((i) => flatLoo[i]!))) };
    }
  }

  // Price every candidate.
  const priced = candidates.map((p) => {
    const kin = kinOf.get(p.slug)!;
    const { value, factors } = impliedValue(fit, p, kin);
    const o = odds.oddsFor(p);
    const plan = farmPlan(p, 1000);
    const econ = farmEconomics(value, o, p.tvl_usd, plan, 1000, 0.1, 0.04);
    const band = bandMultipliers(p.tvl_usd, comps, looResid);
    return { p, kin, value, factors, odds: o, plan, econ, band, expected: value * o };
  });
  priced.sort((x, y) => y.expected - x.expected || (x.p.slug < y.p.slug ? -1 : 1));

  // Rank ranges: 200 seeded bootstrap refits of the pricing pipeline.
  const rng = mulberry32(20_261_114);
  const rankSamples = new Map<string, number[]>(priced.map((r) => [r.p.slug, []]));
  for (let iter = 0; iter < 200; iter++) {
    const sample = Array.from({ length: comps.length }, () => comps[Math.floor(rng() * comps.length)]!);
    const rfit = fitPipeline(sample, kept);
    const rr = priced.map((r) => ({ slug: r.p.slug, ev: Math.round(priceWith(rfit, r.p, r.kin).value * r.odds) }));
    rr.sort((x, y) => y.ev - x.ev || (x.slug < y.slug ? -1 : 1));
    rr.forEach((r, i) => rankSamples.get(r.slug)!.push(i + 1));
  }

  const tvlOrder = [...priced].sort((x, y) => y.p.tvl_usd - x.p.tvl_usd || (x.p.slug < y.p.slug ? -1 : 1));
  const tvlRank = new Map(tvlOrder.map((r, i) => [r.p.slug, i + 1]));
  let rowsMoving5 = 0;

  const board: BoardRow[] = priced.map((r, i) => {
    const samples = rankSamples.get(r.p.slug)!;
    const rankLo = Math.floor(quantile(samples, 0.1));
    const rankHi = Math.ceil(quantile(samples, 0.9));
    if (Math.abs(i + 1 - tvlRank.get(r.p.slug)!) >= 5) rowsMoving5++;
    const ev = Math.max(1, Math.round(r.expected));
    const steps = r.plan.steps.map((s) => `${s.label}: ${s.text} Fee $${s.fee.toFixed(2)} · hands-on ${s.min} min.`);
    steps.push(
      `Plan totals at a $1,000 ticket, 10% drop share, 4% T-bill: fees $${r.plan.fees.toFixed(2)} and ${round2(r.plan.minutes / 60)} h hands-on over ${r.plan.weeks} weeks; ` +
      `slice if it launches $${Math.round(r.econ.slice).toLocaleString('en-US')}; all-in costs $${r.econ.costs.toFixed(2)}; break-even launch odds ${(r.econ.breakeven * 100).toFixed(1)}%; verdict ${r.econ.verdict}.`,
    );
    return {
      rank: i + 1, slug: r.p.slug, name: r.p.name, category: r.p.category, chains: r.p.chains,
      tvl_usd: r.p.tvl_usd, change_7d: r.p.change_7d, mcap_usd: null, listed_at: r.p.listed_at,
      gecko_id: null, symbol: null, token_status: 'pre-token', age_days: r.p.age,
      implied_value_usd: ev,
      value_if_launched_usd: Math.round(r.value),
      launch_odds: round4(r.odds),
      band_p10_usd: Math.round(ev * r.band.p10), band_p25_usd: Math.round(ev * r.band.p25),
      band_p75_usd: Math.round(ev * r.band.p75), band_p90_usd: Math.round(ev * r.band.p90),
      rank_lo: rankLo, rank_hi: rankHi,
      verdict: r.econ.verdict,
      slice_usd_at_1000: Math.round(r.econ.slice),
      net_usd_at_1000: Math.round(r.econ.exp_net),
      net_per_hour_at_1000: round2(r.econ.net_hour),
      breakeven_odds: round4(r.econ.breakeven),
      pays_from_usd: r.econ.pays_from,
      robust_farm: robustFarm(r.value, r.odds, r.p.tvl_usd, r.plan),
      risk_tags: riskTags(r.p, r.kin),
      model: { curve: round4(r.factors.curve!), category: round4(r.factors.category!), growth: round4(r.factors.growth!), tenure: round4(r.factors.tenure!), breadth: round4(r.factors.breadth!), kin: round4(r.factors.kin!) },
      farm_steps: steps,
    };
  });

  const top20 = board.slice(0, 20);
  const top20Stable = top20.filter((r) => {
    const s = rankSamples.get(r.slug)!;
    return s.filter((x) => x <= 20).length / s.length >= 0.8;
  }).length;
  const medianWidth = Math.round(median(board.map((r) => r.rank_hi - r.rank_lo)));
  const band50 = in50 / comps.length;
  const band80 = in80 / comps.length;
  const critique = band50 < 0.45
    ? `Honest weakness: the printed P25-P75 bands run narrow — left out, they caught ${Math.round(band50 * 100)}% of real caps against the 50% they promise. Read the band as a floor for the uncertainty, not the whole of it.`
    : top20Stable < 14
      ? `Honest weakness: the top of the board churns under refits — only ${top20Stable} of the top 20 stay there in 80% of refits. The ranking is a map of where to look, not a finishing order.`
      : `Honest weakness: launch odds beat the base rate by ${odds.hitPct - odds.baseHitPct} points on the held-out split — useful, not clairvoyant. The odds column is a prior, and the verdicts lean on break-even odds for exactly that reason.`;

  const validation: Validation = {
    ladder, kept_terms: kept, dropped_terms: dropped,
    loo_miss: round2(missOf(looErrs)), wf_miss: round2(missOf(wfErrors(comps, kept))),
    flat_loo_miss: ladder[0]!.loo_miss, flat_wf_miss: ladder[0]!.wf_miss,
    within3_pct: Math.round(within3Of(looErrs) * 100),
    rank_rho: round2(spearman(looPred, comps.map((c) => c.mcap_usd!))),
    band50_realised: round4(band50), band80_realised: round4(band80),
    top20_stable: top20Stable, median_rank_width: medianWidth, rows_moving_5: rowsMoving5,
    placebo_loo_miss: round2(missOf(placeboLoo)), placebo_wf_miss: round2(missOf(placeboWf)),
    placebo_within3_pct: Math.round(within3Of(placeboLoo) * 100),
    cohorts,
    worst_cat: worstCat,
    self_critique: critique,
  };

  const groups = new Map<string, { count: number; names: { name: string; tvl: number }[] }>();
  let products = 0;
  for (const p of protos) {
    if (p.tokened) continue;
    const reason = exclusionReason(p);
    if (reason === null) continue;
    products++;
    const g = groups.get(reason) ?? { count: 0, names: [] };
    g.count++;
    g.names.push({ name: p.name, tvl: p.tvl_usd });
    groups.set(reason, g);
  }
  const accounting: RadarData['accounting'] = {
    ranked: board.length,
    tokened_mcap: protos.filter((p) => p.tokened && p.mcap_usd !== null && p.mcap_usd > 0).length,
    tokened_nomcap: protos.filter((p) => p.tokened && !(p.mcap_usd !== null && p.mcap_usd > 0)).length,
    comps: comps.length,
    groups: [...groups.entries()].map(([key, g]) => ({
      key, label: GROUP_LABELS[key] ?? key, count: g.count,
      examples: g.names.sort((x, y) => y.tvl - x.tvl).slice(0, 6).map((x) => x.name),
    })),
  };

  const rows: Record<string, unknown>[] = priced.map((r, i) => {
    const b = board[i]!;
    return {
      rank: b.rank, slug: b.slug, name: b.name, category: b.category, chains: b.chains,
      tvl_usd: b.tvl_usd, change_7d: b.change_7d, age_days: b.age_days,
      watchlist: snapshot.watchlist.includes(b.slug),
      value_if: b.value_if_launched_usd, odds: b.launch_odds, expected: b.implied_value_usd,
      band: { p10: b.band_p10_usd, p25: b.band_p25_usd, p75: b.band_p75_usd, p90: b.band_p90_usd },
      rank_lo: b.rank_lo, rank_hi: b.rank_hi,
      factors: b.model, fees: round2(r.plan.fees), minutes: r.plan.minutes, weeks: r.plan.weeks,
      econ: { slice: Math.round(r.econ.slice), costs: round2(r.econ.costs), net_launch: Math.round(r.econ.net_launch), exp_net: Math.round(r.econ.exp_net), breakeven: b.breakeven_odds, verdict: b.verdict, net_hour: b.net_per_hour_at_1000, pays_from: b.pays_from_usd },
      robust_farm: b.robust_farm, risk_tags: b.risk_tags,
      peers: peerSet(r.p, comps),
      steps: r.plan.steps,
    };
  });

  const data: RadarData = {
    as_of: snapshot.as_of, source: snapshot.source, floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION, kept_terms: kept, dropped_terms: dropped,
    fit: {
      a: round4(fit.a), b: round4(fit.b), gamma: fit.gamma, tenure_lo: fit.tenureLo, tenure_tau: fit.tenureTau,
      breadth_delta: fit.breadthDelta, median_chg: round4(fit.medianChg), median_age: fit.medianAge,
      cat_offsets: Object.fromEntries([...fit.catOffset.entries()].map(([k, v]) => [k, round4(v)])),
    },
    validation, odds: { base_rate: odds.baseRate, hit_pct: odds.hitPct, base_hit_pct: odds.baseHitPct, auc: odds.auc, reliability: odds.reliability },
    accounting, watchlist: snapshot.watchlist,
    protocols: protos.map((p) => [p.slug, p.name, p.category, p.chains, p.tvl_usd, p.change_7d, p.mcap_usd, p.listed_at, p.tokened ? 1 : 0, p.symbol]),
    rows,
    stats: { ranked: board.length, products, tokened: protos.filter((p) => p.tokened).length },
  };
  return { board, data };
}

// ------------------------------------------------------------------ snapshot + gate

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, values, farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows: the gate takes 100 to 4,000`;
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(data: RadarData): string {
  return `window.RADAR=${JSON.stringify(data)};\n`;
}
