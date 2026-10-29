import { h, pageHead, monthPicker, longDate } from '../ui.js';
import { state, derived, saveCell } from '../store.js';
import { entryGrid, view, monthDays } from './grid.js';

export default {
  id: 'counts',
  label: 'Cycle Counts',
  render({ rerender }) {
    const ix = derived.ix();
    const items = [...ix.byType('Raw Material'), ...ix.byType('Component'), ...ix.byType('Finished Good')];
    const prodDays = new Set(state.data.production.map((p) => p.date));
    const receipt = new Set(state.data.goods_receipts.map((r) => `${r.date}|${r.item_no}`));
    const counted = new Set(state.data.cycle_counts.map((c) => `${c.date}|${c.item_no}`));
    const conflict = (d, it) => counted.has(`${d}|${it.item_no}`) && (prodDays.has(d) || receipt.has(`${d}|${it.item_no}`));
    const days = monthDays(view.ym);
    const clashes = days.filter((d) => items.some((it) => conflict(d, it)));
    return h('div', null,
      pageHead('Cycle Counts', 'What is physically on hand. A count replaces the running inventory for that item from that day on. Finished goods are counted in cases. Count on a day with no production and no deliveries; otherwise that day’s usage and receipts are applied on top of the count.',
        monthPicker(view.ym, (ym) => { view.ym = ym; rerender(); })),
      clashes.length ? h('div', { class: 'note bad' }, `Counts this month on a day with production or a delivery (outlined below): ${clashes.map(longDate).join(', ')}.`) : null,
      entryGrid({
        table: 'cycle_counts', field: 'qty', items, ym: view.ym, rows: state.data.cycle_counts, footer: false,
        cellClass: (d, it) => (conflict(d, it) ? 'flag' : null),
        editable: { allowed: true, save: (date, item_no, v) => saveCell('cycle_counts', { date, item_no }, 'qty', v) },
      }));
  },
};
