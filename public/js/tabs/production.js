// The Production module:
//   Daily     every day's cases, newest first, scrolling back
//   Lots      every lot, traced to the customers it shipped to
//   New Lots  the simple way in: pick the day, type the cases made, save
import { h, pageHead, qty, numberCell, dateLabel, todayIso, chip, longDate, toast, niceError, DOW } from '../ui.js';
import { state, derived, saveCell } from '../store.js';
import { can, isClosed, closedNote, monthName } from '../perms.js';
import { eachDay, isWeekend, lotCode, productionDays, toDate } from '../calc.js';
import { downloadXlsx } from '../xlsx.js';
import { xtable, filteredRows, activeFilterCount, clearFilters } from '../xtable.js';

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

function exportExcel(fgs, allDays, values) {
  const parts = fgs.map(nameParts);
  const daily = [
    ['Date', ...parts.map((p) => p[0])],
    ['', ...parts.map((p) => p[1])],
    ['', ...parts.map((p) => p[2])],
    ...allDays.map((d) => [{ date: d }, ...fgs.map((it) => values.get(`${d}|${it.item_no}`) ?? null)]),
  ];
  downloadXlsx(`production-${todayIso()}`, [{ name: 'Production', rows: daily, headRows: 3, freezeCols: 1, widths: [12, ...fgs.map(() => 13)] }]);
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

  // Month totals for the month rows.
  const monthTotal = new Map();
  for (const [k, v] of values) { const [d, no] = k.split('|'); const mk = `${d.slice(0, 7)}|${no}`; monthTotal.set(mk, (monthTotal.get(mk) || 0) + v); }

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
      out.push(h('tr', { class: [isWeekend(d) ? 'weekend' : '', d === today ? 'today' : '', closed ? 'closed-day' : ''].join(' ').trim() || null, 'data-day': d },
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
  const top = h('div', { class: 'prod-top' },
    h('button', { class: 'btn ghost download', title: 'Download every day’s production as an Excel workbook', onclick: () => exportExcel(fgs, allDays, values) }, '⤓ Export to Excel'));
  const box = h('div', { class: 'prod-page' }, top, wrap, more);
  requestAnimationFrame(() => { const sc = scrollParent(wrap); btn.classList.toggle('show', (sc?.scrollTop || 0) > 400); });
  return h('div', null, pageHead('Production', 'Cases produced each day, newest first. Scroll down for earlier days. Typing math like 24*10 works.'), box, btn);
}

export default {
  id: 'production',
  label: 'Daily',
  render() { return dailyView(); },
};

// ---------- Lots ----------
// Each day's production of a product is a lot. Sales are matched to lots first
// in, first out, so a lot can be traced to the customers who received it.
let lotSel = null;
function exportLots(lots) {
  downloadXlsx(`production-lots-${todayIso()}`, [
    { name: 'Lots', rows: [['Lot', 'Product', 'Made', 'Cases', 'Shipped', 'Left'], ...lots.map((l) => [l.code, l.item?.name || '', { date: l.date }, l.cases, l.cases - l.left, l.left])], widths: [16, 30, 12, 9, 9, 9] },
    { name: 'Shipments', rows: [['Lot', 'Product', 'Made', 'Shipped', 'Customer', 'Invoice', 'Cases'],
      ...lots.flatMap((l) => l.shipments.map((x) => [l.code, l.item?.name || '', { date: l.date }, { date: x.date }, x.customer || '', x.invoice || '', x.cases]))], widths: [16, 30, 12, 12, 32, 10, 9] },
  ]);
}
function lotsView(rerender) {
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
      chip('Lots', lots.length), detail,
      unmatched.length ? h('p', { class: 'small muted' }, `${unmatched.length} sale line${unmatched.length > 1 ? 's' : ''} came from stock made before the first lot entered.`) : null,
      h('button', { class: 'btn ghost download', title: 'Download the lots showing, and who each shipped to, as an Excel workbook', onclick: () => exportLots(shown) }, '⤓ Export to Excel'),
      nFilters ? h('button', { class: 'btn ghost', onclick: () => { clearFilters('lots'); rerender(); } }, `Clear filters (${nFilters})`) : null),
    lots.length ? h('div', { class: 'tablewrap', 'data-scroll': 'lots' }, xtable({ id: 'lots', columns, allRows: lots, rows: shown, rerender, defaultSort: { key: 'date', dir: 'desc' },
      className: 'selectable', rowClass: (l) => (l.code === lotSel ? 'selected' : null), onRowClick: (l) => { lotSel = l.code === lotSel ? null : l.code; rerender(); } }))
      : h('div', { class: 'panel empty' }, 'No production entered yet.'));
}

