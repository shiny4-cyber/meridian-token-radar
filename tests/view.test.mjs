import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { filterRows, sortRows, pageSlice, pageCount, activeFilters, encodeHash, decodeHash,
  formatAge, formatDelta, DEFAULT_STATE } from '../dashboard/view.mjs';
import { parseSnapshot, buildRadar } from '../dashboard/model.mjs';

const snapshot = parseSnapshot(readFileSync(process.env.SNAPSHOT_PATH
  || '/root/work/makefun/token-radar/token-radar-01-kit/input/snapshot.json', 'utf8'));
const board = buildRadar(snapshot);
const rows = board.rows;
const base = { ...DEFAULT_STATE, view: 'all' };

test('watchlist filter returns exactly the official watchlist and nothing invented', () => {
  const shown = filterRows(rows, { ...base, coverage: 'watchlist' });
  assert.equal(shown.length, snapshot.watchlist.length);
  assert.deepEqual(shown.map(r => r.slug).sort(), [...snapshot.watchlist].sort());
  assert.ok(shown.every(r => r.watchlist));
});

test('beyond-watchlist filter is the complement and keeps every board row reachable', () => {
  const inside = filterRows(rows, { ...base, coverage: 'watchlist' });
  const outside = filterRows(rows, { ...base, coverage: 'outside' });
  assert.equal(inside.length + outside.length, rows.length);
  assert.equal(new Set([...inside, ...outside].map(r => r.slug)).size, rows.length);
  assert.ok(outside.length >= 60, 'a valid board must carry protocols below the watchlist');
});

test('candidate universe excludes structural and token-recorded rows', () => {
  const candidates = filterRows(rows, { ...base, view: 'candidates' });
  assert.ok(candidates.length > 0);
  assert.ok(candidates.every(r => r.token_status === 'unrecorded' && !r.structural_caution));
  const recorded = filterRows(rows, { ...base, view: 'recorded' });
  assert.ok(recorded.every(r => r.token_status === 'recorded'));
  assert.equal(candidates.length + filterRows(rows, { ...base, view: 'unrecorded' }).length - candidates.length
    + recorded.length, rows.length, 'unrecorded + recorded covers the board');
});

test('comparators sort consistently, place nulls last and break ties by rank', () => {
  const descending = sortRows(rows, 'implied_value_usd', -1);
  const ascending = sortRows(rows, 'implied_value_usd', 1);
  assert.equal(descending[0].rank, 1);
  assert.equal(ascending[ascending.length - 1].rank, 1);
  for (let i = 1; i < descending.length; i++) {
    assert.ok(descending[i - 1].implied_value_usd >= descending[i].implied_value_usd);
  }
  const withNulls = sortRows(rows, 'change_7d', -1);
  const firstNull = withNulls.findIndex(r => r.change_7d === null);
  if (firstNull >= 0) assert.ok(withNulls.slice(firstNull).every(r => r.change_7d === null), 'nulls sort last');
  const byName = sortRows(rows, 'name', 1);
  for (let i = 1; i < byName.length; i++) assert.ok(byName[i - 1].name <= byName[i].name);
  const byAge = sortRows(rows, 'age_days', 1);
  const ageNull = byAge.findIndex(r => r.age_days === null);
  if (ageNull >= 0) assert.ok(byAge.slice(ageNull).every(r => r.age_days === null));
});

test('pagination covers every row exactly once and clamps out-of-range pages', () => {
  const size = 8, pages = pageCount(rows.length, size);
  const seen = new Set();
  for (let p = 0; p < pages; p++) {
    for (const row of pageSlice(rows, p, size).rows) {
      assert.ok(!seen.has(row.slug), `duplicate ${row.slug}`);
      seen.add(row.slug);
    }
  }
  assert.equal(seen.size, rows.length);
  assert.equal(pageSlice(rows, 0, size).page, 0);
  assert.equal(pageSlice(rows, pages + 50, size).page, pages - 1);
  assert.equal(pageSlice(rows, -3, size).page, 0);
  assert.equal(pageSlice([], 0, size).rows.length, 0);
});

test('hash round-trips only non-default state and rejects unknown values', () => {
  const custom = { ...DEFAULT_STATE, view: 'recorded', q: 'aave', category: 'Lending', chain: 'Ethereum',
    coverage: 'watchlist', sort: 'tvl_usd', direction: 1, page: 4 };
  const decoded = decodeHash(encodeHash(custom));
  for (const key of ['view', 'q', 'category', 'chain', 'coverage', 'sort', 'direction', 'page']) {
    assert.equal(decoded[key], custom[key], key);
  }
  assert.equal(encodeHash({ ...DEFAULT_STATE }), '', 'default state leaves a clean address');
  const junk = decodeHash('#view=evil&sort=price&dir=sideways&page=-9&coverage=all');
  assert.equal(junk.view, DEFAULT_STATE.view);
  assert.equal(junk.sort, DEFAULT_STATE.sort);
  assert.equal(junk.direction, DEFAULT_STATE.direction);
  assert.equal(junk.page, 0);
  assert.equal(junk.coverage, '');
});

test('active filter names are human-readable and always include the universe', () => {
  const names = activeFilters({ ...DEFAULT_STATE, category: 'Risk Curators', coverage: 'watchlist', q: 'gauntlet' });
  assert.equal(names[0].label, 'Research candidates');
  assert.ok(names.some(n => n.label === 'Category: Risk Curators'));
  assert.ok(names.some(n => n.label === 'Official watchlist only'));
  assert.ok(names.some(n => n.label.includes('gauntlet')));
  assert.equal(activeFilters({ ...DEFAULT_STATE }).length, 1);
});

test('row formatting is stable for missing and large values', () => {
  assert.equal(formatAge(null), 'Unknown');
  assert.equal(formatAge(30), '30d');
  assert.equal(formatAge(365), '12mo');
  assert.equal(formatAge(1095), '3.0y');
  assert.equal(formatDelta(0), '±0');
  assert.equal(formatDelta(12), '+12');
  assert.equal(formatDelta(-12), '−12');
});

test('board summary reports real watchlist coverage and below-watchlist depth', () => {
  assert.equal(board.summary.watchlist_total, snapshot.watchlist.length);
  assert.equal(board.summary.watchlist_covered, snapshot.watchlist.length);
  assert.equal(board.summary.coverage_ok, true);
  assert.equal(board.summary.below_watchlist, rows.length - snapshot.watchlist.length);
  assert.equal(board.summary.total, 758);
  assert.ok(board.summary.low_confidence > 0, 'low-confidence rows are counted, not hidden');
  assert.equal(board.summary.low_confidence + board.summary.moderate_confidence, rows.length);
});
