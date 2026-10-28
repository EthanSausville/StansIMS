// Small DOM helpers shared by every tab.
import { MONTHS, evalEntry, toDate } from './calc.js';

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

export function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Prev / month name / next control. value = {year, month(1-12)}.
export function monthPicker(value, onChange) {
  const shift = (n) => { let m = value.month + n, y = value.year; if (m < 1) { m = 12; y--; } if (m > 12) { m = 1; y++; } onChange({ year: y, month: m }); };
  return h('div', { class: 'monthpick' },
    h('button', { class: 'btn icon', title: 'Previous month', 'aria-label': 'Previous month', onclick: () => shift(-1) }, '‹'),
    h('span', { class: 'label' }, `${MONTHS[value.month - 1][0]}${MONTHS[value.month - 1].slice(1).toLowerCase()} ${value.year}`),
    h('button', { class: 'btn icon', title: 'Next month', 'aria-label': 'Next month', onclick: () => shift(1) }, '›'),
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
export function numberCell(value, save, { disabled = false, digits = 4, title, wide = false, placeholder, key, cls } = {}) {
  const shown = (v) => (v === null || v === undefined ? '' : qty(v, digits).replace(/,/g, ''));
  const input = h('input', { type: 'text', inputmode: 'decimal', value: shown(value), disabled, title, placeholder, class: wide ? 'wide' : null, 'aria-label': title, 'data-k': key });
  let last = value ?? null;
  input.addEventListener('focus', () => { input.select(); });
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
  return h('td', { class: 'cell num' + (cls ? ' ' + cls : '') }, input);
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

export function pageHead(title, description, ...controls) {
  return h('div', { class: 'pagehead' },
    h('div', { class: 'grow' }, h('h1', null, title), description ? h('p', null, description) : null),
    controls.length ? h('div', { class: 'controls' }, controls) : null);
}

export const shortName = (name) => name.replace(/\s*\(Case of 24\)/, ' (24)').replace(/\.\s/, ' ');
