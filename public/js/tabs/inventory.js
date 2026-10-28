import { h, pageHead, monthPicker, seg, yearSelect, qty, money, typePill, todayIso, longDate } from '../ui.js';
import { state, derived } from '../store.js';
import { viewGrid, view } from './grid.js';
import * as C from '../calc.js';

let mode = 'daily';
let year = new Date().getFullYear();
let show = 'qty';

export default {
  id: 'inventory',
  label: 'Daily Inventory',
  render({ rerender }) {
    const ix = derived.ix(); const inv = derived.inventory();
    const tracked = [...ix.byType('Raw Material'), ...ix.byType('Component'), ...ix.byType('Finished Good')];
    const switcher = seg([['daily', 'Daily'], ['monthend', 'Month-end'], ['usage', 'Usage']], mode, (m) => { mode = m; rerender(); });
    const today = todayIso();
    const negatives = tracked.filter((it) => (inv.byItem.get(it.item_no)?.get(today) ?? 0) < 0);
    const notes = [];
    if (!inv.from) notes.push(h('div', { class: 'note info' }, 'Inventory starts from each item’s first cycle count. Enter a count on the Cycle Counts tab to begin.'));
    if (negatives.length && mode !== 'usage') notes.push(h('div', { class: 'note warn' },
      `${negatives.length} item${negatives.length > 1 ? 's are' : ' is'} below zero today (${negatives.map((i) => i.name).join(', ')}). Usually that means deliveries haven’t been entered on Goods Receipt, or a cycle count is due.`));

    if (mode === 'daily') {
      return h('div', null,
        pageHead('Daily Inventory', 'Running balance for each item: the latest cycle count, plus deliveries, minus what production used. Finished goods add cases produced and subtract cases sold.',
          switcher, monthPicker(view.ym, (ym) => { view.ym = ym; rerender(); })),
        notes,
        viewGrid({ id: 'inv-daily', items: tracked, ym: view.ym, value: (d, it) => inv.byItem.get(it.item_no)?.get(d) ?? null }));
    }

    if (mode === 'usage') {
      const cons = derived.consumption(); const usage = C.perCaseUsage(state.data);
      const items = [...ix.byType('Raw Material'), ...ix.byType('Component')];
      const fgs = ix.byType('Finished Good');
      return h('div', null,
        pageHead('Usage', 'What production used each day, from the recipes and bills of materials (the workbook’s hidden Consumption sheet).',
          switcher, monthPicker(view.ym, (ym) => { view.ym = ym; rerender(); })),
        viewGrid({ id: 'inv-usage', items, ym: view.ym, digits: 3, value: (d, it) => cons.get(d)?.get(it.item_no) ?? null }),
        h('div', { class: 'panel', style: { marginTop: '16px' } }, h('h2', null, 'Used per case produced'),
          h('div', { class: 'tablewrap', style: { border: 0, boxShadow: 'none' } }, h('table', { class: 't' },
            h('thead', null, h('tr', null, h('th', { class: 'sticky-col' }, 'Finished good'), items.map((it) => h('th', { class: 'num wrap' }, it.name)))),
            h('tbody', null, fgs.map((fg) => h('tr', null, h('td', { class: 'sticky-col' }, fg.name),
              items.map((it) => { const v = usage.get(fg.item_no)?.get(it.item_no); return h('td', { class: 'num' + (v ? '' : ' blank') }, v ? qty(v, 4) : ''); }))))))));
    }

    // Month-end (the workbook's EndingInventory$ sheet)
    const years = derived.years();
    if (!years.includes(year)) year = years.at(-1);
    const rows = C.endingInventory(state.data, inv, year);
    const monthIdx = [...Array(12).keys()];
    const totals = (type) => monthIdx.map((m) => rows.filter((r) => r.item.type === type).reduce((s, r) => s + r.value[m], 0));
    const cell = (r, m) => {
      const v = show === 'qty' ? r.qty[m] : r.value[m];
      const future = C.monthEnd(year, m + 1) > today;
      return h('td', { class: 'num' + (v < 0 ? ' neg' : '') + (future ? ' blank' : '') }, v ? (show === 'qty' ? qty(v, 1) : money(v, 0)) : '');
    };
    return h('div', null,
      pageHead('Month-end Inventory', show === 'qty' ? 'Inventory on the last day of each month, in each item’s unit.' : 'Month-end inventory valued at standard cost for the year.',
        switcher, seg([['qty', 'Quantity'], ['value', 'Value $']], show, (s) => { show = s; rerender(); }),
        yearSelect(years, year, (y) => { year = y; rerender(); })),
      notes,
      h('div', { class: 'tablewrap tall', 'data-scroll': 'inv-me' }, h('table', { class: 't' },
        h('thead', null, h('tr', null, h('th', { class: 'sticky-col' }, 'Item'), h('th', null, 'Type'), h('th', null, 'Unit'),
          monthIdx.map((m) => h('th', { class: 'num' }, C.MONTHS[m])))),
        h('tbody', null,
          ['Raw Material', 'Component', 'Finished Good'].map((type) => [
            rows.filter((r) => r.item.type === type).map((r) => h('tr', null,
              h('td', { class: 'sticky-col' }, r.item.name), h('td', null, typePill(type)), h('td', { class: 'muted' }, r.item.unit),
              monthIdx.map((m) => cell(r, m)))),
            h('tr', { class: 'total' }, h('td', { class: 'sticky-col' }, `Total ${type === 'Component' ? 'packaging' : type.toLowerCase() + 's'} ($)`), h('td'), h('td'),
              totals(type).map((t) => h('td', { class: 'num' }, t ? money(t, 0) : ''))),
          ])))),
      h('p', { class: 'small muted' }, `Values use the ${year} standard cost (or the latest one entered). Month-ends after ${longDate(today)} are projections.`));
  },
};
