// A month of days down the side and items across the top, like the daily
// sheets in the workbook (Production, GoodsReceipt, CycleCounts, ...).
import { h, numberCell, dateLabel, qty, todayIso, longDate } from '../ui.js';
import { eachDay, isWeekend, monthEnd, hasReceiving, holdsLabel, COMPANY_START } from '../calc.js';
import { monthName, isClosed, closedNote } from '../perms.js';

const perLabel = (it) => (hasReceiving(it) ? `1 ${it.receiving_unit} = ${holdsLabel(it)}` : '');
import { totalsFoot } from '../xtable.js';

// A month's days (none before the company was purchased).
export const monthDays = ({ year, month }) => { const first = `${year}-${String(month).padStart(2, '0')}-01`; return [...eachDay(first < COMPANY_START ? COMPANY_START : first, monthEnd(year, month))]; };

// Header rows: item type, item name, and (optionally) pack size notes.
// `before`/`after` are extra calculated column labels.
export function itemHead(items, { before = [], after = [], notes = true, firstLabel = 'Date' } = {}) {
  const groups = []; for (const it of items) { const g = groups.at(-1); if (g && g.type === it.type) g.n++; else groups.push({ type: it.type, n: 1 }); }
  const pad = (n) => Array.from({ length: n }, () => h('th'));
  const rows = [
    h('tr', { class: 'group' }, h('th', { class: 'sticky-col' }), pad(before.length), groups.map((g) => h('th', { colspan: g.n }, h('span', { class: 'band-label' }, g.type === 'Component' ? 'Packaging' : g.type))), pad(after.length)),
    h('tr', null, h('th', { class: 'sticky-col' }, firstLabel), before.map((b) => h('th', { class: 'num wrap' }, b)),
      items.map((it) => h('th', { class: 'num wrap', title: `${it.name} · #${it.item_no}${it.unit ? ' · ' + it.unit : ''}` }, it.name)),
      after.map((b) => h('th', { class: 'num wrap' }, b))),
  ];
  if (notes) rows.push(h('tr', null, h('th', { class: 'sticky-col' }), pad(before.length),
    items.map((it) => h('th', { class: 'num' }, perLabel(it) || it.pack_note || it.unit || '')), pad(after.length)));
  return h('thead', null, rows);
}

// Editable month grid backed by one keyed table (date, item_no, field).
//   before(date) / after(date): arrays of <td> for calculated columns
//   cellClass(date, item): extra class for a cell (e.g. a warning outline)
export function entryGrid({ table, field, items, ym, editable, before, after, beforeLabels = [], afterLabels = [], cellClass, rows, notes = true, footer = true, digits = 4, rerender }) {
  const values = new Map(rows.map((r) => [`${r.date}|${r.item_no}`, r[field]]));
  const today = todayIso();
  const ymKey = `${ym.year}-${String(ym.month).padStart(2, '0')}`;
  const closed = isClosed(`${ymKey}-01`); // a closed month can't be changed (Settings → Periods)
  const days = monthDays(ym);
  const totals = items.map(() => 0);
  const body = h('tbody', null, days.map((d) => h('tr', { class: [isWeekend(d) ? 'weekend' : '', d === today ? 'today' : ''].join(' ').trim() || null },
    h('td', { class: 'sticky-col' }, dateLabel(d)),
    before ? before(d) : null,
    items.map((it, i) => {
      const v = values.get(`${d}|${it.item_no}`);
      if (typeof v === 'number') totals[i] += v;
      return numberCell(v ?? null, (nv) => editable.save(d, it.item_no, nv), {
        disabled: !editable.allowed || closed, digits, key: `${table}|${d}|${it.item_no}`,
        title: `${it.name}, ${d}`, cls: cellClass ? cellClass(d, it) : null });
    }),
    after ? after(d) : null)));
  const foot = footer ? totalsFoot({ id: `grid-${table}`, rerender, width: 1 + beforeLabels.length + items.length + afterLabels.length,
    label: 'Month total', cells: [beforeLabels.map(() => h('td')), totals.map((t) => h('td', { class: 'num' }, t ? qty(t, 2) : '')), afterLabels.map(() => h('td'))] }) : null;
  const wrap = h('div', { class: 'tablewrap tall', 'data-scroll': table },
    h('table', { class: 't' + (closed ? ' closed-month' : '') }, itemHead(items, { before: beforeLabels, after: afterLabels, notes }), body, foot));
  return closed ? [h('div', { class: 'note closed-note' }, '🔒 ', closedNote(ymKey)), wrap] : wrap;
}

