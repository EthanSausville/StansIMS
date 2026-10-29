// Cycle counts: the month grid of counts, and a count sheet for one day that
// shows what the running inventory expects next to what was counted.
import { h, pageHead, monthPicker, longDate, seg, qty, todayIso, acctCell, chip, toast, niceError } from '../ui.js';
import { state, derived, saveCell } from '../store.js';
import { entryGrid, view, monthDays } from './grid.js';
import { countSheet, COUNT_TOLERANCE, yearOf, hasReceiving, splitReceiving, unitWord, evalEntry } from '../calc.js';

let mode = 'sheet';
let checking = false; // show expected and differences (for whoever reviews the count); off while counting

// Counting an item that comes in boxes / bags / cases: full ones, plus what's
// loose in the base unit (12 boxes + 15 lb of cheese = 375 lb).
function boxCountCell(item, value, save) {
  const per = Number(item.units_per_receiving);
  const sp = splitReceiving(item, value);
  const full = h('input', { type: 'text', inputmode: 'decimal', class: 'cnt-full', value: sp ? sp.full : '', 'data-k': `csf|${item.item_no}`, 'aria-label': `Full ${unitWord(item.receiving_unit)} of ${item.name}` });
  const loose = h('input', { type: 'text', inputmode: 'decimal', class: 'cnt-loose', value: sp && sp.loose ? sp.loose : '', 'data-k': `csl|${item.item_no}`, 'aria-label': `Loose ${unitWord(item.unit)} of ${item.name}` });
  const total = h('span', { class: 'cnt-total' });
  const read = () => { const f = full.value.trim(); const l = loose.value.trim(); if (!f && !l) return null; return (evalEntry(f || '0') || 0) * per + (evalEntry(l || '0') || 0); };
  const show = () => { try { const v = read(); total.textContent = v === null ? '' : `= ${qty(v, 2)} ${unitWord(item.unit, v)}`; full.classList.remove('error'); loose.classList.remove('error'); } catch { total.textContent = 'Numbers only'; } };
  const commit = async () => { let v; try { v = read(); } catch (err) { (full.value && Number.isNaN(Number(full.value)) ? full : loose).classList.add('error'); toast(err.message, 'bad'); return; }
    if ((v ?? null) === (value ?? null)) return; try { await save(v); } catch (err) { toast(niceError(err), 'bad'); } };
  for (const el of [full, loose]) { el.addEventListener('input', show); el.addEventListener('change', commit); }
  show();
  return h('td', { class: 'cnt-box' }, h('div', { class: 'cnt-line' }, full, h('span', { class: 'cnt-u' }, `full ${unitWord(item.receiving_unit)}`), h('span', { class: 'cnt-plus' }, '+'), loose, h('span', { class: 'cnt-u' }, `${unitWord(item.unit)} loose`)), total);
}
// Counting an item that's only counted in its base unit.
function plainCountCell(item, value, save) {
  const input = h('input', { type: 'text', inputmode: 'decimal', class: 'cnt-full', value: value ?? '', 'data-k': `cs|${item.item_no}`, 'aria-label': `${item.name} counted` });
  input.addEventListener('change', async () => { let v; try { v = input.value.trim() ? evalEntry(input.value) : null; input.classList.remove('error'); } catch (err) { input.classList.add('error'); toast(err.message, 'bad'); return; }
    if ((v ?? null) === (value ?? null)) return; try { await save(v); } catch (err) { toast(niceError(err), 'bad'); } });
  return h('td', { class: 'cnt-box' }, h('div', { class: 'cnt-line' }, input, h('span', { class: 'cnt-u' }, unitWord(item.unit) || 'each')));
}
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
        if (r.item.type !== group) { group = r.item.type; body.push(h('tr', { class: 'grp' }, h('td', { colspan: checking ? 7 : 3 }, group === 'Component' ? 'Packaging' : group === 'Finished Good' ? 'Finished goods (cases)' : 'Raw materials'))); }
        const std = cm.cost(r.item.item_no, yearOf(sheetDate)) || cm.latest(r.item.item_no);
        const saveIt = (v) => saveCell('cycle_counts', { date: sheetDate, item_no: r.item.item_no }, 'qty', v);
        body.push(h('tr', { class: checking && r.flag ? 'flagged' : null },
          h('td', { class: 'sticky-col cnt-name' }, h('strong', null, r.item.name)),
          h('td', { class: 'muted' }, hasReceiving(r.item) ? `1 ${r.item.receiving_unit} = ${qty(Number(r.item.units_per_receiving))} ${unitWord(r.item.unit, 2)}` : ''),
          hasReceiving(r.item) ? boxCountCell(r.item, r.counted, saveIt) : plainCountCell(r.item, r.counted, saveIt),
          checking ? [
            h('td', { class: 'num' + (r.expected < 0 ? ' neg' : '') }, r.expected === null ? '—' : `${qty(r.expected, 1)} ${unitWord(r.item.unit, 2)}`),
            h('td', { class: 'num' + (r.diff < 0 ? ' neg' : '') }, r.diff === null ? '' : (r.diff > 0 ? '+' : '') + qty(r.diff, 1)),
            h('td', { class: 'num' + (r.flag ? ' neg strong' : '') }, r.pct === null ? '' : `${r.pct > 0 ? '+' : ''}${qty(r.pct * 100, 0)}%`),
            r.diff === null ? h('td') : acctCell(r.diff * std, { class: r.diff < 0 ? 'neg' : '' })] : null));
      }
      return h('div', null,
        pageHead('Count Sheet', `Count what’s on the shelf and type it in: full boxes, bags or cases, plus anything loose. Counts save as you go. The count sheet doesn’t show what the system expects while you count, so the count isn’t steered by it; afterwards, Check counts shows expected vs. counted and flags differences over ${tolerance} (recount those, or look for a delivery or production that wasn’t entered). A count replaces the running inventory for that item from that day on.`,
          switcher,
          h('label', { class: 'field' }, 'Count date', dateInput),
          chip('Counted', `${done} of ${rows.length}`),
          h('button', { class: 'btn' + (checking ? ' primary' : ''), 'aria-pressed': String(checking), onclick: () => { checking = !checking; rerender(); } }, checking ? 'Hide expected' : 'Check counts'),
          checking ? chip(`Off by over ${tolerance}`, flagged) : null),
        busy ? h('div', { class: 'note warn' }, `There’s production or a delivery entered on ${longDate(sheetDate)}. Counts are taken at the start of the day, so count before anything is made or received, or count on another day.`) : null,
        h('div', { class: 'tablewrap', 'data-scroll': 'count-sheet' }, h('table', { class: 't count-sheet' },
          h('thead', null, h('tr', null, h('th', { class: 'sticky-col' }, 'Item'), h('th', null, 'Comes in'), h('th', null, 'How many are there?'),
            checking ? [h('th', { class: 'num' }, 'Expected'), h('th', { class: 'num' }, 'Difference'), h('th', { class: 'num' }, '%'), h('th', { class: 'num' }, 'At standard')] : null)),
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
