// Small DOM helpers shared by every tab.
import { MONTHS, evalEntry, toDate, setCurrentYear } from './calc.js';

// h('div', {class: 'x', onclick: fn}, child, 'text', [more children])
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}
function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

const nf = new Map();
export function fmt(v, digits = 0, min = digits) {
  if (v === null || v === undefined || v === '' || Number.isNaN(v)) return '';
  const key = `${digits}|${min}`;
  if (!nf.has(key)) nf.set(key, new Intl.NumberFormat('en-US', { maximumFractionDigits: digits, minimumFractionDigits: min }));
  const s = nf.get(key).format(v);
  return s === '-0' ? '0' : s;
}
export const money = (v, digits = 2) => (v === null || v === undefined ? '' : (v < 0 ? '-$' : '$') + fmt(Math.abs(v), digits));
// Money to the penny, or to two significant digits when that shows more
// ($0.0035, $0.13, $1.94, $1,250.00). acctText leaves off the $; acctCell
// puts the $ at the far left of the cell, like Excel's Accounting format.
export function acctText(v) {
  if (v === null || v === undefined || v === '' || !Number.isFinite(Number(v))) return '';
  const a = Math.abs(Number(v));
  const d = a ? Math.min(8, Math.max(2, 1 - Math.floor(Math.log10(a)))) : 2;
  return (v < 0 ? '(' : '') + fmt(a, d, 2) + (v < 0 ? ')' : '');
}
// The $ and amount for a cell that's already a <td> (e.g. a totals row).
export const acctParts = (v) => (v ? [h('span', { class: 'cur' }, '$'), acctText(v)] : '');
export const acctCell = (v, { class: cls = '', title } = {}) => h('td', { class: `num acct ${cls}`.trim(), title, 'data-v': v || null },
  v ? [h('span', { class: 'cur' }, '$'), acctText(v)] : '');
export const pct = (v) => (Number.isFinite(v) ? fmt(v * 100, 1, 1) + '%' : '');
// Shows a quantity like Excel's General format: up to `digits` decimals, no trailing zeros.
export const qty = (v, digits = 2) => fmt(v, digits, 0);

export function toast(message, kind = '') {
  const t = h('div', { class: `toast ${kind}`, role: kind === 'bad' ? 'alert' : 'status' }, message);
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), kind === 'bad' ? 7000 : 3000);
}

export function niceError(e) {
  const m = e?.message || String(e);
  if (/row-level security|permission denied/i.test(m)) return 'Only admins can change this.';
  if (/foreign key/i.test(m)) return 'That item is still used elsewhere (recipes, production, sales…), so it can’t be removed.';
  if (/duplicate key/i.test(m)) return 'That already exists.';
  if (/Failed to fetch|NetworkError/i.test(m)) return 'Couldn’t reach the database. Check your connection and try again.';
  return m;
}

export const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const dateLabel = (iso) => {
  const d = toDate(iso);
  return h('span', { class: 'datecell' }, h('span', { class: 'dow' }, DOW[d.getUTCDay()]), `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`);
};
export const longDate = (iso) => toDate(iso).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });

// The date the whole site treats as today: Settings → Site (settings.site_date),
// blank for the real date. Until the database has that setting, it's pinned to
// Monday 7/13/2026 (the data runs through the week of 7/6).
export const PRETEND_TODAY = '2026-07-13';
// undefined: no setting yet; null: the real date; 'YYYY-MM-DD': pinned. The last
// value is remembered in the browser so the pages start on the right date
// before the data has loaded.
let siteDate = (() => { try { const v = localStorage.getItem('site-date'); return v === null ? undefined : v === '' ? null : v; } catch { return undefined; } })();
export function setSiteDate(v) {
  siteDate = v; setCurrentYear(Number(todayIso().slice(0, 4)));
  try { if (v === undefined) localStorage.removeItem('site-date'); else localStorage.setItem('site-date', v || ''); } catch { /* not remembered */ }
}
export const realTodayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
export const siteDateSetting = () => siteDate;
export function todayIso() {
  if (siteDate) return siteDate;
  if (siteDate === undefined && PRETEND_TODAY) return PRETEND_TODAY;
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export const thisYear = () => Number(todayIso().slice(0, 4));
setCurrentYear(thisYear()); // so calc.js's year lists and defaults agree
export const thisMonth = () => Number(todayIso().slice(5, 7));

// Prev / month name / next control. value = {year, month(1-12)}.
export function monthPicker(value, onChange) {
  // Months run from January 2026 through December of next year, like every year list on the site.
  const first = 2026; const last = thisYear() + 1;
  const shift = (n) => { let m = value.month + n, y = value.year; if (m < 1) { m = 12; y--; } if (m > 12) { m = 1; y++; } if (y < first || y > last) return; onChange({ year: y, month: m }); };
  return h('div', { class: 'monthpick' },
    h('button', { class: 'btn icon', title: 'Previous month', 'aria-label': 'Previous month', disabled: value.year <= first && value.month === 1, onclick: () => shift(-1) }, '‹'),
    h('span', { class: 'label' }, `${MONTHS[value.month - 1][0]}${MONTHS[value.month - 1].slice(1).toLowerCase()} ${value.year}`),
    h('button', { class: 'btn icon', title: 'Next month', 'aria-label': 'Next month', disabled: value.year >= last && value.month === 12, onclick: () => shift(1) }, '›'),
    h('button', { class: 'btn ghost', onclick: () => { const t = todayIso(); onChange({ year: +t.slice(0, 4), month: +t.slice(5, 7) }); } }, 'Today'));
}

export function yearSelect(years, value, onChange, label = 'Year') {
  return h('label', { class: 'field' }, label,
    h('select', { onchange: (e) => onChange(Number(e.target.value)) }, years.map((y) => h('option', { value: y, selected: y === value }, y))));
}

export function seg(options, value, onChange) {
  return h('div', { class: 'seg', role: 'group' }, options.map(([v, label]) =>
    h('button', { 'aria-pressed': String(v === value), onclick: () => onChange(v) }, label)));
}

export const typePill = (type) => h('span', { class: 'pill ' + ({ 'Raw Material': 'rm', Component: 'cp', 'Finished Good': 'fg', 'Indirect Cost': 'ic', Recipe: 'rc' }[type] || '') }, type);

// A number input that accepts arithmetic ("175*45"), saves on change, and
// shows saving / saved / error states. save(value|null) must return a promise.
// `display(v)` formats the value while the cell isn't being edited (e.g. $1,250.00).
export function numberCell(value, save, { disabled = false, digits = 4, title, wide = false, placeholder, key, cls, display } = {}) {
  const raw = (v) => (v === null || v === undefined ? '' : qty(v, digits).replace(/,/g, ''));
  const shown = (v) => (v === null || v === undefined ? '' : display ? display(v) : raw(v));
  const input = h('input', { type: 'text', inputmode: 'decimal', value: shown(value), disabled, title, placeholder, class: wide ? 'wide' : null, 'aria-label': title, 'data-k': key });
  let last = value ?? null;
  input.addEventListener('focus', () => { if (display) input.value = raw(last); input.select(); });
  if (display) input.addEventListener('blur', () => { if (!input.classList.contains('error') && !input.classList.contains('saving')) setTimeout(() => { if (document.activeElement !== input && !input.classList.contains('error')) input.value = shown(last); }, 0); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); moveFocus(input, e.key === 'ArrowUp' ? -1 : 1); }
    if (e.key === 'Escape') { input.value = shown(last); input.blur(); }
  });
  input.addEventListener('change', async () => {
    let v;
    try { v = evalEntry(input.value); } catch (err) { input.classList.add('error'); toast(err.message, 'bad'); return; }
    if (v === last || (v !== null && last !== null && Math.abs(v - last) < 1e-12)) { input.value = shown(last); input.classList.remove('error'); return; }
    input.classList.remove('error', 'saved'); input.classList.add('saving');
    try {
      await save(v);
      last = v; input.value = shown(v);
      input.classList.remove('saving'); void input.offsetWidth; input.classList.add('saved');
    } catch (err) {
      input.classList.remove('saving'); input.classList.add('error'); toast(niceError(err), 'bad');
    }
  });
  return h('td', { class: 'cell num' + (disabled ? '' : ' entry') + (cls ? ' ' + cls : '') }, input);
}

