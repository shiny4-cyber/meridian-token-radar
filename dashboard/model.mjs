// Meridian / model v1. Pure functions; no clock, network, randomness or ranked-name overrides.
// This exact module is run by main.ts and included in the source dossier.
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
  // A zero market cap is not a positive market observation, but its presence still signals metadata.
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
  // Exclude self and structural products. Deduplicate shared token IDs, preventing pool clones
  // from counting as independent evidence. Pick largest TVL per token; slug breaks ties.
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
  const growthFactor = 1 + growth / 400; // only 25% weight on a noisy seven-day observation
  const ageFactor = age === null ? 0.70 : 0.65 + 0.35 * Math.sqrt(Math.min(age, 1095) / 1095);
  const structural = structuralRisk(p);
  const structureFactor = structural ? 0.5 : 1;
  const tvl = Math.min(p.tvl_usd, 1e12);
  const implied = money(tvl * peers.multiple * growthFactor * ageFactor * structureFactor);
  const lowConfidence = peers.basis !== 'category' || peers.n < 8 || age === null || p.change_7d === null || structural || tvl === 0;
  const confidence = lowConfidence ? 'Low' : 'Moderate'; // never a statistical confidence interval
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
  return { implied_value_usd: implied, age_days: age, confidence,
    band: { low: money(implied * lowFactor), high: money(implied * highFactor), label: 'Scenario range, not a probability interval' },
    drivers: { tvl_used: tvl, peer_multiple: round(peers.multiple), growth_used: growth,
      growth_factor: round(growthFactor), age_factor: round(ageFactor), structure_factor: structureFactor,
      peer_basis: peers.basis, peer_count: peers.n, category_peer_count: peers.category_n,
      peer_q25: round(peers.q25), peer_q75: round(peers.q75), peer_slugs: peers.slugs }, warnings };
}

