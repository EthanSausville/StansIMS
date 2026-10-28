import { h, pageHead, monthPicker, chip } from '../ui.js';
import { state, derived, saveCell } from '../store.js';
import { entryGrid, view, monthDays } from './grid.js';

export default {
  id: 'receipts',
  label: 'Goods Receipt',
  render({ rerender }) {
    const ix = derived.ix();
    const items = [...ix.byType('Raw Material'), ...ix.byType('Component')];
    const days = new Set(monthDays(view.ym));
    const month = state.data.goods_receipts.filter((r) => days.has(r.date));
    return h('div', null,
      pageHead('Goods Receipt', 'Quantities received each day, in each item’s unit (pounds, cups or each). Typing math like 175*45 works.',
        monthPicker(view.ym, (ym) => { view.ym = ym; rerender(); }),
        chip('Receipts', month.length),
        chip('Delivery days', new Set(month.map((r) => r.date)).size),
        h('span', { class: 'legend-entry' }, h('i'), 'Type in the yellow cells')),
      entryGrid({
        table: 'goods_receipts', field: 'qty', rerender, items, ym: view.ym, rows: state.data.goods_receipts,
        editable: { allowed: true, save: (date, item_no, v) => saveCell('goods_receipts', { date, item_no }, 'qty', v) },
      }));
  },
};
