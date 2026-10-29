import {
  DEFAULT_SETTINGS, ROUNDING_CHOICES, MINUTE, HOUR, DAY,
  snap, startOfDay, addDays, dayKey, parseDayKey,
  periodFor, previousPeriod, nextPeriod,
  entryDuration, formatHM, formatClock, hoursDecimal,
} from '/shared/time.js';

// State ---------------------------------------------------------------------

const state = {
  settings: { ...DEFAULT_SETTINGS },
  entries: [],
  loaded: false,
  error: null,
  route: 'clock',
  historyPeriod: null,
  busy: false,
};

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// API -----------------------------------------------------------------------

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

async function refresh() {
  try {
    const d = await api('GET', '/api/state');
    state.settings = { ...DEFAULT_SETTINGS, ...d.settings };
    state.entries = d.entries;
    state.loaded = true;
    state.error = null;
  } catch (err) {
    state.error = err.message;
  }
  // Don't yank the DOM out from under the user mid-edit; the next refresh will catch up.
  const editing = editor.dialog.open || document.activeElement?.closest?.('#settings');
  if (!editing || !state.loaded) render();
}

async function mutate(fn, { successToast } = {}) {
  if (state.busy) return;
  state.busy = true;
  render();
  try {
    await fn();
    if (successToast) toast(successToast);
  } catch (err) {
    toast(err.message);
  } finally {
    state.busy = false;
    await refresh();
  }
}

// Derived data --------------------------------------------------------------

const running = () => state.entries.find((e) => e.stop == null) || null;
const nudgeStep = () => state.settings.roundingMinutes || 5;

function entriesBetween(from, to) {
  return state.entries.filter((e) => e.start >= from && e.start < to).sort((a, b) => b.start - a.start);
}
const sumDuration = (list, now) => list.reduce((t, e) => t + entryDuration(e, now), 0);
const amountFor = (ms) => hoursDecimal(ms) * state.settings.hourlyRate;

function groupByDay(list) {
  const map = new Map();
  for (const e of list) {
    const k = dayKey(e.start);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(e);
  }
  return map;
}

// Formatting ----------------------------------------------------------------

const fmt = {
  time: new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }),
  day: new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }),
  dayYear: new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }),
  range: new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }),
  rangeYear: new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }),
  weekday: new Intl.DateTimeFormat(undefined, { weekday: 'long' }),
};
const thisYear = new Date().getFullYear();
const fmtTime = (ms) => fmt.time.format(ms);
function fmtDay(ms) {
  const today = startOfDay(Date.now());
  if (ms >= today && ms < addDays(today, 1)) return 'Today';
  if (ms >= addDays(today, -1) && ms < today) return 'Yesterday';
  return (new Date(ms).getFullYear() === thisYear ? fmt.day : fmt.dayYear).format(ms);
}
function fmtRange(period) {
  const last = period.end - 1;
  const f = new Date(period.start).getFullYear() === thisYear && new Date(last).getFullYear() === thisYear ? fmt.range : fmt.rangeYear;
  return `${f.format(period.start)} – ${f.format(last)}`;
}
function fmtMoney(n) {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: state.settings.currency }).format(n);
  } catch {
    return `${n.toFixed(2)} ${state.settings.currency}`;
  }
}

// Rendering -----------------------------------------------------------------

const ICONS = {
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  history: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2" fill="var(--surface)"/><circle cx="15" cy="12" r="2" fill="var(--surface)"/><circle cx="8" cy="18" r="2" fill="var(--surface)"/></svg>',
};
const ROUTES = [['clock', 'Clock'], ['history', 'History'], ['settings', 'Settings']];

function renderNav() {
  const html = ROUTES.map(([id, label]) =>
    `<a href="#/${id}" ${state.route === id ? 'aria-current="page"' : ''}>${ICONS[id]}<span>${label}</span></a>`).join('');
  for (const nav of document.querySelectorAll('.tabs')) nav.innerHTML = html;
}

