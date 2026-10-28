import { h, pageHead, monthPicker, money, qty, fmt, chip } from '../ui.js';
import { state, derived, saveCell } from '../store.js';
import { entryGrid, view, monthDays } from './grid.js';

export default {
  id: 'production',
  label: 'Production',
  render({ rerender }) {
    const fgs = derived.ix().byType('Finished Good');
    const days = new Map(derived.production().map((d) => [d.date, d]));
    const B = state.data.settings.production_batch_size;
    const inMonth = monthDays(view.ym).map((d) => days.get(d)).filter(Boolean);
    const sum = (f) => inMonth.reduce((s, d) => s + f(d), 0);
    const calc = (d) => {
      const p = days.get(d);
      return [h('td', { class: 'num calc' }, p ? money(p.loss) : ''), h('td', { class: 'num calc' }, p ? p.batches : ''), h('td', { class: 'num calc' }, p ? fmt(p.oz) : '')];
    };
    return h('div', null,
      pageHead('Production', `Cases produced each day. Oz, batches (${fmt(B)} oz each) and the estimated loss from the last partial batch calculate automatically. Typing math like 24*10 works.`,
        monthPicker(view.ym, (ym) => { view.ym = ym; rerender(); }),
        chip('Cases', qty(sum((d) => Object.values(d.cases).reduce((a, b) => a + b, 0)))),
        chip('Batches', fmt(sum((d) => d.batches))),
        chip('Oz', fmt(sum((d) => d.oz))),
        chip('Est. loss', money(sum((d) => d.loss))),
        h('span', { class: 'legend-entry' }, h('i'), 'Type in the yellow cells')),
      entryGrid({
        table: 'production', field: 'cases', rerender, items: fgs, ym: view.ym, rows: state.data.production, notes: false, digits: 2,
        beforeLabels: ['Est. loss', 'Batches', 'Oz'], before: calc,
        editable: { allowed: true, save: (date, item_no, v) => saveCell('production', { date, item_no }, 'cases', v) },
      }));
  },
};

export const stat = (label, value, sub) => h('div', { class: 'stat' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), sub ? h('div', { class: 'small muted' }, sub) : null);
