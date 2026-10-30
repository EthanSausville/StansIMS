// A month of days down the side and items across the top, like the daily
// sheets in the workbook (Production, GoodsReceipt, CycleCounts, ...).
import { h, numberCell, dateLabel, qty, todayIso } from '../ui.js';
import { eachDay, isWeekend, monthEnd, hasReceiving, holdsLabel } from '../calc.js';

const perLabel = (it) => (hasReceiving(it) ? `1 ${it.receiving_unit} = ${holdsLabel(it)}` : '');
import { totalsFoot } from '../xtable.js';

export const monthDays = ({ year, month }) => [...eachDay(`${year}-${String(month).padStart(2, '0')}-01`, monthEnd(year, month))];

// Header rows: item type, item name, and (optionally) pack size notes.
// `before`/`after` are extra calculated column labels.
export function itemHead(items, { before = [], after = [], notes = true, firstLabel = 'Date' } = {}) {
  const groups = []; for (const it of items) { const g = groups.at(-1); if (g && g.type === it.type) g.n++; else groups.push({ type: it.type, n: 1 }); }
  const pad = (n) => Array.from({ length: n }, () => h('th'));
  const rows = [
    h('tr', { class: 'group' }, h('th', { class: 'sticky-col' }), pad(before.length), groups.map((g) => h('th', { colspan: g.n }, g.type === 'Component' ? 'Packaging' : g.type)), pad(after.length)),
    h('tr', null, h('th', { class: 'sticky-col' }, firstLabel), before.map((b) => h('th', { class: 'num wrap' }, b)),
      items.map((it) => h('th', { class: 'num wrap', title: `${it.name} · #${it.item_no}${it.unit ? ' · ' + it.unit : ''}` }, it.name)),
      after.map((b) => h('th', { class: 'num wrap' }, b))),
  ];
  if (notes) rows.push(h('tr', null, h('th', { class: 'sticky-col' }), pad(before.length),
    items.map((it) => h('th', { class: 'num' }, perLabel(it) || it.pack_note || it.unit || '')), pad(after.length)));
  return h('thead', null, rows);
}

// Editable month grid backed by one keyed table (date, item_no, field).
//   before(date) / after(date): arrays of <td> for calculated columns
//   cellClass(date, item): extra class for a cell (e.g. a warning outline)
export function entryGrid({ table, field, items, ym, editable, before, after, beforeLabels = [], afterLabels = [], cellClass, rows, notes = true, footer = true, digits = 4, rerender }) {
  const values = new Map(rows.map((r) => [`${r.date}|${r.item_no}`, r[field]]));
  const today = todayIso();
  const days = monthDays(ym);
  const totals = items.map(() => 0);
  const body = h('tbody', null, days.map((d) => h('tr', { class: [isWeekend(d) ? 'weekend' : '', d === today ? 'today' : ''].join(' ').trim() || null },
    h('td', { class: 'sticky-col' }, dateLabel(d)),
    before ? before(d) : null,
    items.map((it, i) => {
      const v = values.get(`${d}|${it.item_no}`);
      if (typeof v === 'number') totals[i] += v;
      return numberCell(v ?? null, (nv) => editable.save(d, it.item_no, nv), {
        disabled: !editable.allowed, digits, key: `${table}|${d}|${it.item_no}`,
        title: `${it.name}, ${d}`, cls: cellClass ? cellClass(d, it) : null });
    }),
    after ? after(d) : null)));
  const foot = footer ? totalsFoot({ id: `grid-${table}`, rerender, width: 1 + beforeLabels.length + items.length + afterLabels.length,
    label: 'Month total', cells: [beforeLabels.map(() => h('td')), totals.map((t) => h('td', { class: 'num' }, t ? qty(t, 2) : '')), afterLabels.map(() => h('td'))] }) : null;
  return h('div', { class: 'tablewrap tall', 'data-scroll': table },
    h('table', { class: 't' }, itemHead(items, { before: beforeLabels, after: afterLabels, notes }), body, foot));
}

// Read-only month grid: value(date, item) -> number|null.
export function viewGrid({ id, items, ym, value, cellClass, before, beforeLabels = [], notes = true, digits = 2, footer }) {
  const today = todayIso();
  return h('div', { class: 'tablewrap tall', 'data-scroll': id },
    h('table', { class: 't' }, itemHead(items, { before: beforeLabels, notes }),
      h('tbody', null, monthDays(ym).map((d) => h('tr', { class: [isWeekend(d) ? 'weekend' : '', d === today ? 'today' : ''].join(' ').trim() || null },
        h('td', { class: 'sticky-col' }, dateLabel(d)),
        before ? before(d) : null,
        items.map((it) => {
          const v = value(d, it);
          const cls = ['num', v === null || v === undefined ? 'blank' : '', typeof v === 'number' && v < 0 ? 'neg' : '', cellClass ? cellClass(d, it, v) : ''].join(' ');
          return h('td', { class: cls }, v === null || v === undefined ? '' : qty(v, digits));
        })))),
      footer || null));
}

// The month shown on the daily tabs, shared so switching tabs keeps your place.
export const view = { ym: { year: Number(todayIso().slice(0, 4)), month: Number(todayIso().slice(5, 7)) } };
