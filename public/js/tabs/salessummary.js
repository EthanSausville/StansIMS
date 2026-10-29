// Sales summaries: one row per customer (or product), one column per month,
// for the chosen year and measure. Built from the same lines as Invoices.
import { h, pageHead, money, qty, pct, seg, yearSelect, acctParts } from '../ui.js';
import { derived } from '../store.js';
import { xtable, filteredRows, prefTotals, setPrefTotals, activeFilterCount, clearFilters, downloadButton } from '../xtable.js';
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
      const years = derived.years();
      if (!years.includes(year)) year = years.includes(new Date().getFullYear()) ? new Date().getFullYear() : years.at(-1);
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
      const isMoney = measure !== 'cases';
      const cell = (v) => h('td', { class: 'num' + (isMoney ? ' acct' : '') + (v < 0 ? ' neg' : '') + (v ? '' : ' muted') }, v ? (isMoney ? acctParts(v) : show(v)) : '–');
      const sum = (rs, f) => rs.reduce((acc, t) => acc + f(t), 0);
      const columns = [
        { key: 'key', label: colLabel, sticky: true, value: (t) => t.key, cell: (t) => h('td', { class: 'sticky-col' }, t.key) },
        ...months.map((m, i) => ({ key: `m${i}`, label: m, num: true, value: (t) => t.months[i], text: (t) => (t.months[i] ? show(t.months[i]) : '–'),
          cell: (t) => cell(t.months[i]), total: (rs) => { const v = sum(rs, (t) => t.months[i]); return v ? (isMoney ? acctParts(v) : show(v)) : '–'; } })),
        { key: 'total', label: `Total ${mLabel.toLowerCase()}`, num: true, value: (t) => t.total, text: (t) => show(t.total),
          cell: (t) => h('td', { class: 'num strong' + (isMoney ? ' acct' : '') }, isMoney ? acctParts(t.total) : show(t.total)), total: (rs) => (isMoney ? acctParts(sum(rs, (t) => t.total)) : show(sum(rs, (t) => t.total))) },
        { key: 'share', label: 'Share', num: true, value: (t) => (grand ? t.total / grand : 0), text: (t) => (grand ? pct(t.total / grand) : ''),
          cell: (t) => h('td', { class: 'num muted' }, grand ? pct(t.total / grand) : ''), total: (rs) => (grand ? pct(sum(rs, (t) => t.total) / grand) : '') },
        { key: 'mpct', label: 'Margin %', num: true, value: (t) => (t.sales ? t.margin / t.sales : null), text: (t) => (t.sales ? pct(t.margin / t.sales) : ''),
          cell: (t) => h('td', { class: 'num muted' }, t.sales ? pct(t.margin / t.sales) : ''),
          total: (rs) => { const sl = sum(rs, (t) => t.sales); return sl ? pct(sum(rs, (t) => t.margin) / sl) : ''; } },
      ];
      const tid = `${id}-${year}-${measure}`;
      const sort = { key: 'total', dir: 'desc' };
      const shown = filteredRows({ id: tid, columns, rows: list, defaultSort: sort });
      const nFilters = activeFilterCount(tid);
      return h('div', null,
        pageHead(title, description,
          seg(MEASURES.map(([k, l]) => [k, l]), measure, (m) => { measure = m; rerender(); }),
          yearSelect(years, year, (y) => { year = y; rerender(); }),
          nFilters ? h('button', { class: 'btn ghost', onclick: () => { clearFilters(tid); rerender(); } }, `Clear filters (${nFilters})`) : null,
          list.length ? downloadButton(`${id}-${year}-${measure}`, columns, shown) : null),
        list.length ? h('div', { class: 'tablewrap', 'data-scroll': id },
          xtable({ id: tid, columns, allRows: list, rows: shown, rerender, defaultSort: sort, showTotals: prefTotals(id),
            onToggleTotals: (on) => { setPrefTotals(id, on); rerender(); }, totalsLabel: (rs, all) => (rs.length === all.length ? 'Total' : `Total (${rs.length} of ${all.length})`) }))
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
