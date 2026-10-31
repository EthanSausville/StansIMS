// Cycle counts, as two tabs:
//   New Counts  the count sheet for one day: type what's on the shelf (full
//               boxes + loose). Blind: it doesn't show what's expected.
//   All Counts  every count by day (the month grid), and Check a day:
//               expected vs. counted, with differences flagged.
import { h, pageHead, monthPicker, longDate, seg, qty, todayIso, acctCell, chip, toast, niceError, itemNoTh, itemNoTd } from '../ui.js';
import { state, derived, saveCell } from '../store.js';
import { entryGrid, view, monthDays } from './grid.js';
import { can, isClosed, closedNote } from '../perms.js';
import { countSheet, COUNT_TOLERANCE, yearOf, hasReceiving, splitReceiving, unitWord, evalEntry } from '../calc.js';

let mode = 'month'; // All Counts: 'month' or 'check'

// Counting an item that comes in boxes / bags / cases: full ones, plus what's
// loose in the base unit (12 boxes + 15 lb of cheese = 375 lb).
function boxCountCell(item, value, save, locked) {
  const per = Number(item.units_per_receiving);
  const sp = splitReceiving(item, value);
  const full = h('input', { type: 'text', inputmode: 'decimal', class: 'cnt-full', value: sp ? sp.full : '', 'data-k': `csf|${item.item_no}`, 'aria-label': `Full ${unitWord(item.receiving_unit)} of ${item.name}` });
  const loose = h('input', { type: 'text', inputmode: 'decimal', class: 'cnt-loose', value: sp && sp.loose ? sp.loose : '', 'data-k': `csl|${item.item_no}`, 'aria-label': `Loose ${unitWord(item.unit)} of ${item.name}` });
  const total = h('span', { class: 'cnt-total' });
  const read = () => { const f = full.value.trim(); const l = loose.value.trim(); if (!f && !l) return null; return (evalEntry(f || '0') || 0) * per + (evalEntry(l || '0') || 0); };
  const show = () => { try { const v = read(); total.textContent = v === null ? '' : `= ${qty(v, 2)} ${unitWord(item.unit, v)}`; full.classList.remove('error'); loose.classList.remove('error'); } catch { total.textContent = 'Numbers only'; } };
  const commit = async () => { let v; try { v = read(); } catch (err) { (full.value && Number.isNaN(Number(full.value)) ? full : loose).classList.add('error'); toast(err.message, 'bad'); return; }
    if ((v ?? null) === (value ?? null)) return; try { await save(v); } catch (err) { toast(niceError(err), 'bad'); } };
  for (const el of [full, loose]) { el.disabled = !!locked; el.addEventListener('input', show); el.addEventListener('change', commit); }
  show();
  return h('td', { class: 'cnt-box' }, h('div', { class: 'cnt-line' }, full, h('span', { class: 'cnt-u' }, `full ${unitWord(item.receiving_unit)}`), h('span', { class: 'cnt-plus' }, '+'), loose, h('span', { class: 'cnt-u' }, `${unitWord(item.unit)} loose`)), total);
}
// Counting an item that's only counted in its base unit.
function plainCountCell(item, value, save, locked) {
  const input = h('input', { type: 'text', inputmode: 'decimal', class: 'cnt-full', value: value ?? '', disabled: !!locked, 'data-k': `cs|${item.item_no}`, 'aria-label': `${item.name} counted` });
  input.addEventListener('change', async () => { let v; try { v = input.value.trim() ? evalEntry(input.value) : null; input.classList.remove('error'); } catch (err) { input.classList.add('error'); toast(err.message, 'bad'); return; }
    if ((v ?? null) === (value ?? null)) return; try { await save(v); } catch (err) { toast(niceError(err), 'bad'); } });
  return h('td', { class: 'cnt-box' }, h('div', { class: 'cnt-line' }, input, h('span', { class: 'cnt-u' }, unitWord(item.unit) || 'each')));
}
let sheetDate = todayIso();

