// Token Launch Radar — the model, in the page. The twin of lib/model.ts: the same
// pricing functions, the same seeded PRNG, the same arithmetic. checkBoard() below
// re-runs it on data.js and prints whether it matches board.json. (The ablation,
// odds calibration and robustness grids run in the Node build only.)
'use strict';

const TERM_ORDER = ['category', 'growth', 'tenure', 'breadth'];
const DAY_MS = 86400000;

function ageDays(asOf, listedAt) {
  if (listedAt === null) return null;
  const a = Date.parse(asOf + 'T00:00:00Z'), b = Date.parse(listedAt + 'T00:00:00Z');
  if (!isFinite(a) || !isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}
function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function median(xs) {
  const s = [...xs].sort((a, b) => a - b), n = s.length;
  return n % 2 === 1 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}
function quantile(xs, q) {
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 1) return s[0];
  const at = q * (s.length - 1), lo = Math.floor(at);
  return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (at - lo);
}
const round2 = (n) => Math.round(n * 100) / 100;
const round4 = (n) => Math.round(n * 1e4) / 1e4;

// ---- universe
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
const EXCHANGES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

function exclusionReason(p) {
  if (p.category === 'Bridge' || p.category === 'Canonical Bridge') return 'bridge';
  if (p.category === 'Liquid Staking' || p.category === 'Liquid Restaking' || p.category === 'Restaked BTC') return 'staking';
  if (p.category === 'CEX' || EXCHANGES.some((x) => p.name.startsWith(x))) return 'exchange';
  if (VERSIONED.test(p.name)) return 'versioned';
  if (WRAPPED_WORD.test(p.name)) return 'wrapped';
  return null;
}
function nameStem(name) {
  return name.replace(VERSIONED, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}
function isKin(p, tokenedStems, tokenedSymbols) {
  const stem = nameStem(p.name);
  if (tokenedStems.has(stem)) return true;
  for (const t of tokenedStems) {
    if (t.length >= 5 && (stem.startsWith(t) || t.startsWith(stem)) && Math.min(stem.length, t.length) >= 5) return true;
  }
  return p.name.toLowerCase().split(/[^a-z0-9]+/).some((w) => w.length >= 3 && tokenedSymbols.has(w));
}
function pickComps(protos) {
  const inBand = protos.filter((p) => p.tokened && p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0 &&
    p.listed_at !== null && p.category !== 'CEX' && p.mcap_usd / p.tvl_usd >= 0.005 && p.mcap_usd / p.tvl_usd <= 20);
  const best = new Map();
  for (const p of inBand) {
    const key = p.symbol !== null && p.symbol !== undefined ? p.symbol : p.slug;
    const cur = best.get(key);
    if (cur === undefined || (p.mcap_usd || 0) > (cur.mcap_usd || 0)) best.set(key, p);
  }
  return [...best.values()].sort((a, b) => (a.slug < b.slug ? -1 : 1));
}

// ---- the fit
function wls(xs, ys, ws) {
  let sw = 0, sx = 0, sy = 0;
  for (let i = 0; i < xs.length; i++) { sw += ws[i]; sx += ws[i] * xs[i]; sy += ws[i] * ys[i]; }
  const mx = sx / sw, my = sy / sw;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < xs.length; i++) { const dx = xs[i] - mx; sxy += ws[i] * dx * (ys[i] - my); sxx += ws[i] * dx * dx; }
  const b = sxx > 0 ? sxy / sxx : 0;
  return { a: my - b * mx, b };
}
function fitSizeCurve(comps) {
  const xs = comps.map((p) => Math.log10(p.tvl_usd));
  const ys = comps.map((p) => Math.log10(p.mcap_usd));
  let { a, b } = wls(xs, ys, xs.map(() => 1));
  for (let iter = 0; iter < 8; iter++) {
    const resid = ys.map((y, i) => y - (a + b * xs[i]));
    const mad = median(resid.map((r) => Math.abs(r - median(resid))));
    const s = Math.max(1.4826 * mad, 1e-6);
    const ws = resid.map((r) => { const u = Math.abs(r) / (1.345 * s); return u <= 1 ? 1 : 1 / u; });
    ({ a, b } = wls(xs, ys, ws));
  }
  return { a, b };
}
function growthFactor(change7d, medianChg, gamma) {
  const chg = change7d === null ? medianChg : change7d;
  const excess = (chg - medianChg) / 100;
  const f = Math.pow(1 + Math.max(excess, -0.9), gamma);
  return Math.min(1.25, Math.max(0.75, f));
}
function tenureFactor(age, medianAge, lo, tau) {
  const d = age === null ? medianAge : age;
  return lo + (1 - lo) * (1 - Math.exp(-d / tau));
}
function fitPipeline(comps, terms) {
  const { a, b } = fitSizeCurve(comps);
  const fit = {
    a, b, terms: [...terms], catOffset: new Map(), gamma: 0, tenureLo: 1, tenureTau: 400, breadthDelta: 0,
    medianChg: median(comps.map((p) => (p.change_7d === null ? NaN : p.change_7d)).filter((x) => isFinite(x))),
    medianAge: median(comps.map((p) => (p.age === null ? NaN : p.age)).filter((x) => isFinite(x))),
  };
  const resid = () => comps.map((p) => Math.log10(p.mcap_usd) - Math.log10(priceWith(fit, p, false).value));
  if (terms.includes('category')) {
    const r = resid();
    const byCat = new Map();
    comps.forEach((p, i) => {
      const key = p.category !== null && p.category !== undefined ? p.category : '(none)';
      if (!byCat.has(key)) byCat.set(key, []);
      byCat.get(key).push(r[i]);
    });
    for (const [cat, rs] of byCat) {
      const off = median(rs) * (rs.length / (rs.length + 16));
      fit.catOffset.set(cat, Math.min(0.9, Math.max(-0.9, off)));
    }
  }
  if (terms.includes('growth')) {
    const r = resid();
    let best = { gamma: 0, score: Infinity };
    for (let g = -1; g <= 1.0001; g += 0.125) {
      const score = median(comps.map((p, i) => Math.abs(r[i] - Math.log10(growthFactor(p.change_7d, fit.medianChg, g)))));
      if (score < best.score) best = { gamma: g, score };
    }
    fit.gamma = best.gamma;
  }
  if (terms.includes('tenure')) {
    const r = resid();
    let best = { lo: 1, tau: 400, score: Infinity };
    for (const lo of [0.5, 0.65, 0.8]) {
      for (const tau of [200, 400, 800, 1600]) {
        const score = median(comps.map((p, i) => Math.abs(r[i] - Math.log10(tenureFactor(p.age, fit.medianAge, lo, tau)))));
        if (score < best.score) best = { lo, tau, score };
      }
    }
    fit.tenureLo = best.lo; fit.tenureTau = best.tau;
  }
  if (terms.includes('breadth')) {
    const r = resid();
    let best = { delta: 0, score: Infinity };
    for (const d of [0, 0.01, 0.02, 0.03, 0.05]) {
      const score = median(comps.map((p, i) => Math.abs(r[i] - d * (Math.min(p.chains.length, 10) - 1))));
      if (score < best.score) best = { delta: d, score };
    }
    fit.breadthDelta = best.delta;
  }
  return fit;
}
function priceWith(fit, p, kin) {
  const curve = Math.pow(10, fit.a + fit.b * Math.log10(Math.max(p.tvl_usd, 1)));
  const factors = { curve, category: 1, growth: 1, tenure: 1, breadth: 1, kin: 1 };
  let v = curve;
  if (fit.terms.includes('category')) { factors.category = Math.pow(10, fit.catOffset.get(p.category !== null && p.category !== undefined ? p.category : '(none)') || 0); v *= factors.category; }
  if (fit.terms.includes('growth')) { factors.growth = growthFactor(p.change_7d, fit.medianChg, fit.gamma); v *= factors.growth; }
  if (fit.terms.includes('tenure')) { factors.tenure = tenureFactor(p.age, fit.medianAge, fit.tenureLo, fit.tenureTau); v *= factors.tenure; }
  if (fit.terms.includes('breadth')) { factors.breadth = Math.pow(10, fit.breadthDelta * (Math.min(p.chains.length, 10) - 1)); v *= factors.breadth; }
  if (kin) { factors.kin = 0.5; v *= 0.5; }
  return { value: v, factors };
}
function impliedValue(fit, p, kin) { return priceWith(fit, p, kin); }

