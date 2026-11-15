// All displayed financial data and farm steps come from records.dat, the exact board.json bytes.
// records.dat is JSON, not executable code. It avoids repeating a large generated dataset in the source dossier.
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dollars = value => {
  if (value === null || value === undefined || value < 0) return 'Unavailable';
  for (const [n, suffix] of [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']]) {
    if (value >= n) return `$${(value / n).toFixed(2)}${suffix}`;
  }
  return '$' + value.toLocaleString('en-US', { maximumFractionDigits: 0 });
};
const exact = value => value === null || value < 0 ? 'Unavailable' : '$' + value.toLocaleString('en-US', { maximumFractionDigits: 2 });
const pct = value => value === null ? '—' : `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
const factor = value => `${value.toFixed(3)}×`;
const state = { view: 'candidates', page: 0, size: 8, sort: 'implied_value_usd', direction: -1, selected: null };
let data, filtered = [], focusReturn = null;
const checked = new Map(); // Session-only checklist state, no wallet or identity storage.

function badge(r) { return `<span class="badge ${r.confidence.toLowerCase()}">${esc(r.confidence)}</span>`; }
function statusLabel(r) { return r.token_status === 'recorded' ? 'Token metadata recorded' : 'No token recorded'; }
function selectOptions(id, values) {
  for (const value of [...new Set(values)].sort()) {
    const option = document.createElement('option'); option.value = value; option.textContent = value; $(id).append(option);
  }
}
function summary() {
  const s = data.summary;
  $('summary').innerHTML = [
    ['Watchlist covered', `${s.watchlist}<span class="slash"> / ${s.watchlist}</span>`, 'Every official watchlist protocol included', '<div class="mini-bar" aria-hidden="true">' + '<span></span>'.repeat(20) + '</div>'],
    ['Research candidates', s.research_candidates, 'No token recorded · structural flags excluded', ''],
    ['No-token records', s.no_token_recorded, 'Includes wrappers, bridges and exchange records', ''],
    ['Token benchmarks', s.recorded, `${s.total} total protocols · same sealed snapshot`, '']
  ].map(([label, value, note, bar]) => `<div class="metric"><div class="metric-label">${label}</div><div class="metric-value">${value}</div><div class="metric-note">${note}</div>${bar}</div>`).join('');
  $('snapshot-date').textContent = `${data.as_of} / UTC`;
  $('source-date').textContent = `DefiLlama snapshot · ${data.as_of} · Offline research`;
  $('count-candidates').textContent = s.research_candidates;
  $('count-unrecorded').textContent = s.no_token_recorded;
  $('count-recorded').textContent = s.recorded;
  $('full-source').textContent = `Snapshot provenance: ${data.source}`;
}
function render() {
  const query = $('search').value.trim().toLowerCase(), category = $('category').value, chain = $('chain').value, coverage = $('coverage').value;
  filtered = data.rows.filter(r => {
    if (state.view === 'candidates' && (r.token_status !== 'unrecorded' || r.structural_caution)) return false;
    if (state.view === 'unrecorded' && r.token_status !== 'unrecorded') return false;
    if (state.view === 'recorded' && r.token_status !== 'recorded') return false;
    if (category && (r.category || 'Unclassified') !== category) return false;
    if (chain && !r.chains.includes(chain)) return false;
    if (coverage === 'watchlist' && !r.watchlist || coverage === 'outside' && r.watchlist || coverage === 'structural' && !r.structural_caution) return false;
    return !query || `${r.name} ${r.slug} ${r.symbol || ''}`.toLowerCase().includes(query);
  }).sort((a, b) => {
    const av = a[state.sort], bv = b[state.sort];
    if (av === null && bv !== null) return 1;
    if (bv === null && av !== null) return -1;
    const delta = typeof av === 'string' ? (av < bv ? -1 : av > bv ? 1 : 0) : (av ?? 0) - (bv ?? 0);
    return delta * state.direction || a.rank - b.rank;
  });
  const pages = Math.max(1, Math.ceil(filtered.length / state.size));
  state.page = Math.min(state.page, pages - 1);
  const pageRows = filtered.slice(state.page * state.size, (state.page + 1) * state.size);
  if (!filtered.some(r => r.slug === state.selected)) state.selected = pageRows[0]?.slug ?? null;
  const watchCount = filtered.filter(r => r.watchlist).length;
  $('results').textContent = `${filtered.length} protocols · ${watchCount} watchlist · global ranks preserved`;
  $('view-total').textContent = `${filtered.length} records`;
  $('view-note').innerHTML = {
    candidates: '<b>No token recorded</b> · Wrapper, bridge, exchange and versioned-product flags excluded. Missing metadata does not establish a launch.',
    unrecorded: '<b>All no-token records</b> · Includes structural products. No-token-recorded is not proof of no token; inspect each caution flag.',
    recorded: '<b>Existing-token benchmarks</b> · Token metadata is recorded. Scenario values remain model outputs; observed market cap is shown in details.',
    all: '<b>Full snapshot</b> · All records, all statuses. Rank is a model scenario; it is not a priority score or expected farm reward.'
  }[state.view];
  $('rows').innerHTML = pageRows.map(r => `<tr data-slug="${esc(r.slug)}" class="${r.slug === state.selected ? 'selected' : ''}">
    <td>${String(r.rank).padStart(3, '0')}</td>
    <td><button class="protocol-button" data-detail="${esc(r.slug)}">${esc(r.name)}${r.watchlist ? '<span class="watch-dot" title="Official watchlist"></span>' : ''}<span class="sr-only"> — open protocol detail</span></button><span class="protocol-meta">${esc(r.category || 'Unclassified')} · ${esc(r.chains[0] || 'Chain unknown')}${r.chains.length > 1 ? ` +${r.chains.length - 1}` : ''}${r.structural_caution ? ' · Caution' : ''}</span></td>
    <td class="numeric" title="${exact(r.tvl_usd)}">${dollars(r.tvl_usd)}</td>
    <td class="numeric ${r.change_7d >= 0 ? 'up' : 'down'}">${pct(r.change_7d)}</td>
    <td class="numeric scenario" title="${exact(r.implied_value_usd)}">${dollars(r.implied_value_usd)}<small>${dollars(r.band.low)} – ${dollars(r.band.high)}</small></td>
    <td class="confidence-col">${badge(r)}</td></tr>`).join('');
  $('empty').hidden = filtered.length !== 0;
  $('page-label').textContent = filtered.length ? `${state.page * state.size + 1}–${Math.min((state.page + 1) * state.size, filtered.length)} of ${filtered.length} · Page ${state.page + 1}/${pages}` : '0 records';
  $('prev').disabled = state.page === 0; $('next').disabled = state.page >= pages - 1;
  document.querySelectorAll('[data-sort]').forEach(button => {
    button.parentElement.removeAttribute('aria-sort');
    if (button.dataset.sort === state.sort) button.parentElement.setAttribute('aria-sort', state.direction === 1 ? 'ascending' : 'descending');
  });
  renderPreview();
}
function renderPreview() {
  const r = data.rows.find(r => r.slug === state.selected);
  if (!r) { $('inspector').innerHTML = '<h3>No selection</h3><p class="muted">Adjust the filters to inspect a protocol.</p>'; return; }
  $('inspector').innerHTML = `<div class="inspector-kicker"><span>RESEARCH BRIEF</span><span>#${r.rank}</span></div>
    <div class="protocol-icon" aria-hidden="true">${esc(r.name.slice(0, 2).toUpperCase())}</div><h3 class="inspect-title">${esc(r.name)}</h3>
    <p class="inspect-category">${esc(r.category || 'Unclassified')} · ${r.watchlist ? 'Official watchlist' : 'Extended coverage'}</p>
    <div class="inspect-value-label">Scenario market capitalization</div><div class="inspect-value">${dollars(r.implied_value_usd)}</div>
    <div class="range-label">ILLUSTRATIVE RANGE · NOT A FORECAST</div><div class="range-track" aria-hidden="true"></div><div class="range-numbers"><span>${dollars(r.band.low)}</span><span>${dollars(r.band.high)}</span></div>
    <div class="preview-facts"><div><span>Evidence</span>${badge(r)}</div><div><span>Peer basis</span><strong>${esc(r.drivers.peer_basis)}</strong></div><div><span>Peer observations</span><strong>${r.drivers.peer_count}</strong></div><div><span>Age since listing</span><strong>${r.age_days === null ? 'Unknown' : `${r.age_days} days`}</strong></div></div>
    <p class="caution">${esc(r.warnings[0])}</p><button class="primary" data-detail="${esc(r.slug)}">Open research & farm plan →</button>`;
}
function openDialog(id) { if (id !== 'detail') focusReturn = document.activeElement; $(id).showModal(); }
function closeDialog(id) { $(id).close(); }
function showDetail(slug) {
  const r = data.rows.find(r => r.slug === slug); if (!r) return;
  focusReturn = document.activeElement;
  state.selected = slug; render();
  const d = r.drivers;
  const completed = checked.get(slug) || new Set();
  $('detail-body').innerHTML = `<div class="dialog-header"><div><p class="eyebrow">PROTOCOL RESEARCH / GLOBAL RANK ${r.rank}</p><h2 id="detail-title">${esc(r.name)}</h2><span class="muted">${esc(r.category || 'Unclassified')} · ${esc(r.chains.join(', ') || 'Chain unknown')}</span></div><button class="close" data-close="detail" aria-label="Close protocol detail">×</button></div>
    <div class="detail-grid"><section class="detail-evidence"><span class="badge ${r.token_status === 'recorded' ? 'recorded' : ''}">${statusLabel(r)}</span>
      <p class="inspect-value-label" style="margin-top:17px">Scenario market capitalization</p><div class="inspect-value" title="${exact(r.implied_value_usd)}">${dollars(r.implied_value_usd)}</div>
      <p class="range-label">${dollars(r.band.low)} – ${dollars(r.band.high)} · ${r.confidence} evidence</p>
      <dl class="detail-kpis"><div><dt>Snapshot TVL</dt><dd title="${exact(r.tvl_usd)}">${dollars(r.tvl_usd)}</dd></div><div><dt>Observed market cap</dt><dd title="${exact(r.mcap_usd)}">${dollars(r.mcap_usd)}</dd></div><div><dt>7-day TVL change</dt><dd class="${r.change_7d >= 0 ? 'up' : 'down'}">${pct(r.change_7d)}</dd></div><div><dt>Days since listing</dt><dd>${r.age_days ?? 'Unknown'}</dd></div></dl>
      <h3>Inside the scenario</h3><ul class="factor-list"><li><span>Model TVL</span><b>${dollars(d.tvl_used)}</b></li><li><span>Peer median / TVL</span><b>${factor(d.peer_multiple)}</b></li><li><span>Growth adjustment</span><b>${factor(d.growth_factor)}</b></li><li><span>Listing maturity</span><b>${factor(d.age_factor)}</b></li><li><span>Structural factor</span><b>${factor(d.structure_factor)}</b></li></ul>
      <p class="muted" style="font-size:10px">${esc(d.peer_basis)} · ${d.peer_count} peers used · ${d.category_peer_count} same-category peers. Multipliers shown rounded; calculation uses full precision.</p>
      <details><summary>Inspect ${d.peer_count} comparable records</summary><div class="peer-list">${d.peer_slugs.map(esc).join(' · ') || 'No available peers; 0.25× prior used.'}</div></details>
      <details><summary>Source fields & limitations</summary><p>Slug: ${esc(r.slug)}<br>Listed: ${esc(r.listed_at || 'Unknown')}<br>Symbol: ${esc(r.symbol || 'Not recorded')}<br>CoinGecko ID: ${esc(r.gecko_id || 'Not recorded')}<br>Raw market cap: ${r.mcap_usd === null ? 'null' : esc(r.mcap_usd)}<br>FDV: not supplied<br>Watchlist: ${r.watchlist ? 'Yes' : 'No'}</p><ul class="warning-list">${r.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul></details>
      <p class="caution">Listing history is not operating age. Range is a sensitivity scenario, not a probability interval or expected reward.</p>
    </section><section class="detail-plan"><div class="plan-heading"><h3>Farm research checklist</h3><span id="check-progress">${completed.size}/${r.farm_steps.length} reviewed</span></div><p class="planning-label">${esc(r.planning.label)}</p>
      <ol class="checklist">${r.farm_steps.map((step, i) => `<li><input type="checkbox" id="step-${i}" data-step="${i}" data-slug="${esc(slug)}" ${completed.has(i) ? 'checked' : ''}><label for="step-${i}"><strong>${['01 / VERIFY ACCESS', '02 / CHECK TOKEN STATUS', '03 / BOUNDED TEST', '04 / MONITOR RISK', '05 / EXIT & RECONCILE'][i]}</strong>${esc(step)}</label></li>`).join('')}</ol>
      <div class="detail-status">Checks are local to this page session. No wallet connection. No transactions.</div></section></div>`;
  openDialog('detail');
}
function reset() {
  ['search', 'category', 'chain', 'coverage'].forEach(id => $(id).value = '');
  state.page = 0; state.sort = 'implied_value_usd'; state.direction = -1; render();
}
function bind() {
  ['search', 'category', 'chain', 'coverage'].forEach(id => $(id).addEventListener(id === 'search' ? 'input' : 'change', () => { state.page = 0; render(); }));
  document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => {
    state.view = button.dataset.view; state.page = 0;
    document.querySelectorAll('[data-view]').forEach(b => b.setAttribute('aria-pressed', String(b === button))); render();
  }));
  document.querySelectorAll('[data-sort]').forEach(button => button.addEventListener('click', () => {
    const key = button.dataset.sort; state.direction = key === state.sort ? -state.direction : key === 'name' || key === 'rank' ? 1 : -1;
    state.sort = key; state.page = 0; render();
  }));
  ['reset', 'empty-reset'].forEach(id => $(id).addEventListener('click', reset));
  $('prev').addEventListener('click', () => { state.page--; render(); });
  $('next').addEventListener('click', () => { state.page++; render(); });
  $('board-nav').addEventListener('click', () => $('workspace').scrollIntoView());
  ['method-button', 'method-footer'].forEach(id => $(id).addEventListener('click', () => openDialog('method')));
  document.addEventListener('click', event => {
    const detail = event.target.closest('[data-detail]'), close = event.target.closest('[data-close]');
    if (detail) showDetail(detail.dataset.detail);
    if (close) closeDialog(close.dataset.close);
  });
  document.addEventListener('change', event => {
    const input = event.target.closest('[data-step]'); if (!input) return;
    const set = checked.get(input.dataset.slug) || new Set(), n = Number(input.dataset.step);
    if (input.checked) set.add(n); else set.delete(n);
    checked.set(input.dataset.slug, set); $('check-progress').textContent = `${set.size}/5 reviewed`;
  });
  document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('close', () => {
    if (focusReturn?.isConnected) focusReturn.focus();
    else document.querySelector(`[data-detail="${CSS.escape(state.selected || '')}"]`)?.focus();
  }));
  document.addEventListener('keydown', event => {
    if (event.key === '/' && !document.querySelector('dialog[open]') && !['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
      event.preventDefault(); $('search').focus();
    }
  });
}
async function start() {
  try {
    const response = await fetch('./records.dat', { cache: 'no-store' });
    if (!response.ok) throw new Error(`Static data unavailable (${response.status})`);
    data = await response.json();
    if (data.schema !== 'meridian-radar/v1' || !Array.isArray(data.rows) || !data.rows.length) throw new Error('Invalid board data');
    summary(); selectOptions('category', data.rows.map(r => r.category || 'Unclassified'));
    selectOptions('chain', data.rows.flatMap(r => r.chains)); bind(); render();
    document.documentElement.dataset.ready = 'true';
  } catch (error) {
    $('results').textContent = `Unable to load the board: ${error.message}. Serve the built output through a local static server; file:// fetch is not supported.`;
    $('view-note').textContent = 'No sample or fallback data is displayed. Build main.ts with the sealed snapshot first.';
    document.documentElement.dataset.ready = 'error';
  }
}
start();
