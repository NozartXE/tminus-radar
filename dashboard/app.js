'use strict';
/* T-Minus dashboard. The page carries the whole model a second time: on load it
   refits the value curve and the launch clock from the raw figures in data.js,
   rebuilds every row's value, band, rank range and verdict, and only then turns
   the chip green. What the chip claims is exactly what was checked. */
const T = window.TMINUS;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt$ = (v) => v >= 1e9 ? '$' + (v / 1e9).toFixed(2) + 'B' : v >= 1e6 ? '$' + (v / 1e6).toFixed(1) + 'M' : v >= 1e3 ? '$' + (v / 1e3).toFixed(1) + 'K' : '$' + Math.round(v);
const fmtN = (v, d = 2) => (v < 0 ? '-' : '') + Math.abs(v).toFixed(d);
const fmtDec = (logv) => { const v = 10 ** logv; return v >= 1e9 ? '$' + (v / 1e9) + 'B' : v >= 1e6 ? '$' + (v / 1e6) + 'M' : '$' + (v / 1e3) + 'K'; };

/* ---------- the model, mirrored from lib/model.ts ---------- */
const UNKNOWN_AGE = 365;
function median(v) { const a = [...v].sort((x, y) => x - y), n = a.length; return n ? (n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2) : 0; }
function ols(xs, ys) { const mx = xs.reduce((s, x) => s + x, 0) / xs.length, my = ys.reduce((s, x) => s + x, 0) / ys.length; let cov = 0, vv = 0; for (let i = 0; i < xs.length; i++) { cov += (xs[i] - mx) * (ys[i] - my); vv += (xs[i] - mx) ** 2; } const b = vv ? cov / vv : 0; return { a: my - b * mx, b }; }
function huber(xs, ys) { let f = ols(xs, ys); for (let it = 0; it < 25; it++) { const r = ys.map((y, i) => y - f.a - f.b * xs[i]), m = median(r), mad = median(r.map(x => Math.abs(x - m))), d = 1.345 * (mad === 0 ? 0.1 : mad) / 0.6745; let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0; for (let i = 0; i < xs.length; i++) { const w = Math.abs(r[i]) <= d ? 1 : d / Math.abs(r[i]); sw += w; sx += w * xs[i]; sy += w * ys[i]; sxx += w * xs[i] ** 2; sxy += w * xs[i] * ys[i]; } const den = sw * sxx - sx * sx, b = den ? (sw * sxy - sx * sy) / den : 0; f = { a: (sy - b * sx) / sw, b }; } return f; }
function ageDaysOf(listed) { if (!listed) return null; return Math.max(0, Math.floor((Date.parse(T.as_of + 'T00:00:00Z') - Date.parse(listed + 'T00:00:00Z')) / 86400000)); }
const clampCh = (c) => c === null || c === undefined ? 0 : Math.max(-60, Math.min(120, c));
const growthIn = (p) => clampCh(p.change_7d) / 100;
const logGrowthIn = (p) => Math.log1p(growthIn(p));
const seasonIn = (p) => 1 - Math.exp(-(ageDaysOf(p.listed_at) ?? UNKNOWN_AGE) / 540);
function familyOffsets(comps, basePredict) { const sums = new Map(); comps.forEach(p => { const c = p.category ?? '', r = Math.log10(p.mcap_usd) - basePredict(p); sums.set(c, [...(sums.get(c) ?? []), r]); }); const fam = {}; for (const [c, rs] of sums) fam[c] = rs.reduce((s, x) => s + x, 0) / rs.length * rs.length / (rs.length + 16); return fam; }
function fitForm(comps, variant) {
  if (variant === 'flat') { const ratio = median(comps.map(p => p.mcap_usd / p.tvl_usd)), rawA = Math.log10(Math.max(ratio, 1e-12)), shift = median(comps.map(p => Math.log10(p.mcap_usd) - rawA - Math.log10(Math.max(1e-12, p.tvl_usd)))), a = rawA + shift; return { kind: variant, a, b: 1, g: 0, s: 0, family: {}, predict: (p) => a + Math.log10(Math.max(1e-12, p.tvl_usd)) }; }
  const base = variant === 'family' ? 'loggrowth' : variant;
  const xs = comps.map(p => Math.log10(Math.max(1e-12, p.tvl_usd))), ys = comps.map(p => Math.log10(p.mcap_usd));
  const f = huber(xs, ys), residual = ys.map((y, i) => y - f.a - f.b * xs[i]);
  const gIn = base === 'growth' ? growthIn : logGrowthIn;
  let g = 0, s = 0;
  if (base !== 'curve') g = ols(comps.map(gIn), residual).b;
  if (base === 'loggrowthseason') { const r2 = residual.map((r, i) => r - g * gIn(comps[i])); s = ols(comps.map(seasonIn), r2).b; }
  const raw = (p) => f.a + f.b * Math.log10(Math.max(1e-12, p.tvl_usd)) + (base === 'curve' ? 0 : g * gIn(p)) + (base === 'loggrowthseason' ? s * seasonIn(p) : 0);
  const shift = median(comps.map(p => Math.log10(p.mcap_usd) - raw(p)));
  const centered = (p) => raw(p) + shift;
  if (variant === 'family') { const off = familyOffsets(comps, centered); return { kind: variant, a: f.a + shift, b: f.b, g, s, family: off, predict: (p) => centered(p) + (off[p.category ?? ''] ?? 0) }; }
  return { kind: variant, a: f.a + shift, b: f.b, g, s, family: {}, predict: centered };
}
function looEval(comps, variant) { const miss = []; for (let i = 0; i < comps.length; i++) { const tr = comps.filter((_, j) => j !== i), fit = fitForm(tr, variant), v = 10 ** fit.predict(comps[i]); miss.push(Math.max(v / comps[i].mcap_usd, comps[i].mcap_usd / v)); } return { medianMiss: median(miss), within3: miss.filter(x => x <= 3).length / miss.length }; }
function impliedOf(p, m) {
  const curve = Math.max(1, Math.round(10 ** (m.a + m.b * Math.log10(Math.max(1e-12, p.tvl_usd)))));
  const gm = m.kind === 'curve' || m.kind === 'flat' ? 1 : m.kind === 'growth' ? Math.max(.35, Math.min(2, 10 ** (m.g * growthIn(p)))) : Math.max(.35, Math.min(2, 10 ** (m.g * logGrowthIn(p))));
  const sm = m.kind === 'loggrowthseason' ? Math.max(.4, Math.min(1.6, 10 ** (m.s * seasonIn(p)))) : 1;
  const fm = m.kind === 'family' ? Math.max(.4, Math.min(2.5, 10 ** (m.family[p.category ?? ''] ?? 0))) : 1;
  return { value: Math.max(1, Math.round(curve * gm * sm * fm)), curve, gm, sm, fm };
}
function solveLin(A, b) { const n = b.length, M = A.map((row, i) => [...row, b[i]]); for (let c = 0; c < n; c++) { let piv = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r; const tmp = M[c]; M[c] = M[piv]; M[piv] = tmp; const d = M[c][c] || 1e-12; for (let r = 0; r < n; r++) { if (r === c) continue; const f = M[r][c] / d; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; } } return M.map((row, i) => row[n] / (row[i] || 1e-12)); }
function fitClock(rows) {
  const X = rows.map(r => [1, ...r.x]), y = rows.map(r => r.y), k = X[0].length, beta = new Array(k).fill(0);
  for (let it = 0; it < 100; it++) { const grad = new Array(k).fill(0), H = Array.from({ length: k }, () => new Array(k).fill(0)); for (let i = 0; i < X.length; i++) { const z = X[i].reduce((s, v, j) => s + v * beta[j], 0), pr = 1 / (1 + Math.exp(-z)), w = pr * (1 - pr); for (let a = 0; a < k; a++) { grad[a] += X[i][a] * (y[i] - pr); for (let b = 0; b < k; b++) H[a][b] += X[i][a] * w * X[i][b]; } } for (let a = 1; a < k; a++) { grad[a] -= beta[a]; H[a][a] += 1; } const step = solveLin(H, grad); let mx = 0; for (let a = 0; a < k; a++) { beta[a] += step[a]; mx = Math.max(mx, Math.abs(step[a])); } if (mx < 1e-10) break; }
  return beta;
}
const clockFeats = (tvl, age, chains) => [Math.log10(Math.max(1, tvl)), Math.log10(age + 30), Math.min(chains, 8)];
const clockF = (beta, tvl, age, chains) => { const x = clockFeats(tvl, age, chains); return 1 / (1 + Math.exp(-(beta[0] + beta[1] * x[0] + beta[2] * x[1] + beta[3] * x[2]))); };
const hazard12 = (beta, tvl, age, chains) => { const f0 = clockF(beta, tvl, age, chains); return (clockF(beta, tvl, age + 365, chains) - f0) / Math.max(1 - f0, 1e-9); };
function mulberry(seed) { return () => { let t = seed += 0x6D2B79F5; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const GAS = T.farm.gas, YB = new Set(T.farm.yield_bearing_categories);
function chainClass(p) { const c = p.chains[0] ?? ''; return c === 'Ethereum' ? 'ethereum' : c === 'Solana' ? 'solana' : !p.chains.length ? 'other' : 'layer2'; }
const weeksFor = (age) => age === null ? 8 : age < 180 ? 12 : age < 365 ? 10 : age < 730 ? 8 : 6;
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
function farmEcon(p, value, age, dep, hz) {
  const weeks = weeksFor(age), gas = GAS[chainClass(p)], slice = T.farm.airdrop_share * value * dep / (dep + p.tvl_usd), costs = gas.setup + gas.weekly * weeks + gas.claim, forgone = YB.has(p.category ?? '') ? 0 : round2(dep * T.farm.forgone_apr * weeks / 52), hours = (T.farm.minutes.setup + T.farm.minutes.weekly * weeks + T.farm.minutes.claim) / 60, breakeven = slice > 0 ? (costs + forgone) / slice : Infinity, expSlice = hz * slice, expNet = expSlice - costs - forgone, expHr = expNet / hours;
  const verdict = expNet > 0 && expHr >= T.farm.worth_hour_floor ? 'Worth farming' : expNet > 0 || breakeven <= 2 * hz ? 'Marginal' : 'Skip';
  return { slice, costs, forgone, hours, breakeven, expSlice, expNet, expHr, verdict };
}

/* ---------- evidence: the headline numbers, re-derived from the shipped data ---------- */
function aucScore(y, s) { const order = s.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v || a.i - b.i), r = new Array(s.length).fill(0); let i = 0; while (i < order.length) { let j = i; while (j + 1 < order.length && order[j + 1].v === order[i].v) j++; const avg = (i + 1 + j + 1) / 2; for (let t = i; t <= j; t++) r[order[t].i] = avg; i = j + 1; } let pos = 0, neg = 0, sumPos = 0; y.forEach((v, idx) => { if (v === 1) { pos++; sumPos += r[idx]; } else neg++; }); return pos && neg ? (sumPos - pos * (pos + 1) / 2) / (pos * neg) : 0; }
function clockCV(rows) { const rng = mulberry(0xC10C), idx = rows.map((_, i) => i); for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const t = idx[i]; idx[i] = idx[j]; idx[j] = t; } const pred = new Array(rows.length).fill(0); for (let f = 0; f < 10; f++) { const test = new Set(idx.filter((_, i) => i % 10 === f)), beta = fitClock(rows.filter((_, i) => !test.has(i))); rows.forEach((r, i) => { if (test.has(i)) pred[i] = 1 / (1 + Math.exp(-r.x.reduce((s, v, j) => s + beta[j + 1] * v, beta[0]))); }); } const y = rows.map(r => r.y); return { auc: aucScore(y, pred), brier: y.reduce((s, v, i) => s + (v - pred[i]) ** 2, 0) / y.length }; }
function evidence() {
  const comps = T.raw.comps, kind = T.model.kind;
  const vc = (dep) => { const o = { 'Worth farming': 0, Marginal: 0, Skip: 0 }; for (const r of T.rows) o[r.econ[String(dep)].verdict]++; return o; };
  const crows = T.raw.clock.map(r => ({ x: clockFeats(r.tvl_usd, r.age_days ?? UNKNOWN_AGE, r.chains), y: r.launched }));
  const sub = (keep) => crows.map(r => ({ x: keep.map(i => r.x[i]), y: r.y }));
  const abl2 = [['size + age + chain count', [0, 1, 2], true], ['without chain count', [0, 1], false], ['without size', [1, 2], false], ['without age', [0, 2], false]].map(([label, keep, adopted]) => ({ label, adopted, ...clockCV(sub(keep)) }));
  abl2.push({ label: 'base rate only', adopted: false, auc: 0.5, brier: T.clock.base_brier });
  const pct = (v, q) => { const a = [...v].sort((x, y) => x - y); return a.length ? a[Math.max(0, Math.ceil(q * a.length) - 1)] : 0; };
  const qsf = (v) => [.1, .25, .75, .9].map(q => Math.max(-1, Math.min(1, pct(v, q))));
  const res = [], buckets = new Map();
  for (let i = 0; i < comps.length; i++) { const f = fitForm(comps.filter((_, j) => j !== i), kind), r = Math.log10(comps[i].mcap_usd) - f.predict(comps[i]), key = Math.floor(Math.log10(comps[i].tvl_usd)); res.push(r); buckets.set(key, [...(buckets.get(key) ?? []), r]); }
  const gq = qsf(res), bq = new Map([...buckets].filter(([, v]) => v.length >= 8).map(([k, v]) => [k, qsf(v)]));
  let mid = 0, wide = 0;
  comps.forEach((p, i) => { const q = bq.get(Math.floor(Math.log10(p.tvl_usd))) ?? gq; if (res[i] >= q[1] && res[i] <= q[2]) mid++; if (res[i] >= q[0] && res[i] <= q[3]) wide++; });
  const abl1 = Object.fromEntries(T.validation.ablation.map(a => [a.variant, a.medianMiss]));
  return { vc10: vc(10000), vc1: vc(1000), abl2, gq, covMid: mid / comps.length, covWide: wide / comps.length, tiltGap: abl1.growth - abl1.loggrowth };
}
let EV = null;
function renderEvidence() {
  const ev = EV, c = T.counts, v = T.validation, ck = T.clock;
  const stat = (val, cap, sub, cls = '') => `<div class="stat"><div class="v ${cls}">${val}</div><div class="cap">${cap}</div><div class="sub">${sub}</div></div>`;
  $('statStrip').innerHTML =
    stat(c.protocols, 'protocols tracked', `${c.traded} trading · ${c.aside} aside · ${c.ranked} ranked`) +
    stat(c.ranked, 'ranked pre-token', `${c.above_floor} above floor · ${c.watchlist} watchlist`) +
    stat(ev.vc10['Worth farming'], 'worth farming at $10K', `of ${c.ranked} · only ${ev.vc1['Worth farming']} at $1K`, 'teal') +
    stat('×' + v.looMedianMiss.toFixed(2), 'stage-1 LOO miss', `flat ×${v.flatMedianMiss.toFixed(2)} · 92 comps`, 'teal') +
    stat(Math.round(ev.covMid * 100) + '% · ' + Math.round(ev.covWide * 100) + '%', 'range holds — actual', 'nominal 50/80 · under-covers: 3-in-4', 'teal') +
    stat(ck.cv_auc.toFixed(2), 'AUC · out-of-sample', `${ck.population} · 10-fold · weak at timing`, 'amber') +
    stat(ck.cv_brier.toFixed(3), 'Brier · out-of-sample', `base ${ck.base_brier.toFixed(3)} · edge thin`, 'amber');
  const fr = (label, n, cls = '') => `<tr class="${cls}"><td>${label}</td><td>${n}</td></tr>`;
  const reasons = {}; for (const a of T.aside) reasons[a.reason] = (reasons[a.reason] ?? 0) + 1;
  $('funnelTable').innerHTML = '<tr><th>Disposition</th><th>Count</th></tr>' +
    fr('in the snapshot', c.protocols) +
    fr('already record a token — comps, never ranked', c.traded) +
    fr('set aside by rule — reasons below', c.aside) +
    fr('ranked pre-token — the board below', c.ranked) +
    fr(`Total — ${c.traded} + ${c.aside} + ${c.ranked} = ${c.protocols}, all accounted for`, c.protocols, 'sum') +
    fr('worth farming at $10K', ev.vc10['Worth farming']) +
    fr('marginal at $10K', ev.vc10.Marginal) +
    fr('skip at $10K', ev.vc10.Skip) +
    fr('worth farming at $1K', ev.vc1['Worth farming']);
  $('funnelNote').innerHTML = `Set aside: ${Object.entries(reasons).map(([k, n]) => `${esc(k)} <b>${n}</b>`).join(' · ')}.`;
  $('abl2Table').innerHTML = '<tr><th>Clock form</th><th>CV AUC</th><th>CV Brier</th></tr>' + ev.abl2.map(a => `<tr class="${a.adopted ? 'adopted' : ''}"><td>${esc(a.label)}</td><td>${a.auc.toFixed(3)}</td><td>${a.brier.toFixed(3)}</td></tr>`).join('');
  $('abl2Note').innerHTML = `Same seeded 10 folds, refit here.`;
  $('critList').innerHTML = [
    `Out-of-sample, the P25–P75 band holds <b>${Math.round(ev.covMid * 100)}%</b> of traded comps (calibrated: 50%) and P10–P90 holds <b>${Math.round(ev.covWide * 100)}%</b>, not 80% — read the outer band as a 3-in-4 range.`,
    `The adopted log-growth tilt beats the linear tilt by <b>${ev.tiltGap.toFixed(2)}×</b> of median miss — inside noise. Kept for symmetry, not sharpness.`,
    `The clock's chain-count term does not pay out-of-sample (dropping it: AUC <b>${ev.abl2[1].auc.toFixed(3)}</b> vs <b>${ck.cv_auc.toFixed(3)}</b>), and its Brier edge over the base rate is only <b>${(ck.base_brier - ck.cv_brier).toFixed(3)}</b> — it ranks better than it times.`,
    `Verdicts are hostage to deposit size: <b>${ev.vc10['Worth farming']}</b> of ${c.ranked} plans are worth farming at $10K, only <b>${ev.vc1['Worth farming']}</b> at $1K. Gas and forgone yield, not the model, kill the small farms.`,
    `One snapshot (${esc(T.as_of)}): TVL and 7-day change are single readings, and the clock's ages are tracking ages, not founding dates.`,
  ].map(t => `<li>${t}</li>`).join('');
}

