import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { filterRows, sortRows, pageSlice, pageCount, activeFilters, encodeHash, decodeHash,
  formatAge, formatDelta, DEFAULT_STATE } from '../dashboard/view.mjs';
import { parseSnapshot, buildRadar, scoreProtocol } from '../dashboard/model.mjs';

const snapshot = parseSnapshot(readFileSync(process.env.SNAPSHOT_PATH
  || '/root/work/makefun/token-radar/token-radar-01-kit/input/snapshot.json', 'utf8'));
const board = buildRadar(snapshot);
const rows = board.rows;
const base = { ...DEFAULT_STATE, view: 'all' };
const fixtureLike = () => ({ as_of: '2026-11-14', source: 'fixture', floor_usd: 50_000_000,
  watchlist: ['subject'], protocols: [
    { slug: 'subject', name: 'Subject', category: 'Lending', chains: ['Base'], tvl_usd: 10_000_000, change_7d: 0, mcap_usd: null, listed_at: null, gecko_id: null, symbol: null },
    ...Array.from({ length: 5 }, (_, i) => ({ slug: `peer${i}`, name: `Peer ${i}`, category: 'Lending', chains: ['Base'], tvl_usd: 10_000_000, change_7d: i * 10, mcap_usd: 8_000_000, listed_at: '2024-01-01', gecko_id: `g${i}`, symbol: `P${i}` })) ] });

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

// ---------------------------------------------------------------- plan structure and coverage proof
import { planTotals, stepLabel, coverageProof, assertCoverage } from '../dashboard/view.mjs';

const sum = (xs, k) => xs.reduce((n, x) => n + x[k], 0);

test('plans are keyed on category, chain and structure, so two DEXes on different chains differ', () => {
  const dexes = rows.filter(r => r.plan.branch.startsWith('dex:') && r.plan.mode === 'conditional');
  const byChain = new Map();
  for (const r of dexes) if (!byChain.has(r.plan.chain)) byChain.set(r.plan.chain, r);
  const pair = [...byChain.values()].slice(0, 2);
  assert.equal(pair.length, 2, 'need two DEX rows on different chains');
  assert.notEqual(pair[0].plan.chain, pair[1].plan.chain);
  assert.notEqual(pair[0].farm_steps[2], pair[1].farm_steps[2], 'the bounded-test step must not be shared');
  assert.ok(pair[0].farm_steps[2].includes(pair[0].plan.chain));
  assert.ok(pair[1].farm_steps[2].includes(pair[1].plan.chain));
  // Stronger invariant: identical steps imply identical plan inputs.
  const groups = new Map();
  for (const r of rows) {
    const key = JSON.stringify(r.farm_steps);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const input = r => JSON.stringify([r.name, r.category, r.chains, r.structural_caution, r.plan.capital_usd, r.drivers.peer_multiple]);
    assert.equal(new Set(group.map(input)).size, 1, `shared steps for different inputs: ${group.map(r => r.slug)}`);
  }
});

test('fee ranges in the steps, totals and rendered label agree with the chain table', () => {
  for (const r of rows.filter(x => x.plan.mode === 'conditional')) {
    const used = [...r.chains].sort().slice(0, 3);
    const fee = used.reduce((a, c) => { const f = CHAIN_FEES[c] || CHAIN_FEES.default; return [a[0] + f[0], a[1] + f[1]]; }, [0, 0])
      .map(n => Math.round(n * 100) / 100);
    assert.deepEqual([r.plan.steps[2].usd_low, r.plan.steps[2].usd_high], fee, r.slug);
    assert.deepEqual([r.plan.steps[4].usd_low, r.plan.steps[4].usd_high], fee, r.slug);
    assert.match(r.farm_steps[2], new RegExp(`\\$${String(fee[0]).replace('.', '\\.')}`), r.farm_steps[2]);
    assert.match(r.plan.fee_note, /assumption/i);
  }
});

