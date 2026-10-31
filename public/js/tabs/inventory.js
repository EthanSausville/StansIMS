// Inventory:
//   Daily    every item's running balance, newest day first (like Production →
//            Daily). A day with a cycle count gets two more rows: what was
//            counted and the adjustment (count − what the running inventory
//            expected). A start-of-day count sits below its day (it came before
//            the day's deliveries and production), an end-of-day count above it.
//   Monthly  each month's last day, in quantity or at standard cost.
import { h, pageHead, seg, yearSelect, qty, typePill, todayIso, dateLabel, acctParts, thisYear, itemNoCol } from '../ui.js';
import { state, derived } from '../store.js';
import { endlessDays, dayRowClass } from './grid.js';
import { nameParts } from './production.js';
import { xtable, filteredRows, prefTotals, setPrefTotals, activeFilterCount, clearFilters, downloadButton } from '../xtable.js';
import { downloadXlsx } from '../xlsx.js';
import * as C from '../calc.js';

let year = thisYear();
let show = 'qty';

const trackedItems = () => { const ix = derived.ix(); return [...ix.byType('Raw Material'), ...ix.byType('Component'), ...ix.byType('Finished Good')]; };
function belowZero(inv, tracked) {
  const today = todayIso();
  const negatives = tracked.filter((it) => (inv.byItem.get(it.item_no)?.get(today) ?? 0) < 0);
  return [
    !inv.from ? h('div', { class: 'note info' }, 'Inventory starts from each item’s first cycle count. Enter a count on Count to begin.') : null,
    negatives.length ? h('div', { class: 'note warn' }, `${negatives.length} item${negatives.length > 1 ? 's are' : ' is'} below zero today (${negatives.map((i) => i.name).join(', ')}). Usually that means deliveries haven’t been entered on Receive, or a count is due.`) : null,
  ];
}
// Header: finished goods are recipe / size / case, like Production → Daily;
// materials and packaging just their name (the unit is in each cell).
const headLines = (it) => (it.type === 'Finished Good' ? nameParts(it) : [it.name, '', '']);
const unitOf = (it, v) => (it.type === 'Finished Good' ? (Math.abs(v) === 1 ? 'case' : 'cases') : C.unitWord(it.unit, v) || 'each');
const whole = (v) => Math.round(v) || 0; // no "-0"
const amount = (it, v) => `${qty(whole(v), 0)} ${unitOf(it, whole(v))}`;
const signed = (it, v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${amount(it, Math.abs(v))}`;
const openDays = new Set(); // days whose detail is showing

function exportDaily(tracked, inv, allDays) {
  const lines = tracked.map(headLines);
  const rows = [['Date', ...lines.map((l) => l[0])], ['', ...lines.map((l) => l[1])], ['', ...lines.map((l) => l[2])],
    ...allDays.map((d) => [{ date: d }, ...tracked.map((it) => inv.byItem.get(it.item_no)?.get(d) ?? null)])];
  const counts = [['Date', 'Counted at', 'Item #', 'Item', 'Expected', 'Counted', 'Adjustment']];
  for (const [k, a] of [...inv.adjust].sort((x, y) => (x[0].split('|')[1] < y[0].split('|')[1] ? 1 : -1))) {
    const [no, d] = k.split('|'); const it = tracked.find((t) => t.item_no === +no);
    counts.push([{ date: d }, a.timing === 'end' ? 'End of day' : 'Start of day', +no, it?.name || '', a.expected, a.counted, a.adj]);
  }
  downloadXlsx(`inventory-${todayIso()}`, [
    { name: 'Daily inventory', rows, headRows: 3, freezeCols: 1, widths: [12, ...tracked.map(() => 13)] },
    { name: 'Counts', rows: counts, widths: [12, 12, 9, 30, 12, 12, 12] },
  ]);
}

export default {
  id: 'inventory',
  label: 'Daily',
  render() {
    const inv = derived.inventory(); const tracked = trackedItems(); const today = todayIso();
    const groupStart = new Set(tracked.filter((it, i) => i > 0 && tracked[i - 1].type !== it.type).map((it) => it.item_no));
    const gcls = (it, c = '') => [c, groupStart.has(it.item_no) ? 'grp-start' : ''].join(' ').trim() || null;
    const countDays = new Map(); // date -> Set of timings
    for (const c of state.data.cycle_counts) { if (!countDays.has(c.date)) countDays.set(c.date, new Set()); countDays.get(c.date).add(C.countTiming(c)); }
    const timingWord = (t) => (t === 'end' ? 'end of day' : 'start of day');

    // A day's detail: its count (blue) and adjustment, what came in (green, +)
    // and what went out (red, −). Newest first: an end-of-day count came after
    // the day (above it); the day's movements and a start-of-day count came
    // before its closing balance (below it).
    const detailRow = (d, cls, label, sub, valueOf) => h('tr', { class: `inv-detail ${cls}`, 'data-detail': d },
      h('td', { class: 'sticky-col flag-col' }), h('td', { class: 'sticky-col date-col' }, h('span', { class: 'row-tag' }, label), sub ? h('span', { class: 'small muted' }, ` ${sub}`) : null),
      tracked.map((it) => { const r = valueOf(it); return h('td', { class: gcls(it, ['num', r?.cls || ''].join(' ')), title: r?.title || null }, r ? r.text : ''); }));
    const countBlock = (d, t) => {
      const a = (it) => { const x = inv.adjust.get(`${it.item_no}|${d}`); return x && x.timing === t ? x : null; };
      return [
        detailRow(d, 'count-row', 'Count', timingWord(t), (it) => { const x = a(it); return x ? { text: amount(it, x.counted), cls: 'counted' } : null; }),
        detailRow(d, 'adj-row', 'Adjustment', timingWord(t), (it) => { const x = a(it); if (!x) return null;
          if (x.adj === null) return { text: 'start', cls: 'muted', title: 'First count: it starts this item’s inventory' };
          const v = whole(x.adj); return { text: signed(it, v), cls: v > 0 ? 'up' : v < 0 ? 'down' : 'muted', title: `Expected ${amount(it, x.expected)}, counted ${amount(it, x.counted)}` }; }),
      ];
    };
    const MOVES = [['received', 'Received', 1], ['produced', 'Produced', 1], ['used', 'Used in production', -1], ['sold', 'Sold', -1]];
    const detailRows = (d) => {
      const ts = countDays.get(d) || new Set();
      const above = ts.has('end') ? countBlock(d, 'end') : [];
      const below = [];
      for (const [k, label, sign] of MOVES) {
        const vals = new Map(tracked.map((it) => [it.item_no, inv.moves.get(`${it.item_no}|${d}`)?.[k] || 0]));
        if (![...vals.values()].some((v) => Math.abs(v) > 1e-9)) continue;
        below.push(detailRow(d, sign > 0 ? 'in-row' : 'out-row', label, null, (it) => { const v = vals.get(it.item_no); return Math.abs(v) > 1e-9 ? { text: signed(it, sign * v), cls: sign > 0 ? 'up' : 'down' } : null; }));
      }
      if (ts.has('start')) below.push(...countBlock(d, 'start'));
      if (!above.length && !below.length) below.push(h('tr', { class: 'inv-detail none-row', 'data-detail': d }, h('td', { class: 'sticky-col flag-col' }),
        h('td', { class: 'sticky-col date-col' }, h('span', { class: 'small muted' }, 'Nothing received, made, used, sold or counted')), tracked.map((it) => h('td', { class: gcls(it) }))));
      return { above, below };
    };
    const toggle = (tr, d) => {
      const body = tr.parentElement;
      if (openDays.has(d)) { openDays.delete(d); body.querySelectorAll(`tr[data-detail="${d}"]`).forEach((r) => r.remove()); tr.setAttribute('aria-expanded', 'false'); return; }
      openDays.add(d); const { above, below } = detailRows(d);
      tr.before(...above); tr.after(...below); tr.setAttribute('aria-expanded', 'true');
    };

    const cell = (it, v) => h('td', { class: gcls(it, ['num', v === undefined || v === null ? 'blank' : '', typeof v === 'number' && whole(v) < 0 ? 'neg' : ''].join(' ')) }, v === undefined || v === null ? '' : amount(it, v));
    // Header: a band per kind of item (the yellow lines), then the names.
    const groups = []; for (const it of tracked) { const g = groups.at(-1); if (g && g.type === it.type) g.n++; else groups.push({ type: it.type, n: 1 }); }
    const head = h('thead', null,
      h('tr', { class: 'group' }, h('th', { class: 'sticky-col', colspan: 2 }),
        groups.map((g) => h('th', { colspan: g.n }, h('span', { class: 'band-label' }, g.type === 'Component' ? 'Packaging' : g.type === 'Raw Material' ? 'Raw Materials' : 'Finished Goods')))),
      h('tr', { class: 'fg-head' }, h('th', { class: 'sticky-col flag-col', title: 'A cycle count was entered that day' }, ''), h('th', { class: 'sticky-col date-col' }, 'Date'),
        tracked.map((it) => { const [a, b, c] = headLines(it); return h('th', { class: gcls(it, 'num fg-name'), title: `${it.name} · #${it.item_no}` },
          h('span', { class: 'fg-recipe' }, a), b ? h('span', { class: 'fg-size' }, b) : null, c ? h('span', { class: 'fg-pack' }, c) : null); })));
    const { allDays, list } = endlessDays({ id: 'inv-daily', tableClass: 'prod-table inv-daily', head, lead: 2,
      monthCells: () => tracked.map((it) => h('td', { class: gcls(it) })),
      dayRows: (d) => {
        const ts = countDays.get(d);
        const flag = ts ? h('span', { class: 'count-flag', title: `Cycle count (${[...ts].map(timingWord).join(' and ')})` }, '●') : null;
        const tr = h('tr', { class: [dayRowClass(d, today), 'inv-day'].filter(Boolean).join(' '), 'data-day': d, 'aria-expanded': String(openDays.has(d)), title: 'Click to see what came in, went out and was counted',
          onclick: (e) => toggle(e.currentTarget, d) },
          h('td', { class: 'sticky-col flag-col' }, flag), h('td', { class: 'sticky-col date-col' }, dateLabel(d)), tracked.map((it) => cell(it, inv.byItem.get(it.item_no)?.get(d))));
        if (!openDays.has(d)) return tr;
        const { above, below } = detailRows(d);
        return [above, tr, below];
      } });
    const top = h('div', { class: 'prod-top' },
      h('span', { class: 'small muted' }, 'Click a day to see its count, what came in and what went out.'),
      h('button', { class: 'btn ghost download', title: 'Download every day’s inventory, and every count with its adjustment, as an Excel workbook', onclick: () => exportDaily(tracked, inv, allDays) }, '⤓ Export to Excel'));
    return h('div', null,
      pageHead('Daily', 'Running balance for each item, newest day first: the latest cycle count, plus deliveries, minus what production used. Finished goods add cases produced and subtract cases sold. Click a day to see its count (blue), what came in (green) and what went out (red).'),
      top, belowZero(inv, tracked), list);
  },
};

