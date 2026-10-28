// Sales summaries: one row per customer (or product), one column per month,
// for the chosen year and measure. Built from the same lines as Invoices.
import { h, pageHead, money, qty, pct, seg, yearSelect } from '../ui.js';
import { derived } from '../store.js';
import { MONTHS } from '../calc.js';

const MEASURES = [
  ['amount', 'Sales $', (r) => Number(r.amount) || 0, (v) => money(v, 0)],
  ['cases', 'Cases', (r) => (r.item_no ? Number(r.quantity) || 0 : 0), (v) => qty(v, 0)],
  ['margin', 'Std margin $', (r) => r.stdMargin, (v) => money(v, 0)],
];

function summaryTab({ id, label, title, keyOf, description, colLabel }) {
  let year = new Date().getFullYear();
  let measure = 'amount';
  return {
    id, label,
    render({ rerender }) {
      const all = derived.sales();
      const years = [...new Set([...derived.years(), ...all.map((r) => r.year)])].sort((a, b) => a - b);
      if (!years.includes(year)) year = years.at(-1);
      const [, mLabel, valueOf, show] = MEASURES.find((m) => m[0] === measure);
      const rows = all.filter((r) => r.year === year);
      const table = new Map();
      for (const r of rows) {
        const k = keyOf(r);
        if (!table.has(k)) table.set(k, { key: k, months: Array(12).fill(0), total: 0, sales: 0, margin: 0 });
        const t = table.get(k); const v = valueOf(r);
        t.months[r.month - 1] += v; t.total += v; t.sales += Number(r.amount) || 0; t.margin += r.stdMargin;
      }
      const list = [...table.values()].sort((a, b) => b.total - a.total || String(a.key).localeCompare(String(b.key)));
      const monthTotals = MONTHS.map((_, m) => list.reduce((s, t) => s + t.months[m], 0));
      const grand = monthTotals.reduce((s, v) => s + v, 0);
      const lastMonth = Math.max(0, ...rows.map((r) => r.month));
      const months = MONTHS.slice(0, Math.max(lastMonth, 1));
      const cell = (v) => h('td', { class: 'num' + (v < 0 ? ' neg' : '') + (v ? '' : ' muted') }, v ? show(v) : '–');
      return h('div', null,
        pageHead(title, description,
          seg(MEASURES.map(([k, l]) => [k, l]), measure, (m) => { measure = m; rerender(); }),
          yearSelect(years, year, (y) => { year = y; rerender(); })),
        list.length ? h('div', { class: 'tablewrap', 'data-scroll': id }, h('table', { class: 't' },
          h('thead', null, h('tr', null, h('th', { class: 'sticky-col' }, colLabel), months.map((m) => h('th', { class: 'num' }, m)),
            h('th', { class: 'num' }, `Total ${mLabel.toLowerCase()}`), h('th', { class: 'num' }, 'Share'), h('th', { class: 'num' }, 'Margin %'))),
          h('tbody', null, list.map((t) => h('tr', null, h('td', { class: 'sticky-col' }, t.key),
            months.map((_, m) => cell(t.months[m])),
            h('td', { class: 'num strong' }, show(t.total)), h('td', { class: 'num muted' }, grand ? pct(t.total / grand) : ''),
            h('td', { class: 'num muted' }, t.sales ? pct(t.margin / t.sales) : '')))),
          h('tfoot', null, h('tr', null, h('td', { class: 'sticky-col' }, 'Total'), months.map((_, m) => cell(monthTotals[m])),
            h('td', { class: 'num' }, show(grand)), h('td', { class: 'num' }, grand ? '100%' : ''),
            h('td', { class: 'num' }, (() => { const s = list.reduce((a, t) => a + t.sales, 0); const mg = list.reduce((a, t) => a + t.margin, 0); return s ? pct(mg / s) : ''; })())))))
          : h('div', { class: 'panel empty' }, `No sales in ${year}.`));
    },
  };
}

export const byCustomer = summaryTab({
  id: 'sales-customers', label: 'By Customer', title: 'Sales by Customer', colLabel: 'Customer',
  keyOf: (r) => r.customer || '(no customer)',
  description: 'Each customer by month. Switch between sales dollars, cases and standard margin. Fees and credits (product “Other”) count toward sales dollars.',
});

export const byProduct = summaryTab({
  id: 'sales-products', label: 'By Product', title: 'Sales by Product', colLabel: 'Product',
  keyOf: (r) => r.product || 'Other',
  description: 'Each product by month. Switch between sales dollars, cases and standard margin. “Other” is fees, credits and promotions.',
});
