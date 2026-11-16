// Pure view logic: filters, comparators, pagination, formatting, URL-hash state. No DOM.
// The Node tests and app.js run these same functions, so a tested comparator is the shipped one.
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
