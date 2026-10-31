// Settings → Periods (admins): close a month once its books are final, so
// nobody can add, change or remove its production, deliveries, counts or sales.
// The database enforces it (public.period_guard), for admins too, until the
// month is reopened. Closing and reopening are recorded in Change history.
import { h, pageHead, toast, niceError, confirmDialog, todayIso, longDate } from '../ui.js';
import { state, insertRow, deleteRow } from '../store.js';
import { monthName } from '../perms.js';

const ymOf = (d) => String(d).slice(0, 7);
const nextYm = (ym) => { const [y, m] = ym.split('-').map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`; };

export default {
  id: 'periods',
  label: 'Periods',
  adminOnly: true,
  render() {
    const d = state.data;
    const live = !d.missingTables?.has('closed_periods');
    const closed = new Map((d.closed_periods || []).map((c) => [ymOf(c.month), c]));
    const nowYm = ymOf(todayIso());
    // Every month from the first entry to this month, newest first.
    const tally = new Map();
    const bump = (date, k) => { const ym = ymOf(date); if (!tally.has(ym)) tally.set(ym, { production: new Set(), receipts: 0, counts: new Set(), sales: 0 }); const t = tally.get(ym);
      if (k === 'production') t.production.add(date); else if (k === 'counts') t.counts.add(date); else t[k]++; };
    for (const r of d.production) if (Number(r.cases)) bump(r.date, 'production');
    for (const r of d.goods_receipts) if (Number(r.qty)) bump(r.date, 'receipts');
    for (const r of d.cycle_counts) bump(r.date, 'counts');
    for (const r of d.sales) bump(r.date, 'sales');
    const first = [...tally.keys(), ...closed.keys()].sort()[0] || nowYm;
    const months = []; for (let ym = first; ym <= nowYm; ym = nextYm(ym)) months.push(ym);
    months.reverse();

    const close = async (yms) => {
      const list = yms.filter((ym) => !closed.has(ym));
      if (!list.length) return;
      const label = list.length === 1 ? monthName(list[0]) : `${list.length} months (${monthName(list.at(-1))} – ${monthName(list[0])})`;
      if (!(await confirmDialog(`Close ${label}? Nobody, admins included, can add, change or remove production, deliveries, counts or sales dated then until it’s reopened here.`, 'Close'))) return;
      try { for (const ym of list) await insertRow('closed_periods', { month: `${ym}-01` }); toast(`${label} closed.`); }
      catch (err) { toast(niceError(err), 'bad'); }
    };
    const reopen = async (ym) => {
      if (!(await confirmDialog(`Reopen ${monthName(ym)}? Its entries can be changed again until it’s closed.`, 'Reopen'))) return;
      try { await deleteRow('closed_periods', 'month', closed.get(ym).month); toast(`${monthName(ym)} reopened.`); }
      catch (err) { toast(niceError(err), 'bad'); }
    };

    const past = months.filter((ym) => ym < nowYm);
    const openPast = past.filter((ym) => !closed.has(ym));
    const through = h('select', { 'aria-label': 'Close everything through', disabled: !live || !openPast.length },
      openPast.map((ym) => h('option', { value: ym }, monthName(ym))));
    const n = (v) => (v ? v.toLocaleString() : '—');
    return h('div', null,
      pageHead('Periods', 'Close a month once its books are final.',
        h('label', { class: 'field' }, 'Close everything through', through),
        h('button', { class: 'btn primary', disabled: !live || !openPast.length, onclick: () => close(past.filter((ym) => ym <= through.value)) }, 'Close'),
        h('p', { class: 'small muted' }, 'Closing a month locks its production, deliveries, counts and sales for everyone, admins included, until it’s reopened here. Standards, prices and the plan aren’t locked. The current month can’t be closed until it’s over.')),
      !live ? h('div', { class: 'note warn' }, 'Closing months starts working after the next deploy to main.') : null,
      h('div', { class: 'tablewrap' }, h('table', { class: 't periods-table' },
        h('thead', null, h('tr', null, h('th', null, 'Month'), h('th', null, 'Status'), h('th', { class: 'num' }, 'Production days'), h('th', { class: 'num' }, 'Deliveries'),
          h('th', { class: 'num' }, 'Count days'), h('th', { class: 'num' }, 'Sales lines'), h('th', null, 'Closed'), h('th'))),
        h('tbody', null, months.map((ym) => {
          const t = tally.get(ym) || { production: new Set(), receipts: 0, counts: new Set(), sales: 0 };
          const c = closed.get(ym); const current = ym >= nowYm;
          return h('tr', { class: c ? 'period-closed' : null },
            h('td', null, h('strong', null, monthName(ym))),
            h('td', null, h('span', { class: `user-status ${c ? 'off' : current ? 'invited' : 'on'}` }, c ? '🔒 Closed' : current ? 'Current month' : 'Open')),
            h('td', { class: 'num' }, n(t.production.size)), h('td', { class: 'num' }, n(t.receipts)), h('td', { class: 'num' }, n(t.counts.size)), h('td', { class: 'num' }, n(t.sales)),
            h('td', { class: 'muted small' }, c ? `${c.closed_at ? longDate(String(c.closed_at).slice(0, 10)) : ''}${c.closed_by_email ? ` by ${c.closed_by_email}` : ''}`.trim() : ''),
            h('td', { class: 'user-actions' }, !live ? null : c ? h('button', { class: 'btn small', onclick: () => reopen(ym) }, 'Reopen')
              : current ? null : h('button', { class: 'btn small primary', onclick: () => close([ym]) }, 'Close')));
        })))));
  },
};
