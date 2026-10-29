// Receipts, as two tabs:
//   New Receipts  the simple way in: pick the day, type how many boxes / bags /
//                 cases of each thing came in, save. The site turns them into
//                 each item's base unit (a box of cheese = 30 lb).
//   All Receipts  the grid of everything received each day, in base units, for
//                 checking and fixing.
import { h, pageHead, monthPicker, chip, qty, toast, niceError, todayIso, longDate, DOW } from '../ui.js';
import { state, derived, saveCell } from '../store.js';
import { entryGrid, view, monthDays } from './grid.js';
import { hasReceiving, unitWord, holdsLabel, toDate } from '../calc.js';

let day = todayIso();
let typed = {};      // item_no -> text typed but not saved yet (kept across re-renders)
let lastSaved = null; // { day, lines: [{ item, count, base, before }] } for the confirmation and Undo

const fullDay = (iso) => `${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][toDate(iso).getUTCDay()]}, ${longDate(iso)}`;
// What one entry counts in: the receiving unit, or the base unit when there isn't one.
const entryUnit = (it) => (hasReceiving(it) ? it.receiving_unit : it.unit || 'each');
const perEntry = (it) => (hasReceiving(it) ? Number(it.units_per_receiving) : 1);
const parse = (text) => { const t = String(text ?? '').trim().replace(/,/g, ''); if (!t) return null; return /^\d*\.?\d+$|^\d+\.$/.test(t) ? Number(t) : NaN; };
const count = (n, u) => `${qty(n, 2)} ${unitWord(u, n)}`;