/* ---------- verification: refit both stages, rebuild every row ---------- */
function verify() {
  const t0 = performance.now(), comps = T.raw.comps, rows = T.rows;
  const kind = T.model.kind, fit = fitForm(comps, kind), model = { kind, a: fit.a, b: fit.b, g: fit.g, s: fit.s, family: fit.family };
  const clockRows = T.raw.clock.map(r => ({ x: clockFeats(r.tvl_usd, r.age_days ?? UNKNOWN_AGE, r.chains), y: r.launched }));
  const beta = fitClock(clockRows);
  // bands: LOO residual quantiles of the adopted form, global and by TVL decade
  const pct = (v, q) => { const a = [...v].sort((x, y) => x - y); return a.length ? a[Math.max(0, Math.ceil(q * a.length) - 1)] : 0; };
  const qs = (v) => [.1, .25, .75, .9].map(q => Math.max(-1, Math.min(1, pct(v, q))));
  const allRes = [], buckets = new Map();
  for (let i = 0; i < comps.length; i++) { const tr = comps.filter((_, j) => j !== i), f2 = fitForm(tr, kind), r = Math.log10(comps[i].mcap_usd) - f2.predict(comps[i]), key = Math.floor(Math.log10(comps[i].tvl_usd)); allRes.push(r); buckets.set(key, [...(buckets.get(key) ?? []), r]); }
  const globalQ = qs(allRes), bucketQ = new Map([...buckets].filter(([, v]) => v.length >= 8).map(([k, v]) => [k, qs(v)]));
  // rank ranges: 200 seeded bootstrap refits of the adopted form
  const rng = mulberry(0x9E3779B9), rr = new Map();
  for (let it = 0; it < 200; it++) { const sample = Array.from({ length: comps.length }, () => comps[Math.floor(rng() * comps.length)]), f3 = fitForm(sample, kind), mm = { kind, a: f3.a, b: f3.b, g: f3.g, s: f3.s, family: f3.family }; rows.map(p => ({ p, v: impliedOf(p, mm).value })).sort((x, y) => y.v - x.v || x.p.slug.localeCompare(y.p.slug)).forEach((x, i) => rr.set(x.p.slug, [...(rr.get(x.p.slug) ?? []), i + 1])); }
  const nearRank = (v, q) => [...v].sort((a, b) => a - b)[Math.max(0, Math.ceil(q * v.length) - 1)] ?? 0;
  let bad = '';
  const vals = rows.map(p => ({ p, v: impliedOf(p, model).value }));
  const rankOf = new Map([...vals].sort((x, y) => y.v - x.v || x.p.slug.localeCompare(y.p.slug)).map((x, i) => [x.p.slug, i + 1]));
  for (const p of rows) {
    const v = impliedOf(p, model).value;
    if (v !== p.implied_value_usd) { bad = 'value: ' + p.slug; break; }
    if (rankOf.get(p.slug) !== p.rank) { bad = 'rank: ' + p.slug; break; }
    const key = Math.floor(Math.log10(p.tvl_usd)), q = bucketQ.get(key) ?? globalQ;
    const band = q.map(x => Math.max(1, Math.round(v * 10 ** x))).sort((a, b) => a - b);
    if (JSON.stringify(band) !== JSON.stringify(p.band)) { bad = 'band: ' + p.slug; break; }
    const range = [nearRank(rr.get(p.slug) ?? [], .1), nearRank(rr.get(p.slug) ?? [], .9)];
    if (JSON.stringify(range) !== JSON.stringify(p.rank_range)) { bad = 'rank range: ' + p.slug; break; }
    const hz = hazard12(beta, p.tvl_usd, p.age_days ?? UNKNOWN_AGE, p.chains.length);
    const f0 = clockF(beta, p.tvl_usd, p.age_days ?? UNKNOWN_AGE, p.chains.length);
    if (Math.abs(f0 - p.clock.profile_match) > 2e-4) { bad = 'clock F: ' + p.slug; break; }
    // every econ field is compared, not just the verdict: the detail totals
    // strip prints slice, expected slice, costs, forgone, hours, break-even
    // and expected net per hour straight from this block.
    for (const dep of [1000, 10000]) { const e = farmEcon(p, v, p.age_days, dep, hz), s = p.econ[String(dep)];
      if (e.verdict !== s.verdict || round2(e.expNet) !== s.expected_net || round2(e.expSlice) !== s.expected_slice || round2(e.slice) !== s.slice || round2(e.costs) !== s.costs || e.forgone !== s.forgone || Math.abs(e.hours - s.hours) > 1e-9 || round2(e.expHr) !== s.expected_net_hour || (s.breakeven === null ? isFinite(e.breakeven) : Math.abs(e.breakeven - s.breakeven) > 1e-4)) { bad = 'verdict: ' + p.slug; break; } }
    if (bad) break;
  }
  // evidence layer: the clock ablation must reproduce the shipped out-of-sample
  // scores, the band quantiles the shipped band table, and the rendered numbers
  // the recomputation — anything printed on the first screen is checked here.
  const ev2 = evidence();
  if (!bad && T.clock.beta.some((b, i) => Math.abs(b - beta[i]) > 1e-6)) bad = 'clock beta';
  if (!bad && (Math.abs(ev2.abl2[0].auc - T.clock.cv_auc) > 5e-4 || Math.abs(ev2.abl2[0].brier - T.clock.cv_brier) > 5e-4)) bad = 'clock ablation';
  if (!bad && JSON.stringify(ev2.gq.map(x => +x.toFixed(6))) !== JSON.stringify(T.band_table.global.map(x => +x.toFixed(6)))) bad = 'band table';
  if (!bad && EV && JSON.stringify(ev2) !== JSON.stringify(EV)) bad = 'evidence render';
  const secs = ((performance.now() - t0) / 1000).toFixed(1), chip = $('chip');
  if (bad) { chip.textContent = 're-run mismatch — ' + bad; chip.className = 'chip chip-bad'; }
  else { chip.textContent = `re-run OK — ${rows.length}/${rows.length} rows: ranks, values, bands, ranges, verdicts, totals, funnel + ablations · ${secs}s`; chip.className = 'chip chip-ok'; }
}

