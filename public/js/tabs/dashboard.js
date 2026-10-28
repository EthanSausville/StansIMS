import { h, pageHead, money, pct, yearSelect, todayIso, qty } from '../ui.js';
import { state, derived } from '../store.js';
import { dashboard, MONTHS } from '../calc.js';
import { barChart, hbarChart } from '../charts.js';
import { stat } from './production.js';

const t = todayIso();
let year = Number(t.slice(0, 4));
let month = Number(t.slice(5, 7));

export default {
  id: 'dashboard',
  label: 'Dashboard',
  render({ rerender }) {
    const years = derived.years();
    if (!years.includes(year)) year = years.at(-1);
    const d = dashboard(state.data, year, month);
    const ix = derived.ix(); const inv = derived.inventory(); const pd = derived.demand();
    const items = [...ix.byType('Raw Material'), ...ix.byType('Component')];
    const orderNow = items.filter((it) => pd.get(it.item_no)?.suggestions.get(t));
    const negative = [...items, ...ix.byType('Finished Good')].filter((it) => (inv.byItem.get(it.item_no)?.get(t) ?? 0) < 0);
    const hasSales = d.totalSales !== 0;
    // Draw charts at the size they'll be shown, so text stays readable.
    const full = Math.max(300, Math.min(1560, window.innerWidth - (window.innerWidth <= 520 ? 54 : 72)));
    const half = window.innerWidth >= 900 ? Math.floor((full - 16) / 2) : full;
    const panel = (title, body, legend) => h('div', { class: 'panel' }, h('h2', null, title), legend || null, h('div', { class: 'body chart' }, body));

    return h('div', null,
      pageHead(`${year} Management Dashboard`, `Year to date through ${MONTHS[month - 1][0]}${MONTHS[month - 1].slice(1).toLowerCase()}.`,
        yearSelect(years, year, (y) => { year = y; rerender(); }),
        h('label', { class: 'field' }, 'Through', h('select', { onchange: (e) => { month = Number(e.target.value); rerender(); } },
          MONTHS.map((m, i) => h('option', { value: i + 1, selected: i + 1 === month }, m))))),
      orderNow.length ? h('div', { class: 'note warn' }, `Purchase suggested today: ${orderNow.map((it) => `${it.name} (${qty(pd.get(it.item_no).suggestions.get(t))} ${it.unit})`).join(', ')}. See Purchase Demand.`) : null,
      negative.length ? h('div', { class: 'note warn' }, `${negative.length} item${negative.length > 1 ? 's show' : ' shows'} negative inventory today. Enter missing deliveries on Goods Receipt, or do a cycle count.`) : null,
      h('div', { class: 'cards' },
        stat('Sales', money(d.totalSales, 0)),
        stat('Standard margin', money(d.totalMargin, 0), hasSales ? pct(d.marginPct) + ' of sales' : null),
        stat('Estimated lost inventory', money(d.totalLoss, 0), 'From partial batches'),
        stat('Cases produced', qty(state.data.production.filter((p) => p.date.startsWith(String(year)) && Number(p.date.slice(5, 7)) <= month).reduce((s, p) => s + p.cases, 0)))),
      panel(`${year} YTD Sales & Margin`,
        barChart({ width: full, height: Math.min(340, Math.max(240, full * 0.3)), title: 'Sales and margin by month', labels: d.byMonth.map((m) => m.month),
          series: [{ name: 'Sales', values: d.byMonth.map((m) => m.sales), cls: 'bar-a' }, { name: 'Margin', values: d.byMonth.map((m) => m.margin), cls: 'bar-b' }],
          line: { values: d.byMonth.map((m) => m.marginPct), show: d.byMonth.map((m) => m.sales > 0) } }),
        h('div', { class: 'legend' }, h('span', null, h('i', { style: { background: 'var(--accent)' } }), 'Sales'),
          h('span', null, h('i', { style: { background: 'var(--accent-2)' } }), 'Margin'),
          h('span', null, h('i', { style: { background: 'var(--ink)', height: '2px', verticalAlign: '3px' } }), 'Margin %'))),
      h('div', { class: 'grid2', style: { marginTop: '16px' } },
        panel(`${year} YTD Sales by Product`, d.byProduct.length ? hbarChart({ width: half, rows: d.byProduct, title: 'Sales by product' }) : h('div', { class: 'empty' }, 'No sales yet.')),
        panel(`${year} YTD Sales by Customer`, d.byCustomer.length ? hbarChart({ width: half, rows: d.byCustomer, title: 'Sales by customer' }) : h('div', { class: 'empty' }, 'No sales yet.'))),
      h('div', { style: { marginTop: '16px' } },
        panel(`${year} Minimum Lost Inventory`, barChart({ width: full, title: 'Estimated loss by month', labels: d.loss.map((m) => m.month), series: [{ name: 'Estimated loss', values: d.loss.map((m) => m.loss), cls: 'bar-a' }], height: 220 }))));
  },
};
