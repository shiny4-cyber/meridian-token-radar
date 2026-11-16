import { coverageProof, stepLabel, planTotals } from './view.mjs';
// Meridian model v1: pure functions, no clock, network, randomness or ranked-name overrides.
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const money = n => Math.round(clamp(n, 1, 1e14));
const round = n => Math.round(n * 1e6) / 1e6;
const validDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
  && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
const fail = field => { throw new Error(`Invalid snapshot: ${field}`); };

export function parseSnapshot(text) {
  let s;
  try { s = JSON.parse(text); } catch { fail('not JSON'); }
  if (!s || typeof s !== 'object' || Array.isArray(s)) fail('object required');
  if (!validDate(s.as_of)) fail('as_of date');
  if (typeof s.source !== 'string' || !s.source.trim()) fail('source');
  if (!Number.isSafeInteger(s.floor_usd) || s.floor_usd <= 0) fail('floor_usd');
  if (!Array.isArray(s.protocols) || !s.protocols.length || s.protocols.length > 4000) fail('protocols');
  const slugs = new Set();
  for (const p of s.protocols) {
    if (!p || typeof p !== 'object') fail('protocol object');
    if (typeof p.slug !== 'string' || !/^[^\s]{1,128}$/.test(p.slug) || slugs.has(p.slug)) fail('duplicate or invalid slug');
    slugs.add(p.slug);
    if (typeof p.name !== 'string' || !p.name.trim() || p.name.length > 160) fail(`${p.slug} name`);
    if (!Number.isSafeInteger(p.tvl_usd) || p.tvl_usd < 0) fail(`${p.slug} tvl_usd`);
    if (p.mcap_usd !== null && (typeof p.mcap_usd !== 'number' || !Number.isFinite(p.mcap_usd) || (p.mcap_usd < 0 && p.mcap_usd !== -1) || p.mcap_usd > Number.MAX_SAFE_INTEGER)) fail(`${p.slug} mcap_usd`);
    if (p.change_7d !== null && (typeof p.change_7d !== 'number' || !Number.isFinite(p.change_7d))) fail(`${p.slug} change_7d`);
    for (const key of ['category', 'gecko_id', 'symbol']) {
      if (p[key] !== null && (typeof p[key] !== 'string' || !p[key].trim())) fail(`${p.slug} ${key}`);
    }
    if (!Array.isArray(p.chains) || p.chains.some(c => typeof c !== 'string' || !c.trim()) || new Set(p.chains).size !== p.chains.length) fail(`${p.slug} chains`);
    if (p.listed_at !== null && (!validDate(p.listed_at) || p.listed_at > s.as_of)) fail(`${p.slug} listed_at`);
  }
  if (!Array.isArray(s.watchlist) || new Set(s.watchlist).size !== s.watchlist.length || s.watchlist.some(x => !slugs.has(x))) fail('watchlist');
  return s;
}

export function tokenRecorded(p) {
  return p.gecko_id !== null || p.symbol !== null || p.mcap_usd !== null;
}
export function structuralRisk(p) {
  return ['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX'].includes(p.category)
    || /\b(wrapped|staked|staking)\b/i.test(p.name)
    || /\s(v\d+(\.\d+)?|\d+\.\d+)$/i.test(p.name)
    || /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/i.test(p.name);
}
export function quantile(values, q) {
  if (!values.length) return null;
  const a = [...values].sort((x, y) => x - y), at = (a.length - 1) * q;
  const lo = Math.floor(at), hi = Math.ceil(at);
  return a[lo] + (a[hi] - a[lo]) * (at - lo);
}