export const monthlyTab = {
  id: 'monthly',
  label: 'Monthly',
  render({ rerender }) {
    const inv = derived.inventory(); const tracked = trackedItems(); const today = todayIso();
    // Month-end (the workbook's EndingInventory$ sheet)
    const years = derived.years();
    if (!years.includes(year)) year = years.includes(thisYear()) ? thisYear() : years.at(-1);
    const rows = C.endingInventory(state.data, inv, year);
    const monthIdx = [...Array(12).keys()];
    const totals = (type) => monthIdx.map((m) => rows.filter((r) => r.item.type === type).reduce((s, r) => s + r.value[m], 0));
    const cellText = (r, m) => { const v = show === 'qty' ? r.qty[m] : r.value[m]; return v ? (show === 'qty' ? qty(v, 1) : acctParts(v)) : ''; };
    const columns = [
      itemNoCol((r) => r.item), { key: 'name', label: 'Item', sticky2: true, value: (r) => r.item.name, cell: (r) => h('td', { class: 'sticky-col sticky-col2' }, r.item.name) },
      { key: 'type', label: 'Type', value: (r) => r.item.type, text: (r) => (r.item.type === 'Component' ? 'Packaging' : r.item.type), cell: (r) => h('td', null, typePill(r.item.type)) },
      { key: 'unit', label: 'Unit', value: (r) => r.item.unit || '', cell: (r) => h('td', { class: 'muted' }, r.item.unit) },
      ...monthIdx.map((m) => ({ key: `m${m}`, label: C.MONTHS[m], num: true, value: (r) => (show === 'qty' ? r.qty[m] : r.value[m]),
        cell: (r) => { const v = show === 'qty' ? r.qty[m] : r.value[m]; const future = C.monthEnd(year, m + 1) > today;
          return h('td', { class: 'num' + (v < 0 ? ' neg' : '') + (future ? ' blank' : '') }, cellText(r, m)); },
        total: (rs) => { const t = rs.reduce((s, r) => s + r.value[m], 0); return t ? acctParts(t) : ''; } })),
    ];
    const tid = 'inv-me';
    const shown = filteredRows({ id: tid, columns, rows });
    const nFilters = activeFilterCount(tid);
    return h('div', null,
      pageHead('Monthly', (show === 'qty' ? 'Inventory on the last day of each month, in each item’s unit.' : 'Month-end inventory valued at standard cost for the year.')
        + ` The totals row is in dollars at the ${year} standard cost (or the latest one entered); filter Type to total one kind of item. Month-ends after today are projections.`),
      h('div', { class: 'prod-top' },
        seg([['qty', 'Quantity'], ['value', 'Value $']], show, (s) => { show = s; rerender(); }),
        yearSelect(years, year, (y) => { year = y; rerender(); }),
        nFilters ? h('button', { class: 'btn ghost', onclick: () => { clearFilters(tid); rerender(); } }, `Clear filters (${nFilters})`) : null,
        downloadButton(`month-end-inventory-${year}-${show}`, columns, shown)),
      h('div', { class: 'tablewrap tall', 'data-scroll': tid },
        xtable({ id: tid, columns, allRows: rows, rows: shown, rerender, showTotals: prefTotals(tid), onToggleTotals: (on) => { setPrefTotals(tid, on); rerender(); },
          totalsLabel: (rs, all) => (rs.length === all.length ? 'Total value ($)' : `Total value, ${rs.length} items ($)`) })));
  },
};