// ---- launch odds
const AGE_EDGES = [180, 365, 730, 1095, 1825];
const TVL_EDGES = [10000000, 50000000, 200000000, 1000000000];
function ageBucket(age) {
  if (age === null) return -1;
  let b = 0;
  while (b < AGE_EDGES.length && age >= AGE_EDGES[b]) b++;
  return b;
}
function tvlBand(tvl) {
  let b = 0;
  while (b < TVL_EDGES.length && tvl >= TVL_EDGES[b]) b++;
  return b;
}
function fitOdds(protos) {
  const cell = new Map(), byAge = new Map(), byBand = new Map();
  let tok = 0;
  const bump = (m, k, t) => { const e = m.get(k) || { n: 0, tok: 0 }; e.n++; if (t) e.tok++; m.set(k, e); };
  for (const p of protos) {
    if (p.tokened) tok++;
    bump(cell, ageBucket(p.age) + '|' + tvlBand(p.tvl_usd), p.tokened);
    bump(byAge, ageBucket(p.age), p.tokened);
    bump(byBand, tvlBand(p.tvl_usd), p.tokened);
  }
  const share = (e) => (e !== undefined && e.n >= 20 ? (e.tok + 1) / (e.n + 2) : null);
  const global = (tok + 1) / (protos.length + 2);
  return {
    oddsFor: (p) => {
      const c = share(cell.get(ageBucket(p.age) + '|' + tvlBand(p.tvl_usd)));
      if (c !== null) return c;
      const a2 = share(byAge.get(ageBucket(p.age)));
      if (a2 !== null) return a2;
      const b2 = share(byBand.get(tvlBand(p.tvl_usd)));
      if (b2 !== null) return b2;
      return global;
    },
    baseRate: global,
  };
}
// ---- bands
function bandMultipliers(tvl, comps, looResid) {
  const lt = Math.log10(Math.max(tvl, 1));
  let w = 0.5, near = [];
  for (;;) {
    near = comps.map((c, i) => ({ d: Math.abs(Math.log10(c.tvl_usd) - lt), r: looResid[i] })).filter((x) => x.d <= w).map((x) => x.r);
    if (near.length >= 25 || w >= 1.5) break;
    w += 0.25;
  }
  if (near.length < 5) near = looResid;
  return {
    p10: Math.pow(10, quantile(near, 0.1)), p25: Math.pow(10, quantile(near, 0.25)),
    p75: Math.pow(10, quantile(near, 0.75)), p90: Math.pow(10, quantile(near, 0.9)),
  };
}

