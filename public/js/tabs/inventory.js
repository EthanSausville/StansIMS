// Inventory → Daily: every item's running balance, newest day first. A day
// with a cycle count gets two more rows: what was counted and the adjustment
// (count − what the running inventory expected). A start-of-day count sits
// below its day (it came before the day's deliveries and production), an
// end-of-day count above it. Month-end shows each month's last day.
import { h, pageHead, seg, yearSelect, qty, typePill, todayIso, dateLabel, acctParts, thisYear, itemNoCol, chip } from '../ui.js';
import { state, derived } from '../store.js';
import { itemHead, endlessDays, dayRowClass } from './grid.js';
import { xtable, filteredRows, prefTotals, setPrefTotals, activeFilterCount, clearFilters, downloadButton } from '../xtable.js';
import * as C from '../calc.js';

let mode = 'daily'; // 'daily' or 'monthend'
let year = thisYear();
let show = 'qty';

export default {
  id: 'inventory',
  label: 'Daily',
  render({ rerender }) {
    const ix = derived.ix(); const inv = derived.inventory();
    const tracked = [...ix.byType('Raw Material'), ...ix.byType('Component'), ...ix.byType('Finished Good')];
    const switcher = seg([['daily', 'Daily'], ['monthend', 'Month-end']], mode, (m) => { mode = m; rerender(); });
    const today = todayIso();
    const negatives = tracked.filter((it) => (inv.byItem.get(it.item_no)?.get(today) ?? 0) < 0);
    const notes = [];
    if (!inv.from) notes.push(h('div', { class: 'note info' }, 'Inventory starts from each item’s first cycle count. Enter a count on Count to begin.'));
    if (negatives.length) notes.push(h('div', { class: 'note warn' },
      `${negatives.length} item${negatives.length > 1 ? 's are' : ' is'} below zero today (${negatives.map((i) => i.name).join(', ')}). Usually that means deliveries haven’t been entered on Receive, or a count is due.`));

    if (mode === 'daily') {
      const value = (d, it) => inv.byItem.get(it.item_no)?.get(d);
      const cell = (v, cls = '') => h('td', { class: ['num', v === undefined || v === null ? 'blank' : '', typeof v === 'number' && v < 0 ? 'neg' : '', cls].join(' ').trim() }, v === undefined || v === null ? '' : qty(v, 2));
      // Counts by day and timing.
      const countDays = new Map(); // date -> Set of timings
      for (const c of state.data.cycle_counts) { if (!countDays.has(c.date)) countDays.set(c.date, new Set()); countDays.get(c.date).add(C.countTiming(c)); }
      const countRows = (d, t) => {
        const a = (it) => { const x = inv.adjust.get(`${it.item_no}|${d}`); return x && x.timing === t ? x : null; };
        const label = t === 'end' ? 'end of day' : 'start of day';
        return [
          h('tr', { class: 'count-row', 'data-count': `${d}|${t}` }, h('td', { class: 'sticky-col' }, h('span', { class: 'row-tag' }, 'Count'), h('span', { class: 'small muted' }, ` ${label}`)),
            tracked.map((it) => { const x = a(it); return h('td', { class: 'num' }, x ? qty(x.counted, 2) : ''); })),
          h('tr', { class: 'adj-row', 'data-adjust': `${d}|${t}` }, h('td', { class: 'sticky-col' }, h('span', { class: 'row-tag' }, 'Adjustment'), h('span', { class: 'small muted' }, ` ${label}`)),
            tracked.map((it) => { const x = a(it); const v = x?.adj;
              return h('td', { class: 'num' + (v < 0 ? ' neg' : v > 0 ? ' pos' : ''), title: x && x.adj === null ? 'First count: it starts this item’s inventory' : x ? `Expected ${qty(x.expected, 2)}, counted ${qty(x.counted, 2)}` : null },
                !x ? '' : v === null ? 'start' : `${v > 0 ? '+' : ''}${qty(v, 2)}`); })),
        ];
      };
      const { list } = endlessDays({ id: 'inv-daily', tableClass: 'inv-daily', head: itemHead(tracked, { notes: true }),
        monthCells: () => tracked.map(() => h('td')),
        dayRows: (d) => {
          const ts = countDays.get(d) || new Set();
          const day = h('tr', { class: dayRowClass(d, today), 'data-day': d }, h('td', { class: 'sticky-col' }, dateLabel(d)), tracked.map((it) => cell(value(d, it))));
          // Newest first: an end-of-day count came after the day (above it), a start-of-day count before it (below).
          return [ts.has('end') ? countRows(d, 'end') : null, day, ts.has('start') ? countRows(d, 'start') : null];
        } });
      return h('div', null,
        pageHead('Daily', 'Running balance for each item: the latest cycle count, plus deliveries, minus what production used. Finished goods add cases produced and subtract cases sold.'),
        h('div', { class: 'prod-top' }, h('span', { class: 'small muted' }, 'Newest day first. A count shows what was counted and the adjustment to the running inventory, below the day if it was counted at the start of the day, above it if at the end.'), switcher),
        notes, list);
    }

    // Month-end (the workbook's EndingInventory$ sheet)
    const years = derived.years();
    if (!years.includes(year)) year = years.includes(thisYear()) ? thisYear() : years.at(-1);
    const rows = C.endingInventory(state.data, inv, year);
    const monthIdx = [...Array(12).keys()];
    const totals = (type) => monthIdx.map((m) => rows.filter((r) => r.item.type === type).reduce((s, r) => s + r.value[m], 0));
    const cellText = (r, m) => { const v = show === 'qty' ? r.qty[m] : r.value[m]; return v ? (show === 'qty' ? qty(v, 1) : acctParts(v)) : ''; };
    const columns = [
      itemNoCol((r) => r.item), { key: 'name', label: 'Item', sticky2: true, value: (r) => r.item.name, cell: (r) => h('td', { class: 'sticky-col sticky-col2' }, r.item.name) },
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
        + ` The totals row is in dollars at the ${year} standard cost (or the latest one entered); filter Type to total one kind of item. Month-ends after today are projections.`),
      h('div', { class: 'prod-top' },
        seg([['qty', 'Quantity'], ['value', 'Value $']], show, (s) => { show = s; rerender(); }),
        yearSelect(years, year, (y) => { year = y; rerender(); }),
        nFilters ? h('button', { class: 'btn ghost', onclick: () => { clearFilters(tid); rerender(); } }, `Clear filters (${nFilters})`) : null,
        downloadButton(`month-end-inventory-${year}-${show}`, columns, shown), switcher),
      notes,
      h('div', { class: 'tablewrap tall', 'data-scroll': tid },
        xtable({ id: tid, columns, allRows: rows, rows: shown, rerender, showTotals: prefTotals(tid), onToggleTotals: (on) => { setPrefTotals(tid, on); rerender(); },
          totalsLabel: (rs, all) => (rs.length === all.length ? 'Total value ($)' : `Total value, ${rs.length} items ($)`) })));
  },
};