test('plan totals are pure arithmetic over the steps', () => {
  for (const r of rows) {
    const t = planTotals(r.plan.steps, r.plan.capital_usd);
    assert.deepEqual(r.plan.totals, t);
    assert.equal(t.minutes, sum(r.plan.steps, 'minutes'));
    assert.equal(t.fee_low, sum(r.plan.steps, 'usd_low'));
    assert.equal(t.fee_high, sum(r.plan.steps, 'usd_high'));
    assert.equal(t.peak_principal_usd, r.plan.steps.some(s => s.requires_capital) ? r.plan.capital_usd : 0);
    assert.equal(r.plan.steps.length, r.farm_steps.length);
    r.plan.steps.forEach((s, i) => {
      assert.deepEqual(Object.keys(s).sort(), ['minutes', 'requires_capital', 'stage', 'text', 'usd_high', 'usd_low']);
      assert.equal(stepLabel(s, i, r.plan), r.farm_steps[i]);
    });
  }
});

test('the coverage digest is recomputed from shipped records and rejects tampering', () => {
  const summary = { ...board.summary };
  assert.equal(assertCoverage(summary, rows).matched, summary.watchlist_slugs.length);
  assert.equal(summary.coverage_digest, coverageProof(summary.watchlist_slugs, summary.watchlist_slugs));
  const dropped = { ...summary, watchlist_slugs: summary.watchlist_slugs.slice(1) };
  assert.throws(() => assertCoverage(dropped, rows), /Coverage digest mismatch/);
  const flipped = rows.map(r => r.slug === summary.watchlist_slugs[0] ? { ...r, watchlist: false } : r);
  assert.throws(() => assertCoverage(summary, flipped), /Coverage digest mismatch/);
  const invented = { ...summary, watchlist_slugs: [...summary.watchlist_slugs, 'not-a-protocol'] };
  assert.throws(() => assertCoverage(invented, rows), /Coverage digest mismatch/);
});

test('rows without evidence get an explicit research-only plan and no spend', () => {
  for (const r of rows) {
    const unsupported = r.structural_caution || r.category === null || r.drivers.peer_basis === 'conservative prior';
    assert.equal(r.plan.mode, unsupported ? 'research-only' : 'conditional', `${r.slug} mode`);
    if (unsupported) {
      assert.equal(r.plan.totals.peak_principal_usd, 0);
      assert.equal(r.plan.totals.fee_low, 0);
      assert.equal(r.plan.totals.fee_high, 0);
      assert.ok(r.plan.steps.every(s => s.usd_low === 0 && s.usd_high === 0 && !s.requires_capital));
      assert.equal(r.plan.steps.length, 3);
      assert.match(r.farm_steps[2], /Next action on \d{4}-\d{2}-\d{2}/);
    } else {
      assert.equal(r.plan.steps.length, 5);
      assert.ok(r.plan.totals.peak_principal_usd > 0);
    }
  }
  assert.ok(rows.some(r => r.plan.mode === 'research-only'));
  assert.ok(rows.some(r => r.plan.mode === 'conditional'));
});

test('the gating also fires for a missing category and for a prior-only peer set', () => {
  const s = { as_of: '2026-11-14', source: 'fixture', floor_usd: 1, watchlist: [],
    protocols: [
      { slug: 'no-cat', name: 'No Category', category: null, chains: ['Base'], tvl_usd: 1e6, change_7d: 0, mcap_usd: null, listed_at: '2025-01-01', gecko_id: null, symbol: null },
      { slug: 'lonely', name: 'Lonely', category: 'Unheard Of', chains: ['Base'], tvl_usd: 2e6, change_7d: 0, mcap_usd: null, listed_at: '2025-01-01', gecko_id: null, symbol: null } ] };
  const radar = buildRadar(parseSnapshot(JSON.stringify(s)));
  for (const row of radar.rows) {
    assert.equal(row.plan.mode, 'research-only', row.slug);
    assert.match(row.farm_steps[2], /Next action on \d{4}-\d{2}-\d{2}/);
    assert.equal(row.plan.totals.fee_high, 0);
  }
  const cat = radar.rows.find(r => r.slug === 'no-cat');
  assert.match(cat.farm_steps[2], /a recorded category/);
  const prior = radar.rows.find(r => r.slug === 'lonely');
  assert.match(prior.farm_steps[2], /at least one independent token peer/);
});

// ---------------------------------------------------------------- computed plans, growth and dates
import { CHAIN_FEES } from '../dashboard/model.mjs';