function render() {
  renderNav();
  const view = $('#view');
  if (!state.loaded) {
    view.innerHTML = state.error
      ? `<section class="card error-card"><h2>Can't reach the server</h2><p class="hint">${esc(state.error)}</p><button class="btn" data-action="retry">Try again</button></section>`
      : '<p class="empty">Loading…</p>';
    return;
  }
  if (state.route === 'history') view.innerHTML = renderHistory();
  else if (state.route === 'settings') view.innerHTML = renderSettings();
  else view.innerHTML = renderClock();
}

function entryRow(e, now) {
  const live = e.stop == null;
  const nextDay = !live && dayKey(e.stop) !== dayKey(e.start);
  return `<li><button class="entry ${live ? 'live' : ''}" data-action="edit" data-id="${e.id}" aria-label="Edit entry ${fmtTime(e.start)} to ${live ? 'now' : fmtTime(e.stop)}">
    <span class="entry-range">${fmtTime(e.start)}<span class="dash">–</span>${live ? '<span class="now">now</span>' : fmtTime(e.stop)}${nextDay ? '<small>next day</small>' : ''}</span>
    <span class="entry-dur" ${live ? `data-live-start="${e.start}"` : ''}>${formatHM(entryDuration(e, now))}</span>
  </button></li>`;
}

function dayGroup(key, entries, now, { title } = {}) {
  const dayMs = parseDayKey(key);
  return `<section class="day-group">
    <header class="day-head"><h2>${title || fmtDay(dayMs)}</h2><span data-live-sum="${key}">${formatHM(sumDuration(entries, now))}</span></header>
    <ul class="entries">${entries.map((e) => entryRow(e, now)).join('')}</ul>
  </section>`;
}

function statsBlock(ms, days) {
  return `<dl class="stats">
    <div><dt>Hours</dt><dd data-live-hours>${formatHM(ms)}</dd></div>
    <div><dt>Pay</dt><dd data-live-pay>${fmtMoney(amountFor(ms))}</dd></div>
    <div><dt>Days</dt><dd>${days}</dd></div>
  </dl>`;
}

function renderClock() {
  const now = Date.now();
  const run = running();
  const today = startOfDay(now);
  const todayEntries = entriesBetween(today, addDays(today, 1));
  const todayMs = sumDuration(todayEntries, now);
  const period = periodFor(now, state.settings);
  const periodEntries = entriesBetween(period.start, period.end);
  const periodMs = sumDuration(periodEntries, now);

  return `
  <section class="card status ${run ? 'is-running' : ''}">
    <p class="status-label">${run ? '<span class="dot"></span>Punched in' : 'Not punched in'}</p>
    <p class="elapsed" ${run ? `id="elapsed" data-start="${run.start}"` : 'data-live-today'}>${run ? formatClock(now - run.start, true) : formatHM(todayMs)}</p>
    <p class="status-sub">${run ? `since ${fmtTime(run.start)}` : 'worked today'}</p>
    <button class="punch" data-action="${run ? 'punch-out' : 'punch-in'}" ${state.busy ? 'disabled' : ''}>${run ? 'Stop' : 'Start'}</button>
    <div class="status-links">
      ${run
        ? `<button class="link" data-action="adjust-start">Adjust start…</button>`
        : `<button class="link" data-action="start-earlier">Start earlier…</button>`}
      <button class="link" data-action="add-entry">Add past entry…</button>
    </div>
  </section>

  <section class="card">
    <div class="summary-head"><h2>This pay period</h2><a class="link" href="#/history">${fmtRange(period)}</a></div>
    ${statsBlock(periodMs, groupByDay(periodEntries).size)}
  </section>

  ${todayEntries.length
    ? dayGroup(dayKey(today), todayEntries, now, { title: 'Today' })
    : `<p class="empty">No entries yet today.</p>`}`;
}

