import { h, pageHead, qty, chip, seg, longDate, numberCell, dateLabel, todayIso } from '../ui.js';
import { state, derived, saveCell } from '../store.js';
import { can, isClosed, closedNote, monthName } from '../perms.js';
import { eachDay, isWeekend } from '../calc.js';
import { xtable, filteredRows, activeFilterCount, clearFilters, downloadButton } from '../xtable.js';

let mode = 'daily';
let lotSel = null;

// Lots: each day's production of a product, traced to the customers it shipped to.
function lotsView(rerender, switcher) {
  const { lots, unmatched } = derived.lots();
  const shipped = (l) => l.cases - l.left;
  const columns = [
    { key: 'code', label: 'Lot', sticky: true, value: (l) => l.code, cell: (l) => h('td', { class: 'sticky-col mono' }, l.code) },
    { key: 'item', label: 'Product', value: (l) => l.item?.name || '', cell: (l) => h('td', null, l.item?.name || '') },
    { key: 'date', label: 'Made', value: (l) => l.date, text: (l) => longDate(l.date), cell: (l) => h('td', null, longDate(l.date)) },
    { key: 'cases', label: 'Cases', num: true, value: (l) => l.cases, cell: (l) => h('td', { class: 'num' }, qty(l.cases)) },
    { key: 'shipped', label: 'Shipped', num: true, value: (l) => shipped(l), cell: (l) => h('td', { class: 'num' }, qty(shipped(l))) },
    { key: 'left', label: 'Left', num: true, value: (l) => l.left, cell: (l) => h('td', { class: 'num' + (l.left ? ' strong' : ' muted') }, qty(l.left)) },
    { key: 'customers', label: 'Customers', num: true, value: (l) => new Set(l.shipments.map((x) => x.customer)).size, cell: (l) => h('td', { class: 'num' }, new Set(l.shipments.map((x) => x.customer)).size || '') },
  ];
  const shown = filteredRows({ id: 'lots', columns, rows: lots, defaultSort: { key: 'date', dir: 'desc' } });
  const sel = lotSel ? lots.find((l) => l.code === lotSel) : null;
  const nFilters = activeFilterCount('lots');
  const detail = sel ? h('div', { class: 'side-detail' },
    h('strong', null, `Lot ${sel.code}`), h('div', { class: 'small muted' }, `${sel.item?.name} · made ${longDate(sel.date)} · ${qty(sel.cases)} cases`),
    sel.shipments.length ? h('table', { class: 't side-orders' }, h('thead', null, h('tr', null, h('th', null, 'Shipped'), h('th', null, 'Customer'), h('th', { class: 'num' }, 'Cases'))),
      h('tbody', null, sel.shipments.map((x) => h('tr', { title: x.invoice ? `Invoice ${x.invoice}` : null }, h('td', null, `${Number(x.date.slice(5, 7))}/${Number(x.date.slice(8, 10))}`), h('td', null, x.customer || '—'), h('td', { class: 'num' }, qty(x.cases))))))
      : h('p', { class: 'small muted' }, 'Not shipped yet.'),
    sel.left ? h('div', { class: 'small muted' }, `${qty(sel.left)} cases not shipped yet.`) : null)
    : h('p', { class: 'small muted' }, 'Click a lot to see who it shipped to.');
  return h('div', null,
    pageHead('Production Lots', 'Each day’s production of a product is a lot, coded YYMMDD-item number (260714-500001 = made July 14, 2026). Sales are matched to lots first in, first out: the oldest lot made on or before the sale date ships first. Use it to trace a lot to the customers who received it.',
      switcher, chip('Lots', lots.length), detail,
      unmatched.length ? h('p', { class: 'small muted' }, `${unmatched.length} sale line${unmatched.length > 1 ? 's' : ''} came from stock made before the first lot entered.`) : null,
      downloadButton('production-lots', columns, shown),
      nFilters ? h('button', { class: 'btn ghost', onclick: () => { clearFilters('lots'); rerender(); } }, `Clear filters (${nFilters})`) : null),
    lots.length ? h('div', { class: 'tablewrap', 'data-scroll': 'lots' }, xtable({ id: 'lots', columns, allRows: lots, rows: shown, rerender, defaultSort: { key: 'date', dir: 'desc' },
      className: 'selectable', rowClass: (l) => (l.code === lotSel ? 'selected' : null), onRowClick: (l) => { lotSel = l.code === lotSel ? null : l.code; rerender(); } }))
      : h('div', { class: 'panel empty' }, 'No production entered yet.'));
}

// Splits a product name into its three header lines: recipe, container, case.
//   "Original 7 oz. (Case of 24)" -> Original / 7 oz / Case of 24
//   "Original gallon"             -> Original / Gallon / Each
export function nameParts(it) {
  const m = /^(.*?)\s+(\d+(?:\.\d+)?\s*oz\.?|gallon)\s*(?:\((.*)\))?\s*$/i.exec(it.name || '');
  if (!m) return [it.name || '', '', it.pack_note || ''];
  const size = /gallon/i.test(m[2]) ? 'Gallon' : m[2].replace(/\s*oz\.?$/i, ' oz');
  return [m[1], size, m[3] || it.pack_note || 'Each'];
}

const CHUNK = 62; // days added each time the bottom of the list comes into view
let shownDays = CHUNK;
let topBtn = null;

