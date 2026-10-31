// Settings → Periods (admins): close a month once its books are final, so
// nobody can add, change or remove its production, deliveries, counts or sales.
// The database enforces it (public.period_guard), for admins too, until the
// month is reopened. Each year also has a Beginning and an Ending:
//   Beginning closed  that year's standards (costs, prices, BOMs, labor,
//                     overhead) can't change.
//   Ending closed     the finished year closes (its months with it, and they
//                     can't be reopened one by one until the Ending is), and its
//                     standards roll over to next year's: Dec 31 inventory is
//                     revalued to the new standards, as journal entry H in
//                     January. Next year's Beginning must be closed first.
// All of it is recorded in Change history.
// Each month shows its key figures, so you can check them before closing.
import { h, pageHead, toast, niceError, confirmDialog, todayIso, longDate, money, fmt } from '../ui.js';
import { state, derived, insertRow, deleteRow } from '../store.js';
import { monthName, can } from '../perms.js';
import { monthEnd, rolloverLines } from '../calc.js';

// Every month from January 2026 through December of this year; from October,
// next year too, so its Beginning (standards) can be closed ahead of time.
const FIRST_MONTH = '2026-01';

const ymOf = (d) => String(d).slice(0, 7);
const nextYm = (ym) => { const [y, m] = ym.split('-').map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`; };
const pref = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* fine */ } } };
const num = (v) => Number(v) || 0;

// Each month's figures: ending inventory $, sales $, standard margin $ (sales
// less cases sold at standard cost), purchases $ (deliveries at standard
// cost), production oz, cycle count lines, and working hours (the labor hours
// production took: each batch's BOM labor minutes).
function inventoryValue(date, year) {
  const cm = derived.costs(); const inv = derived.inventory();
  if (!inv.from || date < inv.from) return null;
  let v = 0; let seen = false;
  for (const item of inv.items) { const q = inv.byItem.get(item.item_no)?.get(date); if (q === undefined) continue; seen = true; v += q * (cm.cost(item.item_no, year) || cm.latest(item.item_no)); }
  return seen ? v : null;
}
function monthFigures(d, months, today) {
  const cm = derived.costs(); const inv = derived.inventory(); const days = derived.production();
  const std = (itemNo, y) => cm.cost(itemNo, y) || cm.latest(itemNo);
  const out = new Map(months.map((ym) => [ym, { inventory: null, sales: 0, margin: 0, purchases: 0, oz: 0, counts: 0, hours: 0, any: false }]));
  const at = (date) => out.get(ymOf(date));
  for (const s of derived.sales()) { const f = at(s.date); if (f) { f.sales += num(s.amount); f.margin += num(s.amount) - num(s.stdCost); f.any = true; } }
  for (const r of d.goods_receipts) { const f = at(r.date); if (f && num(r.qty)) { f.purchases += num(r.qty) * std(r.item_no, Number(r.date.slice(0, 4))); f.any = true; } }
  for (const c of d.cycle_counts) { const f = at(c.date); if (f && c.qty !== null && c.qty !== undefined) { f.counts++; f.any = true; } }
  for (const p of days) {
    const f = at(p.date); if (!f || !num(p.oz)) continue;
    const ix = cm.ixFor(Number(p.date.slice(0, 4)));
    f.oz += num(p.oz); f.hours += p.recipes.reduce((t, r) => t + r.batches * ix.laborMinutesOf(r.item_no), 0) / 60; f.any = true;
  }
  // Ending inventory: everything on hand at the month's end (or today, for this month), at standard cost.
  if (inv.from) {
    for (const ym of months) {
      const [y, m] = ym.split('-').map(Number); const end = monthEnd(y, m) < today ? monthEnd(y, m) : today;
      if (end < inv.from) continue;
      let v = 0; let seen = false;
      for (const item of inv.items) { const q = inv.byItem.get(item.item_no)?.get(end); if (q === undefined) continue; seen = true; v += q * std(item.item_no, y); }
      if (seen) out.get(ym).inventory = v;
    }
  }
  return out;
}

export default {
  id: 'periods',
  label: 'Periods',
  render({ rerender }) {
    const d = state.data;
    const live = !d.missingTables?.has('closed_periods') && can('periods', 'edit'); // can close and reopen
    const yearsLive = live && !d.missingTables?.has('closed_years');
    const closed = new Map((d.closed_periods || []).map((c) => [ymOf(c.month), c]));
    const closedYears = new Map((d.closed_years || []).map((c) => [Number(c.year), c]));
    const today = todayIso(); const nowYm = ymOf(today); const nowYear = Number(nowYm.slice(0, 4));
    const dataMonths = [...d.production, ...d.goods_receipts, ...d.cycle_counts, ...d.sales].map((r) => ymOf(r.date));
    const first = [FIRST_MONTH, ...dataMonths, ...closed.keys()].sort()[0];
    const lastYear = Number(nowYm.slice(5, 7)) >= 10 ? nowYear + 1 : nowYear;
    const months = []; for (let ym = first; ym <= `${lastYear}-12`; ym = nextYm(ym)) months.push(ym);
    const years = [...new Set(months.map((ym) => Number(ym.slice(0, 4))))].sort((a, b) => b - a);
    const figs = monthFigures(d, months, today);

    const closeMonth = async (ym) => {
      if (!(await confirmDialog(`Close ${monthName(ym)}? Nobody, admins included, can add, change or remove production, deliveries, counts or sales dated then until it’s reopened here.`, 'Close'))) return;
      try { await insertRow('closed_periods', { month: `${ym}-01` }); toast(`${monthName(ym)} closed.`); } catch (err) { toast(niceError(err), 'bad'); }
    };
    const reopenMonth = async (ym) => {
      if (!(await confirmDialog(`Reopen ${monthName(ym)}? Its entries can be changed again until it’s closed.`, 'Reopen'))) return;
      try { await deleteRow('closed_periods', 'month', closed.get(ym).month); toast(`${monthName(ym)} reopened.`); } catch (err) { toast(niceError(err), 'bad'); }
    };
    const closedBeginnings = new Map((d.closed_beginnings || []).map((c) => [Number(c.year), c]));
    const beginLive = live && !d.missingTables?.has('closed_beginnings');
    const closeBeginning = async (y) => {
      if (!(await confirmDialog(`Close ${y} Beginning? ${y}’s standards (costs, prices, BOMs, labor and overhead) are locked and can’t be changed until it’s reopened here.`, 'Close'))) return;
      try { await insertRow('closed_beginnings', { year: y }); toast(`${y}’s standards are locked.`); } catch (err) { toast(niceError(err), 'bad'); }
    };
    const reopenBeginning = async (y) => {
      if (!(await confirmDialog(`Reopen ${y} Beginning? ${y}’s standards can be changed again.`, 'Reopen'))) return;
      try { await deleteRow('closed_beginnings', 'year', closedBeginnings.get(y).year); toast(`${y}’s standards are open again.`); } catch (err) { toast(niceError(err), 'bad'); }
    };
    const closeEnding = async (y, yms) => {
      if (!closedBeginnings.has(y + 1)) { toast(`Close ${y + 1} Beginning first, so the standards ${y} rolls over to are final.`, 'bad'); return; }
      const lines = rolloverLines(d, y + 1, derived.inventory());
      const net = lines.filter((l) => l.key !== 'adj').reduce((t, l) => t + l.dr - l.cr, 0);
      const what = lines.length ? `Inventory on hand at Dec 31 is revalued from ${y} to ${y + 1} standards (journal entry H in January ${y + 1}: ${net >= 0 ? 'up' : 'down'} ${money(Math.abs(net), 2)}).` : `There’s no inventory at Dec 31 to revalue.`;
      if (!(await confirmDialog(`Close ${y} Ending? Every month in ${y} closes and stays closed until the Ending is reopened. ${what}`, 'Close'))) return;
      try {
        for (const ym of yms) if (!closed.has(ym)) await insertRow('closed_periods', { month: `${ym}-01` });
        await insertRow('closed_years', { year: y, rollover: { lines, net, to: y + 1, at: new Date().toISOString() } });
        toast(`${y} closed; standards rolled over to ${y + 1}.`);
      } catch (err) { toast(niceError(err), 'bad'); }
    };
    const reopenEnding = async (y) => {
      if (!(await confirmDialog(`Reopen ${y} Ending? The roll-over to ${y + 1} standards (journal entry H) is taken back out. ${y}’s months stay closed; you can then reopen any of them on its own.`, 'Reopen'))) return;
      try { await deleteRow('closed_years', 'year', closedYears.get(y).year); toast(`${y} Ending reopened. Its months are still closed.`); } catch (err) { toast(niceError(err), 'bad'); }
    };

    const dash = (v, f) => (v ? f(v) : '—');
    const cells = (f) => [
      h('td', { class: 'num' }, f.inventory === null ? '—' : money(f.inventory, 0)),
      h('td', { class: 'num' }, dash(f.sales, (v) => money(v, 0))),
      h('td', { class: 'num' + (f.margin < 0 ? ' neg' : '') }, dash(f.margin, (v) => money(v, 0))),
      h('td', { class: 'num' }, dash(f.purchases, (v) => money(v, 0))),
      h('td', { class: 'num' }, dash(f.oz, (v) => fmt(v))),
      h('td', { class: 'num' }, dash(f.counts, (v) => v.toLocaleString())),
      h('td', { class: 'num' }, dash(f.hours, (v) => fmt(v))),
    ];
    const who = (c) => (c ? `Closed ${c.closed_at ? longDate(String(c.closed_at).slice(0, 10)) : ''}${c.closed_by_email ? ` by ${c.closed_by_email}` : ''}`.trim() : null);
    const monthRow = (ym) => {
      const c = closed.get(ym); const current = ym === nowYm; const future = ym > nowYm; const yc = closedYears.has(Number(ym.slice(0, 4)));
      return h('tr', { class: 'pr-month' + (current ? ' pr-current' : '') + (future ? ' pr-future' : '') },
        h('td', { class: 'pr-name' }, monthName(ym).replace(/ \d{4}$/, '')),
        h('td', null, h('span', { class: `user-status ${c || yc ? 'off' : future ? 'future' : current ? 'invited' : 'on'}`, title: who(c) }, c || yc ? '🔒 Closed' : future ? 'Future month' : current ? 'Current month' : 'Open')),
        future ? cells(blankRow) : cells(figs.get(ym)),
        h('td', { class: 'user-actions' }, !live || current || future ? null
          : yc ? h('span', { class: 'small muted', title: 'Reopen the year’s Ending first' }, 'Ending closed')
            : c ? h('button', { class: 'btn small', onclick: () => reopenMonth(ym) }, 'Reopen')
              : h('button', { class: 'btn small primary', onclick: () => closeMonth(ym) }, 'Close')));
    };
    const blankRow = { inventory: null, sales: 0, margin: 0, purchases: 0, oz: 0, counts: 0, hours: 0 };
    // Beginning: Jan 1 inventory at the year's standards; closing it locks them.
    const beginningRow = (y) => {
      const c = closedBeginnings.get(y); const prevEnding = closedYears.has(y - 1);
      return h('tr', { class: 'pr-month pr-edge' },
        h('td', { class: 'pr-name' }, 'Beginning'),
        h('td', null, h('span', { class: `user-status ${c ? 'off' : 'on'}`, title: who(c) }, c ? '🔒 Standards locked' : 'Standards open')),
        cells({ ...blankRow, inventory: `${y - 1}-12-31` < today ? inventoryValue(`${y - 1}-12-31`, y) : null }),
        h('td', { class: 'user-actions' }, !beginLive ? null
          : c ? (prevEnding ? h('span', { class: 'small muted', title: `${y - 1} Ending rolled over to these standards` }, `${y - 1} Ending closed`) : h('button', { class: 'btn small', onclick: () => reopenBeginning(y) }, 'Reopen'))
            : h('button', { class: 'btn small primary', onclick: () => closeBeginning(y) }, 'Close')));
    };
    // Ending: Dec 31 inventory; closing it closes the year and rolls standards over.
    const endingRow = (y, yms) => {
      const c = closedYears.get(y); const done = y < nowYear;
      const tip = c ? [who(c), c.rollover ? `Rolled over to ${y + 1} standards: inventory ${c.rollover.net >= 0 ? 'up' : 'down'} ${money(Math.abs(c.rollover.net || 0), 2)}` : null].filter(Boolean).join('\n') : null;
      return h('tr', { class: 'pr-month pr-edge' },
        h('td', { class: 'pr-name' }, 'Ending'),
        h('td', null, h('span', { class: `user-status ${c ? 'off' : done ? 'on' : 'invited'}`, title: tip }, c ? '🔒 Closed' : done ? 'Open' : 'Year not over')),
        cells({ ...blankRow, inventory: done ? inventoryValue(`${y}-12-31`, y) : null }),
        h('td', { class: 'user-actions' }, !yearsLive || !done ? null
          : c ? h('button', { class: 'btn small', onclick: () => reopenEnding(y) }, 'Reopen')
            : h('button', { class: 'btn small primary', title: closedBeginnings.has(y + 1) ? null : `Close ${y + 1} Beginning first`, onclick: () => closeEnding(y, yms) }, 'Close')));
    };
    const yearGroup = (y) => {
      const yms = months.filter((ym) => ym.startsWith(`${y}-`));
      const future = y > nowYear; // next year (from October): its months are all ahead
      const done = y < nowYear; // a finished year starts folded up
      const key = `periods:open:${y}`;
      // Clicking a year folds it up; the current year folds up only its months still ahead.
      const isOpen = pref.get(key) ? pref.get(key) === '1' : !done;
      const partial = !done && !future; // the current year
      const toggle = () => { pref.set(key, isOpen ? '0' : '1'); rerender(); };
      const fs = yms.map((ym) => figs.get(ym));
      const sum = (k) => fs.reduce((t, f) => t + f[k], 0);
      const lastInv = [...fs].reverse().find((f) => f.inventory !== null)?.inventory ?? null;
      const total = { inventory: lastInv, sales: sum('sales'), margin: sum('margin'), purchases: sum('purchases'), oz: sum('oz'), counts: sum('counts'), hours: sum('hours') };
      const head = h('tr', { class: 'pr-year foldable', onclick: toggle, 'aria-expanded': String(isOpen),
          title: partial ? (isOpen ? `Hide ${y}’s Ending and months still ahead` : `Show ${y}’s Ending and months still ahead`) : isOpen ? `Hide ${y}’s months` : `Show ${y}’s months` },
        h('td', { class: 'pr-name' }, String(y)),
        h('td'), cells(future ? blankRow : total), h('td'));
      return h('tbody', { class: 'pr-group' }, head,
        isOpen ? [endingRow(y, yms), [...yms].reverse().map(monthRow), beginningRow(y)]
          : partial ? [[...yms].reverse().filter((ym) => ym <= nowYm).map(monthRow), beginningRow(y)] : null);
    };

    return h('div', null,
      pageHead('Periods', 'Close a month once its books are final.'),
      h('ul', { class: 'pr-intro' },
        h('li', null, h('strong', null, 'Months: '), 'closing one locks its production, deliveries, counts and sales for everyone, admins included, until it’s reopened here.'),
        h('li', null, h('strong', null, 'Beginning: '), 'closing it locks that year’s standards: costs, prices, BOMs, labor and overhead.'),
        h('li', null, h('strong', null, 'Ending: '), 'once the year is over, closing it closes every month in the year and rolls the standards over to next year’s, revaluing Dec 31 inventory (journal entry H in January). Next year’s Beginning has to be closed first. Reopening an Ending leaves the months closed.'),
        h('li', null, h('strong', null, 'Figures: '), 'inventory and purchases are at standard cost; Std margin is sales less cases sold at standard cost; working hours are the labor hours production took (each batch’s BOM labor minutes).'),
        h('li', null, h('strong', null, 'Years: '), 'click a year to fold it up; this year folds up its Ending and the months still ahead.')),
      d.missingTables?.has('closed_periods') ? h('div', { class: 'note warn' }, 'Closing months starts working after the next deploy to main.') : null,
      h('div', { class: 'tablewrap' }, h('table', { class: 't periods-table' },
        h('thead', null, h('tr', null, h('th', null, 'Month'), h('th', null, 'Status'), h('th', { class: 'num' }, 'Ending inventory'), h('th', { class: 'num' }, 'Sales'), h('th', { class: 'num' }, 'Std margin'),
          h('th', { class: 'num' }, 'Purchases'), h('th', { class: 'num' }, 'Production (oz)'), h('th', { class: 'num' }, 'Cycle counts'), h('th', { class: 'num' }, 'Working hours'), h('th'))),
        years.map(yearGroup))));
  },
};
