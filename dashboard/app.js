
import { filterRows, sortRows, pageSlice, pageCount, activeFilters, encodeHash, decodeHash,
  formatUsd, formatExact, formatPct, formatFactor, formatAge, formatDelta, stepLabel,
  assertCoverage, MODEL_SPEC, formulaText, methodSections, DEFAULT_STATE } from './view.mjs';
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PAGE_SIZE = 8;
const state = { ...DEFAULT_STATE };
const checked = new Map(); // session-only checklist state
let data, filtered = [], focusReturn = null;
function badge(r) {
  const why = r.confidence === 'Low' ? 'Low confidence' : 'Moderate confidence';
  return `<span class="badge ${r.confidence.toLowerCase()}" title="${why}: ${esc(r.drivers.peer_count)} peer observations, ${esc(r.drivers.peer_basis)}">${esc(r.confidence)}</span>`;
}
function statusLabel(r) { return r.token_status === 'recorded' ? 'Token metadata recorded' : 'No token recorded'; }
function selectOptions(id, values) {
  for (const value of [...new Set(values)].sort()) {
    const option = document.createElement('option'); option.value = value; option.textContent = value; $(id).append(option);
  }
}
function summary() {
  const s = data.summary;
  $('summary').innerHTML = [
    ['Watchlist covered', `${s.watchlist_covered}<span class="slash"> / ${s.watchlist_total}</span>`, 'Every watchlist protocol is a board row'],
    ['Research candidates', s.research_candidates, 'No token recorded · structural flags excluded'],
    ['Beyond the watchlist', s.below_watchlist, `Ranked below-watchlist protocols · ${s.total} rows in all`],
    ['Token benchmarks', s.recorded, `Separate view · ${s.low_confidence} rows are low confidence`]
  ].map(([label, value, note]) => `<div class="metric"><div class="metric-label">${label}</div><div class="metric-value">${value}</div><div class="metric-note">${note}</div></div>`).join('');
  $('snapshot-date').textContent = `${data.as_of} / UTC`;
  $('source-date').textContent = `DefiLlama snapshot · ${data.as_of} · Offline research`;
  $('count-candidates').textContent = s.research_candidates;
  $('count-unrecorded').textContent = s.no_token_recorded;
  $('count-recorded').textContent = s.recorded;
  $('count-all').textContent = s.total;
  $('full-source').textContent = `Snapshot provenance: ${data.source}`;
  const pct = s.watchlist_total ? Math.round((s.watchlist_covered / s.watchlist_total) * 1000) / 10 : 0;
  $('coverage-line').innerHTML = `<b>Coverage: ${s.watchlist_covered} / ${s.watchlist_total} watchlist protocols shown (${pct}%)</b>` +
    `<span class="coverage-sep">·</span>The watchlist is the floor, not the ceiling: <b>${s.below_watchlist}</b> below-watchlist protocols are ranked too` +
    `<span class="coverage-sep">·</span>${s.total} snapshot rows · ${s.low_confidence} low-confidence rows flagged`;
  $('coverage-line').dataset.ok = String(s.coverage_ok);
}
function readForm() {
  state.q = $('search').value;
  state.category = $('category').value;
  state.chain = $('chain').value;
  state.coverage = $('coverage').value;
}
function writeHash() {
  const next = encodeHash(state);
  const url = location.pathname + location.search + next;
  if (location.hash !== next) history.replaceState(null, '', url);
  $('filter-hash').textContent = next ? `URL state ${next}` : 'URL state: default board';
  $('filter-hash').dataset.changed = String(Boolean(next));
}
function render() {
  readForm();
  filtered = sortRows(filterRows(data.rows, state), state.sort, state.direction);
  const page = pageSlice(filtered, state.page, PAGE_SIZE);
  state.page = page.page;
  if (!filtered.some(r => r.slug === state.selected)) state.selected = page.rows[0]?.slug ?? null;
  const watchCount = filtered.filter(r => r.watchlist).length;
  $('results').textContent = `${filtered.length} protocols · ${watchCount} on the watchlist · global ranks preserved`;
  $('view-total').textContent = `${filtered.length} records`;
  $('view-note').innerHTML = {
    candidates: '<b>No token recorded</b> · Wrapper, bridge, exchange and versioned-product flags excluded. Missing metadata does not establish a launch.',
    unrecorded: '<b>All no-token records</b> · Includes structural products. No-token-recorded is not proof of no token; inspect each caution flag.',
    recorded: '<b>Existing-token benchmarks</b> · Token metadata recorded. Scenario values remain model outputs; observed market cap is shown in details.',
    all: '<b>Full snapshot</b> · All records, all statuses. Rank is a model scenario; it is not a priority score or expected farm reward.'
  }[state.view];
  $('filter-chips').innerHTML = activeFilters(state).map(f =>
    `<button class="chip" data-clear="${esc(f.key)}" title="Remove this filter">${esc(f.label)}<span aria-hidden="true">×</span><span class="sr-only"> — remove filter</span></button>`).join('');
  $('reset').disabled = activeFilters(state).length === 1 && state.sort === DEFAULT_STATE.sort && state.page === 0;
  $('rows').innerHTML = page.rows.map(r => `<tr data-slug="${esc(r.slug)}" data-detail="${esc(r.slug)}" class="${r.slug === state.selected ? 'selected' : ''}">
    <td class="rank-cell">${String(r.rank).padStart(3, '0')}</td>
    <td><button class="protocol-button" data-detail="${esc(r.slug)}">${esc(r.name)}${r.watchlist ? '<span class="watch-dot" title="Official watchlist"></span>' : ''}<span class="sr-only"> — open protocol detail</span></button><span class="protocol-meta">${esc(r.category || 'Unclassified')} · ${esc(r.chains[0] || 'Chain unknown')}${r.chains.length > 1 ? ` +${r.chains.length - 1}` : ''}${r.structural_caution ? ' · Caution' : ''}${r.plan.mode === 'research-only' ? ' · Research only' : ''}</span></td>
    <td class="numeric">${formatUsd(r.tvl_usd)}</td>
    <td class="numeric ${r.change_7d >= 0 ? 'up' : 'down'}">${formatPct(r.change_7d)}</td>
    <td class="numeric scenario">${formatUsd(r.implied_value_usd)}<small>${formatUsd(r.band.low)} – ${formatUsd(r.band.high)}</small></td>
    <td class="numeric delta ${r.rank_delta > 0 ? 'up' : r.rank_delta < 0 ? 'down' : ''}" title="Model rank ${r.rank} vs TVL rank ${r.tvl_rank}">${formatDelta(r.rank_delta)}</td>
    <td class="numeric age">${formatAge(r.age_days)}</td>
    <td class="confidence-col">${badge(r)}</td></tr>`).join('');
  $('page-label').textContent = filtered.length ? `${page.first}–${page.last} of ${filtered.length} · Page ${page.page + 1}/${page.pages}` : '0 records';
  $('page-input').max = String(page.pages); $('page-input').value = String(page.page + 1);
  $('prev').disabled = page.page === 0; $('next').disabled = page.page >= page.pages - 1;
  $('first').disabled = page.page === 0; $('last').disabled = page.page >= page.pages - 1;
  document.querySelectorAll('[data-sort]').forEach(button => {
    button.parentElement.removeAttribute('aria-sort');
    if (button.dataset.sort === state.sort) button.parentElement.setAttribute('aria-sort', state.direction === 1 ? 'ascending' : 'descending');
  });
  writeHash();
}
function openDialog(id) { if (id !== 'detail') focusReturn = document.activeElement; $(id).showModal(); }
function closeDialog(id) { $(id).close(); }
function showDetail(slug) {
  const r = data.rows.find(row => row.slug === slug); if (!r) return;
  focusReturn = document.activeElement; state.selected = slug;
  document.querySelectorAll('#rows tr').forEach(tr => tr.classList.toggle('selected', tr.dataset.slug === slug));
  const d = r.drivers, done = checked.get(slug) || new Set();
  const kpis = [['Snapshot TVL', formatUsd(r.tvl_usd)], ['Observed market cap', formatUsd(r.mcap_usd)],
    ['7-day TVL change', formatPct(r.change_7d)], ['Days since listing', r.age_days ?? 'Unknown']];
  const drivers = [['TVL used by model', formatUsd(d.tvl_used)], ['Peer multiple (mcap / TVL)', formatFactor(d.peer_multiple)],
    ['Growth used', `${formatPct(d.growth_used)} → ${formatFactor(d.growth_factor)}`],
    ['Age factor (listing maturity)', formatFactor(d.age_factor)], ['Structure factor', formatFactor(d.structure_factor)],
    ['Confidence', r.confidence], ['Model rank / TVL rank', `#${r.rank} / #${r.tvl_rank} (${formatDelta(r.rank_delta)})`]];
  const stages = ['01 / VERIFY ACCESS', '02 / CHECK TOKEN STATUS', '03 / BOUNDED TEST', '04 / MONITOR RISK', '05 / EXIT & RECONCILE'];
  $('detail-body').innerHTML = `<div class="dialog-header"><div><p class="eyebrow">PROTOCOL RESEARCH / GLOBAL RANK ${r.rank}</p><h2 id="detail-title">${esc(r.name)}</h2><span class="muted">${esc(r.category || 'Unclassified')} · ${esc(r.chains.join(', ') || 'Chain unknown')}</span></div><button class="close" data-close="detail" aria-label="Close protocol detail">×</button></div>
    <div class="detail-grid"><section class="detail-evidence"><span class="badge ${r.token_status === 'recorded' ? 'recorded' : ''}">${statusLabel(r)}</span>
      <p class="inspect-value-label top">Scenario market capitalization</p><div class="inspect-value">${formatUsd(r.implied_value_usd)}</div>
      <p class="range-label">${formatUsd(r.band.low)} – ${formatUsd(r.band.high)} · ${r.confidence} evidence</p>
      <dl class="detail-kpis">${kpis.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>
      <h3>Full driver breakdown</h3><ul class="factor-list">${drivers.map(([k, v]) =>
        `<li><span>${k}</span><b class="${k === 'Confidence' && r.confidence === 'Low' ? 'low-flag' : ''}">${v}</b></li>`).join('')}</ul>
      <p class="note">${esc(d.peer_basis)} · ${d.peer_count} peers · ${d.category_peer_count} same-category · quartiles ${formatFactor(d.peer_q25)} / ${formatFactor(d.peer_q75)}. Rounded for display; the score uses the published factors.</p>
      <details><summary>Inspect ${d.peer_count} comparable records</summary><div class="peer-list">${d.peer_slugs.map(esc).join(' · ') || 'No available peers; 0.25× prior used.'}</div></details>
      <details><summary>All ${r.warnings.length} warnings & source fields</summary><p>Slug: ${esc(r.slug)}<br>Listed: ${esc(r.listed_at || 'Unknown')}<br>Symbol: ${esc(r.symbol || 'Not recorded')}<br>CoinGecko ID: ${esc(r.gecko_id || 'Not recorded')}<br>Raw market cap: ${r.mcap_usd === null ? 'null' : esc(r.mcap_usd)}<br>FDV: not supplied<br>Watchlist: ${r.watchlist ? 'Yes' : 'No'}</p><ul class="warning-list">${r.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul></details>
      <p class="caution">Age is days since the snapshot's first record for this protocol, a lower bound on operating age: maturity may be understated, never overstated. ${r.drivers.age_dropped ? 'No first record exists, so that factor is dropped and the value renormalised.' : ''} Range is a sensitivity scenario, not a probability interval or expected reward.</p>
    </section><section class="detail-plan"><div class="plan-heading"><h3>${r.plan.mode === 'research-only' ? 'Research checklist' : 'Farm research checklist'}</h3><span id="check-progress">${done.size}/${r.plan.steps.length} reviewed</span></div>
      <p class="plan-mode ${r.plan.mode}">${r.plan.mode === 'research-only' ? 'RESEARCH ONLY — no spend plan' : 'CONDITIONAL TEST PLAN'} · ${esc(r.plan.reason)}</p>
      <p class="planning-label">${esc(r.plan.label)}</p>
      <ol class="checklist">${r.plan.steps.map((step, i) => `<li><input type="checkbox" id="step-${i}" data-step="${i}" data-slug="${esc(slug)}" ${done.has(i) ? 'checked' : ''}><label for="step-${i}">${esc(stepLabel(step, i, r.plan))}</label></li>`).join('')}</ol>
      <p class="note sens-block">Age sensitivity: implied value ${formatUsd(r.implied_value_usd)} if listing maturity holds, ${formatUsd(r.sensitivity.implied_neutral_age)} under a neutral ${r.sensitivity.neutral_age_days}-day age (${formatPct(r.sensitivity.delta_pct)}). Listing age is not operating age or time without a token.</p>
      <p class="note">${esc(r.plan.fee_note)} Review date ${r.plan.review_date}, computed from the snapshot's ${data.as_of} plus ${r.plan.review_days} days.</p>
      <dl class="plan-totals"><div><dt>Total active time</dt><dd>${r.plan.totals.minutes} min</dd></div><div><dt>Fee budget</dt><dd>$${r.plan.totals.fee_low}–$${r.plan.totals.fee_high}</dd></div><div><dt>Peak principal</dt><dd>${r.plan.totals.peak_principal_usd ? '$' + r.plan.totals.peak_principal_usd : 'No capital'}</dd></div></dl>
      <div class="detail-status">Plan branch ${esc(r.plan.branch)} · ${r.plan.review_days}-day review. Checks are local to this page session. No wallet connection. No transactions.</div></section></div>`;
  openDialog('detail');
}
function reset() {
  Object.assign(state, DEFAULT_STATE);
  ['search', 'category', 'chain', 'coverage'].forEach(id => $(id).value = '');
  render();
}
function applyHash() {
  Object.assign(state, decodeHash(location.hash));
  $('search').value = state.q; $('category').value = state.category;
  $('chain').value = state.chain; $('coverage').value = state.coverage;
  document.querySelectorAll('[data-view]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.view === state.view)));
}
function setView(view) {
  state.view = view; state.page = 0;
  document.querySelectorAll('[data-view]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.view === view)));
  render();
}
function bind() {
  ['search', 'category', 'chain', 'coverage'].forEach(id => $(id).addEventListener(id === 'search' ? 'input' : 'change', () => { state.page = 0; render(); }));
  document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => setView(button.dataset.view)));
  document.querySelectorAll('[data-sort]').forEach(button => button.addEventListener('click', () => {
    const key = button.dataset.sort; state.direction = key === state.sort ? -state.direction : key === 'name' || key === 'rank' ? 1 : -1;
    state.sort = key; state.page = 0; render();
  }));
  $('reset').addEventListener('click', reset);
  $('prev').addEventListener('click', () => { state.page--; render(); });
  $('next').addEventListener('click', () => { state.page++; render(); });
  $('first').addEventListener('click', () => { state.page = 0; render(); });
  $('last').addEventListener('click', () => { state.page = pageCount(filtered.length, PAGE_SIZE) - 1; render(); });
  $('page-input').addEventListener('change', event => {
    const value = Number(event.target.value);
    if (Number.isFinite(value)) { state.page = Math.max(0, Math.trunc(value) - 1); render(); }
  });
  $('board-nav').addEventListener('click', () => $('workspace').scrollIntoView());
  ['method-button', 'method-footer'].forEach(id => $(id).addEventListener('click', () => openDialog('method')));
  document.addEventListener('click', event => {
    const detail = event.target.closest('[data-detail]'), close = event.target.closest('[data-close]'), clear = event.target.closest('[data-clear]');
    if (detail) showDetail(detail.dataset.detail);
    if (close) closeDialog(close.dataset.close);
    if (clear) {
      const key = clear.dataset.clear;
      if (key === 'view') setView(DEFAULT_STATE.view);
      else if (key === 'q') { $('search').value = ''; state.page = 0; render(); }
      else if (key === 'category') { $('category').value = ''; state.page = 0; render(); }
      else if (key === 'chain') { $('chain').value = ''; state.page = 0; render(); }
      else if (key === 'coverage') { $('coverage').value = ''; state.page = 0; render(); }
      else { state.sort = DEFAULT_STATE.sort; state.direction = DEFAULT_STATE.direction; render(); }
    }
  });
  document.addEventListener('change', event => {
    const input = event.target.closest('[data-step]'); if (!input) return;
    const set = checked.get(input.dataset.slug) || new Set(), n = Number(input.dataset.step);
    if (input.checked) set.add(n); else set.delete(n);
    checked.set(input.dataset.slug, set);
    const total = data.rows.find(row => row.slug === input.dataset.slug)?.farm_steps.length || 5;
    $('check-progress').textContent = `${set.size}/${total} reviewed`;
  });
  document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('close', () => {
    if (focusReturn?.isConnected) focusReturn.focus();
    else document.querySelector(`button[data-detail="${CSS.escape(state.selected || '')}"]`)?.focus();
  }));
  document.addEventListener('keydown', event => {
    if (event.key === '/' && !document.querySelector('dialog[open]') && !['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
      event.preventDefault(); $('search').focus();
    }
  });
  addEventListener('hashchange', () => { applyHash(); render(); });
}
async function start() {
  try {
    const response = await fetch('./records.dat', { cache: 'no-store' });
    if (!response.ok) throw new Error(`Static data unavailable (${response.status})`);
    data = await response.json();
    if (data.schema !== 'meridian-radar/v1' || !Array.isArray(data.rows) || !data.rows.length) throw new Error('Invalid board data');
    assertCoverage(data.summary, data.rows);
    $('formula').textContent = formulaText(MODEL_SPEC);
    $('method-grid').innerHTML = methodSections(MODEL_SPEC).map(s => `<section><span class="step-label">${esc(s.label)}</span><h3>${esc(s.title)}</h3><p>${esc(s.body)}</p></section>`).join('');
    $('model-version').textContent = MODEL_SPEC.version.toUpperCase();
    summary(); selectOptions('category', data.rows.map(r => r.category || 'Unclassified'));
    selectOptions('chain', data.rows.flatMap(r => r.chains)); bind(); applyHash(); render();
    document.documentElement.dataset.ready = 'true';
  } catch (error) {
    $('results').textContent = `Unable to load the board: ${error.message}. Serve the built output through a local static server; file:// fetch is not supported.`;
    $('view-note').textContent = 'No sample or fallback data is displayed. Build main.ts with the sealed snapshot first.';
    document.documentElement.dataset.ready = 'error';
  }
}
start();