export function farmPlan(p, structural) {
  const chain = [...p.chains].sort(cmp)[0] || 'an independently verified supported chain';
  const ethereum = chain === 'Ethereum';
  const fees = ethereum ? '$5–30' : '$1–10';
  const budget = ethereum ? 30 : 10;
  const c = (p.category || '').toLowerCase();
  let action, risk, exit;
  if (c.includes('lend') || c === 'cdp') {
    action = 'If permissionless supply is documented, test $50 of an accepted collateral asset, without borrowing or leverage. Confirm shares and receipt balance';
    risk = 'bad debt, oracle failure, liquidation if borrowing is later enabled, and withdrawal liquidity';
    exit = 'Redeem a small amount first, then withdraw remaining supply; repay any accidental debt before closing';
  } else if (c.includes('dex')) {
    action = 'If a supported spot pair is documented, test one $10 swap with a 0.5% slippage ceiling; do not manufacture volume. LP is optional only after studying both assets';
    risk = 'slippage, MEV, token approvals and impermanent loss if liquidity is provided';
    exit = 'Reverse the test swap only if needed; remove any LP position and revoke residual approvals';
  } else if (c.includes('bridge')) {
    action = 'If both networks and redemption are verified, bridge only $20 once to a supported destination. First estimate both directions; do not bridge just for speculative points';
    risk = 'bridge custody, validator compromise, depegging and unavailable return liquidity';
    exit = 'Test the documented return or redemption route and confirm the original-chain balance before adding funds';
  } else if (c.includes('staking') || c.includes('restak') || c.includes('staking pool')) {
    action = 'If an accessible staking route exists, test $50 of its documented supported asset after checking minimums, withdrawal queues and slashing exposure';
    risk = 'slashing, receipt-token depeg and delayed withdrawals';
    exit = 'Submit an unstake request and track the documented queue; use secondary liquidity only after checking the discount';
  } else if (c.includes('derivative') || c.includes('perpetual') || c.includes('prediction') || c.includes('leveraged')) {
    action = 'Use a sandbox or read-only market review first. If no sandbox exists, skip trading; do not open leverage or an outcome bet solely to seek unconfirmed rewards';
    risk = 'liquidation, funding costs and total loss of speculative margin';
    exit = 'Close any existing exposure, cancel orders and withdraw free collateral; verify no residual positions remain';
  } else if (c.includes('rwa') || c === 'cex') {
    action = 'Check jurisdiction, issuer access, custody and KYC requirements without depositing. If retail participation is unavailable or terms cannot be verified, mark this row research-only';
    risk = 'custody, legal restrictions, issuer default and redemption gates';
    exit = 'Use the issuer’s documented redemption route only if already invested; otherwise end with a zero-capital research log';
  } else if (c.includes('yield') || c.includes('curator') || c.includes('allocator') || c.includes('basis') || c.includes('stable')) {
    action = 'If a public vault is documented, test $50 in an accepted asset after reviewing the underlying strategy, manager permissions, fees and withdrawal terms';
    risk = 'manager discretion, strategy leverage, smart-contract loss and redemption delays';
    exit = 'Test redeeming a small share amount, then exit the remainder; account for fees and any documented queue';
  } else {
    action = 'Map the documented product and supported assets first. Only if permissionless access and an exit are confirmed, test the smallest useful action up to $25; otherwise skip funding';
    risk = 'unknown product mechanics, smart-contract failure and unverified access';
    exit = 'Use the documented reversal or redemption flow; if an exit cannot be explained before entry, keep this research-only';
  }
  const recorded = tokenRecorded(p);
  const steps = [
    `Research ${p.name} (${p.category || 'unclassified'}) on ${chain}: independently verify the official app, contracts, audits and access. Planning estimate: $0, 20–30 min. The snapshot supplies no trusted app URL or campaign terms.`,
    `${recorded ? 'Token metadata is already recorded; inspect only published incentive programs, not a hypothetical launch.' : 'Verify whether any token or reward program now exists; absent snapshot metadata does not establish either.'} Planning estimate: $0, 10 min. Never assume eligibility, reward size or a launch date.`,
    `${action}. Planning estimate: 20–30 min; ${fees} total transaction-fee budget, plus test principal at risk. Check the live quote before signing; skip if minimums or fees exceed the budget.`,
    `Monitor once weekly for two weeks as a planning schedule, not a qualifying campaign window: log receipts, fees, balances and ${risk}. Estimate: $0 for read-only checks, 10 min/week. Do not repeat transactions just to farm activity.`,
    `${exit}. Planning estimate: 15–30 min of active work plus any published settlement delay; reserve ${fees} for exit fees. Stop on unexpected approvals, depeg, withdrawal failure or a changed risk profile.`
  ];
  return { steps, planning: { fee_budget_usd: budget * 2, review_days: 14, structural_caution: structural,
    label: 'Illustrative planning estimates only; not known campaign terms. Principal can be lost; rewards may be zero.' } };
}

export function buildRadar(snapshot) {
  const watch = new Set(snapshot.watchlist);
  const rows = snapshot.protocols.map(p => {
    const structural = structuralRisk(p), recorded = tokenRecorded(p);
    const score = scoreProtocol(p, snapshot), plan = farmPlan(p, structural);
    return { ...p, chains: [...p.chains].sort(cmp), ...score, watchlist: watch.has(p.slug),
      token_status: recorded ? 'recorded' : 'unrecorded', structural_caution: structural,
      farm_steps: plan.steps, planning: plan.planning };
  }).sort((a, b) => b.implied_value_usd - a.implied_value_usd || cmp(a.slug, b.slug))
    .map((row, i) => ({ rank: i + 1, ...row }));
  return { schema: 'meridian-radar/v1', as_of: snapshot.as_of, source: snapshot.source,
    floor_usd: snapshot.floor_usd, model_version: 'Meridian 1.0',
    methodology: 'TVL × median bounded market-cap/TVL peer ratio × bounded growth × listing-age maturity × structural discount. Scenario market capitalization, not FDV, TVL, token price or forecast.',
    summary: { total: rows.length, watchlist: rows.filter(r => r.watchlist).length,
      no_token_recorded: rows.filter(r => r.token_status === 'unrecorded').length,
      research_candidates: rows.filter(r => r.token_status === 'unrecorded' && !r.structural_caution).length,
      recorded: rows.filter(r => r.token_status === 'recorded').length,
      structural: rows.filter(r => r.structural_caution).length }, rows };
}