// Read-only month grid: value(date, item) -> number|null.
export function viewGrid({ id, items, ym, value, cellClass, before, beforeLabels = [], notes = true, digits = 2, footer }) {
  const today = todayIso();
  return h('div', { class: 'tablewrap tall', 'data-scroll': id },
    h('table', { class: 't' }, itemHead(items, { before: beforeLabels, notes }),
      h('tbody', null, monthDays(ym).map((d) => h('tr', { class: [isWeekend(d) ? 'weekend' : '', d === today ? 'today' : ''].join(' ').trim() || null },
        h('td', { class: 'sticky-col' }, dateLabel(d)),
        before ? before(d) : null,
        items.map((it) => {
          const v = value(d, it);
          const cls = ['num', v === null || v === undefined ? 'blank' : '', typeof v === 'number' && v < 0 ? 'neg' : '', cellClass ? cellClass(d, it, v) : ''].join(' ');
          return h('td', { class: cls }, v === null || v === undefined ? '' : qty(v, digits));
        })))),
      footer || null));
}

// The month shown on the daily tabs, shared so switching tabs keeps your place.
export const view = { ym: { year: Number(todayIso().slice(0, 4)), month: Number(todayIso().slice(5, 7)) } };

// ---------- Endless day list ----------
// Every day from today back to the day the company was purchased, newest
// first, a month at a time: more days load as the bottom comes into view, and
// a button in the bottom right goes back to the top (today).
//   dayRows(day) -> the <tr>s for a day (the day's own row and any extra rows)
//   monthCells(ym) -> the cells after the month name in a month's header row
const CHUNK = 62; // days added each time the bottom of the list comes into view
const shown = new Map(); // list id -> how many days are showing (kept across re-renders)
let topBtn = null;
function scrollParent(el) {
  for (let p = el?.parentElement; p; p = p.parentElement) { const o = getComputedStyle(p).overflowY; if ((o === 'auto' || o === 'scroll') && p.scrollHeight > p.clientHeight) return p; }
  return document.scrollingElement;
}
document.addEventListener('scroll', (e) => {
  if (!topBtn?.isConnected) return;
  const t = e.target === document ? document.scrollingElement : e.target;
  if (!t?.contains?.(topBtn._list)) return;
  topBtn.classList.toggle('show', t.scrollTop > 400);
}, { capture: true, passive: true });

export const dayRowClass = (d, today = todayIso()) => [isWeekend(d) ? 'weekend' : '', d === today ? 'today' : '', isClosed(d) ? 'closed-day' : ''].join(' ').trim() || null;

export function endlessDays({ id, tableClass = '', head, dayRows, monthCells, lead = 1 }) {
  const today = todayIso();
  const allDays = [...eachDay(COMPANY_START, today)].reverse();
  const n = Math.min(Math.max(shown.get(id) || CHUNK, CHUNK), allDays.length); shown.set(id, n);
  const rowsFor = (days, prev) => {
    const out = [];
    for (const d of days) {
      const ym = d.slice(0, 7);
      if (ym !== prev) {
        prev = ym; const closed = isClosed(d);
        out.push(h('tr', { class: 'month-row' + (closed ? ' closed' : ''), 'data-month': ym },
          h('th', { class: 'sticky-col', scope: 'rowgroup', colspan: lead > 1 ? lead : null, title: closed ? closedNote(ym) : null }, monthName(ym), closed ? h('span', { class: 'closed-tag' }, ' 🔒 Closed') : null),
          monthCells(ym)));
      }
      out.push(...[dayRows(d)].flat(Infinity).filter(Boolean));
    }
    return out;
  };
  const body = h('tbody', null, rowsFor(allDays.slice(0, n), null));
  const endNote = `That’s everything: the company was purchased on ${longDate(COMPANY_START)}.`;
  const more = h('div', { class: 'load-more small muted' }, n < allDays.length ? 'Loading earlier days…' : endNote);
  const io = new IntersectionObserver((es) => {
    if (!es.some((e) => e.isIntersecting)) return;
    const have = shown.get(id); if (have >= allDays.length) return;
    const next = allDays.slice(have, have + CHUNK); shown.set(id, have + next.length);
    body.append(...rowsFor(next, allDays[have - 1].slice(0, 7)));
    if (have + next.length >= allDays.length) { more.textContent = endNote; io.disconnect(); }
  }, { rootMargin: '600px 0px' });
  requestAnimationFrame(() => { if (more.isConnected) io.observe(more); });
  const wrap = h('div', { class: 'tablewrap tall day-list', 'data-scroll': id }, h('table', { class: `t ${tableClass}`.trim() }, head, body));
  const btn = h('button', { type: 'button', class: 'to-top', title: 'Back to today', 'aria-label': 'Back to top', onclick: () => scrollParent(wrap).scrollTo({ top: 0, behavior: 'smooth' }) }, '↑');
  btn._list = wrap; topBtn = btn;
  requestAnimationFrame(() => btn.classList.toggle('show', (scrollParent(wrap)?.scrollTop || 0) > 400));
  return { allDays, list: [wrap, more, btn] };
}
