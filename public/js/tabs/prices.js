import { h, pageHead, numberCell, qty } from '../ui.js';
import { state, derived, saveCell, isAdmin } from '../store.js';
import { avgPricePerOz } from '../calc.js';

export default {
  id: 'prices',
  label: 'Standard Price',
  render() {
    const ix = derived.ix(); const cm = derived.costs(); const admin = isAdmin();
    const fgs = ix.byType('Finished Good');
    const prices = new Map(state.data.standard_prices.map((p) => [`${p.item_no}|${p.year}`, p.price]));
    return h('div', null,
      pageHead('Standard Price', 'Price per case by year. The average price per oz values the leftover from partial batches on Production.' + (admin ? '' : ' Only admins can change these.')),
      h('div', { class: 'tablewrap' }, h('table', { class: 't' },
        h('thead', null, h('tr', null, h('th', { class: 'sticky-col' }, 'Product'), h('th', { class: 'num' }, 'Oz per case'), cm.years.map((y) => h('th', { class: 'num' }, y)))),
        h('tbody', null,
          fgs.map((fg) => h('tr', null, h('td', { class: 'sticky-col' }, fg.name), h('td', { class: 'num calc' }, qty(ix.fgCaseOz.get(fg.item_no) || 0)),
            cm.years.map((y) => numberCell(prices.get(`${fg.item_no}|${y}`) ?? null, (v) => saveCell('standard_prices', { item_no: fg.item_no, year: y }, 'price', v),
              { disabled: !admin, digits: 2, key: `sp|${fg.item_no}|${y}`, title: `${fg.name} ${y} price per case` })))),
          h('tr', { class: 'total' }, h('td', { class: 'sticky-col' }, 'Average per oz'), h('td'),
            cm.years.map((y) => { const v = avgPricePerOz(state.data, y); return h('td', { class: 'num' }, v ? '$' + qty(v, 4) : ''); }))))));
  },
};
