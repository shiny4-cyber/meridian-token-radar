import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSnapshot, buildRadar, scoreProtocol, tokenRecorded, structuralRisk } from '../dashboard/model.mjs';

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
  const path = process.env.SNAPSHOT_PATH || '/root/work/makefun/token-radar/token-radar-01-kit/input/snapshot.json';
  const s = parseSnapshot(readFileSync(path, 'utf8'));
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
  assert.equal(r.drivers.age_factor, 0.7);
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
  // Three-year listing maturity, no peers: 10M * .25 * 1.25 * 1 = 3.125M.
  assert.equal(r.implied_value_usd, 3_125_000);
  s.protocols.push({ ...p, slug: 'aaa' });
  assert.deepEqual(buildRadar(s).rows.map(r => r.slug), ['aaa', 'sample']);
});
