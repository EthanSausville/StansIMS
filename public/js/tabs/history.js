// Change history (admins): who changed setup data and purchase orders, when,
// and what changed. Recorded by the database (audit_log), so it can't be edited.
import { h, pageHead, toast, niceError, longDate, seg } from '../ui.js';
import { listAudit, derived } from '../store.js';
import { xtable, filteredRows, activeFilterCount, clearFilters, downloadButton } from '../xtable.js';

let rows = null; let loading = false; let failed = false;
const TABLES = { items: 'Item', standard_costs: 'Standard cost', standard_prices: 'Standard price', boms: 'BOM', bom_lines: 'BOM line', settings: 'Settings',
  year_settings: 'Year settings', purchase_settings: 'Purchase settings', labor_positions: 'Labor position', production_plan: 'Production plan' };
const ACTIONS = { insert: 'Added', update: 'Changed', delete: 'Removed' };
const SKIP = new Set(['id', 'created_at', 'updated_at', 'sort']);
const fmtVal = (v) => (v === null || v === undefined || v === '' ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));

// What the row is about, in words (the item's name, the year...).
function subject(r) {
  const row = r.new_row || r.old_row || {};
  const name = (no) => derived.ix().items.get(no)?.name || (no ? `#${no}` : '');
  const parts = [];
  if (row.item_no) parts.push(name(row.item_no));
  if (row.parent_item_no) parts.push(`${name(row.parent_item_no)} ← ${name(row.item_no)}`);
  if (r.table_name === 'labor_positions' && row.name) parts.push(row.name);
  if (row.year) parts.push(String(row.year));
  if (row.week) parts.push(`week of ${row.week}`);
  return [...new Set(parts)].filter(Boolean).join(' · ');
}
// The fields that changed, as "field: old → new".
function changes(r) {
  const a = r.old_row || {}; const b = r.new_row || {};
  if (r.action === 'insert') return Object.entries(b).filter(([k, v]) => !SKIP.has(k) && v !== null && v !== '').map(([k, v]) => `${k}: ${fmtVal(v)}`).join(', ');
  if (r.action === 'delete') return '';
  return Object.keys({ ...a, ...b }).filter((k) => !SKIP.has(k) && JSON.stringify(a[k]) !== JSON.stringify(b[k])).map((k) => `${k}: ${fmtVal(a[k])} → ${fmtVal(b[k])}`).join(', ');
}

export default {
  id: 'history',
  label: 'Change history',
  adminOnly: true,
  render({ rerender }) {
    if (!rows && !loading && !failed) {
      loading = true;
      listAudit().then((r) => { rows = r; }).catch((e) => { failed = true; if (!/does not exist|schema cache|PGRST205|42P01/i.test(e?.message || '')) toast(niceError(e), 'bad'); })
        .finally(() => { loading = false; rerender(); });
    }
    const list = rows || [];
    const columns = [
      { key: 'at', label: 'When', value: (r) => r.at, text: (r) => longDate(r.at.slice(0, 10)), cell: (r) => h('td', { title: r.at }, `${longDate(r.at.slice(0, 10))} ${r.at.slice(11, 16)}`) },
      { key: 'who', label: 'Who', value: (r) => r.email || 'system', cell: (r) => h('td', null, r.email || h('span', { class: 'muted' }, 'system')) },
      { key: 'what', label: 'What', value: (r) => TABLES[r.table_name] || r.table_name, cell: (r) => h('td', null, TABLES[r.table_name] || r.table_name) },
      { key: 'action', label: 'Action', value: (r) => ACTIONS[r.action] || r.action, cell: (r) => h('td', null, ACTIONS[r.action] || r.action) },
      { key: 'subject', label: 'For', value: (r) => subject(r), cell: (r) => h('td', null, subject(r)) },
      { key: 'changes', label: 'Details', filter: false, value: (r) => changes(r), cell: (r) => h('td', { class: 'wrap-cell small' }, changes(r)) },
    ];
    const shown = filteredRows({ id: 'history', columns, rows: list, defaultSort: { key: 'at', dir: 'desc' } });
    const nFilters = activeFilterCount('history');
    return h('div', null,
      pageHead('Change history', 'Every change to items, standard costs and prices, BOMs, labor, settings and the production plan: who made it, when, and what changed. The database records it, so it can’t be edited. Shows the latest 500 changes.',
        h('button', { class: 'btn', onclick: () => { rows = null; failed = false; rerender(); } }, 'Refresh'),
        list.length ? downloadButton('change-history', columns, shown) : null,
        nFilters ? h('button', { class: 'btn ghost', onclick: () => { clearFilters('history'); rerender(); } }, `Clear filters (${nFilters})`) : null),
      failed ? h('div', { class: 'note warn' }, 'Change history starts being recorded after the next deploy to main.') : null,
      loading && !rows ? h('div', { class: 'empty' }, 'Loading…')
        : list.length ? h('div', { class: 'tablewrap' }, xtable({ id: 'history', columns, allRows: list, rows: shown, rerender, defaultSort: { key: 'at', dir: 'desc' } }))
          : !failed ? h('div', { class: 'panel empty' }, 'No changes recorded yet.') : null);
  },
};