const countItems = () => { const ix = derived.ix(); return [...ix.byType('Raw Material'), ...ix.byType('Component'), ...ix.byType('Finished Good')]; };
const groupName = (t) => (t === 'Component' ? 'Packaging' : t === 'Finished Good' ? 'Finished goods (cases)' : 'Raw materials');
const comesIn = (it) => (hasReceiving(it) ? `1 ${it.receiving_unit} = ${qty(Number(it.units_per_receiving))} ${unitWord(it.unit, 2)}` : '');
// A count as people say it: "12 boxes + 15 lb" (and the base total).
function countText(it, v) {
  if (v === null || v === undefined) return '';
  const sp = splitReceiving(it, v);
  if (!sp) return `${qty(v, 2)} ${unitWord(it.unit, v)}`;
  const parts = [sp.full ? `${qty(sp.full)} ${unitWord(it.receiving_unit, sp.full)}` : '', sp.loose ? `${qty(sp.loose, 2)} ${unitWord(it.unit, sp.loose)}` : ''].filter(Boolean);
  return `${parts.join(' + ') || '0'}${sp.full ? ` (${qty(v, 2)} ${unitWord(it.unit, v)})` : ''}`;
}
const dateField = (value, onPick, max) => h('label', { class: 'field' }, 'Count date', h('input', { type: 'date', class: 'big-date', value, max, 'aria-label': 'Count date',
  onchange: (e) => { if (e.target.value) onPick(e.target.value); } }));
const busyNote = (date) => {
  const busy = state.data.production.some((p) => p.date === date) || state.data.goods_receipts.some((r) => r.date === date);
  return busy ? h('div', { class: 'note warn' }, `There’s production or a delivery entered on ${longDate(date)}. Counts are taken at the start of the day, so count before anything is made or received, or count on another day.`) : null;
};

export const newCounts = {
  id: 'newcounts',
  label: 'New Counts',
  render({ rerender }) {
    const items = countItems();
    const rows = countSheet(state.data, derived.inventory(), sheetDate, items);
    const done = rows.filter((r) => r.counted !== null).length;
    const allowed = can('newcounts', 'edit'); const closed = isClosed(sheetDate); const locked = closed || !allowed;
    let group = null; const body = [];
    for (const r of rows) {
      if (r.item.type !== group) { group = r.item.type; body.push(h('tr', { class: 'grp' }, h('td', { colspan: 4 }, groupName(group)))); }
      const saveIt = (v) => saveCell('cycle_counts', { date: sheetDate, item_no: r.item.item_no }, 'qty', v);
      body.push(h('tr', null,
        itemNoTd(r.item), h('td', { class: 'sticky-col sticky-col2 cnt-name' }, h('strong', null, r.item.name)),
        h('td', { class: 'muted' }, comesIn(r.item)),
        hasReceiving(r.item) ? boxCountCell(r.item, r.counted, saveIt, locked) : plainCountCell(r.item, r.counted, saveIt, locked)));
    }
    return h('div', null,
      pageHead('New Counts', 'Count what’s on the shelf and type it in: full boxes, bags or cases, plus anything loose. Each count saves as soon as you move to the next box. The sheet doesn’t show what the system expects, so the count isn’t steered by it; All Counts → Check a day compares them afterwards.',
        dateField(sheetDate, (d) => { sheetDate = d; rerender(); }, todayIso()),
        h('div', { class: 'dl-day' }, sheetDate === todayIso() ? 'Today' : longDate(sheetDate)),
        sheetDate !== todayIso() ? h('button', { class: 'btn', onclick: () => { sheetDate = todayIso(); rerender(); } }, 'Back to today') : null,
        chip('Counted', `${done} of ${rows.length}`)),
      !allowed ? h('div', { class: 'note warn' }, 'Your role can view counts but not enter them.') : closed ? h('div', { class: 'note closed-note' }, '🔒 ', closedNote(sheetDate.slice(0, 7))) : null,
      busyNote(sheetDate),
      h('h2', { class: 'dl-title' }, `What’s on the shelf on ${longDate(sheetDate)}?`),
      h('div', { class: 'tablewrap', 'data-scroll': 'count-sheet' }, h('table', { class: 't count-sheet' },
        h('thead', null, h('tr', null, itemNoTh(), h('th', { class: 'sticky-col sticky-col2' }, 'Item'), h('th', null, 'Comes in'), h('th', null, 'How many are there?'))),
        h('tbody', null, body))));
  },
};

let checkDate = null; // All Counts → Check a day: the day shown (latest count day by default)

