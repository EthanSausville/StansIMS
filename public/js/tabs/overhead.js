// Standards → Overhead: the standard overhead cost per minute for each year,
// which Overhead (item 300002) uses on Master List and in every BOM. List each
// kind of overhead (electricity, water & sewer, rent, insurance...) with what
// it costs a year; the rate is the year's total divided by the minutes the line
// runs (hours a week and weeks from the Labor tab). See overheadRate in calc.js.
import { h, pageHead, numberCell, money, qty, fmt, toast, niceError, confirmDialog, thisYear, seg } from '../ui.js';
import { state, saveRow, insertRow, updateRow, deleteRow } from '../store.js';
import { can as canArea, standardsLocked, lockedNote } from '../perms.js';
import { overheadRate, overheadAnnual, laborYears, OVERHEAD_ITEM } from '../calc.js';

const n = (v) => Number(v) || 0;
const perMin = (v) => (v ? '$' + qty(v, 4) : '—');
const dollars = (v) => money(v, 0);
const stat = (label, value, sub, cls = '') => h('div', { class: `stat ${cls}`.trim() }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), sub ? h('div', { class: 'small muted' }, sub) : null);
// The usual kinds, to start a year with.
const COMMON = ['Electricity', 'Natural gas', 'Water & sewer', 'Rent', 'Property tax', 'Insurance', 'Equipment maintenance', 'Cleaning & sanitation', 'Waste removal', 'Supplies'];

let selYear = thisYear();