test('action text is composed from row data, never a shared template', () => {
  const seen = new Map();
  for (const r of rows.filter(x => x.plan.mode === 'conditional')) {
    const key = r.plan.action;
    if (!seen.has(key)) seen.set(key, []);
    seen.get(key).push(r);
  }
  for (const group of seen.values()) {
    if (group.length < 2) continue;
    const input = r => JSON.stringify([r.category, r.chains, r.structural_caution, r.plan.capital_usd,
      r.band.low, r.band.high, r.drivers.peer_multiple, r.token_status]);
    assert.equal(new Set(group.map(input)).size, 1, `identical action for different inputs: ${group.map(r => r.slug)}`);
  }
  const dex = rows.filter(r => r.plan.mode === 'conditional' && r.plan.branch.startsWith('dex:'));
  assert.ok(new Set(dex.map(r => r.plan.action)).size > 0.9 * dex.length, 'DEX actions must nearly all differ');
  assert.match(rows.find(r => r.plan.mode === 'conditional').plan.action, /chain|chains/);
});

test('fees come from the per-chain table and minutes from the chain set and capital', () => {
  for (const r of rows) {
    const used = [...r.chains].sort().slice(0, 3);
    const expected = used.reduce((acc, c) => {
      const f = CHAIN_FEES[c] || CHAIN_FEES.default;
      return [acc[0] + f[0], acc[1] + f[1]];
    }, [0, 0]).map(n => Math.round(n * 100) / 100);
    if (r.plan.mode === 'conditional') {
      assert.deepEqual([r.plan.steps[2].usd_low, r.plan.steps[2].usd_high], expected, r.slug);
      assert.deepEqual([r.plan.totals.fee_low, r.plan.totals.fee_high], [expected[0] * 2, expected[1] * 2].map(n => Math.round(n * 100) / 100));
    } else {
      assert.equal(r.plan.totals.fee_low, 0);
    }
    assert.equal(r.plan.totals.minutes, r.plan.steps.reduce((n, s) => n + s.minutes, 0));
  }
  const single = rows.find(r => r.plan.mode === 'conditional' && r.chains.length === 1);
  const multi = rows.find(r => r.plan.mode === 'conditional' && r.chains.length >= 3);
  assert.ok(multi.plan.totals.minutes > single.plan.totals.minutes, 'more chains must cost more minutes');
  const minutes = new Set(rows.map(r => r.plan.totals.minutes));
  assert.ok(minutes.size > 20, 'minutes must not be a constant');
});

test('the review date is computed from the snapshot date and appears in the plan', () => {
  const expected = new Date(Date.parse(`${board.as_of}T00:00:00Z`) + 14 * 86400000).toISOString().slice(0, 10);
  for (const r of rows) {
    assert.equal(r.plan.review_date, expected);
    assert.ok(r.farm_steps.some(s => s.includes(expected)), `${r.slug} must print ${expected}`);
  }
  const research = rows.find(r => r.plan.mode === 'research-only');
  assert.match(research.farm_steps[research.farm_steps.length - 1], /Next action on \d{4}-\d{2}-\d{2}/);
  assert.match(research.farm_steps[research.farm_steps.length - 1], /re-check/i);
});

test('growth moves value materially and the age substitution is exposed two ways', () => {
  const s = fixtureLike();
  const flat = scoreProtocol({ ...s.protocols[0], change_7d: 0 }, s);
  const up = scoreProtocol({ ...s.protocols[0], change_7d: 100 }, s);
  assert.ok(up.implied_value_usd / flat.implied_value_usd >= 1.4, 'a +100% move must beat flat by at least 40%');
  assert.ok(up.drivers.percentile_factor >= 0.9 && up.drivers.percentile_factor <= 1.1);
  assert.equal(flat.drivers.growth_percentile !== null, true);
  const aged = scoreProtocol({ ...s.protocols[0], listed_at: '2023-11-15' }, s);
  assert.equal(aged.sensitivity.neutral_age_days, 365);
  assert.notEqual(aged.sensitivity.implied_neutral_age, aged.implied_value_usd);
  assert.ok(Math.abs(aged.sensitivity.delta_pct) > 1);
});

test('research-only plans end with a computed next action, not a slogan', () => {
  const samples = rows.filter(r => r.plan.mode === 'research-only').slice(0, 3);
  assert.ok(samples.length >= 1);
  for (const r of samples) {
    assert.ok(r, 'each unsupported reason must occur in the snapshot');
    const last = r.farm_steps[r.farm_steps.length - 1];
    assert.ok(last.includes(r.plan.review_date));
    assert.match(last, /if that changes, rebuild the plan|until then keep exposure at zero/);
    assert.ok(!/set a review date/i.test(last), 'no slogan');
  }
});
