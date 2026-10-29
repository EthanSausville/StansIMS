// Consumption: what production used of each raw material and packaging item.
//   By month   standard usage (from production and the BOMs), in units or $.
//   Count to count  actual usage between two cycle counts vs. standard usage.
//   Daily      standard usage by day (the workbook's hidden Consumption sheet),
//              and what one case of each product uses.
import { h, pageHead, monthPicker, seg, yearSelect, qty, typePill, longDate, acctText, acctCell, chip } from '../ui.js';
import { state, derived } from '../store.js';
import { viewGrid, view } from './grid.js';
import { xtable, filteredRows, prefTotals, setPrefTotals, activeFilterCount, clearFilters, downloadButton } from '../xtable.js';
import * as C from '../calc.js';

let mode = 'month';
let year = new Date().getFullYear();
let show = 'qty';

const money = (v) => (v ? '$' + acctText(v) : '');

export default {
  id: 'consumption',
  label: 'Consumption',
  render({ rerender }) {
    const ix = derived.ix(); const cm = derived.costs();
    const mats = [...ix.byType('Raw Material'), ...ix.byType('Component')];
    const switcher = seg([['month', 'By month'], ['counts', 'Count to count'], ['daily', 'Daily']], mode, (m) => { mode = m; rerender(); });

    if (mode === 'daily') {
      const cons = derived.consumption(); const usage = C.perCaseUsage(state.data, view.ym.year);
      const fgs = ix.byType('Finished Good');
      return h('div', null,
        pageHead('Daily Consumption', 'What production used each day, from the cases produced and each product’s BOM (the workbook’s hidden Consumption sheet), and what one case of each product uses.',
          switcher, monthPicker(view.ym, (ym) => { view.ym = ym; rerender(); })),
        viewGrid({ id: 'cons-daily', items: mats, ym: view.ym, digits: 3, value: (d, it) => cons.get(d)?.get(it.item_no) ?? null }),
        h('h2', { class: 'section-title' }, `Used per case produced (${view.ym.year} BOMs)`),
        h('div', { class: 'tablewrap' }, h('table', { class: 't natural plain-cells' },
          h('thead', null, h('tr', null, h('th', { class: 'sticky-col' }, 'Finished good'), mats.map((it) => h('th', { class: 'num wrap' }, it.name)))),
          h('tbody', null, fgs.map((fg) => h('tr', null, h('td', { class: 'sticky-col' }, fg.name),
            mats.map((it) => { const v = usage.get(fg.item_no)?.get(it.item_no); return h('td', { class: 'num' + (v ? '' : ' blank') }, v ? qty(v, 4) : ''); })))))));
    }

    if (mode === 'counts') {
      const rows = derived.counts();
      const cost = (r) => cm.cost(r.item.item_no, C.yearOf(r.to)) || cm.latest(r.item.item_no);
      const pctOf = (r) => (r.standard ? r.variance / r.standard : null);
      const columns = [
        { key: 'name', label: 'Item', sticky: true, value: (r) => r.item.name, cell: (r) => h('td', { class: 'sticky-col' }, r.item.name) },
        { key: 'type', label: 'Type', value: (r) => (r.item.type === 'Component' ? 'Packaging' : r.item.type), cell: (r) => h('td', null, typePill(r.item.type)) },
        { key: 'from', label: 'From count', value: (r) => r.from, text: (r) => longDate(r.from), cell: (r) => h('td', null, longDate(r.from)) },
        { key: 'to', label: 'To count', value: (r) => r.to, text: (r) => longDate(r.to), cell: (r) => h('td', null, longDate(r.to)) },
        { key: 'start', label: 'Counted', num: true, value: (r) => r.start, text: (r) => qty(r.start, 1), cell: (r) => h('td', { class: 'num' }, qty(r.start, 1)) },
        { key: 'received', label: '+ Received', num: true, value: (r) => r.received, text: (r) => qty(r.received, 1), cell: (r) => h('td', { class: 'num' }, r.received ? qty(r.received, 1) : '') },
        { key: 'end', label: '− Counted', num: true, value: (r) => r.end, text: (r) => qty(r.end, 1), cell: (r) => h('td', { class: 'num' }, qty(r.end, 1)) },
        { key: 'actual', label: '= Actual used', num: true, value: (r) => r.actual, text: (r) => qty(r.actual, 1), cell: (r) => h('td', { class: 'num strong' }, qty(r.actual, 1)) },
        { key: 'standard', label: 'Standard used', num: true, value: (r) => r.standard, text: (r) => qty(r.standard, 1), cell: (r) => h('td', { class: 'num' }, qty(r.standard, 1)) },
        { key: 'unit', label: 'Unit', value: (r) => r.item.unit || '', cell: (r) => h('td', { class: 'muted' }, r.item.unit || '') },
        { key: 'variance', label: 'Variance', num: true, value: (r) => r.variance, text: (r) => qty(r.variance, 1), cell: (r) => h('td', { class: 'num' + (r.variance > 0 ? ' neg' : '') }, qty(r.variance, 1)) },
        { key: 'pct', label: 'Variance %', num: true, value: (r) => pctOf(r), text: (r) => (pctOf(r) === null ? '' : `${qty(pctOf(r) * 100, 0)}%`),
          cell: (r) => h('td', { class: 'num' + (pctOf(r) > 0.05 ? ' neg' : '') }, pctOf(r) === null ? '' : `${qty(pctOf(r) * 100, 0)}%`) },
        { key: 'dollars', label: 'Variance $', num: true, value: (r) => r.variance * cost(r), text: (r) => money(r.variance * cost(r)),
          cell: (r) => acctCell(r.variance * cost(r), { class: r.variance > 0 ? 'neg' : '' }), total: (rs) => money(rs.reduce((s, r) => s + r.variance * cost(r), 0)) },
      ];
      const tid = 'cons-counts';
      const shown = filteredRows({ id: tid, columns, rows, defaultSort: { key: 'to', dir: 'desc' } });
      const nFilters = activeFilterCount(tid);
      return h('div', null,
        pageHead('Count to Count', 'Actual usage between two cycle counts of an item (first count + deliveries received − second count) next to what production should have used by the BOMs. A positive variance means more was used than the BOMs account for (waste, loss, a BOM that’s low, or a delivery not entered); negative means less (a missed production entry or a BOM that’s high). Dollars are at standard cost.',
          switcher, chip('Count periods', rows.length), rows.length ? downloadButton('count-to-count', columns, shown) : null,
          nFilters ? h('button', { class: 'btn ghost', onclick: () => { clearFilters(tid); rerender(); } }, `Clear filters (${nFilters})`) : null),
        rows.length ? h('div', { class: 'tablewrap tall', 'data-scroll': tid },
          xtable({ id: tid, columns, allRows: rows, rows: shown, rerender, defaultSort: { key: 'to', dir: 'desc' }, className: 'natural plain-cells',
            showTotals: prefTotals(tid), onToggleTotals: (on) => { setPrefTotals(tid, on); rerender(); }, totalsLabel: (rs, all) => (rs.length === all.length ? 'Total' : `Total (${rs.length} of ${all.length})`) }))
          : h('div', { class: 'panel empty' }, 'Count an item twice on Cycle Counts to see its actual usage here.'));
    }

    // By month
    const years = derived.years();
    if (!years.includes(year)) year = years.includes(new Date().getFullYear()) ? new Date().getFullYear() : years.at(-1);
    const byMonth = C.usageByMonth(state.data, year);
    const rows = mats.map((item) => { const q = byMonth.get(item.item_no) || Array(12).fill(0); const c = cm.cost(item.item_no, year) || cm.latest(item.item_no); return { item, q, d: q.map((v) => v * c), cost: c }; });
    const val = (r, m) => (show === 'qty' ? r.q[m] : r.d[m]);
    const tot = (r) => (show === 'qty' ? r.q : r.d).reduce((s, v) => s + v, 0);
    const cell = (v, extra = '') => (show === 'qty' ? h('td', { class: 'num ' + extra }, v ? qty(v, 1) : '') : acctCell(v, { class: extra }));
    const columns = [
      { key: 'name', label: 'Item', sticky: true, value: (r) => r.item.name, cell: (r) => h('td', { class: 'sticky-col' }, r.item.name) },
      { key: 'type', label: 'Type', value: (r) => (r.item.type === 'Component' ? 'Packaging' : r.item.type), cell: (r) => h('td', null, typePill(r.item.type)) },
      { key: 'unit', label: 'Unit', value: (r) => r.item.unit || '', cell: (r) => h('td', { class: 'muted' }, show === 'qty' ? r.item.unit || '' : '$') },
      ...C.MONTHS.map((m, i) => ({ key: `m${i}`, label: m, num: true, value: (r) => val(r, i), text: (r) => (show === 'qty' ? qty(val(r, i), 1) : money(val(r, i))),
        cell: (r) => cell(val(r, i)), total: (rs) => (show === 'qty' ? '' : money(rs.reduce((s, r) => s + r.d[i], 0))) })),
      { key: 'total', label: 'Total', num: true, value: (r) => tot(r), text: (r) => (show === 'qty' ? qty(tot(r), 1) : money(tot(r))), cell: (r) => cell(tot(r), 'strong'),
        total: (rs) => (show === 'qty' ? '' : money(rs.reduce((s, r) => s + r.d.reduce((a, v) => a + v, 0), 0))) },
    ];
    const tid = 'cons-month';
    const shown = filteredRows({ id: tid, columns, rows });
    const nFilters = activeFilterCount(tid);
    return h('div', null,
      pageHead('Consumption', `Standard usage of each raw material and packaging item by month: the cases produced times what each product’s BOM uses. ${show === 'qty' ? 'In each item’s unit.' : `In dollars at the ${year} standard cost.`} Count to count compares it with actual usage from cycle counts.`,
        switcher, seg([['qty', 'Quantity'], ['dollars', 'Dollars']], show, (s) => { show = s; rerender(); }),
        yearSelect(years, year, (y) => { year = y; rerender(); }),
        downloadButton(`consumption-${year}-${show}`, columns, shown),
        nFilters ? h('button', { class: 'btn ghost', onclick: () => { clearFilters(tid); rerender(); } }, `Clear filters (${nFilters})`) : null),
      h('div', { class: 'tablewrap tall', 'data-scroll': tid },
        xtable({ id: tid, columns, allRows: rows, rows: shown, rerender, className: 'natural plain-cells',
          showTotals: show === 'dollars' && prefTotals(tid), onToggleTotals: show === 'dollars' ? (on) => { setPrefTotals(tid, on); rerender(); } : null,
          totalsLabel: () => 'Total $' })));
  },
};