function comparablePool(protocols, p) {
  // Deduplicate shared token IDs: a pool clone is not independent evidence.
  const tokenKey = x => x.gecko_id ? `gecko:${x.gecko_id}` : x.symbol ? `symbol:${x.symbol.toUpperCase()}` : `slug:${x.slug}`;
  const ownToken = tokenKey(p);
  const eligible = protocols.filter(x => x.slug !== p.slug && tokenRecorded(x)
    && x.mcap_usd > 0 && x.tvl_usd > 0 && !structuralRisk(x) && tokenKey(x) !== ownToken);
  function unique(rows) {
    const seen = new Set();
    return [...rows].sort((a, b) => b.tvl_usd - a.tvl_usd || cmp(a.slug, b.slug)).filter(x => {
      const key = x.gecko_id ? `gecko:${x.gecko_id}` : x.symbol ? `symbol:${x.symbol.toUpperCase()}` : `slug:${x.slug}`;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
  }
  const same = unique(eligible.filter(x => p.category !== null && x.category === p.category));
  const global = unique(eligible);
  const pool = same.length >= 4 ? same : global;
  const ratios = pool.map(x => clamp(x.mcap_usd / x.tvl_usd, 0.05, 5));
  return { n: pool.length, category_n: same.length,
    basis: same.length >= 4 ? 'category' : global.length ? 'global fallback' : 'conservative prior',
    multiple: quantile(ratios, 0.5) ?? 0.25,
    q25: quantile(ratios, 0.25) ?? 0.1, q75: quantile(ratios, 0.75) ?? 0.5,
    slugs: pool.map(x => x.slug).sort(cmp) };
}

export const NEUTRAL_AGE_DAYS = 365;

/** Mid-rank percentile of one 7-day move among the rows that report one; null when it reports none. */
export function growthPercentile(protocols, value) {
  if (value === null || value === undefined) return null;
  let below = 0, equal = 0, total = 0;
  for (const x of protocols) {
    if (x.change_7d === null || x.change_7d === undefined) continue;
    total++;
    if (x.change_7d < value) below++; else if (x.change_7d === value) equal++;
  }
  return total ? (below + equal / 2) / total : null;
}

export function scoreProtocol(p, snapshot) {
  const peers = comparablePool(snapshot.protocols, p);
  const age = p.listed_at === null ? null : Math.floor((Date.parse(snapshot.as_of) - Date.parse(p.listed_at)) / 86400000);
  const growth = clamp(p.change_7d ?? 0, -50, 100);
  // Documented mapping: +100% growth lifts value 1.5x, -50% cuts it to 0.75x.
  const growthFactor = 1 + growth / 200;
  // Cross-sectional term: mid-rank percentile of this move among reported rows, 0.90x..1.10x.
  const pct = growthPercentile(snapshot.protocols, p.change_7d);
  const percentileFactor = pct === null ? 1 : 0.9 + 0.2 * pct;
  const growthCombined = growthFactor * percentileFactor;
  const ageFactor = age === null ? 0.70 : 0.65 + 0.35 * Math.sqrt(Math.min(age, 1095) / 1095);
  const neutralAgeFactor = 0.65 + 0.35 * Math.sqrt(Math.min(NEUTRAL_AGE_DAYS, 1095) / 1095);
  const structural = structuralRisk(p);
  const structureFactor = structural ? 0.5 : 1;
  const tvl = Math.min(p.tvl_usd, 1e12);
  const implied = money(tvl * peers.multiple * growthCombined * ageFactor * structureFactor);
  const impliedNeutral = money(tvl * peers.multiple * growthCombined * neutralAgeFactor * structureFactor);
  const lowConfidence = peers.basis !== 'category' || peers.n < 8 || age === null || p.change_7d === null || structural || tvl === 0;
  const confidence = lowConfidence ? 'Low' : 'Moderate'; // a label, not an interval
  const uncertainty = lowConfidence ? 2.5 : 1.7;
  const lowFactor = Math.min(1 / uncertainty, peers.q25 / peers.multiple);
  const highFactor = Math.max(uncertainty, peers.q75 / peers.multiple);
  const warnings = [];
  if (!tokenRecorded(p)) warnings.push('No token recorded is not proof of no token or a future launch.');
  else warnings.push('Token metadata recorded: a benchmark, not a pre-launch opportunity.');
  if (structural) warnings.push('Wrapper, bridge, exchange or versioned-product heuristic: token value may belong to a parent or underlying asset.');
  if (age === null) warnings.push('Listing date missing; maturity uses a conservative 0.70 factor.');
  if (p.change_7d === null) warnings.push('Seven-day growth missing; neutral growth factor, lower confidence.');
  if (p.change_7d !== null && growth !== p.change_7d) warnings.push('Growth clipped to [-50%, +100%] to suppress outliers.');
  if (p.tvl_usd > tvl) warnings.push('Model TVL capped at $1 trillion; raw TVL retained.');
  if (tvl === 0) warnings.push('Zero TVL: $1 ranking floor, not a meaningful valuation.');
  if (peers.basis !== 'category') warnings.push('Insufficient independent same-category peers; broad fallback is less comparable.');
  if (peers.n < 8) warnings.push(`Only ${peers.n} independent peer observation${peers.n === 1 ? '' : 's'}: the peer multiple is a weak anchor, so this row is low confidence.`);
  return { implied_value_usd: implied, age_days: age, confidence,
    sensitivity: { neutral_age_days: NEUTRAL_AGE_DAYS, neutral_age_factor: round(neutralAgeFactor),
      implied_neutral_age: impliedNeutral,
      delta_pct: round(((implied - impliedNeutral) / impliedNeutral) * 100) },
    band: { low: money(implied * lowFactor), high: money(implied * highFactor), label: 'Scenario range, not a probability interval' },
    drivers: { tvl_used: tvl, peer_multiple: round(peers.multiple), growth_used: growth,
      growth_factor: round(growthFactor), growth_percentile: pct === null ? null : round(pct),
      percentile_factor: round(percentileFactor), growth_combined: round(growthCombined),
      age_factor: round(ageFactor), structure_factor: structureFactor,
      peer_basis: peers.basis, peer_count: peers.n, category_peer_count: peers.category_n,
      peer_q25: round(peers.q25), peer_q75: round(peers.q75), peer_slugs: peers.slugs }, warnings };
}

// ---------------------------------------------------------------- farm plans
const USD = n => n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M`
  : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${Math.round(n)}`;
// Documented per-chain fee assumption in USD, not an observation: one entry transaction per chain.
export const CHAIN_FEES = { Ethereum: [3.5, 22], Arbitrum: [0.15, 1.2], Optimism: [0.15, 1.2],
  Base: [0.05, 0.6], Polygon: [0.02, 0.3], Binance: [0.1, 0.8], Solana: [0.01, 0.15],
  Tron: [0.4, 2.5], Avalanche: [0.1, 1], Bitcoin: [2, 12], default: [0.2, 1.5] };
const REVIEW_DAYS = 14;
const MAX_PLAN_CHAINS = 3;
const r2 = n => Math.round(n * 100) / 100;
const feeOf = chain => CHAIN_FEES[chain] || CHAIN_FEES.default;
const money2 = n => '$' + (n < 10 ? n.toFixed(2).replace(/0$/, '') : Math.round(n).toLocaleString('en-US'));

function capitalFor(p) {
  if (p.tvl_usd >= 5e9) return 250;
  if (p.tvl_usd >= 1e9) return 150;
  if (p.tvl_usd >= 1e8) return 100;
  return 50;
}

function familyOf(category) {
  const c = (category || '').toLowerCase();
  if (c.includes('lend') || c === 'cdp') return 'lending';
  if (c.includes('dex')) return 'dex';
  if (c.includes('bridge')) return 'bridge';
  if (c.includes('staking') || c.includes('restak')) return 'staking';
  if (c.includes('derivative') || c.includes('perpetual') || c.includes('prediction') || c.includes('leveraged')) return 'derivative';
  if (c.includes('rwa') || c === 'cex') return 'custody';
  if (c.includes('yield') || c.includes('curator') || c.includes('allocator') || c.includes('basis') || c.includes('stable')) return 'vault';
  return 'generic';
}

const MECH = {
  lending: 'a supply-only position in one accepted collateral market, borrowing disabled',
  dex: 'one spot swap at a 0.5% slippage ceiling with no volume padding',
  bridge: 'one bridge transfer with the return route timed first',
  staking: 'one staking position after checking the unstake queue',
  derivative: 'a read-only market review with no leverage and no outcome bet',
  custody: 'an access and jurisdiction check with no deposit',
  vault: 'one disclosed vault share after reading the strategy and exit terms',
  generic: 'a documented-access review before any capital moves',
};
const RISK = { lending: 'bad debt, oracle failure and withdrawal liquidity', dex: 'slippage, MEV, approvals and impermanent loss',
  bridge: 'custody, validator compromise, depegging and one-way liquidity', staking: 'slashing, receipt depeg and withdrawal queues',
  derivative: 'liquidation, funding costs and total loss of margin', custody: 'custody, legal restrictions and redemption gates',
  vault: 'manager discretion, leverage, contract loss and redemption delays', generic: 'unknown mechanics, contract failure and unverified access' };
const EXIT = { lending: 'Redeem a small amount first, then withdraw the remainder', dex: 'Reverse the swap if needed and revoke residual approvals',
  bridge: 'Test the return route before adding funds and reconcile both balances', staking: 'Submit the unstake request and track the queue',
  derivative: 'Close exposure, cancel orders and withdraw free collateral', custody: "Use the issuer's redemption route only if already invested",
  vault: 'Redeem a small share first, then exit the remainder net of fees', generic: 'Follow the documented reversal flow' };
const MISSING = { structural: 'a structural flag that a parent asset explains', category: 'a recorded category', prior: 'at least one independent token peer' };

export function planState(p, structural, score) {
  const d = score.drivers;
  if (structural) return { mode: 'research-only', reason: 'a wrapper, bridge, exchange or versioned product whose value may belong to a parent asset' };
  if (p.category === null) return { mode: 'research-only', reason: 'no category recorded, so the product mechanics are unknown' };
  if (d.peer_basis === 'conservative prior') return { mode: 'research-only', reason: 'no comparable token records, so there is no evidence base for sizing a position' };
  return { mode: 'conditional', reason: `${p.category} with ${d.peer_count} independent peer observations` };
}

/** category + first chain + structural flag + chain count: the branch a plan is keyed on. */
export function planBranch(p, structural) {
  return `${familyOf(p.category)}:${[...p.chains].sort(cmp)[0] || 'chain-unknown'}:${structural ? 'structural' : 'direct'}:${p.chains.length > 1 ? 'multi' : 'single'}`;
}

export function farmPlan(p, structural, score, snapshot) {
  const state = planState(p, structural, score);
  const chains = [...p.chains].sort(cmp).slice(0, MAX_PLAN_CHAINS);
  const n = chains.length || 1;
  const chainList = chains.length ? chains.join(' + ') : 'an unverified chain';
  const recorded = tokenRecorded(p);
  const family = familyOf(p.category);
  const conditional = state.mode === 'conditional';
  const capital = conditional ? capitalFor(p) : 0;
  const fees = chains.map(feeOf);
  const entry = { low: r2(fees.reduce((a, f) => a + f[0], 0)) || 0.2, high: r2(fees.reduce((a, f) => a + f[1], 0)) || 1.5 };
  const weeks = REVIEW_DAYS / 7;
  const band = score.band, d = score.drivers;
  const reviewDate = new Date(Date.parse(`${snapshot.as_of}T00:00:00Z`) + REVIEW_DAYS * 86400000).toISOString().slice(0, 10);
  const feeNote = `Per-chain fee assumption (not an observation): ${chains.map((c, i) => `${c} ${money2(fees[i][0])}–${money2(fees[i][1])}`).join(', ') || 'unknown chain 0.2–1.5'}; one entry transaction per chain, capped at ${MAX_PLAN_CHAINS} chains.`;
  if (!conditional) {
    const key = structural ? 'structural' : p.category === null ? 'category' : 'prior';
    const steps = [
      { stage: 'VERIFY ACCESS', minutes: 10 + 6 * n, usd_low: 0, usd_high: 0, requires_capital: false,
        text: `Read ${p.name}'s contracts and audits on ${chainList}; it is ${state.reason}, so verify whether a documented app and exit exist at all.` },
      { stage: 'CHECK TOKEN STATUS', minutes: recorded ? 8 : 12, usd_low: 0, usd_high: 0, requires_capital: false,
        text: `Confirm whether ${p.name} records a token or a published program; the snapshot ${recorded ? 'records token metadata' : 'records none'}, which proves neither a launch nor its absence.` },
      { stage: 'NEXT ACTION', minutes: 5 + 2 * n, usd_low: 0, usd_high: 0, requires_capital: false,
        text: `Next action on ${reviewDate}: re-check ${p.name} for ${MISSING[key]}; if that changes, rebuild the plan, and until then keep exposure at zero across ${chainList}.` },
    ];
    return { mode: 'research-only', reason: state.reason, branch: planBranch(p, structural), chain: chains[0] || null,
      chains, capital_usd: 0, review_days: REVIEW_DAYS, review_date: reviewDate, fee_note: feeNote,
      steps, totals: planTotals(steps, 0),
      label: 'Research-only: this record does not justify any spend. Costs stay at zero and the next action is dated.' };
  }
  const action = `On ${chainList} (${n} chain${n === 1 ? '' : 's'}): ${MECH[family]}, sized at ${USD(capital)} of principal against a ${USD(band.low)}–${USD(band.high)} model band at ${d.peer_multiple}× the peer median, with ${money2(entry.low)}–${money2(entry.high)} of entry fees and ${recorded ? 'token metadata already recorded' : 'no token recorded'}.`;
  const steps = [
    { stage: 'VERIFY ACCESS', minutes: 10 + 8 * n + (recorded ? 0 : 4), usd_low: 0, usd_high: 0, requires_capital: false,
      text: `Verify ${p.name}'s official app, contracts and audits on ${chainList}; the snapshot carries no trusted URL, so confirm the ${p.category} mechanics yourself.` },
    { stage: 'CHECK TOKEN STATUS', minutes: recorded ? 8 : 15, usd_low: 0, usd_high: 0, requires_capital: false,
      text: recorded ? `${p.name} already records token metadata (${p.symbol || p.gecko_id}); inspect only published incentive programs, never a hypothetical launch.`
        : `${p.name} records no token; confirm whether a program now exists, because absent metadata is not proof of a future launch.` },
    { stage: 'BOUNDED TEST', minutes: 15 + 12 * n + Math.round(capital / 50), usd_low: entry.low, usd_high: entry.high, requires_capital: true,
      text: action },
    { stage: 'MONITOR RISK', minutes: Math.round(weeks * (6 + 3 * n)), usd_low: 0, usd_high: 0, requires_capital: false,
      text: `Re-check weekly to ${reviewDate} at ${d.peer_multiple}× over ${d.peer_count} peers: watch ${RISK[family]} on ${chainList}, and log receipts, fees and balances.` },
    { stage: 'EXIT & RECONCILE', minutes: 10 + 6 * n, usd_low: entry.low, usd_high: entry.high, requires_capital: false,
      text: `${EXIT[family]} on ${chainList} by ${reviewDate}; keep ${money2(entry.low)}–${money2(entry.high)} for exit fees and stop on any unexpected approval or withdrawal failure.` },
  ];
  return { mode: 'conditional', reason: state.reason, branch: planBranch(p, structural), chain: chains[0] || null,
    chains, capital_usd: capital, review_days: REVIEW_DAYS, review_date: reviewDate, fee_note: feeNote, action,
    steps, totals: planTotals(steps, capital),
    label: 'Illustrative planning estimates only; not campaign terms. Principal can be lost and rewards may be zero.' };
}

export function buildRadar(snapshot) {
  const watch = new Set(snapshot.watchlist);
  const rows = snapshot.protocols.map(p => {
    const structural = structuralRisk(p), recorded = tokenRecorded(p);
    const score = scoreProtocol(p, snapshot), plan = farmPlan(p, structural, score, snapshot);
    return { ...p, chains: [...p.chains].sort(cmp), ...score, watchlist: watch.has(p.slug),
      token_status: recorded ? 'recorded' : 'unrecorded', structural_caution: structural, plan,
      farm_steps: plan.steps.map((step, i) => stepLabel(step, i, plan)) };
  }).sort((a, b) => b.implied_value_usd - a.implied_value_usd || cmp(a.slug, b.slug))
    .map((row, i) => ({ rank: i + 1, ...row }));

  // rank_delta = TVL rank - model rank, so a positive value means the model lifts the protocol.
  const tvlOrder = [...rows].sort((a, b) => b.tvl_usd - a.tvl_usd || cmp(a.slug, b.slug));
  const tvlRank = new Map(tvlOrder.map((row, i) => [row.slug, i + 1]));
  for (const row of rows) {
    row.tvl_rank = tvlRank.get(row.slug);
    row.rank_delta = row.tvl_rank - row.rank;
  }

  const watchlistTotal = new Set(snapshot.watchlist).size;
  const matched = rows.filter(r => r.watchlist).map(r => r.slug);
  const watchlistCovered = matched.length;
  // Build-time constant from the raw input; the shipped digest is recomputed over it plus the rows.
  const expected = coverageProof(snapshot.watchlist, snapshot.watchlist);
  const digest = coverageProof(snapshot.watchlist, matched);
  if (digest !== expected) throw new Error('coverage digest mismatch at build: a watchlist slug has no row');
  const watchlistSlugs = [...new Set(snapshot.watchlist)].sort(cmp);
  return { schema: 'meridian-radar/v1', as_of: snapshot.as_of, source: snapshot.source,
    floor_usd: snapshot.floor_usd, model_version: 'Meridian 1.0',
    methodology: 'TVL × median bounded market-cap/TVL peer ratio × bounded growth × listing-age maturity × structural discount. Scenario market capitalization, not FDV, TVL, token price or forecast.',
    summary: { total: rows.length, watchlist: watchlistCovered, watchlist_total: watchlistTotal,
      watchlist_covered: watchlistCovered, watchlist_slugs: watchlistSlugs, coverage_digest: digest,
      below_watchlist: rows.filter(r => !r.watchlist).length, coverage_ok: watchlistCovered === watchlistTotal,
      no_token_recorded: rows.filter(r => r.token_status === 'unrecorded').length,
      research_candidates: rows.filter(r => r.token_status === 'unrecorded' && !r.structural_caution).length,
      recorded: rows.filter(r => r.token_status === 'recorded').length,
      structural: rows.filter(r => r.structural_caution).length,
      low_confidence: rows.filter(r => r.confidence === 'Low').length,
      moderate_confidence: rows.filter(r => r.confidence === 'Moderate').length }, rows };
}