function renderHistory() {
  const now = Date.now();
  const s = state.settings;
  const current = periodFor(now, s);
  if (!state.historyPeriod) state.historyPeriod = current;
  const p = state.historyPeriod;
  const isCurrent = p.start === current.start;
  const list = entriesBetween(p.start, p.end);
  const ms = sumDuration(list, now);
  const days = groupByDay(list);

  return `
  <section class="period-nav">
    <button class="icon-btn" data-action="period-prev" aria-label="Previous period">‹</button>
    <div class="period-title">
      <h2>${fmtRange(p)}</h2>
      ${isCurrent ? '<span class="pill">Current period</span>' : '<button class="link" data-action="period-today">Back to current</button>'}
    </div>
    <button class="icon-btn" data-action="period-next" aria-label="Next period" ${isCurrent ? 'disabled' : ''}>›</button>
  </section>

  <section class="card">
    ${statsBlock(ms, days.size)}
    <div class="summary-actions">
      <button class="btn" data-action="export-csv" ${list.length ? '' : 'disabled'}>Export CSV</button>
      <button class="btn" data-action="add-entry">Add entry</button>
    </div>
  </section>

  ${days.size
    ? [...days].map(([k, es]) => dayGroup(k, es, now)).join('')
    : '<p class="empty">Nothing recorded in this period.</p>'}`;
}

const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'NZD', 'CHF', 'JPY', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF', 'MXN', 'BRL', 'INR', 'ZAR', 'SGD', 'HKD', 'KRW'];
const option = (value, label, selected) => `<option value="${esc(value)}" ${selected ? 'selected' : ''}>${esc(label)}</option>`;

function renderSettings() {
  const s = state.settings;
  const now = Date.now();
  const weekdayName = (i) => fmt.weekday.format(new Date(2026, 1, 1 + i)); // 2026-02-01 is a Sunday
  const currencies = CURRENCIES.includes(s.currency) ? CURRENCIES : [s.currency, ...CURRENCIES];
  let periodField = '';
  if (s.periodType === 'monthly') {
    periodField = `<label class="field"><span>Starts on day</span>
        <select name="periodStartDay">${Array.from({ length: 31 }, (_, i) => option(i + 1, i + 1, s.periodStartDay === i + 1)).join('')}</select></label>
      <p class="hint">In shorter months the period starts on the last day.</p>`;
  } else if (s.periodType === 'weekly') {
    periodField = `<label class="field"><span>Starts on</span>
        <select name="periodStartWeekday">${Array.from({ length: 7 }, (_, i) => option(i, weekdayName(i), s.periodStartWeekday === i)).join('')}</select></label>`;
  } else {
    periodField = `<label class="field"><span>A day a period started on</span>
        <input type="date" name="periodAnchor" value="${esc(s.periodAnchor || '')}" required></label>
      <p class="hint">Any period start, past or future. Periods repeat every 14 days from it.</p>`;
  }

  return `<form id="settings" class="settings" autocomplete="off">
    <section class="card">
      <h2>Pay</h2>
      <label class="field"><span>Hourly rate</span>
        <input type="number" name="hourlyRate" min="0" step="0.01" inputmode="decimal" value="${s.hourlyRate}"></label>
      <label class="field"><span>Currency</span>
        <select name="currency">${currencies.map((c) => option(c, c, c === s.currency)).join('')}</select></label>
    </section>

    <section class="card">
      <h2>Pay period</h2>
      <label class="field"><span>Repeats</span>
        <select name="periodType">
          ${option('monthly', 'Every month', s.periodType === 'monthly')}
          ${option('weekly', 'Every week', s.periodType === 'weekly')}
          ${option('biweekly', 'Every two weeks', s.periodType === 'biweekly')}
        </select></label>
      ${periodField}
      <p class="hint">Current period: ${fmtRange(periodFor(now, s))}</p>
    </section>

    <section class="card">
      <h2>Rounding</h2>
      <label class="field"><span>Round punches to</span>
        <select name="roundingMinutes">${ROUNDING_CHOICES.map((m) => option(m, m ? `${m} minutes` : 'Off', s.roundingMinutes === m)).join('')}</select></label>
      <p class="hint">Starts round back to the previous mark and stops forward to the next. Times you type yourself are kept as they are.</p>
    </section>

    <section class="card">
      <h2>Data</h2>
      <p class="hint">Everything lives in one file on your server. Export hours as CSV from History.</p>
      <a class="btn" href="/api/backup" download>Download backup</a>
    </section>
    <p class="saved" id="settings-saved"></p>
  </form>`;
}

