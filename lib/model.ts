/**
 * T-Minus model. Two stages, both fitted on the sealed snapshot and nothing else.
 *
 * Stage one prices the launch: a robust (Huber) size curve in log-log space over
 * the traded tokens the snapshot records, plus a growth tilt on log(1 + change).
 * Six rival forms are fitted and the one with the lowest leave-one-out median
 * miss is adopted; the ablation is published on the board, dropped terms included.
 *
 * Stage two times the launch: the snapshot is current-status data — every
 * protocol is observed once, at its tracking age, with a token or without one.
 * A logistic fit of "already records a token" on size, age and chain count over
 * the 442 comparable protocols gives F(age) for any profile, and the farm engine
 * prices each plan by the next-12-months launch rate the curve implies:
 * expected slice = hazard x slice, verdicts from expected net after all costs.
 *
 * All dates are snapshot-relative; all resampling uses a fixed seed, so two
 * runs write the same bytes.
 */
export type SnapshotProtocol = { slug: string; name: string; category: string | null; chains: string[]; tvl_usd: number; change_7d: number | null; mcap_usd: number | null; listed_at: string | null; gecko_id: string | null; symbol: string | null };
export type Snapshot = { as_of: string; source: string; floor_usd: number; protocols: SnapshotProtocol[]; watchlist: string[] };
export class SnapshotError extends Error { constructor(message: string) { super(message); this.name = 'SnapshotError'; } }
export type Variant = 'flat' | 'curve' | 'growth' | 'loggrowth' | 'loggrowthseason' | 'family';
export type ValueModel = { kind: Variant; a: number; b: number; growthCoef: number; seasonCoef: number; family: Record<string, number> };
export type ClockModel = { beta: number[]; population: number; launched: number; waiting: number; cvAuc: number; cvBrier: number; baseBrier: number };
export type BoardRow = Record<string, any>;

const UNKNOWN_AGE_DAYS = 365;
const VARIANTS: Variant[] = ['flat', 'curve', 'growth', 'loggrowth', 'loggrowthseason', 'family'];
export const VARIANT_LABELS: Record<Variant, string> = {
  flat: 'one flat multiple of TVL',
  curve: 'size curve, no tilt',
  growth: 'size curve + growth tilt (linear)',
  loggrowth: 'size curve + growth tilt (log)',
  loggrowthseason: 'log-growth tilt + seasoning',
  family: 'log-growth + category offsets, shrunk',
};
export const PRODUCT_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC']);
export const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

