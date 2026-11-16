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

export function scoreProtocol(p, snapshot) {
  const peers = comparablePool(snapshot.protocols, p);
  const age = p.listed_at === null ? null : Math.floor((Date.parse(snapshot.as_of) - Date.parse(p.listed_at)) / 86400000);
  const growth = clamp(p.change_7d ?? 0, -50, 100);
  const growthFactor = 1 + growth / 400; // a 7-day move gets only 25% weight
  const ageFactor = age === null ? 0.70 : 0.65 + 0.35 * Math.sqrt(Math.min(age, 1095) / 1095);
  const structural = structuralRisk(p);
  const structureFactor = structural ? 0.5 : 1;
  const tvl = Math.min(p.tvl_usd, 1e12);
  const implied = money(tvl * peers.multiple * growthFactor * ageFactor * structureFactor);
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
    band: { low: money(implied * lowFactor), high: money(implied * highFactor), label: 'Scenario range, not a probability interval' },
    drivers: { tvl_used: tvl, peer_multiple: round(peers.multiple), growth_used: growth,
      growth_factor: round(growthFactor), age_factor: round(ageFactor), structure_factor: structureFactor,
      peer_basis: peers.basis, peer_count: peers.n, category_peer_count: peers.category_n,
      peer_q25: round(peers.q25), peer_q75: round(peers.q75), peer_slugs: peers.slugs }, warnings };
}

// ---------------------------------------------------------------- farm plans
const USD = n => n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M`
  : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${Math.round(n)}`;
const FEE = chain => chain === 'Ethereum' ? { low: 5, high: 30 } : { low: 1, high: 10 };
const REVIEW_DAYS = 14;
const EMPTY = { low: 0, high: 0 };

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

const ACTIONS = {
  lending: ['test a small supply position in an accepted collateral asset, without borrowing',
    'bad debt, oracle failure and withdrawal liquidity',
    'redeem a small amount first, then withdraw the remainder and confirm the receipt balance'],
  dex: ['make one small swap with a 0.5% slippage ceiling and no volume padding',
    'slippage, MEV, token approvals and impermanent loss',
    'reverse the test swap if needed, remove any LP position and revoke residual approvals'],
  bridge: ['bridge one small amount to the documented destination only after confirming the return route',
    'bridge custody, validator compromise, depegging and one-way liquidity',
    'test the documented return route before adding funds and reconcile the original-chain balance'],
  staking: ['stake a small amount of the documented asset after checking minimums and the withdrawal queue',
    'slashing, receipt-token depeg and delayed withdrawals',
    'submit the unstake request, track the queue and compare the secondary-market discount'],
  derivative: ['review the market read-only and open no leverage or outcome bet without a documented sandbox',
    'liquidation, funding costs and total loss of margin',
    'close any exposure, cancel resting orders and withdraw free collateral'],
  custody: ['check jurisdiction, custody and KYC access without depositing anything',
    'custody, legal restrictions, issuer default and redemption gates',
    "use the issuer's documented redemption route only if already invested"],
  vault: ['test a small deposit after reviewing the strategy, manager permissions and withdrawal terms',
    'manager discretion, strategy leverage, contract loss and redemption delays',
    'redeem a small share amount first, then exit the remainder net of fees'],
  generic: ['map the documented product and supported assets before any capital moves',
    'unknown mechanics, contract failure and unverified access',
    'use the documented reversal flow; if no exit can be explained, stay research-only'],
};

/** A spend plan needs evidence; without it the row gets an explicit research-only state. */
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

export function farmPlan(p, structural, score) {
  const state = planState(p, structural, score);
  const chain = [...p.chains].sort(cmp)[0] || 'an unverified chain';
  const extra = p.chains.length > 1 ? ` (${p.chains.length} chains listed)` : '';
  const recorded = tokenRecorded(p);
  const capital = state.mode === 'conditional' ? capitalFor(p) : 0;
  const fee = state.mode === 'conditional' ? FEE(chain) : EMPTY;
  const [action, risk, exit] = ACTIONS[familyOf(p.category)];
  const d = score.drivers, band = score.band;
  const steps = state.mode === 'research-only' ? [
    { stage: 'VERIFY ACCESS', minutes: 20, usd_low: 0, usd_high: 0, requires_capital: false,
      text: `Read ${p.name}'s own documentation, contracts and audits for ${chain}${extra}; it is ${state.reason}, so this row carries no spend plan.` },
    { stage: 'CHECK TOKEN STATUS', minutes: 10, usd_low: 0, usd_high: 0, requires_capital: false,
      text: `Confirm whether ${p.name} records a token or a published incentive program; the snapshot ${recorded ? 'records token metadata' : 'records none'}, which proves neither a launch nor its absence.` },
    { stage: 'RESEARCH LOG', minutes: 15, usd_low: 0, usd_high: 0, requires_capital: false,
      text: `Write down what must become true first for ${p.name} — audited contracts, a documented exit and a published program — and set a review date before any capital is considered.` },
  ] : [
    { stage: 'VERIFY ACCESS', minutes: 25, usd_low: 0, usd_high: 0, requires_capital: false,
      text: `Verify ${p.name}'s official app, contracts and audit reports for ${chain}${extra}; the snapshot carries no trusted URL, so confirm the ${p.category} mechanics yourself.` },
    { stage: 'CHECK TOKEN STATUS', minutes: 10, usd_low: 0, usd_high: 0, requires_capital: false,
      text: recorded ? `${p.name} already records token metadata (${p.symbol || p.gecko_id}); inspect only published incentive programs, never a hypothetical launch.`
        : `${p.name} records no token; confirm whether a program now exists, because absent metadata is not proof of a future launch.` },
    { stage: 'BOUNDED TEST', minutes: 30, usd_low: fee.low, usd_high: fee.high, requires_capital: true,
      text: `On ${chain}${extra}, ${action}, with at most ${USD(capital)} of principal; ${USD(band.low)}–${USD(band.high)} is the model range, not a target.` },
    { stage: 'MONITOR RISK', minutes: 30, usd_low: 0, usd_high: 0, requires_capital: false,
      text: `Re-check weekly for ${REVIEW_DAYS} days at a ${d.peer_multiple}× peer multiple over ${d.peer_count} peers: watch ${risk}, and log receipts, fees and balances.` },
    { stage: 'EXIT & RECONCILE', minutes: 20, usd_low: fee.low, usd_high: fee.high, requires_capital: false,
      text: `For ${p.name}, ${exit}; keep $${fee.low}–$${fee.high} for exit fees and stop on any unexpected approval or withdrawal failure.` },
  ];
  const totals = planTotals(steps, capital);
  return { mode: state.mode, reason: state.reason, branch: planBranch(p, structural), chain,
    capital_usd: capital, review_days: REVIEW_DAYS, steps, totals,
    label: state.mode === 'research-only' ? 'Research-only: this snapshot record does not justify any spend. Costs stay at zero.'
      : 'Illustrative planning estimates only; not campaign terms. Principal can be lost and rewards may be zero.' };
}

export function buildRadar(snapshot) {
  const watch = new Set(snapshot.watchlist);
  const rows = snapshot.protocols.map(p => {
    const structural = structuralRisk(p), recorded = tokenRecorded(p);
    const score = scoreProtocol(p, snapshot), plan = farmPlan(p, structural, score);
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
