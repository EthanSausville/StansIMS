// Settings → Periods (admins): close a month once its books are final, so
// nobody can add, change or remove its production, deliveries, counts or sales.
// The database enforces it (public.period_guard), for admins too, until the
// month is reopened. Closing and reopening are recorded in Change history.
// Months are grouped by year; a finished year folds up under its heading.
import { h, pageHead, toast, niceError, confirmDialog, todayIso, longDate } from '../ui.js';
import { state, insertRow, deleteRow } from '../store.js';
import { monthName } from '../perms.js';

// TEMPORARY: show 2025 too (no data), to see how a finished year looks. Remove
// this line (or set it to null) to start at the first month with entries again.
const SHOW_FROM = '2025-01';

const ymOf = (d) => String(d).slice(0, 7);
const nextYm = (ym) => { const [y, m] = ym.split('-').map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`; };
const pref = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* fine */ } } };

export default {
  id: 'periods',
  label: 'Periods',
  adminOnly: true,
  render({ rerender }) {
    const d = state.data;
    const live = !d.missingTables?.has('closed_periods');
    const closed = new Map((d.closed_periods || []).map((c) => [ymOf(c.month), c]));
    const nowYm = ymOf(todayIso()); const nowYear = Number(nowYm.slice(0, 4));
    const tally = new Map();
    const blank = () => ({ production: new Set(), receipts: 0, counts: new Set(), sales: 0 });
    const bump = (date, k) => { const ym = ymOf(date); if (!tally.has(ym)) tally.set(ym, blank()); const t = tally.get(ym);
      if (k === 'production') t.production.add(date); else if (k === 'counts') t.counts.add(date); else t[k]++; };
    for (const r of d.production) if (Number(r.cases)) bump(r.date, 'production');
    for (const r of d.goods_receipts) if (Number(r.qty)) bump(r.date, 'receipts');
    for (const r of d.cycle_counts) bump(r.date, 'counts');
    for (const r of d.sales) bump(r.date, 'sales');
    const first = [...tally.keys(), ...closed.keys(), ...(SHOW_FROM ? [SHOW_FROM] : [])].sort()[0] || nowYm;
    const months = []; for (let ym = first; ym <= nowYm; ym = nextYm(ym)) months.push(ym);
    const years = [...new Set(months.map((ym) => Number(ym.slice(0, 4))))].sort((a, b) => b - a);

    const close = async (yms) => {
      const list = yms.filter((ym) => !closed.has(ym) && ym < nowYm);
      if (!list.length) return;
      const label = list.length === 1 ? monthName(list[0]) : list.length === 12 ? `all of ${list[0].slice(0, 4)}` : `the rest of ${list[0].slice(0, 4)} (${list.length} months)`;
      if (!(await confirmDialog(`Close ${label}? Nobody, admins included, can add, change or remove production, deliveries, counts or sales dated then until it’s reopened here.`, 'Close'))) return;
      try { for (const ym of list) await insertRow('closed_periods', { month: `${ym}-01` }); toast(`${label[0].toUpperCase()}${label.slice(1)} closed.`); }
      catch (err) { toast(niceError(err), 'bad'); }
    };
    const reopen = async (ym) => {
      if (!(await confirmDialog(`Reopen ${monthName(ym)}? Its entries can be changed again until it’s closed.`, 'Reopen'))) return;
      try { await deleteRow('closed_periods', 'month', closed.get(ym).month); toast(`${monthName(ym)} reopened.`); }
      catch (err) { toast(niceError(err), 'bad'); }
    };

    const n = (v) => (v ? v.toLocaleString() : '—');
    const monthRow = (ym) => {
      const t = tally.get(ym) || blank(); const c = closed.get(ym); const current = ym >= nowYm;
      return h('tr', { class: 'pr-month' + (c ? ' period-closed' : '') },
        h('td', { class: 'pr-name' }, monthName(ym).replace(/ \d{4}$/, '')),
        h('td', null, h('span', { class: `user-status ${c ? 'off' : current ? 'invited' : 'on'}` }, c ? '🔒 Closed' : current ? 'Current month' : 'Open')),
        h('td', { class: 'num' }, n(t.production.size)), h('td', { class: 'num' }, n(t.receipts)), h('td', { class: 'num' }, n(t.counts.size)), h('td', { class: 'num' }, n(t.sales)),
        h('td', { class: 'muted small' }, c ? `${c.closed_at ? longDate(String(c.closed_at).slice(0, 10)) : ''}${c.closed_by_email ? ` by ${c.closed_by_email}` : ''}`.trim() : ''),
        h('td', { class: 'user-actions' }, !live ? null : c ? h('button', { class: 'btn small', onclick: () => reopen(ym) }, 'Reopen')
          : current ? null : h('button', { class: 'btn small primary', onclick: () => close([ym]) }, 'Close')));
    };
    const yearGroup = (y) => {
      const yms = months.filter((ym) => ym.startsWith(`${y}-`));
      const done = y < nowYear; // a finished year can fold up
      const key = `periods:open:${y}`;
      const isOpen = !done || pref.get(key) === '1';
      const nClosed = yms.filter((ym) => closed.has(ym)).length;
      const openPast = yms.filter((ym) => !closed.has(ym) && ym < nowYm);
      const sum = (f) => yms.reduce((t, ym) => t + f(tally.get(ym) || blank()), 0);
      const toggle = () => { pref.set(key, isOpen ? '0' : '1'); rerender(); };
      const status = nClosed === yms.length ? '🔒 Closed' : done ? `${nClosed} of ${yms.length} months closed` : `${nClosed} closed · ${yms.length - nClosed} open`;
      const head = h('tr', { class: 'pr-year' + (done ? ' foldable' : '') + (isOpen ? ' open' : ''), onclick: done ? toggle : null,
          title: done ? (isOpen ? `Hide ${y}’s months` : `Show ${y}’s months`) : null, 'aria-expanded': done ? String(isOpen) : null },
        h('td', { class: 'pr-name' }, String(y)),
        h('td', null, h('span', { class: `user-status ${nClosed === yms.length ? 'off' : done ? 'on' : 'invited'}` }, status)),
        h('td', { class: 'num' }, n(sum((t) => t.production.size))), h('td', { class: 'num' }, n(sum((t) => t.receipts))), h('td', { class: 'num' }, n(sum((t) => t.counts.size))), h('td', { class: 'num' }, n(sum((t) => t.sales))),
        h('td'),
        // A finished year closes in one go; months are otherwise closed one at a time.
        h('td', { class: 'user-actions' }, live && done && openPast.length ? h('button', { class: 'btn small primary', onclick: (e) => { e.stopPropagation(); close(openPast); } }, 'Close year') : null));
      return h('tbody', { class: 'pr-group' }, head, isOpen ? [...yms].reverse().map(monthRow) : null);
    };

    return h('div', null,
      pageHead('Periods', 'Close a month once its books are final.'),
      h('p', { class: 'small muted pr-intro' }, 'Closing a month locks its production, deliveries, counts and sales for everyone, admins included, until it’s reopened here. Standards, prices and the plan aren’t locked. The current month can’t be closed until it’s over.'),
      !live ? h('div', { class: 'note warn' }, 'Closing months starts working after the next deploy to main.') : null,
      h('div', { class: 'tablewrap' }, h('table', { class: 't periods-table' },
        h('thead', null, h('tr', null, h('th', null, 'Month'), h('th', null, 'Status'), h('th', { class: 'num' }, 'Production days'), h('th', { class: 'num' }, 'Deliveries'),
          h('th', { class: 'num' }, 'Count days'), h('th', { class: 'num' }, 'Sales lines'), h('th', null, 'Closed'), h('th'))),
        years.map(yearGroup))));
  },
};