export const allCounts = {
  id: 'counts',
  label: 'All Counts',
  render({ rerender }) {
    const inv = derived.inventory(); const cm = derived.costs();
    const items = countItems();
    const prodDays = new Set(state.data.production.map((p) => p.date));
    const receipt = new Set(state.data.goods_receipts.map((r) => `${r.date}|${r.item_no}`));
    const counted = new Set(state.data.cycle_counts.map((c) => `${c.date}|${c.item_no}`));
    const conflict = (d, it) => counted.has(`${d}|${it.item_no}`) && (prodDays.has(d) || receipt.has(`${d}|${it.item_no}`));
    const switcher = seg([['month', 'Month'], ['check', 'Check a day']], mode, (m) => { mode = m; rerender(); });
    const tolerance = `${Math.round(COUNT_TOLERANCE * 100)}%`;
    const countDays = [...new Set(state.data.cycle_counts.map((c) => c.date))].sort();

    if (mode === 'check') {
      if (!checkDate || !countDays.includes(checkDate)) checkDate = countDays.at(-1) || todayIso();
      const rows = countSheet(state.data, inv, checkDate, items).filter((r) => r.counted !== null);
      const flagged = rows.filter((r) => r.flag).length;
      let group = null; const body = [];
      for (const r of rows) {
        if (r.item.type !== group) { group = r.item.type; body.push(h('tr', { class: 'grp' }, h('td', { colspan: 7 }, groupName(group)))); }
        const std = cm.cost(r.item.item_no, yearOf(checkDate)) || cm.latest(r.item.item_no);
        body.push(h('tr', { class: r.flag ? 'flagged' : null },
          itemNoTd(r.item), h('td', { class: 'sticky-col sticky-col2 cnt-name' }, h('strong', null, r.item.name)),
          h('td', null, countText(r.item, r.counted)),
          h('td', { class: 'num' + (r.expected < 0 ? ' neg' : '') }, r.expected === null ? '—' : `${qty(r.expected, 1)} ${unitWord(r.item.unit, 2)}`),
          h('td', { class: 'num' + (r.diff < 0 ? ' neg' : '') }, r.diff === null ? '' : (r.diff > 0 ? '+' : '') + qty(r.diff, 1)),
          h('td', { class: 'num' + (r.flag ? ' neg strong' : '') }, r.pct === null ? '' : `${r.pct > 0 ? '+' : ''}${qty(r.pct * 100, 0)}%`),
          r.diff === null ? h('td') : acctCell(r.diff * std, { class: r.diff < 0 ? 'neg' : '' })));
      }
      const pick = h('select', { 'aria-label': 'Count day', onchange: (e) => { checkDate = e.target.value; rerender(); } },
        [...countDays].reverse().map((d) => h('option', { value: d, selected: d === checkDate }, longDate(d))));
      return h('div', null,
        pageHead('Check a Count', `What was counted on a day next to what the running inventory expected at the start of that day. Differences over ${tolerance} are flagged: recount those, or look for a delivery or production that wasn’t entered. To change a count, use Month.`,
          switcher, h('label', { class: 'field' }, 'Count day', pick),
          chip('Items counted', rows.length), chip(`Off by over ${tolerance}`, flagged)),
        busyNote(checkDate),
        rows.length ? h('div', { class: 'tablewrap', 'data-scroll': 'count-check' }, h('table', { class: 't count-sheet count-check' },
          h('thead', null, h('tr', null, itemNoTh(), h('th', { class: 'sticky-col sticky-col2' }, 'Item'), h('th', null, 'Counted'), h('th', { class: 'num' }, 'Expected'), h('th', { class: 'num' }, 'Difference'), h('th', { class: 'num' }, '%'), h('th', { class: 'num' }, 'At standard'))),
          h('tbody', null, body)))
          : h('div', { class: 'panel empty' }, 'No counts entered yet. Use New Counts to enter one.'));
    }

    const days = monthDays(view.ym);
    const clashes = days.filter((d) => items.some((it) => conflict(d, it)));
    // counts far from what the running inventory expected
    const off = new Set();
    for (const d of days) for (const r of countSheet(state.data, inv, d, items)) if (r.flag) off.add(`${d}|${r.item.item_no}`);
    return h('div', null,
      pageHead('All Counts', `Every count, by day, in each item’s base unit; the line under each name shows what one box, bag or case holds. A count replaces the running inventory for that item from that day on. Finished goods are counted in cases. Counts more than ${tolerance} away from the running inventory are outlined in red; Check a day shows the details. To enter a count, use New Counts.`,
        switcher, monthPicker(view.ym, (ym) => { view.ym = ym; rerender(); })),
      clashes.length ? h('div', { class: 'note bad' }, `Counts this month on a day with production or a delivery (outlined below): ${clashes.map(longDate).join(', ')}.`) : null,
      off.size ? h('div', { class: 'note warn' }, `${off.size} count${off.size > 1 ? 's' : ''} this month differ from the running inventory by over ${tolerance} (outlined in red). Check a day shows the details.`) : null,
      entryGrid({
        table: 'cycle_counts', field: 'qty', items, ym: view.ym, rows: state.data.cycle_counts, footer: false,
        cellClass: (d, it) => [conflict(d, it) ? 'flag' : '', off.has(`${d}|${it.item_no}`) ? 'off' : ''].join(' ').trim() || null,
        editable: { allowed: can('counts', 'edit'), save: (date, item_no, v) => saveCell('cycle_counts', { date, item_no }, 'qty', v) },
      }));
  },
};
