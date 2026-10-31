import { h, pageHead, monthPicker, money, qty, fmt, chip, acctCell, seg, longDate } from '../ui.js';
import { state, derived, saveCell } from '../store.js';
import { entryGrid, view, monthDays } from './grid.js';
import { can } from '../perms.js';
import { productionLots } from '../calc.js';
import { xtable, filteredRows, activeFilterCount, clearFilters, downloadButton } from '../xtable.js';

let mode = 'daily';
let lotSel = null;

// Lots: each day's production of a product, traced to the customers it shipped to.
function lotsView(rerender, switcher) {
  const { lots, unmatched } = derived.lots();
  const shipped = (l) => l.cases - l.left;
  const columns = [
    { key: 'code', label: 'Lot', sticky: true, value: (l) => l.code, cell: (l) => h('td', { class: 'sticky-col mono' }, l.code) },
    { key: 'item', label: 'Product', value: (l) => l.item?.name || '', cell: (l) => h('td', null, l.item?.name || '') },
    { key: 'date', label: 'Made', value: (l) => l.date, text: (l) => longDate(l.date), cell: (l) => h('td', null, longDate(l.date)) },
    { key: 'cases', label: 'Cases', num: true, value: (l) => l.cases, cell: (l) => h('td', { class: 'num' }, qty(l.cases)) },
    { key: 'shipped', label: 'Shipped', num: true, value: (l) => shipped(l), cell: (l) => h('td', { class: 'num' }, qty(shipped(l))) },
    { key: 'left', label: 'Left', num: true, value: (l) => l.left, cell: (l) => h('td', { class: 'num' + (l.left ? ' strong' : ' muted') }, qty(l.left)) },
    { key: 'customers', label: 'Customers', num: true, value: (l) => new Set(l.shipments.map((x) => x.customer)).size, cell: (l) => h('td', { class: 'num' }, new Set(l.shipments.map((x) => x.customer)).size || '') },
  ];
  const shown = filteredRows({ id: 'lots', columns, rows: lots, defaultSort: { key: 'date', dir: 'desc' } });
  const sel = lotSel ? lots.find((l) => l.code === lotSel) : null;
  const nFilters = activeFilterCount('lots');
  const detail = sel ? h('div', { class: 'side-detail' },
    h('strong', null, `Lot ${sel.code}`), h('div', { class: 'small muted' }, `${sel.item?.name} · made ${longDate(sel.date)} · ${qty(sel.cases)} cases`),
    sel.shipments.length ? h('table', { class: 't side-orders' }, h('thead', null, h('tr', null, h('th', null, 'Shipped'), h('th', null, 'Customer'), h('th', { class: 'num' }, 'Cases'))),
      h('tbody', null, sel.shipments.map((x) => h('tr', { title: x.invoice ? `Invoice ${x.invoice}` : null }, h('td', null, `${Number(x.date.slice(5, 7))}/${Number(x.date.slice(8, 10))}`), h('td', null, x.customer || '—'), h('td', { class: 'num' }, qty(x.cases))))))
      : h('p', { class: 'small muted' }, 'Not shipped yet.'),
    sel.left ? h('div', { class: 'small muted' }, `${qty(sel.left)} cases not shipped yet.`) : null)
    : h('p', { class: 'small muted' }, 'Click a lot to see who it shipped to.');
  return h('div', null,
    pageHead('Production Lots', 'Each day’s production of a product is a lot, coded YYMMDD-item number (260714-500001 = made July 14, 2026). Sales are matched to lots first in, first out: the oldest lot made on or before the sale date ships first. Use it to trace a lot to the customers who received it.',
      switcher, chip('Lots', lots.length), detail,
      unmatched.length ? h('p', { class: 'small muted' }, `${unmatched.length} sale line${unmatched.length > 1 ? 's' : ''} came from stock made before the first lot entered.`) : null,
      downloadButton('production-lots', columns, shown),
      nFilters ? h('button', { class: 'btn ghost', onclick: () => { clearFilters('lots'); rerender(); } }, `Clear filters (${nFilters})`) : null),
    lots.length ? h('div', { class: 'tablewrap', 'data-scroll': 'lots' }, xtable({ id: 'lots', columns, allRows: lots, rows: shown, rerender, defaultSort: { key: 'date', dir: 'desc' },
      className: 'selectable', rowClass: (l) => (l.code === lotSel ? 'selected' : null), onRowClick: (l) => { lotSel = l.code === lotSel ? null : l.code; rerender(); } }))
      : h('div', { class: 'panel empty' }, 'No production entered yet.'));
}

export default {
  id: 'production',
  label: 'Production',
  render({ rerender }) {
    const switcher = seg([['daily', 'Daily'], ['lots', 'Lots']], mode, (m) => { mode = m; rerender(); });
    if (mode === 'lots') return lotsView(rerender, switcher);
    const fgs = derived.ix().byType('Finished Good');
    const days = new Map(derived.production().map((d) => [d.date, d]));
    const inMonth = monthDays(view.ym).map((d) => days.get(d)).filter(Boolean);
    const sum = (f) => inMonth.reduce((s, d) => s + f(d), 0);
    const calc = (d) => {
      const p = days.get(d);
      return [acctCell(p ? p.loss : null, { class: 'calc' }), h('td', { class: 'num calc' }, p ? p.batches : ''), h('td', { class: 'num calc' }, p ? fmt(p.oz) : '')];
    };
    return h('div', null,
      pageHead('Production', 'Cases produced each day. Oz, batches and the estimated loss from the last partial batch calculate automatically: each recipe is batched on its own, in its recipe BOM’s batch size. Typing math like 24*10 works.',
        switcher, monthPicker(view.ym, (ym) => { view.ym = ym; rerender(); }),
        chip('Cases', qty(sum((d) => Object.values(d.cases).reduce((a, b) => a + b, 0)))),
        chip('Batches', fmt(sum((d) => d.batches))),
        chip('Oz', fmt(sum((d) => d.oz))),
        chip('Est. loss', money(sum((d) => d.loss)))),
      entryGrid({
        table: 'production', field: 'cases', rerender, items: fgs, ym: view.ym, rows: state.data.production, notes: false, digits: 2,
        beforeLabels: ['Est. loss', 'Batches', 'Oz'], before: calc,
        editable: { allowed: can('production', 'edit'), save: (date, item_no, v) => saveCell('production', { date, item_no }, 'cases', v) },
      }));
  },
};

export const stat = (label, value, sub) => h('div', { class: 'stat' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), sub ? h('div', { class: 'small muted' }, sub) : null);
