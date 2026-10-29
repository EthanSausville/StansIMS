import { h, pageHead, monthPicker, seg, yearSelect, qty, money, typePill, todayIso, longDate, acctParts } from '../ui.js';
import { state, derived } from '../store.js';
import { viewGrid, view } from './grid.js';
import { xtable, filteredRows, prefTotals, setPrefTotals, activeFilterCount, clearFilters, downloadButton } from '../xtable.js';
import * as C from '../calc.js';

let mode = 'daily'; // 'daily' or 'monthend' (usage moved to the Consumption tab)
let year = new Date().getFullYear();
let show = 'qty';

export default {
  id: 'inventory',
  label: 'Daily Inventory',
  render({ rerender }) {
    const ix = derived.ix(); const inv = derived.inventory();
    const tracked = [...ix.byType('Raw Material'), ...ix.byType('Component'), ...ix.byType('Finished Good')];
    const switcher = seg([['daily', 'Daily'], ['monthend', 'Month-end']], mode, (m) => { mode = m; rerender(); });
    const today = todayIso();
    const negatives = tracked.filter((it) => (inv.byItem.get(it.item_no)?.get(today) ?? 0) < 0);
    const notes = [];
    if (!inv.from) notes.push(h('div', { class: 'note info' }, 'Inventory starts from each item’s first cycle count. Enter a count on New Counts to begin.'));
    if (negatives.length) notes.push(h('div', { class: 'note warn' },
      `${negatives.length} item${negatives.length > 1 ? 's are' : ' is'} below zero today (${negatives.map((i) => i.name).join(', ')}). Usually that means deliveries haven’t been entered on New Receipts, or a count is due.`));

    if (mode === 'daily') {
      return h('div', null,
        pageHead('Daily Inventory', 'Running balance for each item: the latest cycle count, plus deliveries, minus what production used. Finished goods add cases produced and subtract cases sold.',
          switcher, monthPicker(view.ym, (ym) => { view.ym = ym; rerender(); })),
        notes,
        viewGrid({ id: 'inv-daily', items: tracked, ym: view.ym, value: (d, it) => inv.byItem.get(it.item_no)?.get(d) ?? null }));
    }

    // Month-end (the workbook's EndingInventory$ sheet)
    const years = derived.years();
    if (!years.includes(year)) year = years.includes(new Date().getFullYear()) ? new Date().getFullYear() : years.at(-1);
    const rows = C.endingInventory(state.data, inv, year);
    const monthIdx = [...Array(12).keys()];
    const totals = (type) => monthIdx.map((m) => rows.filter((r) => r.item.type === type).reduce((s, r) => s + r.value[m], 0));
    const cellText = (r, m) => { const v = show === 'qty' ? r.qty[m] : r.value[m]; return v ? (show === 'qty' ? qty(v, 1) : acctParts(v)) : ''; };
    const columns = [
      { key: 'name', label: 'Item', sticky: true, value: (r) => r.item.name, cell: (r) => h('td', { class: 'sticky-col' }, r.item.name) },
      { key: 'type', label: 'Type', value: (r) => r.item.type, text: (r) => (r.item.type === 'Component' ? 'Packaging' : r.item.type), cell: (r) => h('td', null, typePill(r.item.type)) },
      { key: 'unit', label: 'Unit', value: (r) => r.item.unit || '', cell: (r) => h('td', { class: 'muted' }, r.item.unit) },
      ...monthIdx.map((m) => ({ key: `m${m}`, label: C.MONTHS[m], num: true, value: (r) => (show === 'qty' ? r.qty[m] : r.value[m]),
        cell: (r) => { const v = show === 'qty' ? r.qty[m] : r.value[m]; const future = C.monthEnd(year, m + 1) > today;
          return h('td', { class: 'num' + (v < 0 ? ' neg' : '') + (future ? ' blank' : '') }, cellText(r, m)); },
        total: (rs) => { const t = rs.reduce((s, r) => s + r.value[m], 0); return t ? acctParts(t) : ''; } })),
    ];
    const tid = 'inv-me';
    const shown = filteredRows({ id: tid, columns, rows });
    const nFilters = activeFilterCount(tid);
    return h('div', null,
      pageHead('Month-end Inventory', (show === 'qty' ? 'Inventory on the last day of each month, in each item’s unit.' : 'Month-end inventory valued at standard cost for the year.')
        + ` The totals row is in dollars at the ${year} standard cost (or the latest one entered); filter Type to total one kind of item. Month-ends after today are projections.`,
        switcher, seg([['qty', 'Quantity'], ['value', 'Value $']], show, (s) => { show = s; rerender(); }),
        yearSelect(years, year, (y) => { year = y; rerender(); }),
        downloadButton(`month-end-inventory-${year}-${show}`, columns, shown),
        nFilters ? h('button', { class: 'btn ghost', onclick: () => { clearFilters(tid); rerender(); } }, `Clear filters (${nFilters})`) : null),
      notes,
      h('div', { class: 'tablewrap tall', 'data-scroll': tid },
        xtable({ id: tid, columns, allRows: rows, rows: shown, rerender, showTotals: prefTotals(tid), onToggleTotals: (on) => { setPrefTotals(tid, on); rerender(); },
          totalsLabel: (rs, all) => (rs.length === all.length ? 'Total value ($)' : `Total value, ${rs.length} items ($)`) })));
  },
};
