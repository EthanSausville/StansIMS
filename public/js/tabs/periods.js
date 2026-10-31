// Settings → Periods (admins): close a month once its books are final, so
// nobody can add, change or remove its production, deliveries, counts or sales.
// The database enforces it (public.period_guard), for admins too, until the
// month is reopened. A finished year can be closed as a whole: its months are
// closed with it and can't be reopened one by one until the year is; reopening
// the year leaves its months closed. All of it is recorded in Change history.
// Each month shows its key figures, so you can check them before closing.
import { h, pageHead, toast, niceError, confirmDialog, todayIso, longDate, money, fmt } from '../ui.js';
import { state, derived, insertRow, deleteRow } from '../store.js';
import { monthName } from '../perms.js';
import { monthEnd } from '../calc.js';

// TEMPORARY: show 2025 too (no data), to see how a finished year looks. Remove
// this line (or set it to null) to start at the first month with entries again.
const SHOW_FROM = '2025-01';

const ymOf = (d) => String(d).slice(0, 7);
const nextYm = (ym) => { const [y, m] = ym.split('-').map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`; };
const pref = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* fine */ } } };
const num = (v) => Number(v) || 0;

// Each month's figures: ending inventory $, sales $, purchases $ (deliveries
// at standard cost), production oz, cycle count lines, working (production) days.
function monthFigures(d, months, today) {
  const cm = derived.costs(); const inv = derived.inventory(); const days = derived.production();
  const std = (itemNo, y) => cm.cost(itemNo, y) || cm.latest(itemNo);
  const out = new Map(months.map((ym) => [ym, { inventory: null, sales: 0, purchases: 0, oz: 0, counts: 0, days: 0, any: false }]));
  const at = (date) => out.get(ymOf(date));
  for (const s of d.sales) { const f = at(s.date); if (f) { f.sales += num(s.amount); f.any = true; } }
  for (const r of d.goods_receipts) { const f = at(r.date); if (f && num(r.qty)) { f.purchases += num(r.qty) * std(r.item_no, Number(r.date.slice(0, 4))); f.any = true; } }
  for (const c of d.cycle_counts) { const f = at(c.date); if (f && c.qty !== null && c.qty !== undefined) { f.counts++; f.any = true; } }
  for (const p of days) { const f = at(p.date); if (f && num(p.oz)) { f.oz += num(p.oz); f.days++; f.any = true; } }
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
  adminOnly: true,
  render({ rerender }) {
    const d = state.data;
    const live = !d.missingTables?.has('closed_periods');
    const yearsLive = !d.missingTables?.has('closed_years');
    const closed = new Map((d.closed_periods || []).map((c) => [ymOf(c.month), c]));
    const closedYears = new Map((d.closed_years || []).map((c) => [Number(c.year), c]));
    const today = todayIso(); const nowYm = ymOf(today); const nowYear = Number(nowYm.slice(0, 4));
    const dataMonths = [...d.production, ...d.goods_receipts, ...d.cycle_counts, ...d.sales].map((r) => ymOf(r.date));
    const first = [...dataMonths, ...closed.keys(), ...(SHOW_FROM ? [SHOW_FROM] : [])].sort()[0] || nowYm;
    const months = []; for (let ym = first; ym <= nowYm; ym = nextYm(ym)) months.push(ym);
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
    const closeYear = async (y, yms) => {
      if (!(await confirmDialog(`Close ${y}? Every month in it is closed, and none can be reopened until the year is reopened here.`, 'Close year'))) return;
      try {
        for (const ym of yms) if (!closed.has(ym)) await insertRow('closed_periods', { month: `${ym}-01` });
        if (yearsLive) await insertRow('closed_years', { year: y });
        toast(`${y} closed.`);
      } catch (err) { toast(niceError(err), 'bad'); }
    };
    const reopenYear = async (y) => {
      if (!(await confirmDialog(`Reopen ${y} as a year? Its months stay closed; you can then reopen any of them on its own.`, 'Reopen year'))) return;
      try { await deleteRow('closed_years', 'year', closedYears.get(y).year); toast(`${y} reopened. Its months are still closed.`); } catch (err) { toast(niceError(err), 'bad'); }
    };

    const dash = (v, f) => (v ? f(v) : '—');
    const cells = (f) => [
      h('td', { class: 'num' }, f.inventory === null ? '—' : money(f.inventory, 0)),
      h('td', { class: 'num' }, dash(f.sales, (v) => money(v, 0))),
      h('td', { class: 'num' }, dash(f.purchases, (v) => money(v, 0))),
      h('td', { class: 'num' }, dash(f.oz, (v) => fmt(v))),
      h('td', { class: 'num' }, dash(f.counts, (v) => v.toLocaleString())),
      h('td', { class: 'num' }, dash(f.days, (v) => v.toLocaleString())),
    ];
    const who = (c) => (c ? `Closed ${c.closed_at ? longDate(String(c.closed_at).slice(0, 10)) : ''}${c.closed_by_email ? ` by ${c.closed_by_email}` : ''}`.trim() : null);
    const monthRow = (ym) => {
      const c = closed.get(ym); const current = ym >= nowYm; const yc = closedYears.has(Number(ym.slice(0, 4)));
      return h('tr', { class: 'pr-month' },
        h('td', { class: 'pr-name' }, monthName(ym).replace(/ \d{4}$/, '')),
        h('td', null, h('span', { class: `user-status ${c || yc ? 'off' : current ? 'invited' : 'on'}`, title: who(c) }, c || yc ? '🔒 Closed' : current ? 'Current month' : 'Open')),
        cells(figs.get(ym)),
        h('td', { class: 'user-actions' }, !live || current ? null
          : yc ? h('span', { class: 'small muted', title: 'Reopen the year first' }, 'Year closed')
            : c ? h('button', { class: 'btn small', onclick: () => reopenMonth(ym) }, 'Reopen')
              : h('button', { class: 'btn small primary', onclick: () => closeMonth(ym) }, 'Close')));
    };
    const yearGroup = (y) => {
      const yms = months.filter((ym) => ym.startsWith(`${y}-`));
      const done = y < nowYear; // a finished year folds up, and can be closed as a whole
      const key = `periods:open:${y}`;
      const isOpen = !done || pref.get(key) === '1';
      const yc = closedYears.get(y);
      const nClosed = yms.filter((ym) => closed.has(ym)).length;
      const toggle = () => { pref.set(key, isOpen ? '0' : '1'); rerender(); };
      const fs = yms.map((ym) => figs.get(ym));
      const sum = (k) => fs.reduce((t, f) => t + f[k], 0);
      const lastInv = [...fs].reverse().find((f) => f.inventory !== null)?.inventory ?? null;
      const total = { inventory: lastInv, sales: sum('sales'), purchases: sum('purchases'), oz: sum('oz'), counts: sum('counts'), days: sum('days') };
      const status = yc ? '🔒 Year closed' : nClosed === yms.length ? '🔒 All months closed' : done ? `${nClosed} of ${yms.length} months closed` : `${nClosed} closed · ${yms.length - nClosed} open`;
      const head = h('tr', { class: 'pr-year' + (done ? ' foldable' : ''), onclick: done ? toggle : null,
          title: done ? (isOpen ? `Hide ${y}’s months` : `Show ${y}’s months`) : null, 'aria-expanded': done ? String(isOpen) : null },
        h('td', { class: 'pr-name' }, String(y)),
        h('td', null, h('span', { class: `user-status ${yc || nClosed === yms.length ? 'off' : done ? 'on' : 'invited'}`, title: who(yc) }, status)),
        cells(total),
        h('td', { class: 'user-actions' }, !live || !done ? null
          : yc ? h('button', { class: 'btn small', onclick: (e) => { e.stopPropagation(); reopenYear(y); } }, 'Reopen year')
            : h('button', { class: 'btn small primary', onclick: (e) => { e.stopPropagation(); closeYear(y, yms); } }, 'Close year')));
      return h('tbody', { class: 'pr-group' }, head, isOpen ? [...yms].reverse().map(monthRow) : null);
    };

    return h('div', null,
      pageHead('Periods', 'Close a month once its books are final.'),
      h('p', { class: 'small muted pr-intro' }, 'Closing a month locks its production, deliveries, counts and sales for everyone, admins included, until it’s reopened here. Closing a finished year closes all its months and keeps them closed until the year is reopened; reopening the year leaves the months closed. Standards, prices and the plan aren’t locked. Ending inventory and purchases are at standard cost; working days are days with production.'),
      !live ? h('div', { class: 'note warn' }, 'Closing months starts working after the next deploy to main.') : null,
      h('div', { class: 'tablewrap' }, h('table', { class: 't periods-table' },
        h('thead', null, h('tr', null, h('th', null, 'Month'), h('th', null, 'Status'), h('th', { class: 'num' }, 'Ending inventory'), h('th', { class: 'num' }, 'Sales'),
          h('th', { class: 'num' }, 'Purchases'), h('th', { class: 'num' }, 'Production (oz)'), h('th', { class: 'num' }, 'Cycle counts'), h('th', { class: 'num' }, 'Working days'), h('th'))),
        years.map(yearGroup))));
  },
};