export default {
  id: 'overhead',
  label: 'Overhead',
  render({ rerender }) {
    const d = state.data; const admin = canArea('overhead', 'edit');
    const live = !d.missingTables?.has('overhead_costs'); // false until the database has the overhead table
    const locked = standardsLocked(selYear); // the year's Beginning is closed (Settings → Periods)
    const can = admin && live && !locked;
    const years = laborYears();
    if (!years.includes(selYear)) selYear = years.includes(thisYear()) ? thisYear() : years.at(-1);
    const O = overheadRate(d, selYear); const F = O.setup;
    const prevRate = years.includes(selYear - 1) ? overheadRate(d, selYear - 1).rate : 0;
    const ys = d.year_settings.find((y) => y.year === selYear) || {};
    const item = d.items.find((i) => i.item_no === OVERHEAD_ITEM);
    const own = F.own; const empty = !O.lines.length; const isFc = F.forecast && !empty;
    const edit = can && own;
    const nextSort = () => Math.max(0, ...(d.overhead_costs || []).filter((x) => x.year === selYear).map((x) => n(x.sort))) + 1;

    const addLine = async (name = 'New overhead') => {
      try { await insertRow('overhead_costs', { year: selYear, name, annual_amount: 0, monthly_amount: 0, sort: nextSort() }); }
      catch (err) { toast(niceError(err), 'bad'); }
    };
    const addCommon = async () => {
      try { let s = nextSort(); for (const name of COMMON) await insertRow('overhead_costs', { year: selYear, name, annual_amount: 0, monthly_amount: 0, sort: s++ }); toast('Added the usual kinds of overhead. Type in what each costs a year, and remove any that don’t apply.'); }
      catch (err) { toast(niceError(err), 'bad'); }
    };
    const confirmForecast = async () => {
      try {
        for (const c of O.lines) { const { id, sourceId, forecast, ...rest } = c; await insertRow('overhead_costs', { ...rest, annual_amount: overheadAnnual(c), year: selYear }); }
        await saveRow('year_settings', { year: selYear }, { overhead_basis: F.settings.overhead_basis ?? null });
        toast(`${selYear} now has its own overhead, starting from the forecast. Change anything that’s different.`);
      } catch (err) { toast(niceError(err), 'bad'); }
    };
    const save = (c, k) => (v) => updateRow('overhead_costs', 'id', c.id, { [k]: v ?? (k === 'annual_amount' ? 0 : null) });
    const text = (c, k, label) => h('td', { class: edit ? 'cell entry' : null },
      edit ? h('input', { type: 'text', value: c[k] ?? '', 'aria-label': `${c.name}: ${label}`, 'data-k': `oh|${c.id}|${k}`, placeholder: k === 'notes' ? 'Notes' : '',
        onchange: (e) => { const v = e.target.value.trim(); if (!v && k === 'name') { e.target.value = c.name; return; } save(c, k)(v || null).catch((err) => toast(niceError(err), 'bad')); } })
        : h('span', { class: k === 'notes' ? 'muted small' : null }, c[k] || ''));

    // ---------- the year ----------
    const yearSeg = seg(years.map((y) => [String(y), String(y)]), String(selYear), (y) => { selYear = Number(y); rerender(); });
    yearSeg.classList.add('year-seg');
    const top = h('div', { class: 'prod-top top-actions' }, yearSeg,
      isFc ? h('span', { class: 'fc-tag big' }, F.needsReview ? 'forecast · review' : 'forecast') : null,
      can && !own && !empty ? h('button', { class: F.needsReview ? 'btn primary' : 'btn', onclick: confirmForecast }, F.needsReview ? `Confirm ${selYear}’s overhead` : `Give ${selYear} its own overhead`) : null);

    const basis = O.basis;
    const change = prevRate && O.rate ? O.rate / prevRate - 1 : null;
    // The rate, worked out, stays along the bottom of the screen (like Labor).
    const sub = (t) => h('span', { class: 'ls-sub' }, t);
    const cards = h('div', { class: 'labor-cards pinned-cards labor-strip' + (isFc ? ' forecast' : '') },
      h('div', { class: 'stat key' + (isFc ? ' forecast' : '') }, h('div', { class: 'label' }, `${selYear} overhead rate${isFc ? ' · forecast' : ''}`),
        h('div', { class: 'value' }, empty ? '—' : perMin(O.rate), empty ? null : h('span', { class: 'per' }, ' a minute')),
        empty ? sub('Add this year’s overhead') : sub(`${money(O.rate * 60)} an hour${change === null ? '' : ` · ${change >= 0 ? '+' : ''}${fmt(change * 100, 1)}% vs. ${selYear - 1}`}`)),
      h('div', { class: 'ls-op', 'aria-hidden': 'true' }, '='),
      h('div', { class: 'stat' }, h('div', { class: 'label' }, 'Overhead a year'), h('div', { class: 'value' }, dollars(O.annual)), sub(`${dollars(O.monthly)} a month`)),
      h('div', { class: 'ls-op', 'aria-hidden': 'true' }, '÷'),
      h('div', { class: 'stat' }, h('div', { class: 'label' }, `${basis === 'labor' ? 'Labor' : 'Line'} minutes a year`), h('div', { class: 'value' }, fmt(O.minutes)),
        sub(basis === 'labor' ? `${qty(O.lineHoursWeek, 2)} hours × ${qty(O.prodWeeks, 2)} weeks × 60 × ${qty(O.crew, 2)} people` : `${qty(O.lineHoursWeek, 2)} hours a week × ${qty(O.prodWeeks, 2)} weeks × 60`)));

    const notes = [
      locked ? h('div', { class: 'note closed-note' }, '🔒 ', lockedNote(selYear)) : null,
      !live ? h('div', { class: 'note warn' }, 'The database hasn’t been updated for the overhead rate yet, so Master List uses the overhead cost typed in there and this can’t be edited. It becomes editable after the next deploy to main.') : null,
      !own && F.fromYear && !empty ? h('div', { class: 'note info' }, `${selYear} is a forecast: ${F.fromYear}’s overhead raised ${qty(F.inflation, 2)}%. ${F.needsReview ? 'The year has begun, so confirm its overhead.' : 'Give it its own overhead to change anything else.'}`) : null,
    ];

    // ---------- the kinds of overhead ----------
    const list = h('section', { class: 'panel people-panel' },
      O.lines.length ? h('div', { class: 'tablewrap flat' }, h('table', { class: 't oh-lines' },
        h('thead', null, h('tr', null, h('th', null, 'Overhead'), h('th', { class: 'num' }, 'A year'), h('th', { class: 'num' }, 'Share'), h('th', null, 'Notes'), h('th'))),
        h('tbody', null, O.lines.map((c) => h('tr', null,
          text(c, 'name', 'name'),
          numberCell(overheadAnnual(c), save(c, 'annual_amount'), { disabled: !edit, digits: 2, key: `oh|${c.id}|annual_amount`, title: `${c.name}: a year`, cls: 'unit-yr', display: (v) => money(n(v), Math.abs(n(v) % 1) > 1e-9 ? 2 : 0) }),
          h('td', { class: 'num muted' }, O.annual ? `${fmt((overheadAnnual(c) / O.annual) * 100, 0)}%` : ''),
          text(c, 'notes', 'notes'),
          h('td', { class: 'row-actions' }, edit ? h('button', { class: 'btn icon-btn danger', title: 'Remove', 'aria-label': `Remove ${c.name}`, onclick: async () => {
            if (await confirmDialog(`Remove ${c.name} from ${selYear}?`, 'Remove')) deleteRow('overhead_costs', 'id', c.id).catch((err) => toast(niceError(err), 'bad'));
          } }, '×') : null)))),
        h('tfoot', null, h('tr', { class: 'oh-total' }, h('td', null, 'Total'), h('td', { class: 'num strong' }, dollars(O.annual)), h('td'), h('td', { class: 'muted small' }, `${dollars(O.monthly)} a month`), h('td')))))
        : h('p', { class: 'panel-note' }, `No overhead entered for ${selYear} yet. Add each kind of overhead (electricity, water & sewer, rent, insurance…) with what it costs a year.`),
      h('div', { class: 'people-foot' },
        can && (own || empty) ? h('button', { class: 'btn', onclick: () => addLine() }, '+ Add overhead') : null,
        can && empty ? h('button', { class: 'btn ghost', onclick: addCommon }, 'Add the usual kinds') : null,
        h('span', { class: 'small muted' }, `Everything it costs to run the plant that isn’t ingredients, packaging or line labor, a year. ${item ? `${item.name} (#${OVERHEAD_ITEM})` : `Item #${OVERHEAD_ITEM}`} costs this rate on Master List and in every BOM.`)));

    // ---------- how it's spread: one sentence ----------
    const basisSel = h('select', { class: 'inline-sel', disabled: !can, 'aria-label': 'Spread overhead over', 'data-k': `oy|${selYear}|basis`,
      onchange: (e) => saveRow('year_settings', { year: selYear }, { overhead_basis: e.target.value }).catch((err) => toast(niceError(err), 'bad')) },
      h('option', { value: 'line', selected: basis !== 'labor' }, 'line minute'), h('option', { value: 'labor', selected: basis === 'labor' }, 'labor minute'));
    const infl = () => { const td = numberCell(ys.overhead_inflation_pct ?? null, (v) => saveRow('year_settings', { year: selYear }, { overhead_inflation_pct: v }), { disabled: !can, key: `oy|${selYear}|infl`, title: 'Overhead increase %', placeholder: '0' });
      const i = td.querySelector('input'); i.classList.add('inline-num'); return i; };
    const line = h('div', { class: 'line-sentence' },
      h('span', null, 'Overhead is spread over each'), basisSel,
      h('span', null, basis === 'labor' ? `: every person-minute on the line (× ${qty(O.crew, 2)} people), the way BOMs count labor.` : `the line runs: ${qty(O.lineHoursWeek, 2)} hours a week, ${qty(O.prodWeeks, 2)} weeks a year (from Labor).`),
      selYear > years[0] && !own ? [h('span', { class: 'ls-gap' }, 'Overhead goes up'), infl(), h('span', null, `% from ${selYear - 1}.`)] : null);

    return h('div', { class: 'labor overhead overhead-page' + (isFc ? ' fc-year' : '') },
      pageHead('Overhead', 'The standard overhead cost per minute for each year: what each kind of overhead costs a year, added up and divided by the minutes the line runs. A new year starts from the year before with an increase and is a forecast until it begins; give it its own overhead to change anything else.' + (admin ? '' : ' Your role can view these but not change them.')),
      top, line, notes, list, cards);
  },
};
