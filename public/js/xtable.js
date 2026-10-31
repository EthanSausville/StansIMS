// A table that filters and sorts like an Excel table: each column heading has
// a button that opens sort options and a checklist of the column's values.
// An optional totals row pins to the bottom of the screen and adds up only
// the rows the filters leave showing (like Excel's SUBTOTAL).
//
// columns: [{ key, label, value(row) -> sortable value, text(row) -> string
//   shown in the filter list, cell(row) -> <td>, num: bool, total: (rows) -> node,
//   filter: false to leave a column out of filtering }]
import { h } from './ui.js';

const views = new Map(); // table id -> { filters: Map(key -> Set of texts), sort: {key, dir} }
let openMenu = null;     // the filter menu currently shown

const viewOf = (id, defaultSort) => {
  if (!views.has(id)) views.set(id, { filters: new Map(), sort: undefined });
  const v = views.get(id);
  if (v.sort === undefined && defaultSort) v.sort = defaultSort;
  return v;
};
const BLANK = '(Blanks)';
const textOf = (col, r) => { const t = col.text ? col.text(r) : col.value(r); return t === null || t === undefined || t === '' ? BLANK : String(t); };
const cmp = (a, b) => {
  if (a === b) return 0;
  if (a === null || a === undefined || a === '') return 1;
  if (b === null || b === undefined || b === '') return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
};

export function closeFilterMenu() { if (openMenu) { openMenu.remove(); openMenu = null; } }
document.addEventListener('mousedown', (e) => { if (openMenu && !openMenu.contains(e.target) && !e.target.closest('.xf-btn')) closeFilterMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openMenu) { const back = openMenu._button; closeFilterMenu(); back?.focus(); } });
window.addEventListener('resize', closeFilterMenu);

export function prefTotals(id) { try { return localStorage.getItem(`xt-totals:${id}`) !== 'off'; } catch { return true; } }
export function setPrefTotals(id, on) { try { localStorage.setItem(`xt-totals:${id}`, on ? 'on' : 'off'); } catch { /* not saved; still works */ } }

// Rows left after every column filter except `skipKey` (Excel lists only the
// values still possible given the other filters).
function applyFilters(view, columns, rows, skipKey) {
  const active = [...view.filters].filter(([k, set]) => k !== skipKey && set);
  if (!active.length) return rows;
  const cols = new Map(columns.map((c) => [c.key, c]));
  return rows.filter((r) => active.every(([k, set]) => set.has(textOf(cols.get(k), r))));
}

export function filteredRows({ id, columns, rows, defaultSort }) {
  const view = viewOf(id, defaultSort);
  let out = applyFilters(view, columns, rows, null);
  if (view.sort) {
    const col = columns.find((c) => c.key === view.sort.key);
    if (col) out = [...out].sort((a, b) => cmp(col.value(a), col.value(b)) * (view.sort.dir === 'desc' ? -1 : 1) || (a.id ?? 0) - (b.id ?? 0));
  }
  return out;
}

export const activeFilterCount = (id) => [...(views.get(id)?.filters.values() || [])].filter(Boolean).length;
export function clearFilters(id) { views.get(id)?.filters.clear(); }
// Sets a column filter to exactly these values (texts as the filter list shows them).
export function setFilter(id, key, texts) { viewOf(id).filters.set(key, texts ? new Set(texts) : null); }
// Makes sure a value isn't hidden by its column's filter (e.g. after adding a line).
export function showValue(id, key, text) { const set = views.get(id)?.filters.get(key); if (set) set.add(text); }

