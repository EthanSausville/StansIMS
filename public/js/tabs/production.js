import { h, pageHead, qty, numberCell, dateLabel, todayIso } from '../ui.js';
import { state, derived, saveCell } from '../store.js';
import { can, isClosed, closedNote, monthName } from '../perms.js';
import { eachDay, isWeekend } from '../calc.js';
import { downloadXlsx } from '../xlsx.js';

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

const openDays = new Set(); // days whose lots are showing
const short = (iso) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;

// The lots made on a day: who each one shipped to (first in, first out).
function lotDetail(dayLots, ncol) {
  return h('tr', { class: 'lot-detail' }, h('td', { colspan: ncol },
    h('div', { class: 'lot-cards' }, dayLots.map((l) => {
      const shipped = l.cases - l.left; const [recipe, size, pack] = nameParts(l.item || {});
      return h('div', { class: 'lot-card' },
        h('div', { class: 'lot-code mono' }, `Lot ${l.code}`),
        h('div', { class: 'small' }, `${recipe} ${size} · ${pack}`),
        h('div', { class: 'small muted' }, `${qty(l.cases, 2)} made · ${qty(shipped, 2)} shipped · `, h('span', { class: l.left > 1e-9 ? 'strong' : null }, `${qty(l.left, 2)} left`)),
        l.shipments.length ? h('table', { class: 'lot-ships' }, h('tbody', null, l.shipments.map((x) => h('tr', { title: x.invoice ? `Invoice ${x.invoice}` : null },
          h('td', null, short(x.date)), h('td', null, x.customer || '—'), h('td', { class: 'num' }, qty(x.cases, 2))))))
          : h('div', { class: 'small muted' }, 'Not shipped yet.'));
    }))));
}

function exportExcel(fgs, allDays, values, lots) {
  const leftOn = new Map(); for (const l of lots) leftOn.set(l.date, (leftOn.get(l.date) || 0) + l.left);
  const parts = fgs.map(nameParts);
  const daily = [
    ['Date', ...parts.map((p) => p[0]), 'Not shipped'],
    ['', ...parts.map((p) => p[1]), ''],
    ['', ...parts.map((p) => p[2]), ''],
    ...allDays.map((d) => [{ date: d }, ...fgs.map((it) => values.get(`${d}|${it.item_no}`) ?? null), leftOn.has(d) ? leftOn.get(d) : null]),
  ];
  const lotRows = [['Lot', 'Product', 'Made', 'Cases', 'Shipped', 'Left'],
    ...lots.map((l) => [l.code, l.item?.name || '', { date: l.date }, l.cases, l.cases - l.left, l.left])];
  const shipRows = [['Lot', 'Product', 'Made', 'Shipped', 'Customer', 'Invoice', 'Cases'],
    ...lots.flatMap((l) => l.shipments.map((x) => [l.code, l.item?.name || '', { date: l.date }, { date: x.date }, x.customer || '', x.invoice || '', x.cases]))];
  downloadXlsx(`production-${todayIso()}`, [
    { name: 'Production', rows: daily, headRows: 3, freezeCols: 1, widths: [12, ...fgs.map(() => 13), 12] },
    { name: 'Lots', rows: lotRows, widths: [16, 30, 12, 9, 9, 9] },
    { name: 'Shipments', rows: shipRows, widths: [16, 30, 12, 12, 32, 10, 9] },
  ]);
}

