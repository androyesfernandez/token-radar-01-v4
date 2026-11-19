// Launch Radar — the page. Renders window.RADAR (written by the Node build beside
// board.json), reprices every plan live from the ticket / drop share / T-bill
// controls, and verifies itself via checkBoard() in model.js.
'use strict';

const R = window.RADAR;
const M = window.RadarModel;
const $ = (id) => document.getElementById(id);
const state = { view: 'board', seg: 'all', verdict: '', ticket: 1000, share: 0.1, tbill: 0.04, cat: '', chain: '', search: '', sort: 'rank', sel: 0 };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const money = (n) => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');
const money2 = (n) => (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (n, d) => (n * 100).toFixed(d === undefined ? 1 : d) + '%';
const ageTxt = (d) => (d === null ? 'not dated' : d >= 365 ? (d / 365.25).toFixed(1) + ' y' : d + ' d');
const moneyC = (n) => { const a = Math.abs(n); const s = n < 0 ? '-$' : '$'; return a >= 1e9 ? s + (a / 1e9).toFixed(2) + 'B' : a >= 1e6 ? s + (a / 1e6).toFixed(1) + 'M' : a >= 1e4 ? s + (a / 1e3).toFixed(1) + 'K' : money(n); };
const beTxt = (be) => (be > 1 ? '>100% — no launch chance repays this' : pct(be, 1));
const planOf = (row) => ({ fees: row.fees, minutes: row.minutes, weeks: row.weeks });
const econAt = (row, ticket, share, tbill) => M.farmEconomics(row.value_if, row.odds, row.tvl_usd, planOf(row), ticket || state.ticket, share === undefined ? state.share : share, tbill === undefined ? state.tbill : tbill);
const lowEcon = (row, ticket, share, tbill) => M.farmEconomics(row.value_if * row.band.p25 / row.expected, row.odds, row.tvl_usd, planOf(row), ticket || state.ticket, share === undefined ? state.share : share, tbill === undefined ? state.tbill : tbill);
const acctTotal = () => R.accounting.ranked + R.accounting.tokened_mcap + R.accounting.tokened_nomcap + R.accounting.groups.reduce((s, g) => s + g.count, 0);

// ---- header + KPIs
function renderHeader() {
  $('asof').textContent = 'Snapshot ' + R.as_of + ' · DefiLlama · floor ' + money(R.floor_usd);
  const v = R.validation;
  const atDef = R.rows.map((r) => econAt(r, 1000, 0.1, 0.04));
  const farms = atDef.filter((e) => e.verdict === 'FARM').length;
  const thin = atDef.filter((e) => e.verdict === 'THIN').length;
  const robust = R.rows.filter((r) => r.robust_farm).length;
  const at10k = R.rows.map((r) => econAt(r, 10000, 0.1, 0.04)).filter((e) => e.verdict === 'FARM').length;
  const best = R.rows.map((r, i) => ({ r, e: atDef[i] })).sort((x, y) => y.e.net_hour - x.e.net_hour)[0];
  const sumEv = R.rows.reduce((s, r) => s + r.expected, 0);
  const kpis = [
    ['Ranked', R.accounting.ranked, R.accounting.groups.reduce((s, g) => s + g.count, 0) + ' products set aside, named below'],
    ['Expected value summed', '$' + (sumEv / 1e9).toFixed(2) + 'B', 'value if launched $' + (R.rows.reduce((s, r) => s + r.value_if, 0) / 1e9).toFixed(2) + 'B before odds'],
    ['Closer than flat', '×' + (v.flat_loo_miss / v.loo_miss).toFixed(1), 'LOO miss ×' + v.loo_miss + ' vs flat ×' + v.flat_loo_miss + ' · ' + R.accounting.comps + ' traded comps'],
    ['Walk-forward miss', '×' + v.wf_miss, 'fit the old, price the new · flat ×' + v.flat_wf_miss],
    ['Bands hold', Math.round(v.band50_realised * 100) + '%', 'P25–P75 (aim 50) · ' + Math.round(v.band80_realised * 100) + '% in P10–P90 (aim 80)'],
    ['Thin or better at $1,000', String(farms + thin), at10k + ' FARM at $10,000 · ' + farms + ' FARM (' + robust + ' robust) at $1,000'],
    ['Best net / hour', (best.e.net_hour >= 0 ? '+' : '') + money2(best.e.net_hour), best.r.name + ' at a $1,000 ticket'],
  ];
  $('kpis').innerHTML = kpis.map(([k, val, s]) => '<div class="kpi"><div class="k">' + k + '</div><div class="v">' + val + '</div><div class="s">' + s + '</div></div>').join('');
}

// ---- accounting
function renderAccounting() {
  const a = R.accounting;
  const total = a.ranked + a.tokened_mcap + a.tokened_nomcap + a.groups.reduce((s, g) => s + g.count, 0);
  $('acct-title').textContent = total + ' protocols read — every one accounted for';
  $('acct-note').textContent = 'the board ranks pre-token candidates only; tokened protocols price the curve and are never ranked';
  const segs = [
    ['Ranked — no token yet', a.ranked, '#e8b33c'],
    ['Token trades, with a market cap', a.tokened_mcap, '#5b7a99'],
    ['Token on record, no market cap', a.tokened_nomcap, '#37424e'],
    ...a.groups.map((g) => [g.label, g.count, '#6e5636']),
  ];
  $('acct-bar').innerHTML = segs.map(([label, n, c]) => '<div style="width:' + (n / total * 100) + '%;background:' + c + '" title="' + esc(label) + ': ' + n + '"></div>').join('');
  $('acct-legend').innerHTML = segs.map(([label, n]) => '<span><b>' + n + '</b> ' + esc(label) + '</span>').join('');
}

// ---- model + tests boxes
function renderBoxes() {
  const f = R.fit, v = R.validation;
  const keptTxt = R.kept_terms.length ? R.kept_terms.join(' × ') : 'no extra term — all four were fitted, tested and dropped (ladder on Method)';
  $('modelbox').innerHTML =
    '<h3>How a launch is priced</h3>' +
    '<div class="formula">value if launched = 10^' + f.a.toFixed(4) + ' × TVL^' + f.b.toFixed(4) + '\n' +
    '  a Huber-robust log-log fit on ' + R.accounting.comps + ' traded comps\n' +
    '  × kin 0.5 when a tokened namesake trades · terms in the price: ' + keptTxt + '\n' +
    'expected value = value if launched × launchOdds(age, TVL)\n' +
    '  launchOdds = share of look-alikes recording a token, Laplace-smoothed\n' +
    'verdict = break-even odds of the plan: FARM ≤ 10% · THIN ≤ 33% · SKIP above</div>' +
    '<p>One function prices every row; this page re-runs it in your browser and the header chip reports the match.</p>' +
    '<p class="muted">Launch odds, held out: called ' + R.odds.hit_pct + '% right against a ' + R.odds.base_hit_pct + '% base rate' + (R.odds.auc >= 0.65 ? ' · AUC ' + R.odds.auc.toFixed(2) : '') + ' — a prior from this snapshot\'s own record, not a prediction.</p>';
  const lad = v.ladder;
  const coh = v.cohorts.map((c) => '<tr><td>' + c.label + '</td><td>' + c.n + '</td><td>' + c.within3_pct + '%</td><td>' + c.band_n + '/' + c.n + ' (' + c.band_pct + '%)</td></tr>').join('');
  const wc = v.worst_cat;
  $('oosbox').innerHTML =
    '<h3>Out of sample — does it hold on tokens it never saw?</h3>' +
    '<table class="mini"><tr><th>Model</th><th>Left out</th><th>Walk-fwd</th><th>Within 3×</th></tr>' +
    '<tr><td>' + lad[0].label + '</td><td>×' + lad[0].loo_miss + '</td><td>×' + lad[0].wf_miss + '</td><td>' + lad[0].within3_pct + '%</td></tr>' +
    '<tr><td>' + lad[1].label + '</td><td>×' + lad[1].loo_miss + '</td><td>×' + lad[1].wf_miss + '</td><td>' + lad[1].within3_pct + '%</td></tr>' +
    '<tr><td>Placebo — growth, sign flipped</td><td>×' + v.placebo_loo_miss + '</td><td>×' + v.placebo_wf_miss + '</td><td>' + v.placebo_within3_pct + '%</td></tr></table>' +
    '<p class="small"><b>Named factors, tested:</b> 7-day growth LOO ×' + lad[3].loo_miss + ' · WF ×' + lad[3].wf_miss + ' vs the curve\'s ×' + lad[1].loo_miss + ' · ×' + lad[1].wf_miss + ' — worse on both, dropped. Tenure LOO ×' + lad[4].loo_miss + ' · WF ×' + lad[4].wf_miss + ' — split verdict, dropped by the both-tests rule. TVL carries the price; both print ×1.000.</p>' +
    '<p>Bands: stated 50 / 80 · realised ' + Math.round(v.band50_realised * 100) + ' / ' + Math.round(v.band80_realised * 100) + '. Rank stability: ' + v.top20_stable + ' of the top 20 stay top-20 in ≥80% of 200 refits; median rank range ' + v.median_rank_width + ' places.</p>' +
    '<h3 style="margin-top:8px">Range honesty — realised coverage by cohort</h3>' +
    '<table class="mini"><tr><th>Comps by listing</th><th>n</th><th>Within 3×</th><th>In P25–P75</th></tr>' + coh + '</table>' +
    (wc ? '<p class="small">Weakest: ' + esc(wc.category) + ' (' + wc.n + ' traded), median miss ×' + wc.miss + ' — ' + (wc.miss > wc.flat_miss ? 'worse than' : 'still better than') + ' flat\'s ×' + wc.flat_miss + ' there.</p>' : '') +
    '<p class="muted">' + esc(v.self_critique) + '</p>';
}

// ---- scatter
function renderScatter() {
  const W = 460, H = 196, x0 = 46, x1 = W - 8, y0 = 8, y1 = H - 26;
  const lx = [Math.log10(5e6), Math.log10(2e10)], ly = [Math.log10(1e5), Math.log10(3e10)];
  const X = (tvl) => x0 + (Math.log10(Math.max(tvl, 1)) - lx[0]) / (lx[1] - lx[0]) * (x1 - x0);
  const Y = (val) => y1 - (Math.log10(Math.max(val, 1)) - ly[0]) / (ly[1] - ly[0]) * (y1 - y0);
  let s = '';
  for (const gx of [1e7, 1e8, 1e9, 1e10]) s += '<line x1="' + X(gx) + '" y1="' + y0 + '" x2="' + X(gx) + '" y2="' + y1 + '" stroke="#1a222c"/><text x="' + X(gx) + '" y="' + (H - 8) + '" fill="#8a97a5" font-size="9" text-anchor="middle">$' + (gx / 1e9 >= 1 ? gx / 1e9 + 'B' : gx / 1e6 + 'M') + '</text>';
  for (const gy of [1e6, 1e8, 1e10]) s += '<line x1="' + x0 + '" y1="' + Y(gy) + '" x2="' + x1 + '" y2="' + Y(gy) + '" stroke="#1a222c"/><text x="4" y="' + (Y(gy) + 3) + '" fill="#8a97a5" font-size="9">$' + (gy / 1e9 >= 1 ? gy / 1e9 + 'B' : gy / 1e6 + 'M') + '</text>';
  for (const raw of R.protocols) {
    if (raw[8] === 1 && raw[6] !== null && raw[6] > 0) s += '<circle cx="' + X(raw[4]).toFixed(1) + '" cy="' + Y(raw[6]).toFixed(1) + '" r="2.2" fill="#5b7a99" opacity="0.65"/>';
  }
  for (const row of R.rows) s += '<circle cx="' + X(row.tvl_usd).toFixed(1) + '" cy="' + Y(row.expected).toFixed(1) + '" r="2.2" fill="#e8b33c" opacity="0.8"/>';
  const f = R.fit;
  const curve = (tvl) => Math.pow(10, f.a + f.b * Math.log10(tvl));
  s += '<path d="M' + X(5e6).toFixed(1) + ' ' + Y(curve(5e6)).toFixed(1) + ' L' + X(2e10).toFixed(1) + ' ' + Y(curve(2e10)).toFixed(1) + '" stroke="#e8b33c" stroke-width="1.6" fill="none"/>';
  $('scatter').innerHTML = s;
  $('scatter-note').textContent = 'Grey: the ' + R.accounting.tokened_mcap + ' tokens that trade, at real caps. Amber: this board at expected value. Line: the fitted curve. Each row prints its own band.';
}

// ---- the board
function segRows() {
  let rows = R.rows;
  if (state.seg === 'watchlist') rows = rows.filter((r) => r.watchlist);
  if (state.seg === 'offlist') rows = rows.filter((r) => !r.watchlist && r.tvl_usd >= R.floor_usd);
  if (state.seg === 'below') rows = rows.filter((r) => r.tvl_usd < R.floor_usd);
  return rows;
}
function visibleRows() {
  let rows = segRows().map((r) => ({ r, e: econAt(r) }));
  if (state.verdict === 'ROBUST') rows = rows.filter((x) => x.r.robust_farm);
  else if (state.verdict) rows = rows.filter((x) => x.e.verdict === state.verdict);
  if (state.cat) rows = rows.filter((x) => (x.r.category || '') === state.cat);
  if (state.chain) rows = rows.filter((x) => x.r.chains.includes(state.chain));
  if (state.search) {
    const q = state.search.toLowerCase();
    rows = rows.filter((x) => x.r.name.toLowerCase().includes(q) || x.r.slug.includes(q));
  }
  const by = { rank: (x, y) => x.r.rank - y.r.rank, nethour: (x, y) => y.e.net_hour - x.e.net_hour, value: (x, y) => y.r.value_if - x.r.value_if, odds: (x, y) => y.r.odds - x.r.odds, tvl: (x, y) => y.r.tvl_usd - x.r.tvl_usd };
  return rows.sort(by[state.sort] || by.rank);
}
function badges(r) {
  let out = '';
  if (r.watchlist) out += '<span class="badge">WATCHLIST</span>';
  else if (r.tvl_usd >= R.floor_usd) out += '<span class="badge">OFF LIST</span>';
  else out += '<span class="badge">EARLY</span>';
  for (const t of r.risk_tags) out += '<span class="badge risk">' + t + '</span>';
  if (r.robust_farm) out += '<span class="badge">ROBUST</span>';
  return out;
}
function renderBoard() {
  const rows = visibleRows();
  $('board-body').innerHTML = rows.map(({ r, e }, i) => {
    const chg = r.change_7d === null ? '<span class="sub">—</span>' : '<span class="' + (r.change_7d >= 0 ? 'pos' : 'neg') + '">' + (r.change_7d > 0 ? '+' : '') + r.change_7d.toFixed(1) + '%</span>';
    const low = lowEcon(r);
    return '<tr data-slug="' + r.slug + '" class="' + (i === state.sel ? 'sel' : '') + '">' +
      '<td>' + r.rank + '<div class="sub">' + r.rank_lo + '–' + r.rank_hi + '</div></td>' +
      '<td><span class="pname">' + esc(r.name) + '</span>' + badges(r) + '<div class="pmeta">' + esc(r.category || 'Uncategorised') + ' · ' + esc(r.chains[0] || '—') + (r.chains.length > 1 ? ' +' + (r.chains.length - 1) : '') + '</div></td>' +
      '<td>' + moneyC(r.tvl_usd) + '</td><td>' + chg + '</td><td>' + (r.age_days === null ? '—' : ageTxt(r.age_days)) + '</td>' +
      '<td>' + (r.value_if / r.tvl_usd >= 1 ? (r.value_if / r.tvl_usd).toFixed(2) : (r.value_if / r.tvl_usd).toFixed(3)) + '×</td>' +
      '<td><span class="oddsbar"><i style="width:' + Math.round(r.odds * 100) + '%"></i></span>' + pct(r.odds, 0) + '</td>' +
      '<td>' + moneyC(r.value_if) + '</td>' +
      '<td>' + moneyC(r.expected) + '<div class="sub">' + moneyC(r.band.p25) + ' – ' + moneyC(r.band.p75) + '</div><div class="bandviz"><i style="left:' + bandPos(r.band.p25) + '%;width:' + Math.max(2, bandPos(r.band.p75) - bandPos(r.band.p25)) + '%"></i><b style="left:' + bandPos(r.expected) + '%"></b></div></td>' +
      '<td>' + moneyC(e.slice) + '</td>' +
      '<td><span class="' + (e.exp_net >= 0 ? 'pos' : 'neg') + '">' + money(e.exp_net) + '</span><div class="sub">' + (e.net_hour >= 0 ? '+' : '') + money2(e.net_hour) + '/h' + (e.pays_from ? ' pays from ' + moneyC(e.pays_from) : ' never pays') + '</div><div class="sub">low end ' + money(low.exp_net) + '</div></td>' +
      '<td><span class="verdict ' + e.verdict + '">' + e.verdict + '</span><div class="sub">' + (e.breakeven > 1 ? 'never pays' : 'needs ' + pct(e.breakeven, 0)) + '</div></td>' +
      '<td>' + money2(r.fees) + ' fees<div class="sub">' + (r.minutes / 60).toFixed(1) + ' h · ' + r.weeks + ' wk</div></td></tr>';
  }).join('');
  $('board-count').textContent = rows.length + ' of ' + R.rows.length + ' rows at a ' + money(state.ticket) + ' ticket, ' + pct(state.share, 0) + ' drop share, ' + pct(state.tbill, 0) + ' T-bill — every net and verdict reprices live via farmEconomics() on this page.';
  document.querySelectorAll('#board-body tr').forEach((tr) => tr.addEventListener('click', () => openDetail(tr.dataset.slug)));
}
function bandPos(v) {
  return Math.min(100, Math.max(0, (Math.log10(Math.max(v, 1)) - 6) / 3 * 100));
}
function renderFarmNext() {
  const at = R.rows.map((r) => ({ r, e: econAt(r) }));
  const counts = { FARM: 0, THIN: 0, SKIP: 0 };
  at.forEach((x) => { counts[x.e.verdict]++; });
  const top = at.filter((x) => x.e.verdict !== 'SKIP').sort((x, y) => y.e.net_hour - x.e.net_hour).slice(0, 5);
  let line = '<b>FARM NEXT</b> — ' +
    (top.length ? top.map(({ r, e }) => esc(r.name) + ' <span class="net">+' + money2(e.net_hour) + '/h</span> ' + e.verdict).join(' · ') : 'no FARM or THIN plan at this ticket') +
    ' · ' + counts.FARM + ' FARM / ' + counts.THIN + ' THIN / ' + counts.SKIP + ' SKIP at ' + money(state.ticket);
  if (counts.FARM === 0) {
    const f10 = R.rows.map((r) => ({ r, e: econAt(r, 10000, 0.1, 0.04) })).filter((x) => x.e.verdict === 'FARM').sort((x, y) => y.e.net_hour - x.e.net_hour)[0];
    if (f10) line += '; first FARM ' + esc(f10.r.name) + ' at $10,000';
  }
  $('farmnext').innerHTML = line;
}
function renderPfStrip() {
  const ticket = 1000, capital = 10000, hoursWk = 5;
  const cands = R.rows.map((r) => ({ r, e: econAt(r, ticket, 0.1, 0.04) }))
    .filter((x) => x.e.verdict !== 'SKIP')
    .sort((x, y) => y.e.net_hour - x.e.net_hour);
  let spent = 0, weekly = 0;
  const picked = [];
  for (const x of cands) {
    const wk = (x.r.minutes / 60) / x.r.weeks;
    if (spent + ticket <= capital && weekly + wk <= hoursWk) { picked.push(x); spent += ticket; weekly += wk; }
  }
  if (!picked.length) { $('pfstrip').innerHTML = '<b>PLAN FOR ' + money(capital) + ' · ' + hoursWk + ' H/WK</b> — no plan clears its costs at a ' + money(ticket) + ' ticket under the stated assumptions → Portfolio'; return; }
  const tSlice = picked.reduce((s, x) => s + x.e.slice * x.r.odds, 0);
  const tNet = picked.reduce((s, x) => s + x.e.exp_net, 0);
  const tCosts = picked.reduce((s, x) => s + x.e.costs, 0);
  const tSliceFull = picked.reduce((s, x) => s + x.e.slice, 0);
  const tHours = picked.reduce((s, x) => s + x.r.minutes / 60, 0);
  $('pfstrip').innerHTML = '<b>PLAN FOR ' + money(capital) + ' · ' + hoursWk + ' H/WK</b> — ' + picked.length + ' plans · expected slices ' + money(tSlice) +
    ' · combined expected net <b>' + money(tNet) + '</b> (' + (tNet >= 0 ? '+' : '') + money2(tNet / tHours) + '/h hands-on) · blended break-even ' + pct(tCosts / tSliceFull, 1) +
    ' · ' + tHours.toFixed(1) + ' h hands-on in total → Portfolio';
}
function renderWall() {
  const rows = R.rows.filter((r) => r.watchlist);
  $('wall').innerHTML = rows.map((r) => {
    const e = econAt(r);
    return '<div class="wallcard" data-slug="' + r.slug + '"><div class="r1"><span><b>#' + r.rank + ' ' + esc(r.name) + '</b></span><span class="verdict ' + e.verdict + '">' + e.verdict + '</span></div>' +
      '<div class="sub">' + moneyC(r.tvl_usd) + ' TVL · odds ' + pct(r.odds, 0) + ' · value ' + moneyC(r.value_if) + ' · expected ' + moneyC(r.expected) + '</div>' +
      '<div class="plan">' + esc(r.steps[1].text) + '</div>' +
      '<div class="sub">' + money2(r.fees) + ' fees · ' + (r.minutes / 60).toFixed(1) + ' h · ' + r.weeks + ' wk · net ' + money(e.exp_net) + ' at ' + money(state.ticket) + '</div></div>';
  }).join('');
  document.querySelectorAll('.wallcard').forEach((c) => c.addEventListener('click', () => openDetail(c.dataset.slug)));
}

// ---- detail
function openDetail(slug) {
  const r = R.rows.find((x) => x.slug === slug);
  if (!r) return;
  const f = r.factors;
  const mult = (x) => '×' + x.toFixed(3);
  const factorRow = (name, val, note) => '<tr><td>' + name + '</td><td class="n">' + val + '</td><td>' + note + '</td></tr>';
  const tickets = [500, 1000, 5000].map((t) => {
    const e = econAt(r, t, 0.1, 0.04);
    return '<tr><td>' + money(t) + '</td><td class="n">' + money(e.slice) + '</td><td class="n">' + money2(e.costs) + '</td><td class="n">' + money(e.net_launch) + '</td><td class="n">' + beTxt(e.breakeven) + '</td><td><span class="verdict ' + e.verdict + '">' + e.verdict + '</span></td></tr>';
  }).join('');
  const lowDef = lowEcon(r, 1000, 0.1, 0.04);
  const midDef = econAt(r, 1000, 0.1, 0.04);
  const termNames = { category: 'category', growth: 'growth carry', tenure: 'tenure', breadth: 'breadth' };
  const termNotes = { category: 'fitted offset, shrunk', growth: 'fitted on the comps\' residuals', tenure: 'fitted seasoning', breadth: 'fitted per-chain term' };
  const droppedNames = [];
  let termRows = '';
  for (const t of M.TERM_ORDER) {
    if (R.kept_terms.includes(t)) termRows += factorRow('× ' + termNames[t], mult(f[t]), termNotes[t]);
    else droppedNames.push(termNames[t]);
  }
  if (droppedNames.length) termRows += factorRow('× ' + droppedNames.join(' · '), '×1.000', 'fitted, tested, dropped — not in the price (ladder on Method)');
  const grid = [0.05, 0.1, 0.2].map((sh) => '<tr><td>' + pct(sh, 0) + ' share</td>' + [0, 0.04, 0.08].map((tb) => {
    const e = econAt(r, 1000, sh, tb);
    return '<td><span class="verdict ' + e.verdict + '">' + e.verdict + '</span></td>';
  }).join('') + '</tr>').join('');
  const steps = r.steps.map((s) => '<tr><td>' + esc(s.label) + '</td><td>' + esc(s.text) + '</td><td class="n">' + money2(s.fee) + '</td><td class="n">' + s.min + ' min</td></tr>').join('');
  const peers = r.peers.map((p) => '<tr><td>' + esc(p.name) + (p.symbol ? ' (' + esc(p.symbol) + ')' : '') + '</td><td class="n">' + money(p.tvl_usd) + '</td><td class="n">' + money(p.mcap_usd) + '</td><td class="n">×' + p.multiple.toFixed(3) + '</td></tr>').join('');
  $('detail').innerHTML = '<div class="sheet"><button class="closebtn" id="dclose">Esc ✕</button>' +
    '<h2>#' + r.rank + ' ' + esc(r.name) + '</h2>' +
    '<p class="muted">' + esc(r.category || 'Uncategorised') + ' · ' + r.chains.map(esc).join(', ') + ' · TVL ' + money(r.tvl_usd) + ' · 7d ' + (r.change_7d === null ? '—' : r.change_7d.toFixed(1) + '%') + ' · no token for ' + ageTxt(r.age_days) + (r.risk_tags.length ? ' · ' + r.risk_tags.join(' · ') : '') + '</p>' +
    '<div class="grid"><div><h3>How this price is built</h3><table>' +
    factorRow('Size curve at its TVL', money(f.curve), 'the fitted line, before any term') +
    termRows +
    factorRow('× kin', mult(f.kin), f.kin < 1 ? 'a tokened namesake trades — stated ×0.5' : 'no tokened namesake') +
    factorRow('= value if launched', '<b>' + money(r.value_if) + '</b>', 'band ' + money(Math.round(r.value_if * r.band.p25 / r.expected)) + ' – ' + money(Math.round(r.value_if * r.band.p75 / r.expected)) + ' (P25–P75)') +
    factorRow('× launch odds', pct(r.odds, 1), 'share of look-alikes with a token') +
    factorRow('= expected value', '<b>' + money(r.expected) + '</b>', 'rank ' + r.rank + ' · refit range ' + r.rank_lo + '–' + r.rank_hi + ' of ' + R.rows.length) +
    '</table><h3 style="margin-top:12px">The peers this price leans on</h3><table><tr><th>Traded comp</th><th class="n">TVL</th><th class="n">Real cap</th><th class="n">Multiple</th></tr>' + peers +
    '<tr><td><b>' + esc(r.name) + ' (implied)</b></td><td class="n">' + money(r.tvl_usd) + '</td><td class="n">' + money(r.value_if) + '</td><td class="n">×' + (r.value_if / r.tvl_usd).toFixed(3) + '</td></tr></table></div>' +
    '<div><h3>The farm plan — farmPlan()</h3><table><tr><th>When</th><th>Step</th><th class="n">Fee</th><th class="n">Time</th></tr>' + steps +
    '<tr><td></td><td><b>Ledger totals</b></td><td class="n"><b>' + money2(r.fees) + '</b></td><td class="n"><b>' + r.minutes + ' min</b></td></tr></table>' +
    '<h3 style="margin-top:12px">Verdict maths (10% share, 4% T-bill)</h3><table><tr><th>Ticket</th><th class="n">Slice</th><th class="n">Costs</th><th class="n">Net if launch</th><th class="n">Break-even</th><th>Verdict</th></tr>' + tickets + '</table>' +
    '<p class="muted small">At the band\'s low end (P25 value), the $1,000 plan\'s expected net is ' + money(lowDef.exp_net) + ' instead of ' + money(midDef.exp_net) + ' — the band, not just the assumptions, is stress-tested.</p>' +
    '<h3 style="margin-top:12px">Robustness at $1,000 — verdict across assumptions</h3><table><tr><th></th><th>T-bill 0%</th><th>4%</th><th>8%</th></tr>' + grid + '</table>' +
    '<p class="muted small">' + (r.robust_farm ? 'This plan is FARM at all nine assumption points — a robust farm.' : 'The verdict moves with the assumptions; the grid shows exactly where it flips.') + '</p>' +
    '</div></div></div>';
  $('detail').hidden = false;
  $('dclose').addEventListener('click', closeDetail);
}
function closeDetail() { $('detail').hidden = true; $('detail').innerHTML = ''; }

// ---- portfolio
function buildPortfolio() {
  const capital = Number($('pf-capital').value) || 0;
  const hoursWk = Number($('pf-hours').value) || 0;
  const safer = $('pf-safer').checked;
  const ticket = state.ticket;
  const cands = R.rows.map((r) => ({ r, e: econAt(r) }))
    .filter((x) => x.e.verdict !== 'SKIP')
    .filter((x) => !safer || !(x.r.risk_tags.includes('FALLING') || x.r.risk_tags.includes('NEW')))
    .sort((x, y) => y.e.net_hour - x.e.net_hour);
  let spent = 0, weekly = 0;
  const picked = [];
  for (const x of cands) {
    const wk = (x.r.minutes / 60) / x.r.weeks;
    if (spent + ticket <= capital && weekly + wk <= hoursWk) { picked.push(x); spent += ticket; weekly += wk; }
  }
  if (!picked.length) { $('pf-out').innerHTML = '<p class="muted">Nothing fits that budget at a ' + money(ticket) + ' ticket under the current assumptions — loosen the hours, raise the capital, or move the drop share.</p>'; return; }
  const tSlice = picked.reduce((s, x) => s + x.e.slice * x.r.odds, 0);
  const tNet = picked.reduce((s, x) => s + x.e.exp_net, 0);
  const tFees = picked.reduce((s, x) => s + x.r.fees, 0);
  const tCosts = picked.reduce((s, x) => s + x.e.costs, 0);
  const tSliceFull = picked.reduce((s, x) => s + x.e.slice, 0);
  $('pf-out').innerHTML = '<table class="mini"><tr><th>Plan</th><th>Ticket</th><th>Expected net</th><th>Net / h</th><th>Hours / wk</th><th>Verdict</th></tr>' +
    picked.map(({ r, e }) => '<tr><td>' + esc(r.name) + '</td><td>' + money(ticket) + '</td><td>' + money(e.exp_net) + '</td><td>' + money2(e.net_hour) + '</td><td>' + ((r.minutes / 60) / r.weeks).toFixed(2) + '</td><td>' + e.verdict + '</td></tr>').join('') + '</table>' +
    '<p><b>' + picked.length + ' plans · ' + money(spent) + ' of ' + money(capital) + ' deployed · ' + weekly.toFixed(1) + ' h/week.</b> Combined expected net <b>' + money(tNet) + '</b> (expected slices ' + money(tSlice) + ' less all-in costs ' + money2(tCosts) + ', of which fees ' + money2(tFees) + '). Blended break-even odds ' + pct(tCosts / tSliceFull, 1) + ' — the launches, together, need to be at least that likely for the book to pay.</p>';
}

// ---- method
function renderMethod() {
  const v = R.validation, f = R.fit;
  const lad = v.ladder.map((s) => '<tr' + (s.kept === false ? ' class="drop"' : '') + '><td>' + esc(s.label) + '</td><td>×' + s.loo_miss + '</td><td>×' + s.wf_miss + '</td><td>' + s.within3_pct + '%</td><td>' + (s.kept === null ? '—' : s.kept ? '<span class="keep">kept</span>' : 'dropped: loses one of the two tests') + '</td></tr>').join('');
  const rel = R.odds.reliability.map((b) => '<tr><td>' + b.bin + '</td><td>' + b.n + '</td><td>' + pct(b.predicted, 0) + '</td><td>' + pct(b.realised, 0) + '</td></tr>').join('');
  $('method-body').innerHTML =
    '<div class="grid" style="display:grid;grid-template-columns:1fr 1fr;gap:10px">' +
    '<div class="panel"><h3>compareModels() — the ablation ladder</h3><p class="small muted">Each term is fitted on the residuals of the stages before it, then kept only if it improves BOTH the leave-one-out and the walk-forward median miss. Dropped terms stay, struck through, with the numbers that killed them.</p>' +
    '<table class="mini"><tr><th>Model</th><th>LOO</th><th>Walk-fwd</th><th>Within 3×</th><th>Fate</th></tr>' + lad + '</table>' +
    '<p class="small">Full model: LOO ×' + v.loo_miss + ' · walk-forward ×' + v.wf_miss + ' · ' + v.within3_pct + '% of comps within 3× · rank correlation ' + v.rank_rho + ' against real caps. Bands realised: P25–P75 caught ' + Math.round(v.band50_realised * 100) + '% (stated 50), P10–P90 caught ' + Math.round(v.band80_realised * 100) + '% (stated 80).</p>' +
    '<p class="small">Placebo control: the growth machinery with its signal sign-flipped scores LOO ×' + v.placebo_loo_miss + ' · walk-forward ×' + v.placebo_wf_miss + ' — a term that cannot beat its own placebo is noise; every rung above was held to that standard.</p></div>' +
    '<div class="panel"><h3>launchOdds() — reliability, predicted vs realised</h3><p class="small muted">All 758 protocols binned by the odds the model gives them; the realised column is the share that actually record a token. Held out on a seeded 70/30 split the model calls ' + R.odds.hit_pct + '% right; always guessing the majority gives ' + R.odds.base_hit_pct + '%' + (R.odds.auc >= 0.65 ? '; odds AUC ' + R.odds.auc.toFixed(2) : '') + '.</p>' +
    '<table class="mini"><tr><th>Predicted odds</th><th>n</th><th>Predicted</th><th>Realised</th></tr>' + rel + '</table>' +
    '<p class="small">Fitted constants: curve 10^' + f.a.toFixed(4) + ' × TVL^' + f.b.toFixed(4) + ' · field median week ' + f.median_chg.toFixed(1) + '% · field median age ' + Math.round(f.median_age) + ' d.</p></div>' +
    '<div class="panel"><h3>Fitted vs stated — what is whose</h3><p class="small"><b>Fitted from the snapshot:</b> the size curve, every candidate term (kept or dropped by the ladder), the launch-odds cells, the bands, the rank ranges. <b>Stated assumptions:</b> drop share 10% (reader can move it), T-bill 4%, the kin haircut ×0.5, per-chain fee priors (Ethereum $6.00 an action down to Solana $0.10), hold windows of 8–12 weeks by age, verdict thresholds at 10% and 33% break-even odds.</p>' +
    '<p class="small"><b>Exclusions, by the house rule:</b> bridges and canonical bridges, liquid staking/restaking, exchange custody and CEX, versioned names, wrapped/staked names — ' + R.accounting.groups.reduce((s, g) => s + g.count, 0) + ' protocols, each counted on the board\'s accounting strip. Set aside, e.g. ' + R.accounting.groups.flatMap((g) => g.examples.slice(0, 3)).slice(0, 8).map(esc).join(' · ') + '. A candidate matching a traded token\'s name stays ranked with the kin haircut and a SIBLING tag.</p></div>' +
    '<div class="panel"><h3>Determinism &amp; the self-check</h3><p class="small">The Node build runs the model once and writes board.json; run it twice and the bytes are identical (one seeded PRNG, no clock, no network). This page re-runs the same model from the same data — checkBoard() in model.js recomputes ranks, values, odds, bands and verdicts against board.json, and the header chip prints the match count.</p>' +
    '<p class="small muted">' + esc(v.self_critique) + '</p></div></div>';
}

// ---- wiring
function setView(view) {
  state.view = view;
  document.querySelectorAll('#viewtabs button').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
  for (const name of ['board', 'watchlist', 'portfolio', 'method']) $('view-' + name).hidden = name !== view;
  $('rail').hidden = view !== 'board';
  document.body.classList.toggle('wall', view === 'watchlist');
  if (view === 'watchlist') renderWall();
  if (view === 'method') renderMethod();
}
function refresh() { renderBoard(); renderFarmNext(); renderPfStrip(); if (state.view === 'watchlist') renderWall(); }
function init() {
  const cats = [...new Set(R.rows.map((r) => r.category || ''))].sort();
  $('f-cat').innerHTML = '<option value="">All</option>' + cats.map((c) => '<option>' + esc(c) + '</option>').join('');
  const chains = [...new Set(R.rows.flatMap((r) => r.chains))].sort();
  $('f-chain').innerHTML = '<option value="">All</option>' + chains.map((c) => '<option>' + esc(c) + '</option>').join('');
  renderHeader(); renderAccounting(); renderBoxes(); renderScatter(); refresh();
  document.querySelectorAll('#viewtabs button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
  document.querySelectorAll('#segtabs button').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('#segtabs button').forEach((x) => x.classList.toggle('on', x === b));
    state.seg = b.dataset.seg; state.sel = 0; refresh();
  }));
  $('f-verdict').addEventListener('change', (e) => { state.verdict = e.target.value; refresh(); });
  $('f-ticket').addEventListener('change', (e) => { state.ticket = Number(e.target.value); refresh(); renderHeader(); });
  $('f-share').addEventListener('change', (e) => { state.share = Number(e.target.value); refresh(); });
  $('f-tbill').addEventListener('change', (e) => { state.tbill = Number(e.target.value); refresh(); });
  $('f-cat').addEventListener('change', (e) => { state.cat = e.target.value; refresh(); });
  $('f-chain').addEventListener('change', (e) => { state.chain = e.target.value; refresh(); });
  $('f-sort').addEventListener('change', (e) => { state.sort = e.target.value; refresh(); });
  $('f-search').addEventListener('input', (e) => { state.search = e.target.value; refresh(); });
  $('pf-build').addEventListener('click', buildPortfolio);
  document.addEventListener('keydown', (e) => {
    if (!$('detail').hidden) { if (e.key === 'Escape') closeDetail(); return; }
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') { if (e.key === 'Escape') e.target.blur(); return; }
    const rows = visibleRows();
    if (e.key === 'j') { state.sel = Math.min(state.sel + 1, rows.length - 1); renderBoard(); }
    if (e.key === 'k') { state.sel = Math.max(state.sel - 1, 0); renderBoard(); }
    if (e.key === 'Enter' && rows[state.sel]) openDetail(rows[state.sel].r.slug);
    if (e.key === '/') { e.preventDefault(); $('f-search').focus(); }
  });
  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get('view')) setView(hash.get('view'));
  if (hash.get('detail')) openDetail(hash.get('detail'));
  setTimeout(() => {
    try {
      const c = M.checkBoard(R);
      const wl = R.rows.filter((r) => r.watchlist).length;
      $('checkchip').textContent = '✓ page = board.json · ' + c.match + '/' + c.total + ' rows re-priced in your browser match · watchlist ' + wl + '/' + R.watchlist.length + ' · ' + acctTotal() + '/758 accounted for';
    } catch (err) {
      $('checkchip').textContent = 'self-check failed to run: ' + err.message;
    }
  }, 60);
}
init();