function showMenu(button, anchor, { id, columns, rows, col, rerender, defaultSort }) {
  closeFilterMenu();
  const view = viewOf(id, defaultSort);
  const pool = applyFilters(view, columns, rows, col.key);
  const counts = new Map(); const order = new Map();
  for (const r of pool) {
    const t = textOf(col, r); counts.set(t, (counts.get(t) || 0) + 1);
    if (!order.has(t)) order.set(t, col.value(r));
  }
  const values = [...counts.keys()].sort((a, b) => (a === BLANK) - (b === BLANK) || cmp(order.get(a), order.get(b)));
  const current = view.filters.get(col.key);
  const checked = new Set(current ? values.filter((v) => current.has(v)) : values);
  let query = '';

  const list = h('div', { class: 'xf-list', role: 'group', 'aria-label': `${col.label} values` });
  const all = h('input', { type: 'checkbox' });
  const drawList = () => {
    const shown = values.filter((v) => !query || v.toLowerCase().includes(query));
    all.checked = shown.length > 0 && shown.every((v) => checked.has(v));
    all.indeterminate = !all.checked && shown.some((v) => checked.has(v));
    list.replaceChildren(
      h('label', { class: 'xf-item xf-all' }, all, query ? '(Select all search results)' : '(Select all)'),
      ...shown.map((v) => h('label', { class: 'xf-item' },
        h('input', { type: 'checkbox', checked: checked.has(v), onchange: (e) => { e.target.checked ? checked.add(v) : checked.delete(v); drawList(); } }),
        h('span', { class: 'xf-val' }, v), h('span', { class: 'xf-count' }, counts.get(v)))),
      ...(shown.length ? [] : [h('div', { class: 'xf-empty' }, 'No matches')]));
  };
  all.addEventListener('change', () => {
    const shown = values.filter((v) => !query || v.toLowerCase().includes(query));
    for (const v of shown) all.checked ? checked.add(v) : checked.delete(v);
    drawList();
  });
  const apply = () => {
    if (query) { // like Excel: a search keeps only the matching ticked values
      for (const v of [...checked]) if (!v.toLowerCase().includes(query)) checked.delete(v);
    }
    view.filters.set(col.key, checked.size === values.length ? null : new Set(checked));
    closeFilterMenu(); rerender();
  };
  const sortBtn = (dir, label) => h('button', { type: 'button', class: 'xf-sort' + (view.sort?.key === col.key && view.sort.dir === dir ? ' on' : ''),
    onclick: () => { view.sort = { key: col.key, dir }; closeFilterMenu(); rerender(); } }, label);
  const search = h('input', { type: 'search', class: 'xf-search', placeholder: 'Search', 'aria-label': `Search ${col.label} values`,
    oninput: (e) => { query = e.target.value.trim().toLowerCase(); drawList(); },
    onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); apply(); } } });
  const menu = h('div', { class: 'xf-menu', role: 'dialog', 'aria-label': `Filter ${col.label}` },
    sortBtn('asc', col.num ? 'Sort smallest to largest' : 'Sort A to Z'),
    sortBtn('desc', col.num ? 'Sort largest to smallest' : 'Sort Z to A'),
    h('hr'),
    h('button', { type: 'button', class: 'xf-sort', disabled: !current, onclick: () => { view.filters.set(col.key, null); closeFilterMenu(); rerender(); } }, `Clear filter from “${col.label}”`),
    search, list,
    h('div', { class: 'xf-actions' },
      h('button', { type: 'button', class: 'btn', onclick: () => { const back = openMenu?._button; closeFilterMenu(); back?.focus(); } }, 'Cancel'),
      h('button', { type: 'button', class: 'btn primary', onclick: apply }, 'OK')));
  menu._button = button;
  drawList();
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  const width = Math.min(300, window.innerWidth - 16);
  menu.style.width = `${width}px`;
  menu.style.left = `${Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8))}px`;
  menu.style.top = `${Math.min(r.bottom + 4, window.innerHeight - 120)}px`;
  menu.style.maxHeight = `${Math.max(240, window.innerHeight - r.bottom - 16)}px`;
  openMenu = menu;
  search.focus();
}