function dailyView() {
  const fgs = derived.ix().byType('Finished Good');
  const values = new Map();
  for (const r of state.data.production) values.set(`${r.date}|${r.item_no}`, (values.get(`${r.date}|${r.item_no}`) || 0) + (Number(r.cases) || 0));
  const today = todayIso();
  const first = state.data.production.reduce((m, r) => (r.date < m ? r.date : m), `${today.slice(0, 4)}-01-01`);
  const allDays = [...eachDay(first < '2026-01-01' ? first : '2026-01-01', today)].reverse(); // newest first
  const allowed = can('production', 'edit');
  const save = (date, item_no, v) => saveCell('production', { date, item_no }, 'cases', v);
  const ncol = 2 + fgs.length;

  // Lots: each day's production of a product, traced to the customers it shipped to.
  const { lots, unmatched } = derived.lots();
  const lotsOn = new Map(); for (const l of lots) { if (!lotsOn.has(l.date)) lotsOn.set(l.date, []); lotsOn.get(l.date).push(l); }
  const lotOf = new Map(lots.map((l) => [`${l.date}|${l.item?.item_no}`, l]));
  const leftOf = (list) => list.reduce((t, l) => t + l.left, 0);

  // Month totals for the month rows.
  const monthTotal = new Map(); const monthLeft = new Map();
  for (const [k, v] of values) { const [d, no] = k.split('|'); const mk = `${d.slice(0, 7)}|${no}`; monthTotal.set(mk, (monthTotal.get(mk) || 0) + v); }
  for (const l of lots) monthLeft.set(l.date.slice(0, 7), (monthLeft.get(l.date.slice(0, 7)) || 0) + l.left);

  const leftCell = (v, made) => h('td', { class: 'num lot-left' + (made && v <= 1e-9 ? ' muted' : '') }, made ? (v > 1e-9 ? qty(v, 2) : 'All shipped') : '');
  const rowsFor = (days, prev) => {
    const out = [];
    for (const d of days) {
      const ym = d.slice(0, 7);
      if (ym !== prev) {
        prev = ym;
        const closed = isClosed(d);
        out.push(h('tr', { class: 'month-row' + (closed ? ' closed' : ''), 'data-month': ym },
          h('th', { class: 'sticky-col', scope: 'rowgroup', title: closed ? closedNote(ym) : null }, monthName(ym), closed ? h('span', { class: 'closed-tag' }, ' 🔒 Closed') : null),
          fgs.map((it) => { const t = monthTotal.get(`${ym}|${it.item_no}`); return h('td', { class: 'num' }, t ? qty(t, 2) : ''); }),
          h('td', { class: 'num' }, monthLeft.get(ym) > 1e-9 ? qty(monthLeft.get(ym), 2) : '')));
      }
      const closed = isClosed(d); const dayLots = lotsOn.get(d) || []; const open = dayLots.length && openDays.has(d);
      const toggle = dayLots.length ? h('button', { type: 'button', class: 'lot-toggle', 'aria-expanded': String(!!open), title: open ? 'Hide this day’s lots' : 'Show who this day’s lots shipped to',
        onclick: (e) => {
          const tr = e.currentTarget.closest('tr');
          if (openDays.has(d)) { openDays.delete(d); tr.nextElementSibling?.classList.contains('lot-detail') && tr.nextElementSibling.remove(); }
          else { openDays.add(d); tr.after(lotDetail(dayLots, ncol)); }
          e.currentTarget.setAttribute('aria-expanded', String(openDays.has(d)));
        } }, '▸') : null;
      out.push(h('tr', { class: [isWeekend(d) ? 'weekend' : '', d === today ? 'today' : '', closed ? 'closed-day' : ''].join(' ').trim() || null, 'data-day': d },
        h('td', { class: 'sticky-col' }, h('span', { class: 'date-wrap' }, dateLabel(d), toggle)),
        fgs.map((it) => {
          const l = lotOf.get(`${d}|${it.item_no}`);
          return numberCell(values.get(`${d}|${it.item_no}`) ?? null, (v) => save(d, it.item_no, v), {
            disabled: !allowed || closed, digits: 2, key: `production|${d}|${it.item_no}`,
            title: l ? `${it.name}, ${d} · Lot ${l.code} · ${qty(l.cases - l.left, 2)} shipped, ${qty(l.left, 2)} left` : `${it.name}, ${d}` });
        }),
        leftCell(leftOf(dayLots), dayLots.length)));
      if (open) out.push(lotDetail(dayLots, ncol));
    }
    return out;
  };

  const head = h('thead', null, h('tr', { class: 'fg-head' }, h('th', { class: 'sticky-col' }, 'Date'),
    fgs.map((it) => { const [recipe, size, pack] = nameParts(it); return h('th', { class: 'num fg-name', title: `${it.name} · #${it.item_no}` },
      h('span', { class: 'fg-recipe' }, recipe), h('span', { class: 'fg-size' }, size), h('span', { class: 'fg-pack' }, pack)); }),
    h('th', { class: 'num fg-name', title: 'Cases from the day’s lots not shipped yet (first in, first out)' }, h('span', { class: 'fg-recipe' }, 'Not'), h('span', { class: 'fg-size' }, 'shipped'), h('span', { class: 'fg-pack' }, 'Cases'))));
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
  const top = h('div', { class: 'prod-top' },
    h('span', { class: 'small muted' }, 'Each day’s production of a product is a lot (coded YYMMDD-item). Click ▸ next to a date to see who its lots shipped to.',
      unmatched.length ? ` ${unmatched.length} sale line${unmatched.length > 1 ? 's' : ''} came from stock made before the first lot entered.` : ''),
    h('button', { class: 'btn ghost download', title: 'Download every day, every lot and who it shipped to as an Excel workbook', onclick: () => exportExcel(fgs, allDays, values, lots) }, '⤓ Export to Excel'));
  const box = h('div', { class: 'prod-page' }, top, wrap, more);
  requestAnimationFrame(() => { const sc = scrollParent(wrap); btn.classList.toggle('show', (sc?.scrollTop || 0) > 400); });
  return h('div', null, pageHead('Production', 'Cases produced each day, newest first, with the lots they make. Scroll down for earlier days. Typing math like 24*10 works.'), box, btn);
}

export default {
  id: 'production',
  label: 'Production',
  render() { return dailyView(); },
};

export const stat = (label, value, sub) => h('div', { class: 'stat' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), sub ? h('div', { class: 'small muted' }, sub) : null);