// ---- farm plans
const CHAIN_FEE = {
  Ethereum: 6.0, Solana: 0.1, Base: 0.35, Arbitrum: 0.45, Optimism: 0.4, Polygon: 0.15,
  BSC: 0.3, Avalanche: 0.5, 'Hyperliquid L1': 0.2, Ink: 0.35, Linea: 0.4, Scroll: 0.4,
};
const DEFAULT_CHAIN_FEE = 1.5;
const TICKET_LADDER = [250, 500, 1000, 2500, 5000, 10000, 25000];

function holdWeeks(age) {
  if (age === null || age < 180) return 12;
  if (age < 365) return 10;
  return 8;
}
function fmtMoney(n) { return '$' + Math.round(n).toLocaleString('en-US'); }
function actionFor(p, ticket, chain) {
  const c = (p.category || '').toLowerCase(), n = p.name, t = fmtMoney(ticket);
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return 'Supply ' + t + ' of USDC to ' + n + ' on ' + chain + ' and keep the position open; do not borrow against it in week one.';
  if (c.includes('dex')) return 'Provide ' + t + " of liquidity to " + n + "'s main USDC pool on " + chain + ' and keep the LP position open.';
  if (c.includes('yield') || c.includes('curator') || c.includes('allocator')) return 'Deposit ' + t + ' of USDC into a ' + n + ' vault on ' + chain + ' and keep the vault shares in the same wallet.';
  if (c.includes('staking') || c.includes('restak')) return 'Stake ' + t + " of the chain's staking asset through " + n + ' on ' + chain + ' and keep the receipt token.';
  if (c.includes('perpetual') || c.includes('derivative')) return 'Deposit ' + t + ' of USDC as margin on ' + n + ' and open one small hedged position, then leave it untouched.';
  if (c.includes('rwa') || c.includes('stable')) return 'Mint or deposit ' + t + " of the protocol's yield asset through " + n + ' on ' + chain + ' and hold it.';
  if (c.includes('prediction')) return 'Fund ' + t + ' on ' + n + ' and place one position in a liquid market; do not chase losses.';
  if (c.includes('insurance')) return 'Buy ' + t + ' of cover from ' + n + ' on ' + chain + ' and keep the policy for the full term.';
  return 'Deposit ' + t + ' of USDC into ' + n + ' on ' + chain + ' and keep the position open.';
}
function farmPlan(p, ticket) {
  const chain = p.chains.length > 0 ? p.chains[0] : 'its main chain';
  const fee = CHAIN_FEE[chain] !== undefined ? CHAIN_FEE[chain] : DEFAULT_CHAIN_FEE;
  const weeks = holdWeeks(p.age);
  const chgTxt = p.change_7d === null ? 'not reported' : (p.change_7d > 0 ? '+' : '') + p.change_7d.toFixed(1) + '%';
  const steps = [
    { label: 'Day 1', text: 'Fund a fresh wallet on ' + chain + ' with ' + fmtMoney(ticket) + ' of USDC plus a little spare for gas; keep the seed phrase offline and use this wallet for nothing else.', fee, min: 25 },
    { label: 'Day 1', text: actionFor(p, ticket, chain), fee, min: 20 },
    { label: 'Weeks 2-' + weeks, text: 'Repeat one qualifying action a week — a top-up of about ' + fmtMoney(Math.max(25, Math.round(ticket / 10))) + ', a swap or a vote — on a different weekday each time; steady wallets outrank one-day bursts.', fee: fee * (weeks - 1), min: 10 * (weeks - 1) },
    { label: 'Monthly', text: 'Check the 7-day TVL change (' + chgTxt + ' now): if it falls under -20%, withdraw half the same day and write the reason in the farm log.', fee: 0, min: 15 * Math.ceil(weeks / 4) },
    { label: 'Week ' + weeks, text: 'Log every transaction hash, then watch only ' + p.name + "'s own site and docs for a points or claim page; never pay or sign a 'claim fee' — a real claim costs nothing.", fee: 0, min: 15 },
    { label: 'Week ' + weeks, text: 'If nothing is announced by the end of week ' + weeks + ', withdraw the whole position in one transaction and record the final balance in the farm log.', fee, min: 15 },
  ];
  return { steps, weeks, fees: steps.reduce((s, x) => s + x.fee, 0), minutes: steps.reduce((s, x) => s + x.min, 0) };
}
function farmEconomics(valueIf, odds, tvl, plan, ticket, share, tbill) {
  const sliceAt = (t) => share * valueIf * (t / (tvl + t));
  const costsAt = (t) => plan.fees + t * tbill * (plan.weeks / 52);
  const slice = sliceAt(ticket), costs = costsAt(ticket);
  const breakeven = slice > 0 ? costs / slice : Infinity;
  const verdict = breakeven <= 0.1 ? 'FARM' : breakeven <= 0.33 ? 'THIN' : 'SKIP';
  let paysFrom = null;
  for (const t of TICKET_LADDER) if (sliceAt(t) >= costsAt(t)) { paysFrom = t; break; }
  const expNet = odds * slice - costs;
  return { slice, costs, net_launch: slice - costs, exp_net: expNet, breakeven, verdict, net_hour: expNet / (plan.minutes / 60), pays_from: paysFrom };
}