// Builds the <table>: headings with filter buttons, the rows (already
// filtered and sorted with filteredRows), then the totals row in the footer,
// which stays pinned to the bottom of the screen. onToggleTotals(on) adds a
// Hide button to it, and a slim "Show totals" bar while it's hidden.
export function xtable({ id, columns, allRows, rows, rerender, defaultSort, showTotals, onToggleTotals, totalsLabel, rowClass, onRowClick, rowAfter, extraCells, extraHead, emptyText = 'No rows match these filters.', className = '' }) {
  const view = viewOf(id, defaultSort);
  const width = columns.length + (extraCells ? 1 : 0);
  const head = h('tr', null, columns.map((col) => {
    const filtered = !!view.filters.get(col.key);
    const sorted = view.sort?.key === col.key ? view.sort.dir : null;
    const btn = col.filter === false ? null : h('button', { type: 'button', class: 'xf-btn' + (filtered ? ' on' : ''),
      'aria-label': `Filter and sort ${col.label}${filtered ? ' (filtered)' : ''}`, title: filtered ? 'Filtered' : 'Filter and sort',
      onclick: (e) => {
        e.stopPropagation(); const b = e.currentTarget; const anchor = b._anchor || b; b._anchor = null;
        if (openMenu?._button === b) closeFilterMenu(); else showMenu(b, anchor, { id, columns, rows: allRows, col, rerender, defaultSort });
      } },
      filtered ? '⏷' : '▾');
    return h('th', { class: [col.num ? 'num' : '', col.sticky ? 'sticky-col' : '', col.sticky2 ? 'sticky-col sticky-col2' : '', col.key === 'item_no' && col.sticky ? 'itemno' : '', col.grow ? 'grow' : '', 'xf-th'].join(' ').trim(), 'aria-sort': sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : null },
      h('span', { class: 'xf-head' }, h('span', { class: 'xf-label' }, col.label, col.sub ? h('span', { class: 'xf-sub' }, col.sub) : null, sorted ? h('span', { class: 'xf-arrow', 'aria-hidden': 'true' }, sorted === 'asc' ? ' ↑' : ' ↓') : null), btn));
  }), extraCells ? h('th', null, extraHead || null) : null);
  const count = h('span', { title: `${rows.length.toLocaleString()} of ${allRows.length.toLocaleString()} lines shown` },
    rows.length === allRows.length ? `${rows.length.toLocaleString()} ${rows.length === 1 ? 'line' : 'lines'}` : `${rows.length.toLocaleString()} of ${allRows.length.toLocaleString()}`);
  const toggle = (on) => h('button', { type: 'button', class: 'xt-toggle', onclick: () => onToggleTotals(on) },
    on ? h('span', { 'aria-hidden': 'true' }, '▴ ') : null, on ? 'Show totals' : 'Hide');
  const first = totalsLabel ? totalsLabel(rows, allRows) : count;
  let foot = null;
  if (showTotals) {
    foot = h('tr', { class: 'xt-totals' }, columns.map((col, i) => h('td', { class: [col.num ? 'num' : '', col.sticky ? 'sticky-col' : '', col.sticky2 ? 'sticky-col sticky-col2' : '', col.key === 'item_no' && col.sticky ? 'itemno' : ''].join(' ').trim() },
      i === 0 ? (extraCells || !onToggleTotals ? first : h('span', { class: 'ft-label' }, first, toggle(false))) : col.total ? col.total(rows) : '')),
      extraCells ? h('td', { class: 'xt-hide' }, onToggleTotals ? toggle(false) : null) : null);
  } else if (onToggleTotals) {
    foot = h('tr', { class: 'xt-totals-off' }, h('td', { colspan: width }, h('span', { class: 'xt-off-inner' }, toggle(true))));
  }
  return h('table', { class: `t xtable ${className}`.trim() },
    h('thead', null, head),
    h('tbody', null, rows.length ? rows.map((r) => [h('tr', { class: rowClass ? rowClass(r) : null, onclick: onRowClick ? (e) => { if (!e.target.closest('input, select, button, a')) onRowClick(r); } : null }, columns.map((c) => c.cell(r)), extraCells ? extraCells(r) : null), rowAfter ? rowAfter(r, width) : null])
      : h('tr', null, h('td', { colspan: width, class: 'empty' }, emptyText))),
    foot ? h('tfoot', null, foot) : null);
}

// A totals footer for tables that aren't xtables (the daily grids and sales
// summaries): pinned to the bottom like Sales Detail, with Hide / Show totals.
// cells: the <td>s after the first (label) cell.
export function totalsFoot({ id, rerender, label = 'Total', cells, width }) {
  const on = prefTotals(id);
  const flip = (v) => () => { setPrefTotals(id, v); rerender(); };
  if (!on) return h('tfoot', null, h('tr', { class: 'xt-totals-off' }, h('td', { colspan: width }, h('span', { class: 'xt-off-inner' },
    h('button', { type: 'button', class: 'xt-toggle', onclick: flip(true) }, h('span', { 'aria-hidden': 'true' }, '▴ '), 'Show totals')))));
  return h('tfoot', null, h('tr', { class: 'xt-totals' },
    h('td', { class: 'sticky-col' }, h('span', { class: 'ft-label' }, label, h('button', { type: 'button', class: 'xt-toggle', onclick: flip(false) }, 'Hide'))),
    cells));
}

// Downloads rows as a CSV file that opens in Excel: numbers stay numbers,
// everything else as shown on screen.
export function downloadCsv(name, columns, rows) {
  const esc = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const head = columns.map((c) => esc(c.label + (c.sub ? ` (${c.sub})` : '')));
  const lines = rows.map((r) => columns.map((c) => {
    const v = c.value(r);
    if (c.num && typeof v === 'number' && Number.isFinite(v)) return String(Math.round(v * 1e6) / 1e6);
    return esc(c.text ? c.text(r) : v);
  }));
  const csv = '﻿' + [head, ...lines].map((l) => l.join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = h('a', { href: url, download: `${name}.csv` }); document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export const downloadButton = (name, columns, rows) => h('button', { class: 'btn ghost download', title: 'Download the rows showing as a CSV file (opens in Excel)', onclick: () => downloadCsv(name, columns, rows) }, '⤓ Download for Excel');
