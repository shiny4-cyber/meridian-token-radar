import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSnapshot, buildRadar, scoreProtocol, tokenRecorded, structuralRisk } from '../dashboard/model.mjs';

const SNAPSHOT_PATH = process.env.SNAPSHOT_PATH || '/root/work/makefun/token-radar/token-radar-01-kit/input/snapshot.json';
const snapshotText = () => readFileSync(SNAPSHOT_PATH, 'utf8');
const fixture = () => ({ as_of: '2026-11-14', source: 'test fixture', floor_usd: 50_000_000,
  protocols: [{ slug: 'sample', name: 'Sample', category: 'Lending', chains: ['Ethereum'], tvl_usd: 10_000_000,
    change_7d: 0, mcap_usd: null, listed_at: null, gecko_id: null, symbol: null }], watchlist: ['sample'] });

test('rejects malformed financial fields, duplicate slugs and impossible dates', () => {
  for (const mutate of [s => s.floor_usd = 0, s => s.protocols[0].tvl_usd = -1,
    s => s.protocols[0].change_7d = 'NaN', s => s.protocols.push(s.protocols[0]),
    s => s.watchlist.push('invented'), s => s.as_of = '2026-02-30',
    s => s.protocols[0].listed_at = '2027-01-01']) {
    const s = fixture(); mutate(s);
    assert.throws(() => parseSnapshot(JSON.stringify(s)), /Invalid snapshot/);
  }
});

test('all official rows and watchlist are covered with deterministic ranks and bounded plans', () => {
  const s = parseSnapshot(snapshotText());
  const b = buildRadar(s);
  assert.equal(b.rows.length, s.protocols.length);
  assert.equal(b.rows.length, 758);
  assert.equal(b.summary.watchlist, 40);
  assert.equal(new Set(b.rows.map(r => r.slug)).size, b.rows.length);
  for (const [i, r] of b.rows.entries()) {
    assert.equal(r.rank, i + 1);
    assert.ok(Number.isSafeInteger(r.implied_value_usd) && r.implied_value_usd > 0 && r.implied_value_usd <= 1e14);
    if (i) assert.ok(b.rows[i - 1].implied_value_usd >= r.implied_value_usd);
    assert.ok(r.band.low <= r.implied_value_usd && r.band.high >= r.implied_value_usd);
    assert.ok(r.farm_steps.length >= 3 && r.farm_steps.length <= 12);
    assert.equal(new Set(r.farm_steps).size, r.farm_steps.length);
    for (const step of r.farm_steps) assert.ok(step.trim().length >= 20 && step.trim().length <= 600);
    assert.equal(r.tvl_usd, s.protocols.find(p => p.slug === r.slug).tvl_usd);
  }
  const reversed = { ...s, protocols: [...s.protocols].reverse(), watchlist: [...s.watchlist].reverse() };
  assert.deepEqual(buildRadar(reversed), b);
});

test('zero, missing, sentinel and extreme inputs never fabricate positive market observations', () => {
  const s = fixture(), p = s.protocols[0];
  p.tvl_usd = 0; p.change_7d = null; p.mcap_usd = -1;
  const accepted = parseSnapshot(JSON.stringify(s));
  const r = scoreProtocol(accepted.protocols[0], accepted);
  assert.equal(r.implied_value_usd, 1);
  assert.equal(r.confidence, 'Low');
  assert.equal(r.drivers.peer_count, 0);
  assert.equal(r.drivers.age_factor, 1);
  assert.equal(r.drivers.age_dropped, true);
  assert.equal(r.drivers.growth_factor, 1);
  assert.ok(tokenRecorded(p));
  p.tvl_usd = 9e15; p.change_7d = 1e20;
  const high = scoreProtocol(p, s);
  assert.equal(high.drivers.tvl_used, 1e12);
  assert.equal(high.drivers.growth_used, 100);
  p.change_7d = -1e20;
  assert.equal(scoreProtocol(p, s).drivers.growth_used, -50);
  p.name = 'Example V2'; assert.ok(structuralRisk(p));
});