// Live ticking (no full re-render) ------------------------------------------

function tick() {
  const run = running();
  const now = Date.now();
  const el = $('#elapsed');
  if (el && run) el.textContent = formatClock(now - run.start, true);
  for (const node of document.querySelectorAll('[data-live-start]')) {
    node.textContent = formatHM(now - Number(node.dataset.liveStart));
  }
  if (!run) return;
  for (const node of document.querySelectorAll('[data-live-sum]')) {
    const day = parseDayKey(node.dataset.liveSum);
    node.textContent = formatHM(sumDuration(entriesBetween(day, addDays(day, 1)), now));
  }
  const period = state.route === 'history' && state.historyPeriod ? state.historyPeriod : periodFor(now, state.settings);
  const ms = sumDuration(entriesBetween(period.start, period.end), now);
  for (const node of document.querySelectorAll('[data-live-hours]')) node.textContent = formatHM(ms);
  for (const node of document.querySelectorAll('[data-live-pay]')) node.textContent = fmtMoney(amountFor(ms));
}

// Punching ------------------------------------------------------------------

function punchIn() {
  const now = Date.now();
  return mutate(() => api('POST', '/api/entries', { start: snap(now, state.settings.roundingMinutes, 'down') }));
}

function punchOut() {
  const run = running();
  if (!run) return;
  const now = Date.now();
  let stop = snap(now, state.settings.roundingMinutes, 'up');
  if (stop <= run.start) stop = run.start + nudgeStep() * MINUTE;
  return mutate(() => api('PATCH', `/api/entries/${run.id}`, { stop }));
}

// Entry editor --------------------------------------------------------------

const editor = {
  dialog: $('#editor'),
  form: $('#editor-form'),
  mode: 'new',
  entry: null,
  deleteTimer: null,
};

const pad = (n) => String(n).padStart(2, '0');
const toTimeValue = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fromTimeValue = (dateKey, value) => {
  if (!value) return null;
  const [h, m] = value.split(':').map(Number);
  const d = new Date(parseDayKey(dateKey));
  d.setHours(h, m, 0, 0);
  return d.getTime();
};

function openEditor(mode, entry = null) {
  const f = editor.form;
  const now = Date.now();
  editor.mode = mode;
  editor.entry = entry;
  clearTimeout(editor.deleteTimer);

  const titles = { new: 'Add entry', edit: 'Edit entry', 'start-earlier': 'Start earlier', 'adjust-start': 'Adjust start' };
  $('#editor-title').textContent = titles[mode];
  $('#editor-save').textContent = mode === 'start-earlier' ? 'Start' : 'Save';
  $('#editor-delete').hidden = !entry;
  $('#editor-delete').textContent = entry && entry.stop == null ? 'Discard' : 'Delete';
  $('#editor-delete').classList.remove('confirm');
  $('#editor-error').textContent = '';

  const stopField = $('#stop-field');
  stopField.hidden = mode === 'start-earlier';

  const step = (state.settings.roundingMinutes || 1) * 60;
  f.start.step = step;
  f.stop.step = step;

  let start, stop, isRunning;
  if (entry) {
    start = entry.start; stop = entry.stop; isRunning = entry.stop == null;
  } else if (mode === 'start-earlier') {
    start = snap(now, state.settings.roundingMinutes, 'down'); stop = null; isRunning = true;
  } else {
    stop = snap(now, state.settings.roundingMinutes, 'down'); start = stop - HOUR; isRunning = false;
  }
  f.date.value = dayKey(start);
  f.start.value = toTimeValue(start);
  f.stop.value = stop == null ? '' : toTimeValue(stop);
  f.running.checked = isRunning;
  f.running.closest('.check').hidden = mode === 'start-earlier' || (running() && running().id !== entry?.id);
  syncEditor();
  editor.dialog.showModal();
  (mode === 'new' ? f.date : f.start).focus();
}

