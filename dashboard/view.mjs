
const CMP = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
export const VIEWS = ['candidates', 'unrecorded', 'recorded', 'all'];
export const COVERAGE = ['', 'watchlist', 'outside', 'structural', 'low'];
export const SORT_KEYS = ['rank', 'name', 'tvl_usd', 'change_7d', 'implied_value_usd', 'age_days', 'rank_delta'];
export const DEFAULT_STATE = { view: 'candidates', q: '', category: '', chain: '', coverage: '',
  sort: 'implied_value_usd', direction: -1, page: 0 };
export function inView(row, view) {
  if (view === 'candidates') return row.token_status === 'unrecorded' && !row.structural_caution;
  if (view === 'unrecorded') return row.token_status === 'unrecorded';
  if (view === 'recorded') return row.token_status === 'recorded';
  return true;
}
export function filterRows(rows, f) {
  const q = (f.q || '').trim().toLowerCase();
  const category = f.category || '', chain = f.chain || '', coverage = f.coverage || '';
  return rows.filter(row => {
    if (!inView(row, f.view || 'candidates')) return false;
    if (category && (row.category || 'Unclassified') !== category) return false;
    if (chain && !row.chains.includes(chain)) return false;
    if (coverage === 'watchlist' && !row.watchlist) return false;
    if (coverage === 'outside' && row.watchlist) return false;
    if (coverage === 'structural' && !row.structural_caution) return false;
    if (coverage === 'low' && row.confidence !== 'Low') return false;
    if (q && !`${row.name} ${row.slug} ${row.symbol || ''}`.toLowerCase().includes(q)) return false;
    return true;
  });
}
export function compareRows(a, b, key, direction) {
  const av = a[key], bv = b[key];
  const aMissing = av === null || av === undefined, bMissing = bv === null || bv === undefined;
  if (aMissing && bMissing) return a.rank - b.rank;
  if (aMissing) return 1;
  if (bMissing) return -1;
  const delta = typeof av === 'string' ? CMP(av, bv) : av - bv;
  return delta * direction || a.rank - b.rank;
}
export function sortRows(rows, key, direction) {
  const k = SORT_KEYS.includes(key) ? key : 'implied_value_usd';
  const dir = direction === 1 ? 1 : -1;
  return [...rows].sort((a, b) => compareRows(a, b, k, dir));
}
export function pageCount(total, size) { return Math.max(1, Math.ceil(total / size)); }
export function pageSlice(rows, page, size) {
  const pages = pageCount(rows.length, size);
  const p = Math.min(Math.max(Math.trunc(page) || 0, 0), pages - 1);
  return { rows: rows.slice(p * size, (p + 1) * size), page: p, pages,
    first: rows.length ? p * size + 1 : 0, last: Math.min((p + 1) * size, rows.length) };
}
const FILTER_NAMES = { watchlist: 'Official watchlist only', outside: 'Beyond watchlist',
  structural: 'Structural caution only', low: 'Low confidence only' };
const VIEW_NAMES = { candidates: 'Research candidates', unrecorded: 'All no-token records',
  recorded: 'Token benchmarks', all: 'Full universe' };