function validDate(s: unknown): s is string { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s; }
function finite(v: unknown, label: string): number { if (typeof v !== 'number' || !Number.isFinite(v)) throw new SnapshotError(`${label} must be a finite number`); return v; }
function nullableString(v: unknown, label: string): string | null { if (v !== null && typeof v !== 'string') throw new SnapshotError(`${label} must be a string or null`); return v; }
export function parseSnapshot(text: string): Snapshot {
  let raw: any; try { raw = JSON.parse(text); } catch { throw new SnapshotError('snapshot must be valid JSON'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new SnapshotError('snapshot must be an object');
  if (!validDate(raw.as_of)) throw new SnapshotError('as_of must match YYYY-MM-DD');
  if (typeof raw.source !== 'string') throw new SnapshotError('source must be a string');
  if (!Number.isSafeInteger(raw.floor_usd) || raw.floor_usd <= 0) throw new SnapshotError('floor_usd must be a positive safe integer');
  if (!Array.isArray(raw.protocols)) throw new SnapshotError('protocols must be an array');
  if (!Array.isArray(raw.watchlist) || raw.watchlist.some((x: unknown) => typeof x !== 'string')) throw new SnapshotError('watchlist must be an array of strings');
  const protocols = raw.protocols.map((p: any, i: number): SnapshotProtocol => {
    const at = `protocols[${i}]`; if (!p || typeof p !== 'object' || Array.isArray(p)) throw new SnapshotError(`${at} must be an object`);
    for (const k of ['slug', 'name']) if (typeof p[k] !== 'string') throw new SnapshotError(`${at}.${k} must be a string`);
    if (p.category !== null && typeof p.category !== 'string') throw new SnapshotError(`${at}.category must be a string or null`);
    if (!Array.isArray(p.chains) || p.chains.some((x: unknown) => typeof x !== 'string')) throw new SnapshotError(`${at}.chains must be an array of strings`);
    const tvl_usd = finite(p.tvl_usd, `${at}.tvl_usd`);
    const change_7d = p.change_7d === null ? null : finite(p.change_7d, `${at}.change_7d`);
    const mcap_usd = p.mcap_usd === null ? null : finite(p.mcap_usd, `${at}.mcap_usd`);
    const listed_at = nullableString(p.listed_at, `${at}.listed_at`); if (listed_at !== null && !validDate(listed_at)) throw new SnapshotError(`${at}.listed_at must be a valid YYYY-MM-DD date or null`);
    const gecko_id = nullableString(p.gecko_id, `${at}.gecko_id`), symbol = nullableString(p.symbol, `${at}.symbol`);
    return { slug: p.slug, name: p.name, category: p.category, chains: [...p.chains], tvl_usd, change_7d, mcap_usd, listed_at, gecko_id, symbol };
  });
  return { as_of: raw.as_of, source: raw.source, floor_usd: raw.floor_usd, protocols, watchlist: [...raw.watchlist] };
}
export function ageDays(asOf: string, listedAt: string | null): number | null { if (listedAt === null || !validDate(asOf) || !validDate(listedAt)) return null; return Math.max(0, Math.floor((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${listedAt}T00:00:00Z`)) / 86400000)); }
export function recordsToken(p: SnapshotProtocol): boolean { return p.gecko_id !== null || p.symbol !== null; }
export function isProductKind(p: SnapshotProtocol): boolean { return PRODUCT_CATEGORIES.has(p.category ?? '') || /\b(wrapped|staked|staking)\b/i.test(p.name) || EXCHANGE_PREFIXES.some(x => p.name.toLowerCase().startsWith(x.toLowerCase())); }
export function isRankable(p: SnapshotProtocol): boolean { return !recordsToken(p) && !VERSIONED.test(p.name) && p.category !== 'CEX' && !isProductKind(p); }
export function isComp(p: SnapshotProtocol): boolean { return recordsToken(p) && p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0 && !VERSIONED.test(p.name) && p.category !== 'CEX' && !isProductKind(p); }
export function isTraded(p: SnapshotProtocol): boolean { return recordsToken(p) && p.mcap_usd !== null && p.category !== 'CEX'; }
export function inClockPopulation(p: SnapshotProtocol): boolean { return !VERSIONED.test(p.name) && p.category !== 'CEX' && !isProductKind(p); }
export function asideReason(p: SnapshotProtocol): string {
  if (recordsToken(p) && p.mcap_usd === null) return 'records a token with no market cap';
  if (VERSIONED.test(p.name)) return 'a versioned pool of another protocol';
  if (isProductKind(p) && !EXCHANGE_PREFIXES.some(x => p.name.toLowerCase().startsWith(x.toLowerCase()))) return 'a wrapped, staked or bridged product';
  if (p.category === 'CEX' || EXCHANGE_PREFIXES.some(x => p.name.toLowerCase().startsWith(x.toLowerCase()))) return 'an exchange';
  return 'records no token, set aside by rule';
}

function median(v: number[]): number { const a = [...v].sort((x, y) => x - y), n = a.length; return n ? (n % 2 ? a[(n - 1) / 2]! : (a[n / 2 - 1]! + a[n / 2]!) / 2) : 0; }
function ols(xs: number[], ys: number[]): { a: number; b: number } { const mx = xs.reduce((s, x) => s + x, 0) / xs.length, my = ys.reduce((s, x) => s + x, 0) / ys.length; let cov = 0, vv = 0; for (let i = 0; i < xs.length; i++) { cov += (xs[i]! - mx) * (ys[i]! - my); vv += (xs[i]! - mx) ** 2; } const b = vv ? cov / vv : 0; return { a: my - b * mx, b }; }
export function huberFit(xs: number[], ys: number[]): { a: number; b: number } { let fit = ols(xs, ys); for (let it = 0; it < 25; it++) { const r = ys.map((y, i) => y - fit.a - fit.b * xs[i]!), m = median(r), mad = median(r.map(x => Math.abs(x - m))), d = 1.345 * (mad === 0 ? 0.1 : mad) / 0.6745; let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0; for (let i = 0; i < xs.length; i++) { const w = Math.abs(r[i]!) <= d ? 1 : d / Math.abs(r[i]!); sw += w; sx += w * xs[i]!; sy += w * ys[i]!; sxx += w * xs[i]! ** 2; sxy += w * xs[i]! * ys[i]!; } const den = sw * sxx - sx * sx; const b = den ? (sw * sxy - sx * sy) / den : 0; fit = { a: (sy - b * sx) / sw, b }; } return fit; }
export function clampChange(c: number | null): number { return c === null ? 0 : Math.max(-60, Math.min(120, c)); }
export function growthInput(p: SnapshotProtocol): number { return clampChange(p.change_7d) / 100; }
export function logGrowthInput(p: SnapshotProtocol): number { return Math.log1p(growthInput(p)); }
export function seasonInput(p: SnapshotProtocol, asOf: string): number { return 1 - Math.exp(-(ageDays(asOf, p.listed_at) ?? UNKNOWN_AGE_DAYS) / 540); }

type FormFit = { a: number; b: number; g: number; s: number; family: Record<string, number>; predict: (p: SnapshotProtocol) => number };
function familyOffsets(comps: SnapshotProtocol[], basePredict: (p: SnapshotProtocol) => number): Record<string, number> { const sums = new Map<string, number[]>(); comps.forEach(p => { const c = p.category ?? '', r = Math.log10(p.mcap_usd!) - basePredict(p); sums.set(c, [...(sums.get(c) ?? []), r]); }); const family: Record<string, number> = {}; for (const [c, rs] of sums) family[c] = rs.reduce((s, x) => s + x, 0) / rs.length * rs.length / (rs.length + 16); return family; }
function fitForm(comps: SnapshotProtocol[], asOf: string, variant: Variant): FormFit {
  if (variant === 'flat') { const ratio = median(comps.map(p => p.mcap_usd! / p.tvl_usd)), rawA = Math.log10(Math.max(ratio, 1e-12)), shift = median(comps.map(p => Math.log10(p.mcap_usd!) - rawA - Math.log10(Math.max(1e-12, p.tvl_usd)))), a = rawA + shift; return { a, b: 1, g: 0, s: 0, family: {}, predict: p => a + Math.log10(Math.max(1e-12, p.tvl_usd)) }; }
  const base: Variant = variant === 'family' ? 'loggrowth' : variant;
  const xs = comps.map(p => Math.log10(Math.max(1e-12, p.tvl_usd))), ys = comps.map(p => Math.log10(p.mcap_usd!));
  const f = huberFit(xs, ys), residual = ys.map((y, i) => y - f.a - f.b * xs[i]!);
  const gIn = base === 'growth' ? growthInput : logGrowthInput;
  let g = 0, s = 0;
  if (base === 'growth' || base === 'loggrowth' || base === 'loggrowthseason') g = ols(comps.map(gIn), residual).b;
  if (base === 'loggrowthseason') { const r2 = residual.map((r, i) => r - g * gIn(comps[i]!)); s = ols(comps.map(p => seasonInput(p, asOf)), r2).b; }
  const family: Record<string, number> = {};
  const raw = (p: SnapshotProtocol) => f.a + f.b * Math.log10(Math.max(1e-12, p.tvl_usd)) + (base === 'curve' ? 0 : g * gIn(p)) + (base === 'loggrowthseason' ? s * seasonInput(p, asOf) : 0);
  const shift = median(comps.map(p => Math.log10(p.mcap_usd!) - raw(p)));
  const centered = (p: SnapshotProtocol) => raw(p) + shift;
  if (variant === 'family') { const off = familyOffsets(comps, centered); Object.assign(family, off); return { a: f.a + shift, b: f.b, g, s, family, predict: p => centered(p) + (off[p.category ?? ''] ?? 0) }; }
  return { a: f.a + shift, b: f.b, g, s, family, predict: centered };
}
function ranks(v: number[]): number[] { const order = v.map((x, i) => ({ x, i })).sort((a, b) => a.x - b.x || a.i - b.i), r = Array(v.length); order.forEach((o, i) => r[o.i] = i + 1); return r; }
function spearman(a: number[], b: number[]): number { if (a.length < 2) return 0; const x = ranks(a), y = ranks(b), mx = (a.length + 1) / 2; let n = 0, d = 0; for (let i = 0; i < a.length; i++) { n += (x[i]! - mx) * (y[i]! - mx); d += (x[i]! - mx) ** 2; } return d ? n / d : 0; }
export function looEvaluate(comps: SnapshotProtocol[], asOf: string, variant: Variant): { medianMiss: number; within3: number; spearman: number } { const miss: number[] = [], pred: number[] = [], actual: number[] = []; for (let i = 0; i < comps.length; i++) { const train = comps.filter((_, j) => j !== i), p = comps[i]!, fit = fitForm(train, asOf, variant), v = 10 ** fit.predict(p); pred.push(v); actual.push(p.mcap_usd!); miss.push(Math.max(v / p.mcap_usd!, p.mcap_usd! / v)); } return { medianMiss: median(miss), within3: miss.filter(x => x <= 3).length / miss.length, spearman: spearman(pred, actual) }; }
function adoptedModel(comps: SnapshotProtocol[], asOf: string): { model: ValueModel; variant: Variant; evals: { variant: Variant; medianMiss: number; within3: number; spearman: number }[] } {
  const evals = VARIANTS.map(v => ({ variant: v, ...looEvaluate(comps, asOf, v) }));
  let best = evals[1]!; for (const e of evals) if (e.variant !== 'flat' && e.medianMiss < best.medianMiss) best = e;
  const fit = fitForm(comps, asOf, best.variant);
  return { variant: best.variant, evals, model: { kind: best.variant, a: fit.a, b: fit.b, growthCoef: fit.g, seasonCoef: fit.s, family: fit.family } };
}
function modelLog10(p: SnapshotProtocol, m: ValueModel, asOf: string): number { const kind = m.kind; const x = Math.log10(Math.max(1e-12, p.tvl_usd)); let v = m.a + m.b * x; if (kind === 'growth') v += m.growthCoef * growthInput(p); if (kind === 'loggrowth' || kind === 'loggrowthseason' || kind === 'family') v += m.growthCoef * logGrowthInput(p); if (kind === 'loggrowthseason') v += m.seasonCoef * seasonInput(p, asOf); if (kind === 'family') v += m.family[p.category ?? ''] ?? 0; return v; }
export function impliedValue(p: SnapshotProtocol, model: ValueModel, asOf: string): { value: number; factors: { curveValue: number; growthMult: number; seasonMult: number; familyMult: number } } {
  const curve = Math.max(1, Math.round(10 ** (model.a + model.b * Math.log10(Math.max(1e-12, p.tvl_usd)))));
  const gm = model.kind === 'curve' || model.kind === 'flat' ? 1 : model.kind === 'growth' ? Math.max(.35, Math.min(2, 10 ** (model.growthCoef * growthInput(p)))) : Math.max(.35, Math.min(2, 10 ** (model.growthCoef * logGrowthInput(p))));
  const sm = model.kind === 'loggrowthseason' ? Math.max(.4, Math.min(1.6, 10 ** (model.seasonCoef * seasonInput(p, asOf)))) : 1;
  const fm = model.kind === 'family' ? Math.max(.4, Math.min(2.5, 10 ** (model.family[p.category ?? ''] ?? 0))) : 1;
  return { value: Math.max(1, Math.round(curve * gm * sm * fm)), factors: { curveValue: curve, growthMult: Number(gm.toFixed(4)), seasonMult: Number(sm.toFixed(4)), familyMult: Number(fm.toFixed(4)) } };
}
function percentile(v: number[], q: number): number { const a = [...v].sort((x, y) => x - y); return a.length ? a[Math.max(0, Math.ceil(q * a.length) - 1)]! : 0; }
function residualBands(comps: SnapshotProtocol[], m: ValueModel, asOf: string): { global: number[]; buckets: Map<number, number[]> } { const all: number[] = [], bucket = new Map<number, number[]>(), qs = (v: number[]) => [.1, .25, .75, .9].map(q => Math.max(-1, Math.min(1, percentile(v, q)))); for (let i = 0; i < comps.length; i++) { const tr = comps.filter((_, j) => j !== i), p = comps[i]!, fit = fitForm(tr, asOf, m.kind), r = Math.log10(p.mcap_usd!) - fit.predict(p), key = Math.floor(Math.log10(p.tvl_usd)); all.push(r); bucket.set(key, [...(bucket.get(key) ?? []), r]); } return { global: qs(all), buckets: new Map([...bucket].filter(([, v]) => v.length >= 8).map(([k, v]) => [k, qs(v)])) }; }
function mulberry32(seed: number): () => number { return () => { let t = seed += 0x6D2B79F5; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function nearestRank(v: number[], q: number): number { return [...v].sort((a, b) => a - b)[Math.max(0, Math.ceil(q * v.length) - 1)] ?? 0; }
function buildRanges(comps: SnapshotProtocol[], ranked: SnapshotProtocol[], m: ValueModel, asOf: string): Map<string, [number, number]> { const rng = mulberry32(0x9E3779B9), rr = new Map<string, number[]>(); for (let it = 0; it < 200; it++) { const sample = Array.from({ length: comps.length }, () => comps[Math.floor(rng() * comps.length)]!), fit = fitForm(sample, asOf, m.kind), mm: ValueModel = { kind: m.kind, a: fit.a, b: fit.b, growthCoef: fit.g, seasonCoef: fit.s, family: fit.family }; ranked.map(p => ({ p, v: impliedValue(p, mm, asOf).value })).sort((x, y) => y.v - x.v || x.p.slug.localeCompare(y.p.slug)).forEach((x, i) => rr.set(x.p.slug, [...(rr.get(x.p.slug) ?? []), i + 1])); } return new Map([...rr].map(([k, v]) => [k, [nearestRank(v, .1), nearestRank(v, .9)]])); }

/* ---- stage two: the launch clock (current-status logistic fit) ---- */
export function clockFeatures(tvl: number, age: number, chains: number): number[] { return [Math.log10(Math.max(1, tvl)), Math.log10(age + 30), Math.min(chains, 8)]; }
function solveLinear(A: number[][], b: number[]): number[] { const n = b.length, M = A.map((row, i) => [...row, b[i]!]); for (let c = 0; c < n; c++) { let piv = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[piv]![c]!)) piv = r; const tmp = M[c]!; M[c] = M[piv]!; M[piv] = tmp; const d = M[c]![c]! || 1e-12; for (let r = 0; r < n; r++) { if (r === c) continue; const f = M[r]![c]! / d; for (let k = c; k <= n; k++) M[r]![k]! -= f * M[c]![k]!; } } return M.map((row, i) => row[n]! / (row[i]! || 1e-12)); }
export function fitClock(rows: { x: number[]; y: number }[]): number[] {
  const X = rows.map(r => [1, ...r.x]), y = rows.map(r => r.y), k = X[0]!.length, beta = new Array(k).fill(0);
  for (let it = 0; it < 100; it++) {
    const grad = new Array(k).fill(0), H = Array.from({ length: k }, () => new Array(k).fill(0));
    for (let i = 0; i < X.length; i++) { const z = X[i]!.reduce((s, v, j) => s + v * beta[j]!, 0), pr = 1 / (1 + Math.exp(-z)), w = pr * (1 - pr); for (let a = 0; a < k; a++) { grad[a]! += X[i]![a]! * (y[i]! - pr); for (let b = 0; b < k; b++) H[a]![b]! += X[i]![a]! * w * X[i]![b]!; } }
    for (let a = 1; a < k; a++) { grad[a]! -= beta[a]!; H[a]![a]! += 1; }
    const step = solveLinear(H, grad); let maxStep = 0; for (let a = 0; a < k; a++) { beta[a]! += step[a]!; maxStep = Math.max(maxStep, Math.abs(step[a]!)); }
    if (maxStep < 1e-10) break;
  }
  return beta;
}
export function clockF(beta: number[], tvl: number, age: number, chains: number): number { const x = clockFeatures(tvl, age, chains), z = beta[0]! + beta[1]! * x[0]! + beta[2]! * x[1]! + beta[3]! * x[2]!; return 1 / (1 + Math.exp(-z)); }
export function hazard12(beta: number[], tvl: number, age: number, chains: number): number { const f0 = clockF(beta, tvl, age, chains), f1 = clockF(beta, tvl, age + 365, chains); return (f1 - f0) / Math.max(1 - f0, 1e-9); }
function aucScore(y: number[], s: number[]): number { const order = s.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v || a.i - b.i), r = new Array(s.length).fill(0); let i = 0; while (i < order.length) { let j = i; while (j + 1 < order.length && order[j + 1]!.v === order[i]!.v) j++; const avg = (i + 1 + j + 1) / 2; for (let t = i; t <= j; t++) r[order[t]!.i] = avg; i = j + 1; } let pos = 0, neg = 0, sumPos = 0; y.forEach((v, idx) => { if (v === 1) { pos++; sumPos += r[idx]!; } else neg++; }); return pos && neg ? (sumPos - pos * (pos + 1) / 2) / (pos * neg) : 0; }
function clockValidation(rows: { x: number[]; y: number }[]): { auc: number; brier: number; baseBrier: number } {
  const rng = mulberry32(0xC10C), idx = rows.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const t = idx[i]!; idx[i] = idx[j]!; idx[j] = t; }
  const pred = new Array(rows.length).fill(0), folds = 10;
  for (let f = 0; f < folds; f++) { const test = new Set(idx.filter((_, i) => i % folds === f)), beta = fitClock(rows.filter((_, i) => !test.has(i))); rows.forEach((r, i) => { if (test.has(i)) { const z = beta[0]! + beta[1]! * r.x[0]! + beta[2]! * r.x[1]! + beta[3]! * r.x[2]!; pred[i] = 1 / (1 + Math.exp(-z)); } }); }
  const y = rows.map(r => r.y), base = y.reduce((s, v) => s + v, 0) / y.length;
  return { auc: aucScore(y, pred), brier: y.reduce((s, v, i) => s + (v - pred[i]!) ** 2, 0) / y.length, baseBrier: base * (1 - base) };
}

/* ---- farm economics: plans priced by expected value ---- */
export const FARM = { DEPOSITS: [1000, 10000] as const, AIRDROP_SHARE: .075, FORGONE_APR: .04, SETUP_MINUTES: 25, WEEKLY_MINUTES: 8, CLAIM_MINUTES: 10, WORTH_HOUR_FLOOR: 2, GAS: { ethereum: { setup: 6, weekly: 4, claim: 1.5 }, solana: { setup: .05, weekly: .02, claim: .05 }, layer2: { setup: .6, weekly: .25, claim: .2 }, other: { setup: 1.5, weekly: .75, claim: .5 } } };
const YIELD_BEARING = new Set(['Lending', 'CDP', 'Yield', 'Risk Curators', 'Onchain Capital Allocator', 'RWA', 'Basis Trading', 'Collateral Management']);
type ChainClass = 'ethereum' | 'solana' | 'layer2' | 'other';
function chainClass(p: SnapshotProtocol): ChainClass { const c = p.chains[0] ?? ''; if (c === 'Ethereum') return 'ethereum'; if (c === 'Solana') return 'solana'; if (!p.chains.length) return 'other'; return 'layer2'; }
function weeksFor(age: number | null): number { return age === null ? 8 : age < 180 ? 12 : age < 365 ? 10 : age < 730 ? 8 : 6; }
function round2(n: number): number { return Math.round((n + Number.EPSILON) * 100) / 100; }
export function farmEconomics(p: SnapshotProtocol, impliedValueUsd: number, age: number | null, deposit: number, hz: number) {
  const weeks = weeksFor(age), gas = FARM.GAS[chainClass(p)], slice = FARM.AIRDROP_SHARE * impliedValueUsd * deposit / (deposit + p.tvl_usd), costs = gas.setup + gas.weekly * weeks + gas.claim, forgone = YIELD_BEARING.has(p.category ?? '') ? 0 : round2(deposit * FARM.FORGONE_APR * weeks / 52), hours = (FARM.SETUP_MINUTES + FARM.WEEKLY_MINUTES * weeks + FARM.CLAIM_MINUTES) / 60, breakeven = slice > 0 ? (costs + forgone) / slice : Infinity, expectedSlice = hz * slice, expectedNet = expectedSlice - costs - forgone, expectedNetHour = expectedNet / hours;
  const verdict = expectedNet > 0 && expectedNetHour >= FARM.WORTH_HOUR_FLOOR ? 'Worth farming' : expectedNet > 0 || breakeven <= 2 * hz ? 'Marginal' : 'Skip';
  return { deposit, weeks, slice: round2(slice), costs: round2(costs), forgone, hours, breakeven: Number(breakeven.toFixed(4)), hazard12: Number(hz.toFixed(4)), expected_slice: round2(expectedSlice), expected_net: round2(expectedNet), expected_net_hour: round2(expectedNetHour), verdict };
}
function actionFor(p: SnapshotProtocol, chain: string): string { const c = p.category ?? ''; if (/Lending|CDP|Collateral/i.test(c)) return `Supply the deposit as USDC collateral to ${p.name} and leave it supplied; borrow nothing, or borrow under a third and re-supply it if the protocol counts borrows.`; if (/Dexs|Trading/i.test(c)) return `Provide the deposit to ${p.name}'s highest-TVL pool and keep the LP position.`; if (/Yield|Vaults|Risk Curators|Onchain Capital Allocator/i.test(c)) return `Deposit into ${p.name}'s largest vault and keep the shares.`; if (/Derivatives|Perps/i.test(c)) return `Deposit the deposit as margin on ${p.name} and open one small hedged position.`; if (/Bridge/i.test(c)) return `Bridge the deposit through ${p.name} to ${chain} and use it in one app there.`; if (/RWA/i.test(c)) return `Mint ${p.name}'s yield asset with the deposit and hold it.`; if (/Prediction Market/i.test(c)) return `Fund the ${p.name} account and place one position a week.`; return `Deposit into ${p.name}'s main product on ${chain} and keep the position open.`; }
export type FarmStep = { when: string; text: string; cost: string; time: string };
export function farmSteps(p: SnapshotProtocol, age: number | null, hz: number, econ10k: ReturnType<typeof farmEconomics>): FarmStep[] {
  const chain = p.chains[0] ?? 'the protocol\'s main chain', cls = chainClass(p), gas = FARM.GAS[cls], weeks = econ10k.weeks, forgone = econ10k.forgone.toFixed(2), hzPct = Math.round(hz * 100);
  const waitCost = econ10k.forgone > 0 ? `the deposit stays in the position; the yield it gives up is about $${forgone} over ${weeks} weeks` : `the deposit stays in the position; it earns the product's own yield while it waits, so no yield is given up`;
  const qualifier = cls === 'ethereum' ? 'an Ethereum mainnet wallet, where one transaction costs dollars, not cents' : cls === 'solana' ? 'a Solana wallet, where fees are cents' : cls === 'layer2' ? 'a layer-2 wallet, where fees are well under a dollar' : 'the protocol\'s main chain';
  return [
    { when: 'Day 0', text: `Open ${p.name} only from its DefiLlama listing, bookmark the domain, confirm the listing records no token, and use a fresh wallet that holds only farm funds.`, cost: '$0.00', time: '5 min' },
    { when: 'Day 0', text: `Read the countdown first: protocols of ${p.name}'s age and size launch at about ${hzPct}% a year on this snapshot's clock, so size the position for a wait of about ${weeks} weeks, not for a date.`, cost: '$0.00', time: '5 min' },
    { when: 'Day 0', text: `Move the deposit plus gas money to a fresh wallet on ${chain}: ${qualifier}.`, cost: `about $${gas.setup.toFixed(2)} to withdraw and make the first transaction`, time: '10 min' },
    { when: 'Day 0', text: actionFor(p, chain), cost: `the deposit stays in the position, plus about $${gas.setup.toFixed(2)} of gas`, time: '15 min to set up' },
    { when: 'Week 1', text: `Repeat a small qualifying action (a deposit top-up, a swap, a borrow or a vote) so the wallet reads as a user, not a snapshot tourist.`, cost: `about $${gas.weekly.toFixed(2)} of gas a week`, time: '8 min a week' },
    { when: `Weeks 1-${weeks}`, text: `Keep the position open for the full ${weeks} weeks so activity spans more than one snapshot of ${p.name}'s records; do not chase a points page that is not linked from the bookmarked domain.`, cost: waitCost, time: `${weeks} weeks` },
    { when: 'Any day', text: `If ${p.name}'s TVL falls by more than a third from entry, or it reports bad debt, a pause or an exploit, withdraw at once and end the plan; a farm is an option, not an obligation.`, cost: `about $${gas.claim.toFixed(2)} to withdraw`, time: '15 min' },
    { when: 'At the end', text: `If a token launches, claim only through the domain bookmarked on day 0, never a link from a DM, an ad or a reply; a claim that asks for a fee or seed phrase is theft, not a launch. Then log the wallet, dates and every transaction so the position can be repeated or unwound.`, cost: '$0.00 to check; never pay to claim', time: '10 min' }];
}
export function stepText(step: FarmStep): string { let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`.trim(); if (s.length < 20) s = s.padEnd(20, '.'); if (s.length > 600) s = s.slice(0, 596) + '...'; return s; }
function compsNear(p: SnapshotProtocol, comps: SnapshotProtocol[], model: ValueModel, asOf: string) { return [...comps].sort((x, y) => Number((x.category ?? '') !== (p.category ?? '')) - Number((y.category ?? '') !== (p.category ?? '')) || Math.abs(Math.log10(x.tvl_usd) - Math.log10(p.tvl_usd)) - Math.abs(Math.log10(y.tvl_usd) - Math.log10(p.tvl_usd)) || x.slug.localeCompare(y.slug)).slice(0, 4).map(c => { const curve = Math.max(1, Math.round(10 ** (model.a + model.b * Math.log10(Math.max(1e-12, c.tvl_usd))))); return { name: c.name, symbol: c.symbol, tvl_usd: c.tvl_usd, mcap_usd: c.mcap_usd, curve_value_usd: curve, ratio: Number((c.mcap_usd! / curve).toFixed(4)) }; }); }

export function buildBoard(snapshot: Snapshot, model: ValueModel, clock: ClockModel, bands: { global: number[]; buckets: Map<number, number[]> }): BoardRow[] {
  const ranked = snapshot.protocols.filter(isRankable), comps = snapshot.protocols.filter(isComp), ranges = buildRanges(comps, ranked, model, snapshot.as_of);
  return ranked.map(p => {
    const out = impliedValue(p, model, snapshot.as_of), age = ageDays(snapshot.as_of, p.listed_at), hz = hazard12(clock.beta, p.tvl_usd, age ?? UNKNOWN_AGE_DAYS, p.chains.length), key = Math.floor(Math.log10(p.tvl_usd)), qs = bands.buckets.get(key), q = qs && qs.length ? qs : bands.global;
    const band = q.map(x => Math.max(1, Math.round(out.value * 10 ** x))); const ordered = [band[0]!, band[1]!, band[2]!, band[3]!].sort((x, y) => x - y);
    const econ = { '1000': farmEconomics(p, out.value, age, 1000, hz), '10000': farmEconomics(p, out.value, age, 10000, hz) }, steps = farmSteps(p, age, hz, econ['10000']);
    return { rank: 0, slug: p.slug, name: p.name, category: p.category, chains: p.chains, tvl_usd: p.tvl_usd, change_7d: p.change_7d, mcap_usd: null, listed_at: p.listed_at, gecko_id: null, symbol: null, token_status: 'pre-token', age_days: age, implied_value_usd: out.value, model: { curve_value_usd: out.factors.curveValue, growth_multiplier: out.factors.growthMult, season_multiplier: out.factors.seasonMult, family_multiplier: out.factors.familyMult }, band: ordered, rank_range: ranges.get(p.slug) ?? [0, 0], clock: { profile_match: Number(clockF(clock.beta, p.tvl_usd, age ?? UNKNOWN_AGE_DAYS, p.chains.length).toFixed(4)), hazard12: Number(hz.toFixed(4)) }, watchlist: snapshot.watchlist.includes(p.slug), above_floor: p.tvl_usd >= snapshot.floor_usd && !snapshot.watchlist.includes(p.slug), econ, verdict: econ['10000'].verdict, steps, farm_steps: steps.map(stepText), comps_near: compsNear(p, comps, model, snapshot.as_of) };
  }).sort((x, y) => y.implied_value_usd - x.implied_value_usd || x.slug.localeCompare(y.slug)).map((r, i) => ({ ...r, rank: i + 1 }));
}
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null { const slugs = new Set(board.map(x => x.slug)); for (const s of snapshot.watchlist) if (!slugs.has(s)) return `watchlist slug missing: ${s}`; for (let i = 0; i < board.length; i++) if (board[i]!.rank !== i + 1) return 'ranks are not exactly 1..N'; for (let i = 1; i < board.length; i++) if (board[i - 1]!.implied_value_usd < board[i]!.implied_value_usd) return 'implied value rises as rank ascends'; if (board.length && new Set(board.map(x => x.implied_value_usd)).size === 1) return 'all rows share one implied value'; for (const r of board) { if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `invalid implied value: ${r.slug}`; const steps = r.farm_steps ?? []; if (steps.length < 3 || steps.length > 12) return `farm step count invalid: ${r.slug}`; for (const s of steps) { const n = String(s).trim().length; if (n < 20 || n > 600) return `farm step length invalid: ${r.slug}`; } } return null; }
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: Record<string, any> } {
  const comps = snapshot.protocols.filter(isComp), { model, variant, evals } = adoptedModel(comps, snapshot.as_of), loo = looEvaluate(comps, snapshot.as_of, variant);
  const clockRows = snapshot.protocols.filter(inClockPopulation).map(p => ({ x: clockFeatures(p.tvl_usd, ageDays(snapshot.as_of, p.listed_at) ?? UNKNOWN_AGE_DAYS, p.chains.length), y: recordsToken(p) ? 1 : 0, slug: p.slug, tvl_usd: p.tvl_usd, age_days: ageDays(snapshot.as_of, p.listed_at), chains: p.chains.length }));
  const beta = fitClock(clockRows), cv = clockValidation(clockRows);
  const clock: ClockModel = { beta, population: clockRows.length, launched: clockRows.filter(r => r.y === 1).length, waiting: clockRows.filter(r => r.y === 0).length, cvAuc: cv.auc, cvBrier: cv.brier, baseBrier: cv.baseBrier };
  const dated = comps.filter(p => p.listed_at !== null).sort((x, y) => (ageDays(snapshot.as_of, y.listed_at) ?? 0) - (ageDays(snapshot.as_of, x.listed_at) ?? 0) || x.slug.localeCompare(y.slug));
  let timeSplitMiss: number | null = null;
  if (dated.length >= 10) { const cut = Math.floor(dated.length / 2), train = dated.slice(0, cut), test = dated.slice(cut), fit = fitForm(train, snapshot.as_of, variant); timeSplitMiss = median(test.map(p => { const v = 10 ** fit.predict(p); return Math.max(v / p.mcap_usd!, p.mcap_usd! / v); })); }
  const bands = residualBands(comps, model, snapshot.as_of);
  const board = buildBoard(snapshot, model, clock, bands);
  const traded = snapshot.protocols.filter(isTraded).map(p => { const curve = Math.max(1, Math.round(10 ** (model.a + model.b * Math.log10(Math.max(1e-12, p.tvl_usd))))); return { slug: p.slug, name: p.name, symbol: p.symbol, category: p.category, chains: p.chains, tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd, change_7d: p.change_7d, curve_value_usd: curve, ratio: Number((p.mcap_usd! / curve).toFixed(4)) }; }).sort((x, y) => y.mcap_usd! - x.mcap_usd! || x.slug.localeCompare(y.slug));
  const tradedSlugs = new Set(traded.map(x => x.slug));
  const aside = snapshot.protocols.filter(p => !isRankable(p) && !tradedSlugs.has(p.slug)).map(p => ({ slug: p.slug, name: p.name, category: p.category, tvl_usd: p.tvl_usd, reason: asideReason(p) })).sort((x, y) => y.tvl_usd - x.tvl_usd || x.slug.localeCompare(y.slug));
  const above = board.filter(x => x.above_floor).length, early = board.filter(x => x.tvl_usd < snapshot.floor_usd && !x.watchlist).length;
  const medTvl = median(clockRows.map(r => r.tvl_usd));
  const clockCurve = [90, 180, 365, 548, 730, 1095, 1460, 1825, 2190, 2555].map(a => ({ age: a, f: Number(clockF(beta, medTvl, a, 1).toFixed(4)), hazard: Number(hazard12(beta, medTvl, a, 1).toFixed(4)) }));
  const scatter = (() => { const xs = comps.map(p => Math.log10(p.tvl_usd)), lo = Math.min(...xs), hi = Math.max(...xs), q = bands.global, round = (v: number) => Number(v.toFixed(3)), points = Array.from({ length: 25 }, (_, i) => lo + (hi - lo) * i / 24); return { comps: comps.map(p => [round(Math.log10(p.tvl_usd)), round(Math.log10(p.mcap_usd!))]), curve: points.map(x => [round(x), round(model.a + model.b * x)]), band: points.map(x => { const y = model.a + model.b * x; return [round(x), round(y + q[1]!), round(y + q[2]!)]; }) }; })();
  const validation = { comps: comps.length, looMedianMiss: loo.medianMiss, looWithin3: loo.within3, looSpearman: loo.spearman, flatMedianMiss: looEvaluate(comps, snapshot.as_of, 'flat').medianMiss, timeSplitMiss, ablation: evals.map(x => ({ variant: x.variant, label: VARIANT_LABELS[x.variant], medianMiss: x.medianMiss, within3: x.within3 })), refits: 200, scatter };
  const bandTable = { global: bands.global, buckets: Object.fromEntries([...bands.buckets].map(([k, v]) => [String(k), v])) };
  return { board, radar: { as_of: snapshot.as_of, source: snapshot.source, floor_usd: snapshot.floor_usd, model_version: 'tminus-1', model, clock: { beta: clock.beta, population: clock.population, launched: clock.launched, waiting: clock.waiting, cv_auc: clock.cvAuc, cv_brier: clock.cvBrier, base_brier: clock.baseBrier, curve: clockCurve }, validation, band_table: bandTable, counts: { protocols: snapshot.protocols.length, watchlist: snapshot.watchlist.length, ranked: board.length, above_floor: above, early, traded: traded.length, aside: aside.length }, early_size: early, live_size: above, rows: board, traded, aside, farm: { deposits: FARM.DEPOSITS, airdrop_share: FARM.AIRDROP_SHARE, forgone_apr: FARM.FORGONE_APR, worth_hour_floor: FARM.WORTH_HOUR_FLOOR, minutes: { setup: FARM.SETUP_MINUTES, weekly: FARM.WEEKLY_MINUTES, claim: FARM.CLAIM_MINUTES }, gas: FARM.GAS, yield_bearing_categories: [...YIELD_BEARING].sort() }, raw: { comps: comps.map(p => ({ slug: p.slug, category: p.category, tvl_usd: p.tvl_usd, change_7d: p.change_7d, mcap_usd: p.mcap_usd, listed_at: p.listed_at })), clock: clockRows.map(r => ({ tvl_usd: r.tvl_usd, age_days: r.age_days, chains: r.chains, launched: r.y })) } } };
}
export function dataScript(radar: Record<string, any>): string { return `window.TMINUS=${JSON.stringify(radar)};\n`; }