/** Read the editor; returns { start, stop, error }. */
function readEditor() {
  const f = editor.form;
  const dateKey = f.date.value;
  if (!dateKey) return { error: 'Pick a date.' };
  const start = fromTimeValue(dateKey, f.start.value);
  if (start == null) return { error: 'Enter a start time.' };
  if (f.running.checked) {
    if (start > Date.now() + MINUTE) return { error: 'A running entry cannot start in the future.' };
    return { start, stop: null };
  }
  let stop = fromTimeValue(dateKey, f.stop.value);
  if (stop == null) return { error: 'Enter a stop time, or mark the entry as still running.' };
  if (stop <= start) stop += DAY;
  return { start, stop };
}

function syncEditor() {
  const f = editor.form;
  f.stop.disabled = f.running.checked;
  f.querySelectorAll('[data-nudge="stop"]').forEach((b) => (b.disabled = f.running.checked));
  const r = readEditor();
  const summary = $('#editor-summary');
  if (r.error) {
    summary.textContent = '';
    return;
  }
  if (r.stop == null) summary.textContent = `Running since ${fmtTime(r.start)}`;
  else summary.textContent = `${formatHM(r.stop - r.start)}${dayKey(r.stop) !== dayKey(r.start) ? ' · ends the next day' : ''}`;
}