test('shared token clones do not contaminate leave-one-token-out comparables', () => {
  const s = fixture();
  const p = { ...s.protocols[0], slug: 'parent', gecko_id: 'shared-token', symbol: 'SHARED', mcap_usd: 20e6 };
  s.protocols = [p, { ...p, slug: 'clone', tvl_usd: 5e6 }, ...Array.from({ length: 4 }, (_, i) => ({
    ...p, slug: `peer-${i}`, gecko_id: `independent-${i}`, symbol: `I${i}`, tvl_usd: 10e6, mcap_usd: 10e6
  }))];
  const result = scoreProtocol(p, s);
  assert.equal(result.drivers.peer_count, 4);
  assert.equal(result.drivers.peer_multiple, 1);
  assert.ok(!result.drivers.peer_slugs.includes('clone'));
});

test('fixed inputs give an independently calculated scenario and slug tie-break', () => {
  const s = fixture(), p = s.protocols[0];
  p.listed_at = '2023-11-15'; p.change_7d = 100;
  const r = scoreProtocol(p, s);
  // Three-year listing maturity, no category peers, +100% growth: 10M * .25 * 1.5 * 1.0 = 3.75M.
  assert.equal(r.drivers.growth_factor, 1.5);
  assert.equal(r.drivers.growth_percentile, 0.5);
  assert.equal(r.implied_value_usd, 3_750_000);
  s.protocols.push({ ...p, slug: 'aaa' });
  assert.deepEqual(buildRadar(s).rows.map(r => r.slug), ['aaa', 'sample']);
});

test('peer market-cap/TVL ratios clamp to the documented 0.05–5× bounds', () => {
  const s = fixture();
  const subject = { ...s.protocols[0], slug: 'subject', tvl_usd: 10e6 };
  s.protocols = [subject, ...Array.from({ length: 5 }, (_, i) => ({
    ...subject, slug: `huge-${i}`, gecko_id: `h${i}`, symbol: `H${i}`, mcap_usd: 10e6 * 100
  }))];
  assert.equal(scoreProtocol(subject, s).drivers.peer_multiple, 5);
  s.protocols = [subject, ...Array.from({ length: 5 }, (_, i) => ({
    ...subject, slug: `tiny-${i}`, gecko_id: `t${i}`, symbol: `T${i}`, mcap_usd: 1
  }))];
  assert.equal(scoreProtocol(subject, s).drivers.peer_multiple, 0.05);
});

test('low-confidence flagging follows missing data and structural heuristics', () => {
  const { rows } = buildRadar(parseSnapshot(snapshotText()));
  for (const row of rows) {
    assert.ok(['Low', 'Moderate'].includes(row.confidence));
    const d = row.drivers;
    const expectedLow = d.peer_basis !== 'category' || d.peer_count < 8 || row.age_days === null
      || row.change_7d === null || row.structural_caution || d.tvl_used === 0;
    assert.equal(row.confidence === 'Low', expectedLow, `${row.slug} confidence`);
    if (row.confidence === 'Low') assert.ok(row.warnings.length >= 2, `${row.slug} must explain its low confidence`);
  }
  assert.ok(rows.some(r => r.confidence === 'Moderate'));
  assert.ok(rows.some(r => r.confidence === 'Low'));
});

test('TVL rank and rank delta are consistent for every row', () => {
  const { rows } = buildRadar(parseSnapshot(snapshotText()));
  const sortedByTvl = [...rows].sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1));
  sortedByTvl.forEach((row, i) => {
    assert.equal(row.tvl_rank, i + 1);
    assert.equal(row.rank_delta, row.tvl_rank - row.rank);
  });
  assert.equal(new Set(rows.map(r => r.tvl_rank)).size, rows.length);
});