export const lotsTab = { id: 'lots', label: 'Lots', render({ rerender }) { return lotsView(rerender); } };

// ---------- New Lots ----------
// Production's way in, like New Receipts: pick the day, type the cases made of
// each product, save. Each product made that day is a lot.
const DAY_MINUTES = 8 * 60, SETUP_MINUTES = 45, BATCH_MINUTES = 25;
const BATCHES_A_DAY = Math.floor((DAY_MINUTES - SETUP_MINUTES) / BATCH_MINUTES);
let nlDay = todayIso();
let nlTyped = {};    // item_no -> text typed but not saved yet
let nlSaved = null;  // { day, lines: [{ item, n, before }] }
const fullDay = (iso) => `${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][toDate(iso).getUTCDay()]}, ${longDate(iso)}`;
const parseCases = (t) => { t = String(t ?? '').trim().replace(/,/g, ''); if (!t) return null; return /^\d*\.?\d+$|^\d+\.$/.test(t) ? Number(t) : NaN; };
const hm = (min) => `${Math.floor(min / 60)}h${String(Math.round(min % 60)).padStart(2, '0')}`;

function newLotsView(rerender) {
  const fgs = derived.ix().byType('Finished Good');
  const day = nlDay;
  const already = new Map(); for (const r of state.data.production) if (r.date === day) already.set(r.item_no, (already.get(r.item_no) || 0) + (Number(r.cases) || 0));
  const isToday = day === todayIso();
  const closed = isClosed(day); const allowed = can('newlots', 'edit'); const locked = closed || !allowed;
  const lines = () => fgs.map((item) => ({ item, n: parseCases(nlTyped[item.item_no]) })).filter((l) => l.n !== null);

  const saveBtn = h('button', { class: 'btn primary big', type: 'submit' }, 'Save production');
  const summary = h('div', { class: 'dl-summary' });
  const time = h('div', { class: 'small muted nl-time' });
  const refresh = () => {
    const ls = lines(); const bad = ls.filter((l) => Number.isNaN(l.n)); const good = ls.filter((l) => l.n > 0);
    saveBtn.disabled = !good.length || bad.length > 0 || locked;
    summary.textContent = bad.length ? `Fix the number for ${bad.map((l) => l.item.name).join(', ')} (numbers only, like 24 or 120).`
      : good.length ? `Ready to save ${good.length} lot${good.length > 1 ? 's' : ''} for ${fullDay(day)}.` : 'Type how many cases were made of each product.';
    summary.classList.toggle('bad', bad.length > 0);
    // The day's batches (this entry plus anything already in), and the time they take.
    const rows = [...already].map(([item_no, cases]) => ({ date: day, item_no, cases }));
    for (const l of good) rows.push({ date: day, item_no: l.item.item_no, cases: l.n });
    const pd = rows.length ? productionDays({ ...state.data, production: rows })[0] : null;
    const b = pd?.batches || 0; const min = b ? SETUP_MINUTES + b * BATCH_MINUTES : 0;
    time.textContent = b ? `${b} batch${b > 1 ? 'es' : ''} this day: about ${hm(min)} with setup (45 min, then 25 min a batch). An 8-hour day holds ${BATCHES_A_DAY}.` : '';
    time.classList.toggle('bad', b > BATCHES_A_DAY);
  };

  const row = (item) => {
    const [recipe, size, pack] = nameParts(item);
    const input = h('input', { type: 'text', inputmode: 'decimal', class: 'dl-input', 'aria-label': `Cases of ${item.name}`, 'data-k': `nl|${item.item_no}`,
      value: nlTyped[item.item_no] ?? '', autocomplete: 'off', disabled: locked,
      oninput: (e) => { nlTyped[item.item_no] = e.target.value; input.classList.toggle('error', Number.isNaN(parseCases(e.target.value))); refresh(); },
      onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); const all = [...document.querySelectorAll('.dl-input')]; const i = all.indexOf(e.target); (all[i + 1] || saveBtn).focus(); } } });
    const before = already.get(item.item_no);
    return h('div', { class: 'dl-row' },
      h('div', { class: 'dl-name' }, h('strong', null, `${size} · ${pack}`), h('span', { class: 'small muted mono' }, `Lot ${lotCode(day, item.item_no)}`)),
      h('div', { class: 'dl-entry' }, input, h('span', { class: 'dl-unit' }, 'cases')),
      h('div', { class: 'dl-side' }, before ? h('span', { class: 'small muted dl-before' }, `Already in for this day: ${qty(before, 2)} cases`) : null));
  };
  const groups = []; for (const it of fgs) { const r = nameParts(it)[0]; const g = groups.find((x) => x[0] === r); if (g) g[1].push(it); else groups.push([r, [it]]); }

  const save = async (e) => {
    e.preventDefault();
    const ls = lines().filter((l) => l.n > 0);
    if (!ls.length || lines().some((l) => Number.isNaN(l.n))) return;
    saveBtn.disabled = true; const done = [];
    try {
      for (const { item, n } of ls) {
        const before = already.get(item.item_no) || 0;
        await saveCell('production', { date: day, item_no: item.item_no }, 'cases', before + n);
        done.push({ item, n, before });
      }
      nlTyped = {}; nlSaved = { day, lines: done };
      toast(`Production saved for ${fullDay(day)}.`); rerender();
    } catch (err) { toast(niceError(err), 'bad'); saveBtn.disabled = false; }
  };
  const undo = async () => {
    try { for (const l of nlSaved.lines) await saveCell('production', { date: nlSaved.day, item_no: l.item.item_no }, 'cases', l.before || null); toast('Production taken back out.'); nlSaved = null; rerender(); }
    catch (err) { toast(niceError(err), 'bad'); }
  };
  const dateInput = h('input', { type: 'date', class: 'big-date', value: day, max: todayIso(), 'aria-label': 'Production date',
    onchange: (e) => { if (e.target.value) { nlDay = e.target.value; nlSaved = null; rerender(); } } });
  refresh();
  return h('div', null,
    pageHead('New Lots', 'For the production line: pick the day, type how many cases of each product were made, and press Save production. Each product made that day is a lot. If something was already entered for that day, this adds to it.',
      h('label', { class: 'field' }, 'Production date', dateInput),
      h('div', { class: 'dl-day' }, isToday ? 'Today' : DOW[toDate(day).getUTCDay()], ' · ', longDate(day)),
      !isToday ? h('button', { class: 'btn', onclick: () => { nlDay = todayIso(); nlSaved = null; rerender(); } }, 'Back to today') : null),
    !allowed ? h('div', { class: 'note warn' }, 'Your role can view production but not enter it.') : closed ? h('div', { class: 'note closed-note' }, '🔒 ', closedNote(day.slice(0, 7))) : null,
    nlSaved ? h('section', { class: 'panel dl-saved' },
      h('h2', null, '✓ Saved'),
      h('ul', null, nlSaved.lines.map((l) => h('li', null, h('strong', null, `${qty(l.n, 2)} cases`), ` of ${l.item.name}`, h('span', { class: 'muted mono' }, ` · Lot ${lotCode(nlSaved.day, l.item.item_no)}`)))),
      h('div', { class: 'small muted' }, `Made ${fullDay(nlSaved.day)}.`),
      h('button', { class: 'btn', onclick: undo }, 'Undo')) : null,
    h('form', { class: 'delivery', onsubmit: save },
      h('h2', { class: 'dl-title' }, `What was made on ${fullDay(day)}?`),
      groups.map(([title, items]) => h('section', { class: 'dl-group' }, h('h3', null, title), items.map(row))),
      h('div', { class: 'dl-bar' }, h('div', null, summary, time), saveBtn)));
}
export const newLotsTab = { id: 'newlots', label: 'New Lots', render({ rerender }) { return newLotsView(rerender); } };

export const stat = (label, value, sub) => h('div', { class: 'stat' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), sub ? h('div', { class: 'small muted' }, sub) : null);