function nudge(field, dir) {
  const input = editor.form[field];
  const [h, m] = (input.value || '00:00').split(':').map(Number);
  let minutes = h * 60 + m + dir * nudgeStep();
  minutes = Math.max(0, Math.min(24 * 60 - 1, minutes));
  input.value = `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
  syncEditor();
}

async function saveEditor() {
  const r = readEditor();
  if (r.error) {
    $('#editor-error').textContent = r.error;
    return;
  }
  const body = { start: r.start, stop: r.stop };
  try {
    if (editor.entry) await api('PATCH', `/api/entries/${editor.entry.id}`, body);
    else await api('POST', '/api/entries', body);
    editor.dialog.close();
    await refresh();
  } catch (err) {
    $('#editor-error').textContent = err.message;
  }
}

async function deleteFromEditor() {
  const btn = $('#editor-delete');
  if (!btn.classList.contains('confirm')) {
    btn.classList.add('confirm');
    btn.textContent = editor.entry.stop == null ? 'Discard this entry?' : 'Delete this entry?';
    editor.deleteTimer = setTimeout(() => {
      btn.classList.remove('confirm');
      btn.textContent = editor.entry?.stop == null ? 'Discard' : 'Delete';
    }, 4000);
    return;
  }
  clearTimeout(editor.deleteTimer);
  const removed = editor.entry;
  try {
    await api('DELETE', `/api/entries/${removed.id}`);
    editor.dialog.close();
    await refresh();
    toast(removed.stop == null ? 'Entry discarded' : 'Entry deleted', {
      action: 'Undo',
      onAction: () => mutate(() => api('POST', '/api/entries', { start: removed.start, stop: removed.stop })),
    });
  } catch (err) {
    $('#editor-error').textContent = err.message;
  }
}

// CSV export ------------------------------------------------------------------

function exportCsv(period) {
  const now = Date.now();
  const days = groupByDay(entriesBetween(period.start, period.end));
  const rows = [['date', 'hours', 'decimal_hours', 'amount']];
  for (const key of [...days.keys()].sort()) {
    const ms = sumDuration(days.get(key), now);
    rows.push([key, formatClock(ms), hoursDecimal(ms).toFixed(2), amountFor(ms).toFixed(2)]);
  }
  const csv = rows.map((r) => r.join(',')).join('\r\n') + '\r\n';
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `timecard-${dayKey(period.start)}_${dayKey(period.end - 1)}.csv`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// Toast -----------------------------------------------------------------------

let toastTimer = null;
function toast(text, { action, onAction } = {}) {
  const el = $('#toast');
  $('.toast-text', el).textContent = text;
  const btn = $('.toast-action', el);
  btn.hidden = !action;
  btn.textContent = action || '';
  btn.onclick = () => { hideToast(); onAction?.(); };
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 6000);
}
function hideToast() { $('#toast').hidden = true; }

// Events ----------------------------------------------------------------------

$('#view').addEventListener('click', (ev) => {
  const btn = ev.target.closest('[data-action]');
  if (!btn || btn.disabled) return;
  const s = state.settings;
  switch (btn.dataset.action) {
    case 'retry': return refresh();
    case 'punch-in': return punchIn();
    case 'punch-out': return punchOut();
    case 'start-earlier': return openEditor('start-earlier');
    case 'adjust-start': return openEditor('adjust-start', running());
    case 'add-entry': return openEditor('new');
    case 'edit': {
      const entry = state.entries.find((e) => e.id === Number(btn.dataset.id));
      return entry && openEditor(entry.stop == null ? 'adjust-start' : 'edit', entry);
    }
    case 'period-prev': state.historyPeriod = previousPeriod(state.historyPeriod, s); return render();
    case 'period-next': state.historyPeriod = nextPeriod(state.historyPeriod, s); return render();
    case 'period-today': state.historyPeriod = null; return render();
    case 'export-csv': return exportCsv(state.historyPeriod);
  }
});

$('#view').addEventListener('change', async (ev) => {
  const form = ev.target.closest('#settings');
  if (!form) return;
  const { name, value } = ev.target;
  if (name === 'periodAnchor' && !value) return;
  const patch = { [name]: name === 'hourlyRate' || name === 'periodStartDay' || name === 'periodStartWeekday' || name === 'roundingMinutes' ? Number(value) : value };
  if (name === 'periodType' && value === 'biweekly' && !state.settings.periodAnchor) {
    patch.periodAnchor = dayKey(periodFor(Date.now(), { ...state.settings, periodType: 'weekly' }).start);
  }
  try {
    state.settings = { ...state.settings, ...(await api('PUT', '/api/settings', patch)) };
    state.historyPeriod = null;
    render();
    const saved = $('#settings-saved');
    if (saved) { saved.textContent = 'Saved'; setTimeout(() => { if (saved.isConnected) saved.textContent = ''; }, 1800); }
  } catch (err) {
    toast(err.message);
    render();
  }
});

editor.form.addEventListener('submit', (ev) => { ev.preventDefault(); saveEditor(); });
editor.form.addEventListener('input', syncEditor);
editor.form.addEventListener('click', (ev) => {
  const n = ev.target.closest('[data-nudge]');
  if (n) nudge(n.dataset.nudge, Number(n.dataset.dir));
});
$('#editor-cancel').addEventListener('click', () => editor.dialog.close());
$('#editor-delete').addEventListener('click', deleteFromEditor);
editor.dialog.addEventListener('click', (ev) => { if (ev.target === editor.dialog) editor.dialog.close(); });

function route() {
  const id = (location.hash.match(/^#\/(\w+)/) || [])[1];
  state.route = ROUTES.some(([r]) => r === id) ? id : 'clock';
  if (state.route !== 'history') state.historyPeriod = null;
  render();
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
window.addEventListener('online', refresh);
setInterval(() => { if (!document.hidden) refresh(); }, 60_000);
setInterval(tick, 1000);

if (navigator.serviceWorker && window.isSecureContext) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

route();
refresh();
