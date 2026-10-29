import { h, pageHead, numberCell, qty } from '../ui.js';
import { state, derived, saveCell, isAdmin } from '../store.js';
import { avgPricePerOz } from '../calc.js';
import { xtable, filteredRows, prefTotals, setPrefTotals, activeFilterCount, clearFilters } from '../xtable.js';

export default {
  id: 'prices',
  label: 'Standard Price',
  render({ rerender }) {
    const ix = derived.ix(); const cm = derived.costs(); const admin = isAdmin();
    const fgs = ix.byType('Finished Good');
    const prices = new Map(state.data.standard_prices.map((p) => [`${p.item_no}|${p.year}`, p.price]));
    const price = (fg, y) => prices.get(`${fg.item_no}|${y}`) ?? null;
    const columns = [
      { key: 'name', label: 'Product', sticky: true, value: (fg) => fg.name, cell: (fg) => h('td', { class: 'sticky-col' }, fg.name) },
      { key: 'oz', label: 'Oz per case', num: true, value: (fg) => ix.fgCaseOz.get(fg.item_no) || 0, text: (fg) => qty(ix.fgCaseOz.get(fg.item_no) || 0),
        cell: (fg) => h('td', { class: 'num calc' }, qty(ix.fgCaseOz.get(fg.item_no) || 0)) },
      ...cm.years.map((y) => ({ key: `y${y}`, label: String(y), num: true, value: (fg) => price(fg, y), text: (fg) => (price(fg, y) === null ? '' : '$' + qty(price(fg, y), 2)),
        cell: (fg) => numberCell(price(fg, y), (v) => saveCell('standard_prices', { item_no: fg.item_no, year: y }, 'price', v),
          { disabled: !admin, digits: 2, key: `sp|${fg.item_no}|${y}`, title: `${fg.name} ${y} price per case` }),
        total: () => { const v = avgPricePerOz(state.data, y); return v ? '$' + qty(v, 4) : ''; } })),
    ];
    const rows = filteredRows({ id: 'prices', columns, rows: fgs });
    const nFilters = activeFilterCount('prices');
    return h('div', null,
      pageHead('Standard Price', 'Price per case by year. The bottom row is the average price per oz across all products, which values the leftover from partial batches on Production.' + (admin ? '' : ' Only admins can change these.'),
        nFilters ? h('button', { class: 'btn ghost', onclick: () => { clearFilters('prices'); rerender(); } }, `Clear filters (${nFilters})`) : null),
      h('div', { class: 'tablewrap', 'data-scroll': 'prices' },
        xtable({ id: 'prices', columns, allRows: fgs, rows, rerender, className: 'natural', showTotals: prefTotals('prices'),
          onToggleTotals: (on) => { setPrefTotals('prices', on); rerender(); }, totalsLabel: () => 'Average $/oz' })));
  },
};