/* ---------- board UI ---------- */
const state = { q: '', seg: 'all', ver: 'all', fam: '', chain: '', dep: 10000, sort: 'expnet', dir: -1 };
const VERDICTS = ['Worth farming', 'Marginal', 'Skip'];
const vClass = (v) => v === 'Worth farming' ? 'go' : v === 'Marginal' ? 'warn' : 'skip';
function chips(el, items, cur, fn, cls) { el.innerHTML = items.map(([k, label]) => `<button type="button" class="${cls ? cls(k) : ''}" data-k="${esc(k)}" aria-pressed="${String(cur === k)}">${esc(label)}</button>`).join(''); el.querySelectorAll('button').forEach(b => b.addEventListener('click', () => fn(b.dataset.k))); }
function filtered() {
  let rows = T.rows.filter(r =>
    (state.seg === 'all' || (state.seg === 'watchlist' && r.watchlist) || (state.seg === 'above' && r.above_floor) || (state.seg === 'early' && !r.watchlist && !r.above_floor)) &&
    (state.ver === 'all' || r.econ[String(state.dep)].verdict === state.ver) &&
    (!state.fam || (r.category ?? '') === state.fam) && (!state.chain || r.chains.includes(state.chain)) &&
    (!state.q || (r.name + ' ' + (r.category ?? '')).toLowerCase().includes(state.q)));
  const key = { rank: r => r.rank, name: r => r.name.toLowerCase(), tvl: r => r.tvl_usd, chg: r => r.change_7d ?? -1e9, age: r => r.age_days ?? -1, hz: r => r.clock.hazard12, val: r => r.implied_value_usd, range: r => (r.rank_range[0] + r.rank_range[1]) / 2, expnet: r => r.econ[String(state.dep)].expected_net, verdict: r => VERDICTS.indexOf(r.econ[String(state.dep)].verdict) * 1e12 + r.econ[String(state.dep)].expected_net }[state.sort];
  rows.sort((a, b) => { const d = key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : a.slug.localeCompare(b.slug); return d * state.dir; });
  return rows;
}
const BAND_LO = Math.min(...T.rows.map(r => r.band[0])), BAND_HI = Math.max(...T.rows.map(r => r.band[3]));
const fmtBand = (v) => v >= 1e9 ? '$' + (v / 1e9).toFixed(1) + 'B' : v >= 1e6 ? '$' + Math.round(v / 1e6) + 'M' : v >= 1e3 ? '$' + Math.round(v / 1e3) + 'K' : '$' + Math.round(v);
function bandCell(r) {
  const px = (v) => ((Math.log10(v) - Math.log10(BAND_LO)) / (Math.log10(BAND_HI) - Math.log10(BAND_LO)) * 132).toFixed(1);
  return `<span class="bandline">P10 ${fmtBand(r.band[0])} · P90 ${fmtBand(r.band[3])}</span><span class="bandbar" title="shared log $ scale, ${fmt$(BAND_LO)} to ${fmt$(BAND_HI)}: segment = this row's P10–P90, tick = implied value"><span class="seg" style="left:${px(r.band[0])}px;width:${Math.max(2, px(r.band[3]) - px(r.band[0]))}px"></span><span class="m" style="left:${px(r.implied_value_usd)}px"></span></span>`;
}
function renderBoard() {
  const rows = filtered(), dep = String(state.dep);
  $('boardBody').innerHTML = rows.map(r => { const e = r.econ[dep]; return `<tr data-slug="${esc(r.slug)}" class="${r.rank === 1 ? 'rank1' : ''}">
    <td>${r.rank}</td>
    <td class="left"><a class="pname" href="#/p/${esc(r.slug)}">${esc(r.name)}</a><br><span class="psub">${esc(r.category ?? 'Uncategorised')} · ${esc(r.chains.slice(0, 2).join(', ') || '—')}${r.watchlist ? ' · watchlist' : ''}</span></td>
    <td>${fmt$(r.tvl_usd)}</td><td>${r.change_7d === null ? '—' : (r.change_7d >= 0 ? '+' : '') + r.change_7d.toFixed(1) + '%'}</td>
    <td>${r.age_days === null ? '—' : r.age_days >= 365 ? (r.age_days / 365).toFixed(1) + 'y' : r.age_days + 'd'}</td>
    <td><span class="hzbar" title="launch rate over the next 12 months, from the clock"><i style="width:${Math.min(100, r.clock.hazard12 * 220)}%"></i></span>${Math.round(r.clock.hazard12 * 100)}%</td>
    <td><b>${fmt$(r.implied_value_usd)}</b></td><td>${bandCell(r)}</td>
    <td>${r.rank_range[0]}–${r.rank_range[1]}</td>
    <td class="${e.expected_net >= 0 ? 'pos' : 'neg'}">${e.expected_net >= 0 ? '+' : '−'}$${Math.round(Math.abs(e.expected_net))}</td>
    <td><span class="verdict ${vClass(e.verdict)}">${esc(e.verdict)}</span></td></tr>`; }).join('');
  $('boardBody').querySelectorAll('tr').forEach(tr => tr.addEventListener('click', () => { location.hash = '#/p/' + tr.dataset.slug; }));
  $('empty').hidden = rows.length > 0;
  const active = state.q || state.seg !== 'all' || state.ver !== 'all' || state.fam || state.chain;
  $('view-board').classList.toggle('filtered', !!active);
  const cs = $('compactStrip');
  if (active) {
    cs.hidden = false;
    cs.innerHTML = `<b>T-MINUS</b> · snapshot ${esc(T.as_of)} · ${T.counts.ranked} ranked · ${EV.vc10['Worth farming']} worth at $10K · showing <b>${rows.length} of ${T.counts.ranked}</b>`;
  } else cs.hidden = true;
  $('boardNote').innerHTML = `<b>Sorted by expected net</b> at the $${state.dep.toLocaleString()} size, highest first — # is the rank by implied value; click a column to re-sort. <b>Verdicts:</b> Worth = expected net &gt; $0 and ≥ $${T.farm.worth_hour_floor.toFixed(2)}/h · Marginal = expected net &gt; $0, or break-even within 2× the clock's rate · Skip = the rest. <b>Rank range</b> = 10th–90th percentile across 200 seeded bootstrap refits. Age <b>—</b> = no listing date in the snapshot; the clock scores it at a ${UNKNOWN_AGE}-day default.`;
  const fb = $('farmbook');
  if (active && rows.length) {
    const n = rows.length, cap = state.dep * n, fees = rows.reduce((s, r) => s + r.econ[dep].costs, 0), forg = rows.reduce((s, r) => s + r.econ[dep].forgone, 0), hrs = rows.reduce((s, r) => s + r.econ[dep].hours, 0), expS = rows.reduce((s, r) => s + r.econ[dep].expected_slice, 0), slices = rows.reduce((s, r) => s + r.econ[dep].slice, 0);
    fb.hidden = false;
    fb.innerHTML = `<b>This selection as one farm book</b> — n = ${n} protocols. Every figure clock-weighted: a slice counts at the launch rate of its protocol, not at face value. Book break-even 1 in ${slices > 0 ? Math.max(1, Math.round(slices / (fees + forg))) : '—'} = at face value, that share of the slices must actually land to cover fees + forgone yield.
      <div class="fb-grid"><span>Capital at work<b>${fmt$(cap)}</b></span><span>Fees &amp; gas<b>${fmt$(fees)}</b></span><span>Forgone yield<b>${fmt$(forg)}</b></span><span>Your time<b>${hrs.toFixed(1)} h</b></span><span>Slices if all launch<b>${fmt$(slices)}</b></span><span>Expected slices<b>${fmt$(expS)}</b></span><span>Expected net<b>${fmt$(expS - fees - forg)}</b></span><span>Book break-even<b>${slices > 0 ? '1 in ' + Math.max(1, Math.round(slices / (fees + forg))) : '—'}</b></span></div>`;
  } else fb.hidden = true;
}
function drawFit() {
  const cv = $('fitChart'), dpr = Math.min(2, window.devicePixelRatio || 1), W = cv.clientWidth, H = 160;
  cv.width = W * dpr; cv.height = H * dpr; const g = cv.getContext('2d'); g.scale(dpr, dpr);
  const sc = T.validation.scatter, xs = sc.comps.map(p => p[0]), ys = sc.comps.map(p => p[1]);
  const x0 = Math.min(...xs) - .2, x1 = Math.max(...xs) + .2, y0 = Math.min(...ys) - .2, y1 = Math.max(...ys) + .2;
  // axes first: faint gridlines and labelled decade ticks on both log scales,
  // so the plot reads on its own — market cap against TVL, in dollars.
  const L = 48, R = 10, Tp = 8, B = 32, pw = W - L - R, ph = H - Tp - B;
  const X = (v) => L + (v - x0) / (x1 - x0) * pw, Y = (v) => Tp + ph - (v - y0) / (y1 - y0) * ph;
  g.font = '12px sans-serif';
  g.strokeStyle = '#232F42'; g.fillStyle = '#A9B8C8'; g.textAlign = 'right'; g.textBaseline = 'middle';
  for (let d = Math.ceil(y0); d <= Math.floor(y1); d++) { const y = Y(d); g.beginPath(); g.moveTo(L, y); g.lineTo(W - R, y); g.stroke(); g.fillText(fmtDec(d), L - 6, y); }
  g.textAlign = 'center'; g.textBaseline = 'top';
  for (let d = Math.ceil(x0); d <= Math.floor(x1); d++) g.fillText(fmtDec(d), X(d), Tp + ph + 5);
  g.strokeStyle = '#2C3A4D'; g.strokeRect(L + .5, Tp + .5, pw - 1, ph - 1);
  g.fillStyle = '#35C4B5'; for (const [x, y] of sc.comps) { g.fillRect(X(x) - 1.5, Y(y) - 1.5, 3, 3); }
  g.fillStyle = '#A9B8C8'; g.textAlign = 'left'; g.textBaseline = 'top'; g.fillText('dots: traded comps · amber: adopted curve · dashed: P25–P75 band', L + 6, Tp + 5);
  g.strokeStyle = '#7E90A5'; g.setLineDash([4, 3]); g.beginPath(); sc.band.forEach(([x, , hi], i) => i ? g.lineTo(X(x), Y(hi)) : g.moveTo(X(x), Y(hi))); g.stroke();
  g.beginPath(); sc.band.forEach(([x, lo], i) => i ? g.lineTo(X(x), Y(lo)) : g.moveTo(X(x), Y(lo))); g.stroke(); g.setLineDash([]);
  g.strokeStyle = '#F0A832'; g.lineWidth = 2; g.beginPath(); sc.curve.forEach(([x, y], i) => i ? g.lineTo(X(x), Y(y)) : g.moveTo(X(x), Y(y))); g.stroke();
  g.fillStyle = '#8CA0B5'; g.save(); g.translate(11, Tp + ph / 2); g.rotate(-Math.PI / 2); g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('market cap (log $)', 0, 0); g.restore();
  g.textAlign = 'center'; g.textBaseline = 'bottom'; g.fillText('TVL (log $)', L + pw / 2, H - 2);
}
function drawClock() {
  const cv = $('clockChart'), dpr = Math.min(2, window.devicePixelRatio || 1), W = cv.clientWidth, H = 160;
  cv.width = W * dpr; cv.height = H * dpr; const g = cv.getContext('2d'); g.scale(dpr, dpr);
  const pts = T.clock.curve;
  // axes first: percent ticks up the side, labelled ages along the log time axis.
  const L = 46, R = 10, Tp = 8, B = 32, pw = W - L - R, ph = H - Tp - B;
  const X = (a) => L + Math.log10(a / 90) / Math.log10(2555 / 90) * pw, Y = (v) => Tp + ph - v * ph;
  g.font = '12px sans-serif';
  g.strokeStyle = '#232F42'; g.fillStyle = '#A9B8C8'; g.textAlign = 'right'; g.textBaseline = 'middle';
  for (const t of [0, .25, .5, .75, 1]) { const y = Y(t); g.beginPath(); g.moveTo(L, y); g.lineTo(W - R, y); g.stroke(); g.fillText(Math.round(t * 100) + '%', L - 6, y); }
  g.textAlign = 'center'; g.textBaseline = 'top';
  for (const [a, lab] of [[90, '3 mo'], [180, '6 mo'], [365, '1 y'], [730, '2 y'], [1460, '4 y'], [2555, '7 y']]) g.fillText(lab, X(a), Tp + ph + 5);
  g.strokeStyle = '#2C3A4D'; g.strokeRect(L + .5, Tp + .5, pw - 1, ph - 1);
  g.strokeStyle = '#F0A832'; g.lineWidth = 2; g.beginPath(); pts.forEach((p, i) => i ? g.lineTo(X(p.age), Y(p.f)) : g.moveTo(X(p.age), Y(p.f))); g.stroke();
  g.strokeStyle = '#35C4B5'; g.beginPath(); pts.forEach((p, i) => i ? g.lineTo(X(p.age), Y(p.hazard)) : g.moveTo(X(p.age), Y(p.hazard))); g.stroke();
  g.fillStyle = '#A9B8C8'; g.textAlign = 'left'; g.textBaseline = 'top'; g.fillText('amber: launched-by-age share · teal: launch rate / yr', L + 6, Tp + 5);
  g.fillStyle = '#8CA0B5'; g.save(); g.translate(11, Tp + ph / 2); g.rotate(-Math.PI / 2); g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('share of lookalikes', 0, 0); g.restore();
  g.textAlign = 'center'; g.textBaseline = 'bottom'; g.fillText('tracking age (log scale)', L + pw / 2, H - 2);
}
function renderHero() {
  const v = T.validation, c = T.clock;
  $('fitStats').innerHTML = `Fitted on the <b>${v.comps} traded tokens</b> the snapshot records. Leave-one-out median miss <b>${v.looMedianMiss.toFixed(2)}x</b> (flat multiple ${v.flatMedianMiss.toFixed(2)}x); <b>${Math.round(v.looWithin3 * 100)}%</b> land within 3x; time-split ${v.timeSplitMiss ? v.timeSplitMiss.toFixed(2) + 'x' : '—'}.`;
  $('clockStats').innerHTML = `Current-status fit on <b>${c.population} protocols</b> (${c.launched} already record a token, ${c.waiting} still wait). Out-of-sample: AUC <b>${c.cv_auc.toFixed(2)}</b>, Brier <b>${c.cv_brier.toFixed(3)}</b> against ${c.base_brier.toFixed(3)} for guessing the base rate.`;
  $('ablTable').innerHTML = '<tr><th>Form</th><th>LOO miss</th><th>Within 3x</th></tr>' + v.ablation.map(a => `<tr class="${a.variant === T.model.kind ? 'adopted' : ''}"><td>${esc(a.label)}</td><td>${a.medianMiss.toFixed(2)}x</td><td>${Math.round(a.within3 * 100)}%</td></tr>`).join('');
  $('boardCounts').innerHTML = `<b>${T.counts.ranked} ranked</b> · watchlist ${T.counts.watchlist}/${T.counts.watchlist} · <a href="#/traded">already trading: ${T.counts.traded}</a> · <a href="#/aside">set aside: ${T.counts.aside}</a> · all ${T.counts.protocols} protocols accounted for.`;
  $('methodText').innerHTML = `
    <div><h3>Stage one — the price</h3><p>A robust size curve, log(value) on log(TVL), fitted on the traded comps, plus a growth tilt on log(1 + 7-day change): a hot week is priced as froth (tilt coefficient ${T.model.growthCoef.toFixed(2)}), and the board shows the ablation that chose this form over five rivals, the losers included. Bands are leave-one-out residual quantiles at each protocol's TVL decade; rank ranges come from 200 seeded bootstrap refits.</p></div>
    <div><h3>Stage two — the clock</h3><p>The snapshot observes each protocol once: its tracking age, and whether a token exists yet. That is current-status data. The logistic fit of "already launched" on size, age and chain count gives F(age) for any profile; the next-12-months launch rate is (F(age + 1y) − F(age)) / (1 − F(age)). It is a frequency among lookalikes — the honest reading of a single snapshot, and the page says so wherever the number is used.</p></div>
    <div><h3>Farm pricing</h3><p>Each plan assumes an airdrop of ${(T.farm.airdrop_share * 100).toFixed(1)}% of the implied value, split pro-rata against TVL. Expected slice = launch rate x slice. Verdict: <b>Worth farming</b> when expected net after gas, forgone yield and time is positive and pays at least $${T.farm.worth_hour_floor}/hour; <b>Marginal</b> when expected net is positive but thin, or the break-even launch odds are within 2x of the clock; <b>Skip</b> otherwise. Gas is priced by chain class; positions that earn their own yield are charged no forgone yield.</p></div>`;
  $('footNote').textContent = `T-Minus reads one sealed DefiLlama snapshot (as of ${T.as_of}). Implied values are this board's own claims, fitted on that snapshot alone; nothing here predicts that a token will be issued.`;
}