// Back to top: a button in the bottom right once the page has scrolled down.
function scrollParent(el) {
  for (let p = el?.parentElement; p; p = p.parentElement) { const o = getComputedStyle(p).overflowY; if ((o === 'auto' || o === 'scroll') && p.scrollHeight > p.clientHeight) return p; }
  return document.scrollingElement;
}
function onAnyScroll(e) {
  if (!topBtn?.isConnected) return;
  const t = e.target === document ? document.scrollingElement : e.target;
  if (!t?.contains?.(topBtn.previousElementSibling)) return;
  topBtn.classList.toggle('show', t.scrollTop > 400);
}
document.addEventListener('scroll', onAnyScroll, { capture: true, passive: true });

function dailyView(switcher) {
  const fgs = derived.ix().byType('Finished Good');
  const values = new Map(state.data.production.map((r) => [`${r.date}|${r.item_no}`, r.cases]));
  const today = todayIso();
  const first = state.data.production.reduce((m, r) => (r.date < m ? r.date : m), `${today.slice(0, 4)}-01-01`);
  const allDays = [...eachDay(first < '2026-01-01' ? first : '2026-01-01', today)].reverse(); // newest first
  const allowed = can('production', 'edit');
  const save = (date, item_no, v) => saveCell('production', { date, item_no }, 'cases', v);
  const ncol = 1 + fgs.length;

  // Month totals for the month rows.
  const monthTotal = new Map();
  for (const r of state.data.production) { const k = `${r.date.slice(0, 7)}|${r.item_no}`; monthTotal.set(k, (monthTotal.get(k) || 0) + (Number(r.cases) || 0)); }

  const rowsFor = (days, prev) => {
    const out = [];
    for (const d of days) {
      const ym = d.slice(0, 7);
      if (ym !== prev) {
        prev = ym;
        const closed = isClosed(d);
        out.push(h('tr', { class: 'month-row' + (closed ? ' closed' : ''), 'data-month': ym },
          h('th', { class: 'sticky-col', scope: 'rowgroup', title: closed ? closedNote(ym) : null }, monthName(ym), closed ? h('span', { class: 'closed-tag' }, ' 🔒 Closed') : null),
          fgs.map((it) => { const t = monthTotal.get(`${ym}|${it.item_no}`); return h('td', { class: 'num' }, t ? qty(t, 2) : ''); })));
      }
      const closed = isClosed(d);
      out.push(h('tr', { class: [isWeekend(d) ? 'weekend' : '', d === today ? 'today' : '', closed ? 'closed-day' : ''].join(' ').trim() || null },
        h('td', { class: 'sticky-col' }, dateLabel(d)),
        fgs.map((it) => numberCell(values.get(`${d}|${it.item_no}`) ?? null, (v) => save(d, it.item_no, v), {
          disabled: !allowed || closed, digits: 2, key: `production|${d}|${it.item_no}`, title: `${it.name}, ${d}` }))));
    }
    return out;
  };

  const head = h('thead', null, h('tr', { class: 'fg-head' }, h('th', { class: 'sticky-col' }, 'Date'),
    fgs.map((it) => { const [recipe, size, pack] = nameParts(it); return h('th', { class: 'num fg-name', title: `${it.name} · #${it.item_no}` },
      h('span', { class: 'fg-recipe' }, recipe), h('span', { class: 'fg-size' }, size), h('span', { class: 'fg-pack' }, pack)); })));
  shownDays = Math.min(Math.max(shownDays, CHUNK), allDays.length);
  const body = h('tbody', null, rowsFor(allDays.slice(0, shownDays), null));
  const more = h('div', { class: 'load-more small muted' }, shownDays < allDays.length ? 'Loading earlier days…' : `That’s everything back to ${monthName(allDays.at(-1).slice(0, 7))}.`);
  const loadMore = () => {
    if (shownDays >= allDays.length) return;
    const prev = allDays[shownDays - 1].slice(0, 7);
    const next = allDays.slice(shownDays, shownDays + CHUNK);
    shownDays += next.length;
    body.append(...rowsFor(next, prev));
    if (shownDays >= allDays.length) { more.textContent = `That’s everything back to ${monthName(allDays.at(-1).slice(0, 7))}.`; io.disconnect(); }
  };
  const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) loadMore(); }, { rootMargin: '600px 0px' });
  requestAnimationFrame(() => { if (more.isConnected) io.observe(more); });

  const wrap = h('div', { class: 'tablewrap tall prod-wrap', 'data-scroll': 'production' }, h('table', { class: 't prod-table' }, head, body));
  const btn = h('button', { type: 'button', class: 'to-top', title: 'Back to today', 'aria-label': 'Back to top', onclick: () => {
    const sc = scrollParent(wrap); sc.scrollTo({ top: 0, behavior: 'smooth' });
  } }, '↑');
  topBtn = btn;
  const box = h('div', { class: 'prod-page' }, h('div', { class: 'prod-top' }, switcher), wrap, more);
  requestAnimationFrame(() => { const sc = scrollParent(wrap); btn.classList.toggle('show', (sc?.scrollTop || 0) > 400); });
  return h('div', null, pageHead('Production', 'Cases produced each day, newest first. Scroll down for earlier days. Typing math like 24*10 works.'), box, btn);
}

export default {
  id: 'production',
  label: 'Production',
  render({ rerender }) {
    const switcher = seg([['daily', 'Daily'], ['lots', 'Lots']], mode, (m) => { mode = m; rerender(); });
    if (mode === 'lots') return lotsView(rerender, switcher);
    return dailyView(switcher);
  },
};

export const stat = (label, value, sub) => h('div', { class: 'stat' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), sub ? h('div', { class: 'small muted' }, sub) : null);
