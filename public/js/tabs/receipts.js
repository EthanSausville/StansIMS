import { h, pageHead, monthPicker } from '../ui.js';
import { state, derived, saveCell } from '../store.js';
import { entryGrid, view, monthDays } from './grid.js';
import { stat } from './production.js';

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
        h('span', { class: 'legend-entry' }, h('i'), 'Type in the yellow cells'),
        monthPicker(view.ym, (ym) => { view.ym = ym; rerender(); })),
      h('div', { class: 'cards' },
        stat('Receipts this month', month.length),
        stat('Days with deliveries', new Set(month.map((r) => r.date)).size)),
      entryGrid({
        table: 'goods_receipts', field: 'qty', items, ym: view.ym, rows: state.data.goods_receipts,
        editable: { allowed: true, save: (date, item_no, v) => saveCell('goods_receipts', { date, item_no }, 'qty', v) },
      }));
  },
};