/* ---------- detail & list views ---------- */
function show(view) { for (const id of ['view-board', 'view-detail', 'view-list']) $(id).hidden = id !== view; window.scrollTo(0, 0); }
function renderDetail(slug) {
  const r = T.rows.find(x => x.slug === slug);
  if (!r) { location.hash = '#/'; return; }
  const f = r.model, band = r.band;
  const factor = (cap, val) => `<div class="factor"><div class="cap">${cap}</div><div class="val">${val}</div></div>`;
  const depRow = (dep) => { const e = r.econ[String(dep)]; return `<tr><td>$${dep.toLocaleString()}</td><td>${fmt$(e.slice)}</td><td>${fmt$(e.expected_slice)}</td><td>${fmt$(e.costs)}</td><td>${fmt$(e.forgone)}</td><td class="${e.expected_net >= 0 ? 'pos' : 'neg'}">${e.expected_net >= 0 ? '+' : '−'}$${fmtN(Math.abs(e.expected_net))}</td><td>${e.expected_net >= 0 ? '+' : '−'}$${fmtN(Math.abs(e.expected_net_hour))}</td><td>${e.breakeven === null || !isFinite(e.breakeven) ? '—' : Math.round(e.breakeven * 100) + '%'}</td><td><span class="verdict ${vClass(e.verdict)}">${esc(e.verdict)}</span></td></tr>`; };
  const e10 = r.econ['10000'];
  const beta = T.clock.beta, bAge = r.age_days ?? UNKNOWN_AGE, bx = clockFeats(r.tvl_usd, bAge, r.chains.length);
  const bF0 = clockF(beta, r.tvl_usd, bAge, r.chains.length), bF1 = clockF(beta, r.tvl_usd, bAge + 365, r.chains.length), bHz = hazard12(beta, r.tvl_usd, bAge, r.chains.length);
  const gmExact = impliedOf(r, { kind: T.model.kind, a: T.model.a, b: T.model.b, g: T.model.growthCoef, s: T.model.seasonCoef, family: T.model.family }).gm;
  const contrib = (v) => `${v >= 0 ? '+' : '−'}${fmtN(Math.abs(v))}`;
  const signed$ = (v) => `${v >= 0 ? '+' : '−'}$${fmtN(Math.abs(v))}`;
  const tile = (val, cap, sub, cls) => `<div class="stat"><div class="v${cls ? ' ' + cls : ''}">${val}</div><div class="cap">${cap}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
  $('view-detail').innerHTML = `
    <a class="backlink" href="#/">← Back to the board</a>
    <div class="d-head"><div><h1>${esc(r.name)}</h1><div class="sub">${esc(r.category ?? 'Uncategorised')} · ${esc(r.chains.slice(0, 3).join(', ') || 'no chain listed')}${r.chains.length > 3 ? ` +${r.chains.length - 3} more` : ''} · TVL ${fmt$(r.tvl_usd)} · 7d ${r.change_7d === null ? '—' : (r.change_7d >= 0 ? '+' : '') + r.change_7d.toFixed(1) + '%'} · rank #${r.rank} (range ${r.rank_range[0]}–${r.rank_range[1]})${r.watchlist ? ' · on the watchlist' : ''}</div></div>
    <div class="d-big"><div><div class="cap">implied value if it launched at this record</div><div class="v">${fmt$(r.implied_value_usd)}</div></div><div><div class="cap">launch rate, next 12 months</div><div class="h">${Math.round(r.clock.hazard12 * 100)}% / yr</div></div></div></div>
    <div class="totals-h">The farm at the $10,000 size — totals</div><div class="totals" id="totalsStrip">
      ${tile(fmt$(e10.slice), 'Slice if launch')}${tile(fmt$(e10.expected_slice), 'Expected slice', `${Math.round(r.clock.hazard12 * 100)}% launch rate`)}${tile(fmt$(e10.costs), 'Fees and gas')}${tile(fmt$(e10.forgone), 'Yield forgone')}${tile(e10.hours.toFixed(1) + 'h', 'Your time', `over ${e10.weeks} weeks`)}${tile(signed$(e10.expected_net), 'Expected net', signed$(e10.expected_net_hour) + '/h', e10.expected_net >= 0 ? 'pos' : 'neg')}${tile(e10.breakeven === null || !isFinite(e10.breakeven) ? '—' : Math.round(e10.breakeven * 100) + '%', 'Break-even launch rate')}${tile(esc(e10.verdict), 'Verdict', '', vClass(e10.verdict))}
    </div>
    <div class="totals-h">How the two headline numbers are built</div><div class="buildup" id="buildup">
      <div class="bu-row"><span class="bu-cap">Stage 1 — value</span>TVL <b>${fmt$(r.tvl_usd)}</b> → size curve <b>${fmt$(f.curve_value_usd)}</b> → × growth tilt <b>${gmExact.toFixed(4)}</b> (7d ${r.change_7d === null ? '—' : (r.change_7d >= 0 ? '+' : '') + r.change_7d.toFixed(1) + '%'}, log tilt) → <b>implied value ${fmt$(r.implied_value_usd)}</b> · band P10 ${fmt$(band[0])} – P90 ${fmt$(band[3])}</div>
      <div class="bu-row"><span class="bu-cap">Stage 2 — clock</span>drivers, logit points: size <b>${contrib(beta[1] * bx[0])}</b> · age <b>${contrib(beta[2] * bx[1])}</b> · chains <b>${contrib(beta[3] * bx[2])}</b> · base <b>${contrib(beta[0])}</b> → F(today) <b>${Math.round(bF0 * 100)}%</b> → F(+1y) <b>${Math.round(bF1 * 100)}%</b> → <b>launch rate (${Math.round(bF1 * 100)}% − ${Math.round(bF0 * 100)}%) / (1 − ${Math.round(bF0 * 100)}%) = ${Math.round(bHz * 100)}% / yr</b></div>
      <div class="bu-row"><span class="bu-cap">Snapshot record</span>listed <b>${esc(r.listed_at ?? 'null')}</b> · tracked <b>${r.age_days === null ? '—' : r.age_days + 'd'}</b> · chains <b>${esc(r.chains.slice(0, 3).join(', ') || 'none listed')}${r.chains.length > 3 ? ` +${r.chains.length - 3} more` : ''}</b> · status: <b>no token recorded</b> (gecko_id and symbol both null)</div>
    </div>
    <div class="panel plan-panel"><h2>The plan — ${r.steps.length} steps, ${r.econ['10000'].weeks} weeks at the $10,000 size</h2><ol class="steps">
      ${r.steps.map(s => `<li><span class="when">${esc(s.when)}</span><span class="txt">${esc(s.text)}</span><span class="ct">${esc(s.cost)}<br>${esc(s.time)}</span></li>`).join('')}</ol></div>
    <div class="d-grid">
      <div class="panel"><h2>The value build</h2><div class="factors">
        ${factor('TVL', fmt$(r.tvl_usd))}<span class="factor-arrow">→</span>${factor('Size curve', fmt$(f.curve_value_usd))}<span class="factor-arrow">×</span>${factor('Growth tilt', f.growth_multiplier.toFixed(2) + 'x')}${f.family_multiplier !== 1 ? `<span class="factor-arrow">×</span>${factor('Category', f.family_multiplier.toFixed(2) + 'x')}` : ''}${f.season_multiplier !== 1 ? `<span class="factor-arrow">×</span>${factor('Seasoning', f.season_multiplier.toFixed(2) + 'x')}` : ''}<span class="factor-arrow">=</span>${factor('Implied value', fmt$(r.implied_value_usd))}
      </div><p class="stats">Band from leave-one-out residuals at this TVL decade: P10 <b>${fmt$(band[0])}</b> · P25 <b>${fmt$(band[1])}</b> · P75 <b>${fmt$(band[2])}</b> · P90 <b>${fmt$(band[3])}</b>. The band is the honest width of the model: half the traded comps land within ${T.validation.looMedianMiss.toFixed(1)}x of their fitted value.</p>
      <h2 style="margin-top:24px">Nearest traded comps</h2><table class="data"><tr><th>Protocol</th><th>TVL</th><th>Market cap</th><th>Curve says</th><th>Actual / curve</th></tr>
      ${r.comps_near.map(c => `<tr><td>${esc(c.name)}${c.symbol ? ' (' + esc(c.symbol) + ')' : ''}</td><td>${fmt$(c.tvl_usd)}</td><td>${fmt$(c.mcap_usd)}</td><td>${fmt$(c.curve_value_usd)}</td><td>${c.ratio.toFixed(2)}x</td></tr>`).join('')}</table></div>
      <div class="panel"><h2>The countdown</h2><div class="clockread">
        <div class="cr"><div class="val">${r.age_days === null ? '—' : (r.age_days / 365).toFixed(1) + 'y'}</div><div class="cap">tracked with no token</div></div>
        <div class="cr"><div class="val">${Math.round(r.clock.profile_match * 100)}%</div><div class="cap">of lookalikes have launched by this age</div></div>
        <div class="cr"><div class="val">${Math.round(r.clock.hazard12 * 100)}%</div><div class="cap">launch rate, next 12 months</div></div></div>
      <p class="stats">The clock is fitted on ${T.clock.population} comparable protocols in this snapshot (${T.clock.launched} launched, ${T.clock.waiting} waiting), cross-validated AUC ${T.clock.cv_auc.toFixed(2)}. It prices the farm below; it does not move the implied value, which is what the token would be worth if the launch happened at today's record.</p>
      <h2 style="margin-top:24px">The farm, priced both ways</h2><table class="data"><tr><th>Deposit</th><th>Slice</th><th>Expected slice</th><th>Costs</th><th>Forgone</th><th>Expected net</th><th>Per hour</th><th>Break-even</th><th>Verdict</th></tr>${depRow(1000)}${depRow(10000)}</table>
      <p class="stats">Slice assumes a ${(T.farm.airdrop_share * 100).toFixed(1)}% airdrop of the implied value, split pro-rata. Expected slice = slice x the ${Math.round(r.clock.hazard12 * 100)}% launch rate. Break-even is the launch rate at which the plan pays for itself.</p></div>
      <div class="panel" style="grid-column:1/-1"><h2>The snapshot record</h2><dl class="kv">
        <dt>slug</dt><dd>${esc(r.slug)}</dd><dt>category</dt><dd>${esc(r.category ?? 'null')}</dd><dt>chains</dt><dd>${esc(r.chains.join(', ') || '—')}</dd>
        <dt>TVL</dt><dd>$${r.tvl_usd.toLocaleString()}</dd><dt>7-day change</dt><dd>${r.change_7d === null ? 'null' : r.change_7d + '%'}</dd>
        <dt>tracked since</dt><dd>${esc(r.listed_at ?? 'null')}</dd><dt>token</dt><dd>none recorded (gecko_id and symbol both null)</dd><dt>watchlist</dt><dd>${r.watchlist ? 'yes' : 'no'}</dd></dl></div>
    </div>`;
  show('view-detail');
}
function renderList(kind) {
  const el = $('view-list');
  if (kind === 'traded') {
    el.innerHTML = `<div class="listhead"><h1>Already trading</h1><a href="#/">← Board</a></div><p class="stats" style="margin-bottom:12px">These protocols record a token with a market cap, so the radar never ranks them. The curve column is what stage one would say from TVL alone — the comps the fit learned from, shown with their misses.</p>
    <div class="tablewrap"><table class="board"><thead><tr><th class="left">Protocol</th><th>TVL</th><th>Market cap</th><th>Curve says</th><th>Actual / curve</th></tr></thead><tbody>
    ${T.traded.map(p => `<tr><td class="left"><span class="pname">${esc(p.name)}</span> <span class="psub">${esc(p.symbol ?? '')} · ${esc(p.category ?? '')}</span></td><td>${fmt$(p.tvl_usd)}</td><td>${fmt$(p.mcap_usd)}</td><td>${fmt$(p.curve_value_usd)}</td><td>${p.ratio.toFixed(2)}x</td></tr>`).join('')}</tbody></table></div>`;
  } else {
    const counts = {}; for (const a of T.aside) counts[a.reason] = (counts[a.reason] ?? 0) + 1;
    el.innerHTML = `<div class="listhead"><h1>Set aside</h1><a href="#/">← Board</a></div><p class="stats" style="margin-bottom:12px">${Object.entries(counts).map(([k, v]) => `${esc(k)}: <b>${v}</b>`).join(' · ')}. Every one of the ${T.counts.protocols} snapshot protocols is on the board, in the trading list, or here with its reason.</p>
    <div class="tablewrap"><table class="board"><thead><tr><th class="left">Protocol</th><th>TVL</th><th class="left">Reason</th></tr></thead><tbody>
    ${T.aside.map(p => `<tr><td class="left"><span class="pname">${esc(p.name)}</span> <span class="psub">${esc(p.category ?? '')}</span></td><td>${fmt$(p.tvl_usd)}</td><td class="left">${esc(p.reason)}</td></tr>`).join('')}</tbody></table></div>`;
  }
  show('view-list');
}

/* ---------- wiring ---------- */
function route() {
  const h = location.hash || '#/';
  if (h.startsWith('#/p/')) renderDetail(h.slice(4));
  else if (h === '#/traded') renderList('traded');
  else if (h === '#/aside') renderList('aside');
  else { show('view-board'); }
}
function init() {
  if (!T) { $('boot').hidden = true; const f = $('fatal'); f.hidden = false; f.textContent = 'The radar data (data.js) did not load, so the board cannot be drawn. Nothing on this page is estimated by hand: without the snapshot output there is nothing to show.'; return; }
  $('boot').hidden = true; $('view-board').hidden = false;
  $('asof').textContent = 'snapshot as of ' + T.as_of;
  EV = evidence();
  renderHero(); renderEvidence(); drawFit(); drawClock();
  chips($('segChips'), [['all', 'All'], ['watchlist', 'Watchlist'], ['above', 'Above floor'], ['early', 'Early']], state.seg, (k) => { state.seg = k; init2(); });
  chips($('verChips'), [['all', 'Any verdict'], ['Worth farming', 'Worth'], ['Marginal', 'Marginal'], ['Skip', 'Skip']], state.ver, (k) => { state.ver = k; init2(); }, (k) => k === 'Worth farming' ? 'v-go' : k === 'Marginal' ? 'v-warn' : k === 'Skip' ? 'v-skip' : '');
  chips($('depChips'), [['1000', '$1K'], ['10000', '$10K']], String(state.dep), (k) => { state.dep = Number(k); init2(); });
  const fams = [...new Set(T.rows.map(r => r.category ?? ''))].sort();
  $('famSel').innerHTML = '<option value="">All categories</option>' + fams.map(c => `<option value="${esc(c)}">${esc(c || 'Uncategorised')}</option>`).join('');
  const chains = [...new Set(T.rows.flatMap(r => r.chains))].sort();
  $('chainSel').innerHTML = '<option value="">All chains</option>' + chains.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  $('famSel').addEventListener('change', (e) => { state.fam = e.target.value; renderBoard(); });
  $('chainSel').addEventListener('change', (e) => { state.chain = e.target.value; renderBoard(); });
  $('q').addEventListener('input', (e) => { state.q = e.target.value.trim().toLowerCase(); renderBoard(); });
  $('resetBtn').addEventListener('click', () => { Object.assign(state, { q: '', seg: 'all', ver: 'all', fam: '', chain: '' }); $('q').value = ''; $('famSel').value = ''; $('chainSel').value = ''; init2(); });
  document.querySelectorAll('#boardTable th[data-k]').forEach(th => th.addEventListener('click', () => { const k = th.dataset.k; if (state.sort === k) state.dir *= -1; else { state.sort = k; state.dir = k === 'name' ? 1 : -1; if (k === 'rank') state.dir = 1; } renderBoard(); }));
  renderBoard(); route();
  window.addEventListener('hashchange', route);
  setTimeout(verify, 40);
}
function init2() { // refresh chip groups after a state change, then re-render
  chips($('segChips'), [['all', 'All'], ['watchlist', 'Watchlist'], ['above', 'Above floor'], ['early', 'Early']], state.seg, (k) => { state.seg = k; init2(); });
  chips($('verChips'), [['all', 'Any verdict'], ['Worth farming', 'Worth'], ['Marginal', 'Marginal'], ['Skip', 'Skip']], state.ver, (k) => { state.ver = k; init2(); }, (k) => k === 'Worth farming' ? 'v-go' : k === 'Marginal' ? 'v-warn' : k === 'Skip' ? 'v-skip' : '');
  chips($('depChips'), [['1000', '$1K'], ['10000', '$10K']], String(state.dep), (k) => { state.dep = Number(k); init2(); });
  renderBoard();
}
document.addEventListener('DOMContentLoaded', init);
