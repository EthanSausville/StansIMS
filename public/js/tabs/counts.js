// Cycle counts: the month grid of counts, and a count sheet for one day that
// shows what the running inventory expects next to what was counted.
import { h, pageHead, monthPicker, longDate, seg, numberCell, qty, todayIso, acctCell, chip } from '../ui.js';
import { state, derived, saveCell } from '../store.js';
import { entryGrid, view, monthDays } from './grid.js';
import { countSheet, COUNT_TOLERANCE, yearOf } from '../calc.js';

let mode = 'sheet';
let sheetDate = todayIso();

export default {
  id: 'counts',
  label: 'Cycle Counts',
  render({ rerender }) {
    const ix = derived.ix(); const inv = derived.inventory(); const cm = derived.costs();
    const items = [...ix.byType('Raw Material'), ...ix.byType('Component'), ...ix.byType('Finished Good')];
    const prodDays = new Set(state.data.production.map((p) => p.date));
    const receipt = new Set(state.data.goods_receipts.map((r) => `${r.date}|${r.item_no}`));
    const counted = new Set(state.data.cycle_counts.map((c) => `${c.date}|${c.item_no}`));
    const conflict = (d, it) => counted.has(`${d}|${it.item_no}`) && (prodDays.has(d) || receipt.has(`${d}|${it.item_no}`));
    const switcher = seg([['sheet', 'Count sheet'], ['month', 'Month']], mode, (m) => { mode = m; rerender(); });
    const tolerance = `${Math.round(COUNT_TOLERANCE * 100)}%`;

    if (mode === 'sheet') {
      const rows = countSheet(state.data, inv, sheetDate, items);
      const busy = prodDays.has(sheetDate) || state.data.goods_receipts.some((r) => r.date === sheetDate);
      const flagged = rows.filter((r) => r.flag).length;
      const done = rows.filter((r) => r.counted !== null).length;
      const dateInput = h('input', { type: 'date', value: sheetDate, 'aria-label': 'Count date', onchange: (e) => { if (e.target.value) { sheetDate = e.target.value; rerender(); } } });
      let group = null;
      const body = [];
      for (const r of rows) {
        if (r.item.type !== group) { group = r.item.type; body.push(h('tr', { class: 'grp' }, h('td', { colspan: 8 }, group === 'Component' ? 'Packaging' : group))); }
        const std = cm.cost(r.item.item_no, yearOf(sheetDate)) || cm.latest(r.item.item_no);
        body.push(h('tr', { class: r.flag ? 'flagged' : null },
          h('td', { class: 'sticky-col' }, r.item.name),
          h('td', { class: 'muted' }, r.item.pack_note || r.item.unit || ''),
          h('td', { class: 'num' + (r.expected < 0 ? ' neg' : '') }, r.expected === null ? '—' : qty(r.expected, 1)),
          numberCell(r.counted, (v) => saveCell('cycle_counts', { date: sheetDate, item_no: r.item.item_no }, 'qty', v),
            { digits: 4, key: `cs|${r.item.item_no}`, title: `${r.item.name} counted on ${sheetDate}`, placeholder: ' ' }),
          h('td', { class: 'muted' }, r.item.unit || ''),
          h('td', { class: 'num' + (r.diff < 0 ? ' neg' : '') }, r.diff === null ? '' : (r.diff > 0 ? '+' : '') + qty(r.diff, 1)),
          h('td', { class: 'num' + (r.flag ? ' neg strong' : '') }, r.pct === null ? '' : `${r.pct > 0 ? '+' : ''}${qty(r.pct * 100, 0)}%`),
          r.diff === null ? h('td') : acctCell(r.diff * std, { class: r.diff < 0 ? 'neg' : '' })));
      }
      return h('div', null,
        pageHead('Count Sheet', `Count what’s physically on hand and type it in. Expected is the running inventory at the start of the day (the end of the day before). Differences over ${tolerance} are flagged: recount those, or look for a delivery or production that wasn’t entered. A count replaces the running inventory for that item from that day on.`,
          switcher,
          h('label', { class: 'field' }, 'Count date', dateInput),
          chip('Counted', `${done} of ${rows.length}`), chip(`Off by over ${tolerance}`, flagged)),
        busy ? h('div', { class: 'note warn' }, `There’s production or a delivery entered on ${longDate(sheetDate)}. Counts are taken at the start of the day, so count before anything is made or received, or count on another day.`) : null,
        h('div', { class: 'tablewrap', 'data-scroll': 'count-sheet' }, h('table', { class: 't count-sheet' },
          h('thead', null, h('tr', null, h('th', { class: 'sticky-col' }, 'Item'), h('th', null, 'Pack'), h('th', { class: 'num' }, 'Expected'), h('th', { class: 'num' }, 'Counted'), h('th', null, 'Unit'),
            h('th', { class: 'num' }, 'Difference'), h('th', { class: 'num' }, '%'), h('th', { class: 'num' }, 'At standard'))),
          h('tbody', null, body))));
    }

    const days = monthDays(view.ym);
    const clashes = days.filter((d) => items.some((it) => conflict(d, it)));
    // counts far from what the running inventory expected
    const off = new Set();
    for (const d of days) for (const r of countSheet(state.data, inv, d, items)) if (r.flag) off.add(`${d}|${r.item.item_no}`);
    return h('div', null,
      pageHead('Cycle Counts', `What is physically on hand. A count replaces the running inventory for that item from that day on. Finished goods are counted in cases. Count on a day with no production and no deliveries; otherwise that day’s usage and receipts are applied on top of the count. Counts more than ${tolerance} away from the running inventory are outlined in red.`,
        switcher, monthPicker(view.ym, (ym) => { view.ym = ym; rerender(); })),
      clashes.length ? h('div', { class: 'note bad' }, `Counts this month on a day with production or a delivery (outlined below): ${clashes.map(longDate).join(', ')}.`) : null,
      off.size ? h('div', { class: 'note warn' }, `${off.size} count${off.size > 1 ? 's' : ''} this month differ from the running inventory by over ${tolerance} (outlined in red). The Count sheet shows the details.`) : null,
      entryGrid({
        table: 'cycle_counts', field: 'qty', items, ym: view.ym, rows: state.data.cycle_counts, footer: false,
        cellClass: (d, it) => [conflict(d, it) ? 'flag' : '', off.has(`${d}|${it.item_no}`) ? 'off' : ''].join(' ').trim() || null,
        editable: { allowed: true, save: (date, item_no, v) => saveCell('cycle_counts', { date, item_no }, 'qty', v) },
      }));
  },
};