// Enter / arrow keys move to the same column in the next row, like a spreadsheet.
function moveFocus(input, dir) {
  const td = input.closest('td'); const tr = td?.parentElement; if (!tr) return;
  const col = [...tr.children].indexOf(td);
  let row = dir > 0 ? tr.nextElementSibling : tr.previousElementSibling;
  while (row) {
    const target = row.children[col]?.querySelector('input:not([disabled])');
    if (target) { target.focus(); return; }
    row = dir > 0 ? row.nextElementSibling : row.previousElementSibling;
  }
  input.blur();
}

export function confirmDialog(message, okLabel = 'Delete') {
  return new Promise((resolve) => {
    const dlg = h('dialog', null, h('form', { method: 'dialog' },
      h('p', { style: { margin: 0 } }, message),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', value: 'cancel' }, 'Cancel'),
        h('button', { class: 'btn primary', value: 'ok' }, okLabel))));
    dlg.addEventListener('close', () => { resolve(dlg.returnValue === 'ok'); dlg.remove(); });
    document.body.append(dlg); dlg.showModal();
  });
}

// A tab's actions and controls. The app moves them into the left side bar;
// the title and description go behind the (i) in the page-tab row.
// (The Dashboard keeps a full heading: bigHead.)
export function pageHead(title, description, ...controls) {
  const items = controls.flat(Infinity).filter(Boolean);
  const bar = h('section', { class: 'panel toolbar', 'aria-label': title }, h('div', { class: 'tb-row' }, items));
  bar._about = { title, description };
  return bar;
}
export function bigHead(title, description, ...controls) {
  return h('div', { class: 'pagehead' },
    h('div', { class: 'grow' }, h('h1', null, title), description ? h('p', null, description) : null),
    controls.length ? h('div', { class: 'controls' }, controls) : null);
}
// A small figure for the bar (e.g. "Cases 1,240").
export const chip = (label, value) => h('span', { class: 'tb-chip' }, h('span', { class: 'muted' }, label), ' ', h('strong', null, value));

// Item # as the first column of a table of items; it stays put when the table
// scrolls sideways, with the item's name pinned next to it (sticky2).
export const itemNoCol = (get) => ({ key: 'item_no', label: 'Item #', sticky: true, value: (r) => get(r)?.item_no ?? '',
  cell: (r) => h('td', { class: 'sticky-col itemno' }, get(r)?.item_no ?? '') });
export const itemNoTh = () => h('th', { class: 'sticky-col itemno' }, 'Item #');
export const itemNoTd = (it) => h('td', { class: 'sticky-col itemno' }, it?.item_no ?? '');

// Password rules for the whole site (the Worker and Supabase check them too).
export const MIN_PASSWORD = 10;
export function passwordProblem(p) {
  if (!p || p.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (p.length > 72) return 'Use 72 characters or fewer.';
  if (!/[a-z]/i.test(p) || !/[0-9]/.test(p)) return 'Use letters and at least one number.';
  return '';
}

export const shortName = (name) => name.replace(/\s*\(Case of 24\)/, ' (24)').replace(/\.\s/, ' ');