export function activeFilters(f) {
  const out = [{ key: 'view', label: VIEW_NAMES[f.view || 'candidates'] || VIEW_NAMES.candidates }];
  if (f.q) out.push({ key: 'q', label: `Search “${f.q}”` });
  if (f.category) out.push({ key: 'category', label: `Category: ${f.category}` });
  if (f.chain) out.push({ key: 'chain', label: `Chain: ${f.chain}` });
  if (f.coverage) out.push({ key: 'coverage', label: FILTER_NAMES[f.coverage] || f.coverage });
  return out;
}
export function encodeHash(f) {
  const params = new URLSearchParams();
  const s = { ...DEFAULT_STATE, ...f };
  if (s.view !== DEFAULT_STATE.view) params.set('view', s.view);
  if (s.q) params.set('q', s.q);
  if (s.category) params.set('category', s.category);
  if (s.chain) params.set('chain', s.chain);
  if (s.coverage) params.set('coverage', s.coverage);
  if (s.sort !== DEFAULT_STATE.sort) params.set('sort', s.sort);
  if (s.direction !== DEFAULT_STATE.direction) params.set('dir', s.direction === 1 ? 'asc' : 'desc');
  if (s.page > 0) params.set('page', String(s.page));
  const text = params.toString();
  return text ? `#${text}` : '';
}
export function decodeHash(hash) {
  const params = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  const view = VIEWS.includes(params.get('view')) ? params.get('view') : DEFAULT_STATE.view;
  const sort = SORT_KEYS.includes(params.get('sort')) ? params.get('sort') : DEFAULT_STATE.sort;
  const dir = params.get('dir');
  const page = Number(params.get('page'));
  return { view, sort, q: (params.get('q') || '').slice(0, 80),
    category: (params.get('category') || '').slice(0, 80),
    chain: (params.get('chain') || '').slice(0, 80),
    coverage: COVERAGE.includes(params.get('coverage')) ? params.get('coverage') : '',
    direction: dir === 'asc' ? 1 : dir === 'desc' ? -1 : DEFAULT_STATE.direction,
    page: Number.isSafeInteger(page) && page > 0 ? Math.min(page, 100000) : 0 };
}
export function formatUsd(value) {
  if (value === null || value === undefined || value < 0) return 'Unavailable';
  for (const [n, suffix] of [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']]) {
    if (value >= n) return `$${(value / n).toFixed(2)}${suffix}`;
  }
  return '$' + Math.round(value).toLocaleString('en-US');
}
export function formatExact(value) {
  return value === null || value === undefined || value < 0 ? 'Unavailable'
    : '$' + value.toLocaleString('en-US', { maximumFractionDigits: 2 });
}
export function formatPct(value) { return value === null || value === undefined ? '—' : `${value > 0 ? '+' : ''}${value.toFixed(2)}%`; }
export function formatFactor(value) { return `${value.toFixed(3)}×`; }
export function formatAge(days) {
  if (days === null || days === undefined) return 'Unknown';
  if (days < 60) return `${days}d`;
  if (days < 730) return `${Math.round(days / 30.44)}mo`;
  return `${(days / 365.25).toFixed(1)}y`;
}
export function formatDelta(delta) {
  if (!Number.isFinite(delta) || delta === 0) return '±0';
  return delta > 0 ? `+${delta}` : `−${Math.abs(delta)}`;
}
export function stepLabel(step, index, plan) {
  const stage = `${String(index + 1).padStart(2, '0')} / ${step.stage}`;
  const cost = step.usd_low === 0 && step.usd_high === 0 ? '$0' : `$${step.usd_low}–$${step.usd_high}`;
  const principal = step.requires_capital && plan.capital_usd ? `, principal up to $${plan.capital_usd} at risk` : '';
  return `${stage} — ${step.text} Time: ${step.minutes} min. Cost: ${cost}${principal}.`;
}
export function planTotals(steps, capital) {
  const fees = steps.reduce((n, s) => n + s.usd_low, 0);
  const feeHigh = steps.reduce((n, s) => n + s.usd_high, 0);
  return { minutes: steps.reduce((n, s) => n + s.minutes, 0), fee_low: fees, fee_high: feeHigh,
    peak_principal_usd: steps.some(s => s.requires_capital) ? capital : 0,
    capital_steps: steps.filter(s => s.requires_capital).length };
}
const FNV_OFFSET = 0xcbf29ce484222325n, FNV_PRIME = 0x100000001b3n, MASK64 = 0xffffffffffffffffn;
export function coverageDigest(slugs) {
  let h = FNV_OFFSET;
  for (const byte of new TextEncoder().encode([...new Set(slugs)].sort().join('\n'))) {
    h = ((h ^ BigInt(byte)) * FNV_PRIME) & MASK64;
  }
  return h.toString(16).padStart(16, '0');
}
export function coverageProof(listed, matched) {
  return coverageDigest([...listed.map(s => `w:${s}`), ...matched.map(s => `r:${s}`)]);
}
export function assertCoverage(summary, rows) {
  const listed = [...new Set(summary.watchlist_slugs || [])];
  const matched = rows.filter(r => r.watchlist).map(r => r.slug);
  const digest = coverageProof(listed, matched);
  if (digest !== summary.coverage_digest) {
    throw new Error(`Coverage digest mismatch: records give ${digest}, summary states ${summary.coverage_digest}`);
  }
  const absent = listed.filter(slug => !matched.includes(slug));
  if (absent.length) throw new Error(`Coverage digest matches but ${absent.length} watchlist slug(s) have no row`);
  return { digest, listed: listed.length, matched: matched.length };
}
export const MODEL_SPEC = {
  version: 'meridian-1.2',
  growth: { cap: 100, floor: -50, divisor: 200 },
  percentile: { base: 0.9, span: 0.2 },
  maturity: { floor: 0.65, range: 0.35, horizon: 1095 },
  renorm: 0.9,
  structural: 0.5,
  peer: { prior: 0.25, clip_low: 0.05, clip_high: 5, min_category: 4 },
  tvl_cap: 1e12,
  neutral_age_days: 365,
  review_days: 14,
  chain_max: 3,
};
const fx = n => `${Number(n.toFixed(4))}×`;
const signed = n => (n > 0 ? `+${n}` : `${n}`);
export function formulaText(spec = MODEL_SPEC) {
  const g = spec.growth, p = spec.percentile, m = spec.maturity;
  return `TVL (≤${spec.tvl_cap / 1e12}T) × peer multiple (${fx(spec.peer.clip_low)}–${fx(spec.peer.clip_high)}, median of ≥${spec.peer.min_category} category peers, else ${fx(spec.peer.prior)} prior) × growth (1 + clamp(g, ${signed(g.floor)}, ${signed(g.cap)})/${g.divisor} → ${fx(1 + g.floor / g.divisor)}–${fx(1 + g.cap / g.divisor)}) × percentile (${fx(p.base)}–${fx(p.base + p.span)}) × maturity (${fx(m.floor)}–${fx(m.floor + m.range)} by ${m.horizon} days since first record) × structural (${fx(spec.structural)} when flagged) × renormalisation (${fx(spec.renorm)} when the first record is missing, the age factor dropped)`;
}
export function methodSections(spec = MODEL_SPEC) {
  const g = spec.growth, p = spec.percentile, m = spec.maturity;
  return [
    { label: '01 / ANCHOR', title: 'Observed market cap / TVL',
      body: `Token-recorded rows with positive market cap and TVL are the comparison set; wrappers, bridges, CEXs and versioned products are excluded and shared token IDs count once. A category median needs ${spec.peer.min_category} independent peers, else a global median, else a ${fx(spec.peer.prior)} prior. Ratios clip to ${fx(spec.peer.clip_low)}–${fx(spec.peer.clip_high)}; each detail lists the peer slugs and counts.` },
    { label: '02 / GROWTH', title: 'Seven-day move and its rank',
      body: `Growth factor = 1 + clamp(seven-day change, ${signed(g.floor)}, ${signed(g.cap)}) / ${g.divisor}, so ${signed(g.cap)}% lifts value ${fx(1 + g.cap / g.divisor)} and ${signed(g.floor)}% cuts it to ${fx(1 + g.floor / g.divisor)}; a missing change is neutral. A second term, ${fx(p.base)}–${fx(p.base + p.span)}, scales the row by its mid-rank percentile among every reported move, so the same percentage is worth more when few protocols share it.` },
    { label: '03 / AGE', title: 'Operating age proxy',
      body: `Maturity = ${m.floor} + ${m.range} × √(min(days since first record, ${m.horizon}) / ${m.horizon}). That record is a lower bound on operating age, so maturity may be understated, never overstated. With no first record the factor is dropped and value renormalised by ${fx(spec.renorm)} (the snapshot's median maturity) instead of imputing an age; the row is Low confidence.` },
    { label: '04 / LIMIT', title: 'What the snapshot cannot say',
      body: `TVL is not revenue or equity; market cap is not FDV, which needs absent supply data. There is no price, unlock schedule, parent mapping, trusted app URL or campaign proof, and market-cap −1 is an unavailable sentinel. Δ TVL compares model rank with pure TVL rank, and the neutral-age sensitivity beside each score shows the value if the age proxy were exactly ${spec.neutral_age_days} days.` },
  ];
}
export function publishedScore(row) {
  const d = row.drivers, s = row.sensitivity;
  const value = d.tvl_used * d.peer_multiple * d.growth_factor * d.percentile_factor
    * d.age_factor * d.structure_factor * (d.age_dropped ? d.renorm_applied : 1);
  return Math.max(1, Math.round(Math.min(value, 1e14))) === row.implied_value_usd ? row.implied_value_usd : null;
}