function enterView(rerender) {
  const ix = derived.ix();
  const groups = [['Raw materials', ix.byType('Raw Material')], ['Packaging', ix.byType('Component')]];
  const already = new Map(state.data.goods_receipts.filter((r) => r.date === day).map((r) => [r.item_no, Number(r.qty) || 0]));
  const isToday = day === todayIso();

  const lines = () => [...ix.byType('Raw Material'), ...ix.byType('Component')]
    .map((item) => ({ item, n: parse(typed[item.item_no]) })).filter((l) => l.n !== null);
  const saveBtn = h('button', { class: 'btn primary big', type: 'submit' }, 'Save delivery');
  const summary = h('div', { class: 'dl-summary' });
  const refresh = () => {
    const ls = lines(); const bad = ls.filter((l) => Number.isNaN(l.n));
    const good = ls.filter((l) => l.n > 0);
    saveBtn.disabled = !good.length || bad.length > 0;
    summary.textContent = bad.length ? `Fix the number for ${bad.map((l) => l.item.name).join(', ')} (numbers only, like 12 or 2.5).`
      : good.length ? `Ready to save ${good.length} item${good.length > 1 ? 's' : ''} for ${fullDay(day)}.` : 'Type how many came in next to each item that was delivered.';
    summary.classList.toggle('bad', bad.length > 0);
  };

  const row = (item) => {
    const u = entryUnit(item); const per = perEntry(item);
    const conv = h('span', { class: 'dl-conv' });
    const input = h('input', { type: 'text', inputmode: 'decimal', class: 'dl-input', 'aria-label': `How many ${unitWord(u)} of ${item.name}`, 'data-k': `dl|${item.item_no}`,
      value: typed[item.item_no] ?? '', autocomplete: 'off',
      oninput: (e) => { typed[item.item_no] = e.target.value; show(); refresh(); },
      onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); const all = [...document.querySelectorAll('.dl-input')]; const i = all.indexOf(e.target); (all[i + 1] || saveBtn).focus(); } } });
    const unitEl = h('span', { class: 'dl-unit' });
    const show = () => {
      const n = parse(input.value);
      input.classList.toggle('error', Number.isNaN(n));
      unitEl.textContent = unitWord(u, Number.isNaN(n) || n === null ? 2 : n);
      conv.textContent = Number.isNaN(n) ? 'Numbers only' : n && hasReceiving(item) ? `= ${qty(n * per, 2)} ${unitWord(item.unit, n * per)}` : '';
    };
    show();
    const before = already.get(item.item_no);
    return h('div', { class: 'dl-row' + (parse(typed[item.item_no]) > 0 ? ' filled' : '') },
      h('div', { class: 'dl-name' }, h('strong', null, item.name),
        h('span', { class: 'small muted' }, hasReceiving(item) ? `1 ${item.receiving_unit} = ${holdsLabel(item)}` : `Counted in ${unitWord(item.unit) || 'each'}`)),
      h('div', { class: 'dl-entry' }, input, unitEl),
      h('div', { class: 'dl-side' }, conv,
        before ? h('span', { class: 'small muted dl-before' }, `Already in for this day: ${hasReceiving(item) ? count(before / per, u) + ' · ' : ''}${qty(before, 2)} ${unitWord(item.unit, before)}`) : null));
  };

  const save = async (e) => {
    e.preventDefault();
    const ls = lines().filter((l) => l.n > 0);
    if (!ls.length || lines().some((l) => Number.isNaN(l.n))) return;
    saveBtn.disabled = true;
    const done = [];
    try {
      for (const { item, n } of ls) {
        const before = already.get(item.item_no) || 0; const base = n * perEntry(item);
        await saveCell('goods_receipts', { date: day, item_no: item.item_no }, 'qty', before + base);
        done.push({ item, n, base, before });
      }
      typed = {}; lastSaved = { day, lines: done };
      toast(`Delivery saved for ${fullDay(day)}.`);
      rerender();
    } catch (err) { toast(niceError(err), 'bad'); saveBtn.disabled = false; }
  };
  const undo = async () => {
    try { for (const l of lastSaved.lines) await saveCell('goods_receipts', { date: lastSaved.day, item_no: l.item.item_no }, 'qty', l.before || null); toast('Delivery taken back out.'); lastSaved = null; rerender(); }
    catch (err) { toast(niceError(err), 'bad'); }
  };

  const dateInput = h('input', { type: 'date', class: 'big-date', value: day, max: todayIso(), 'aria-label': 'Delivery date',
    onchange: (e) => { if (e.target.value) { day = e.target.value; lastSaved = null; rerender(); } } });
  refresh();
  return h('div', null,
    pageHead('New Receipts', 'For whoever unloads the truck: pick the day it came in, type how many boxes, bags or cases of each thing arrived, and press Save delivery. The site works out the pounds, cups or each for you. If something was already entered for that day, this adds to it. All Receipts shows everything received, to check or fix past days.',
      h('label', { class: 'field' }, 'Delivery date', dateInput),
      h('div', { class: 'dl-day' }, isToday ? 'Today' : DOW[toDate(day).getUTCDay()], ' · ', longDate(day)),
      !isToday ? h('button', { class: 'btn', onclick: () => { day = todayIso(); lastSaved = null; rerender(); } }, 'Back to today') : null),
    lastSaved ? h('section', { class: 'panel dl-saved' },
      h('h2', null, '✓ Saved'),
      h('ul', null, lastSaved.lines.map((l) => h('li', null, h('strong', null, count(l.n, entryUnit(l.item))), ` of ${l.item.name}`, hasReceiving(l.item) ? h('span', { class: 'muted' }, ` (${qty(l.base, 2)} ${unitWord(l.item.unit, l.base)})`) : null))),
      h('div', { class: 'small muted' }, `Received ${fullDay(lastSaved.day)}.`),
      h('button', { class: 'btn', onclick: undo }, 'Undo this delivery')) : null,
    h('form', { class: 'delivery', onsubmit: save },
      h('h2', { class: 'dl-title' }, `What came in on ${fullDay(day)}?`),
      groups.map(([title, items]) => h('section', { class: 'dl-group' }, h('h3', null, title), items.map(row))),
      h('div', { class: 'dl-bar' }, summary, saveBtn)));
}

export const newReceipts = {
  id: 'newreceipts',
  label: 'New Receipts',
  render({ rerender }) { return enterView(rerender); },
};

export const allReceipts = {
  id: 'receipts',
  label: 'All Receipts',
  render({ rerender }) {
    const ix = derived.ix();
    const items = [...ix.byType('Raw Material'), ...ix.byType('Component')];
    const days = new Set(monthDays(view.ym));
    const month = state.data.goods_receipts.filter((r) => days.has(r.date));
    return h('div', null,
      pageHead('All Receipts', 'Everything received each day, in each item’s base unit (pounds, cups or each); the line under each name shows what one box, bag or case holds. To enter a delivery, use New Receipts. Fix a number here by typing over it; typing math like 30*12 works.',
        monthPicker(view.ym, (ym) => { view.ym = ym; rerender(); }),
        chip('Receipts', month.length),
        chip('Delivery days', new Set(month.map((r) => r.date)).size)),
      entryGrid({
        table: 'goods_receipts', field: 'qty', rerender, items, ym: view.ym, rows: state.data.goods_receipts,
        editable: { allowed: true, save: (date, item_no, v) => saveCell('goods_receipts', { date, item_no }, 'qty', v) },
      }));
  },
};
