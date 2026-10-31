// Inventory → Count: the count sheet for one day. Type what's on the shelf
// (full boxes + loose), and say whether it was counted at the start of the day
// (before that day's deliveries and production) or the end (after them).
// Blind: it doesn't show what's expected. Inventory → Daily shows each count
// and its adjustment.
import { h, pageHead, longDate, seg, qty, todayIso, chip, toast, niceError, itemNoTh, itemNoTd } from '../ui.js';
import { state, derived, saveCell, saveField } from '../store.js';
import { can, isClosed, closedNote } from '../perms.js';
import { countSheet, hasReceiving, splitReceiving, unitWord, evalEntry, countTiming, COMPANY_START } from '../calc.js';

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
const dateField = (value, onPick, max) => h('label', { class: 'field' }, 'Count date', h('input', { type: 'date', class: 'big-date', value, min: COMPANY_START, max, 'aria-label': 'Count date',
  onchange: (e) => { if (e.target.value) onPick(e.target.value < COMPANY_START ? COMPANY_START : e.target.value); } }));
let pickedTiming = null; // start / end chosen for a day with no counts yet
const dayTiming = (date) => { const c = state.data.cycle_counts.find((x) => x.date === date); return c ? countTiming(c) : (pickedTiming || 'start'); };

export const newCounts = {
  id: 'newcounts',
  label: 'Count',
  render({ rerender }) {
    const items = countItems();
    const timing = dayTiming(sheetDate);
    const rows = countSheet(state.data, derived.inventory(), sheetDate, items);
    const done = rows.filter((r) => r.counted !== null).length;
    const allowed = can('newcounts', 'edit'); const closed = isClosed(sheetDate); const locked = closed || !allowed;
    let group = null; const body = [];
    for (const r of rows) {
      if (r.item.type !== group) { group = r.item.type; body.push(h('tr', { class: 'grp' }, h('td', { colspan: 4 }, groupName(group)))); }
      const saveIt = (v) => saveCell('cycle_counts', { date: sheetDate, item_no: r.item.item_no }, 'qty', v, { timing });
      body.push(h('tr', null,
        itemNoTd(r.item), h('td', { class: 'sticky-col sticky-col2 cnt-name' }, h('strong', null, r.item.name)),
        h('td', { class: 'muted' }, comesIn(r.item)),
        hasReceiving(r.item) ? boxCountCell(r.item, r.counted, saveIt, locked) : plainCountCell(r.item, r.counted, saveIt, locked)));
    }
    // Switching start / end changes the day's counts already entered too.
    const setTiming = async (t) => {
      pickedTiming = t;
      const rowsToday = state.data.cycle_counts.filter((c) => c.date === sheetDate && countTiming(c) !== t);
      try { for (const c of rowsToday) await saveField('cycle_counts', { date: c.date, item_no: c.item_no }, 'timing', t); } catch (err) { toast(niceError(err), 'bad'); }
      rerender();
    };
    const timingSeg = seg([['start', 'Start of day'], ['end', 'End of day']], timing, (t) => { if (!locked) setTiming(t); });
    timingSeg.classList.add('count-timing'); if (locked) timingSeg.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    return h('div', null,
      pageHead('Count', 'Count what’s on the shelf and type it in: full boxes, bags or cases, plus anything loose. Each count saves as soon as you move to the next box. Say whether it was counted at the start of the day (before that day’s deliveries and production) or the end (after them): an end-of-day count includes that day in its adjustment. The sheet doesn’t show what the system expects, so the count isn’t steered by it; Daily shows each count and its adjustment.'),
      h('div', { class: 'nb-date' },
        dateField(sheetDate, (d) => { sheetDate = d; pickedTiming = null; rerender(); }, todayIso()),
        h('div', { class: 'dl-day' }, sheetDate === todayIso() ? 'Today' : longDate(sheetDate)),
        sheetDate !== todayIso() ? h('button', { class: 'btn', onclick: () => { sheetDate = todayIso(); pickedTiming = null; rerender(); } }, 'Back to today') : null,
        h('div', { class: 'field' }, h('span', null, 'Counted at the'), timingSeg),
        chip('Counted', `${done} of ${rows.length}`)),
      !allowed ? h('div', { class: 'note warn' }, 'Your role can view counts but not enter them.') : closed ? h('div', { class: 'note closed-note' }, '🔒 ', closedNote(sheetDate.slice(0, 7))) : null,
      h('h2', { class: 'dl-title' }, `What’s on the shelf at the ${timing === 'end' ? 'end' : 'start'} of ${longDate(sheetDate)}?`),
      h('div', { class: 'tablewrap', 'data-scroll': 'count-sheet' }, h('table', { class: 't count-sheet' },
        h('thead', null, h('tr', null, itemNoTh(), h('th', { class: 'sticky-col sticky-col2' }, 'Item'), h('th', null, 'Comes in'), h('th', null, 'How many are there?'))),
        h('tbody', null, body))));
  },
};