// ---- the board, rebuilt
function protoFrom(raw, asOf) {
  return {
    slug: raw[0], name: raw[1], category: raw[2], chains: raw[3], tvl_usd: raw[4],
    change_7d: raw[5], mcap_usd: raw[6], listed_at: raw[7], tokened: raw[8] === 1, symbol: raw[9],
    age: ageDays(asOf, raw[7]),
  };
}
function buildBoard(rawProtocols, watchlist, asOf, keptTerms) {
  const protos = rawProtocols.map((r) => protoFrom(r, asOf));
  const tokenedStems = new Set(protos.filter((p) => p.tokened).map((p) => nameStem(p.name)));
  const tokenedSymbols = new Set(protos.filter((p) => p.tokened && p.symbol !== null && p.symbol !== undefined).map((p) => String(p.symbol).toLowerCase()));
  const candidates = protos.filter((p) => !p.tokened && exclusionReason(p) === null);
  const comps = pickComps(protos);
  const fit = fitPipeline(comps, keptTerms);
  const oddsModel = fitOdds(protos);
  const looResid = comps.map((c, i) => {
    const rest = comps.filter((_, j) => j !== i);
    return Math.log10(c.mcap_usd) - Math.log10(priceWith(fitPipeline(rest, keptTerms), c, false).value);
  });
  const priced = candidates.map((p) => {
    const kin = isKin(p, tokenedStems, tokenedSymbols);
    const { value, factors } = impliedValue(fit, p, kin);
    const o = oddsModel.oddsFor(p);
    const plan = farmPlan(p, 1000);
    const econ = farmEconomics(value, o, p.tvl_usd, plan, 1000, 0.1, 0.04);
    const band = bandMultipliers(p.tvl_usd, comps, looResid);
    return { p, kin, value, factors, odds: o, plan, econ, band, expected: value * o };
  });
  priced.sort((x, y) => y.expected - x.expected || (x.p.slug < y.p.slug ? -1 : 1));
  const rng = mulberry32(20261114);
  const samples = new Map(priced.map((r) => [r.p.slug, []]));
  for (let iter = 0; iter < 200; iter++) {
    const sample = Array.from({ length: comps.length }, () => comps[Math.floor(rng() * comps.length)]);
    const rfit = fitPipeline(sample, keptTerms);
    const rr = priced.map((r) => ({ slug: r.p.slug, ev: Math.round(priceWith(rfit, r.p, r.kin).value * r.odds) }));
    rr.sort((x, y) => y.ev - x.ev || (x.slug < y.slug ? -1 : 1));
    rr.forEach((r, i) => samples.get(r.slug).push(i + 1));
  }
  const rows = priced.map((r, i) => {
    const s = samples.get(r.p.slug);
    const ev = Math.max(1, Math.round(r.expected));
    return {
      rank: i + 1, slug: r.p.slug, expected: ev, value_if: Math.round(r.value), odds: round4(r.odds),
      band: { p10: Math.round(ev * r.band.p10), p25: Math.round(ev * r.band.p25), p75: Math.round(ev * r.band.p75), p90: Math.round(ev * r.band.p90) },
      rank_lo: Math.floor(quantile(s, 0.1)), rank_hi: Math.ceil(quantile(s, 0.9)),
      verdict: r.econ.verdict, breakeven: round4(r.econ.breakeven),
    };
  });
  return { rows, fit, comps: comps.length };
}

// checkBoard(): re-run the model on the page's own data and compare row by row with
// board.json's rows — values and verdicts exact, rank ranges within one place.
function checkBoard(R) {
  const t0 = performance.now();
  const mine = buildBoard(R.protocols, R.watchlist, R.as_of, R.kept_terms);
  let match = 0, refitAgree = 0;
  const n = Math.min(mine.rows.length, R.rows.length);
  for (let i = 0; i < n; i++) {
    const a = mine.rows[i], b = R.rows[i];
    if (a.slug === b.slug && a.expected === b.expected && a.value_if === b.value_if && a.odds === b.odds &&
      a.band.p25 === b.band.p25 && a.band.p75 === b.band.p75 && a.verdict === b.econ.verdict && a.breakeven === b.econ.breakeven) match++;
    if (Math.abs(a.rank_lo - b.rank_lo) <= 1 && Math.abs(a.rank_hi - b.rank_hi) <= 1) refitAgree++;
  }
  return { match, total: R.rows.length, refitAgree, ms: Math.round(performance.now() - t0) };
}

window.RadarModel = { TERM_ORDER, farmPlan, farmEconomics, checkBoard };
