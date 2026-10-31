// Overhead rate: the standard overhead cost per minute for each year, which
// Overhead (item 300002) uses on Master List and in every BOM. A year's
// overhead costs (rent, utilities, insurance...) per month, times 12, divided
// by the year's production minutes (see overheadRate in calc.js). The line's
// hours a week and weeks come from the Labor tab's line assumptions.
import { h, pageHead, numberCell, money, qty, fmt, toast, niceError, confirmDialog, thisYear } from '../ui.js';
import { state, saveRow, insertRow, updateRow, deleteRow } from '../store.js';
import { can as canArea, standardsLocked, lockedNote } from '../perms.js';
import { overheadRate, laborYears, OVERHEAD_ITEM } from '../calc.js';

const n = (v) => Number(v) || 0;
const perMin = (v) => (v ? '$' + qty(v, 4) : '—');
const dollars = (v) => money(v, 0);
const ratio = (v) => `${fmt(v * 100, 1, 0)}%`;
const stat = (label, value, sub, cls = '') => h('div', { class: `stat ${cls}`.trim() }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), sub ? h('div', { class: 'small muted' }, sub) : null);

let selYear = thisYear();

export default {
  id: 'overhead',
  label: 'Overhead',
  sideWidth: 0.35,
  sideKey: 'labor', // same side bar width as Labor
  render({ rerender }) {
    const d = state.data; const admin = canArea('overhead', 'edit');
    const live = !d.missingTables?.has('overhead_costs'); // false until the database has the overhead table
    const locked = standardsLocked(selYear); // the year's Beginning is closed (Settings → Periods)
    const can = admin && live && !locked;
    const years = laborYears();
    if (!years.includes(selYear)) selYear = years.includes(thisYear()) ? thisYear() : years.at(-1);
    const byYear = new Map(years.map((y) => [y, overheadRate(d, y)]));
    const O = byYear.get(selYear); const F = O.setup;
    const ys = d.year_settings.find((y) => y.year === selYear) || {};
    const item = d.items.find((i) => i.item_no === OVERHEAD_ITEM);
    const ownRows = F.own; const empty = !O.lines.length; const isFc = F.forecast && !empty;
    const edit = can && ownRows;

    const addLine = async () => {
      try { await insertRow('overhead_costs', { year: selYear, name: 'New cost', monthly_amount: 0, sort: Math.max(0, ...(d.overhead_costs || []).filter((x) => x.year === selYear).map((x) => n(x.sort))) + 1 }); }
      catch (err) { toast(niceError(err), 'bad'); }
    };
    const confirmForecast = async () => {
      try {
        for (const c of O.lines) { const { id, sourceId, forecast, ...rest } = c; await insertRow('overhead_costs', { ...rest, year: selYear }); }
        await saveRow('year_settings', { year: selYear }, { overhead_basis: F.settings.overhead_basis ?? null });
        toast(`${selYear} now has its own overhead, starting from the forecast. Change anything that’s different.`);
      } catch (err) { toast(niceError(err), 'bad'); }
    };
    const save = (c, k) => (v) => updateRow('overhead_costs', 'id', c.id, { [k]: v ?? (k === 'monthly_amount' ? 0 : null) });
    const text = (c, k, label, cls) => h('td', { class: cls + (edit ? ' cell entry' : '') },
      edit ? h('input', { type: 'text', value: c[k] ?? '', 'aria-label': `${c.name}: ${label}`, 'data-k': `oh|${c.id}|${k}`, placeholder: k === 'notes' ? 'What it covers' : '',
        onchange: (e) => { const v = e.target.value.trim(); if (!v && k === 'name') { e.target.value = c.name; return; } save(c, k)(v || null).catch((err) => toast(niceError(err), 'bad')); } })
        : h('div', { class: k === 'name' ? 'pos-name' : 'muted small', title: c[k] || '' }, c[k] || ''));

    // ---------- side bar: the selected year's costs and how they're spread ----------
    const yearHead = h('div', { class: 'year-head' },
      h('h1', null, selYear, isFc ? h('span', { class: 'fc-tag big' }, F.needsReview ? 'forecast · review' : 'forecast') : null),
      h('span', { class: 'muted' }, empty ? 'Not set up' : `${perMin(O.rate)} per minute`));
    const costTable = h('table', { class: 't side-people oh-lines' + (ownRows ? '' : ' is-forecast') },
      h('thead', null, h('tr', null, h('th', { class: 'pos-h' }, 'Cost'), h('th', { class: 'num' }, 'Per month'), h('th', { class: 'pos-h' }, 'Notes'), h('th'))),
      h('tbody', null, O.lines.map((c) => h('tr', null,
        text(c, 'name', 'name', 'pos'),
        numberCell(c.monthly_amount ?? null, save(c, 'monthly_amount'), { disabled: !edit, digits: 2, key: `oh|${c.id}|monthly_amount`, title: `${c.name}: per month`, cls: 'unit-mo', display: (v) => money(n(v), Math.abs(n(v) % 1) > 1e-9 ? 2 : 0) }),
        text(c, 'notes', 'notes', 'oh-notes'),
        h('td', { class: 'row-actions' }, edit ? h('button', { class: 'btn icon-btn danger', title: 'Remove', 'aria-label': `Remove ${c.name}`, onclick: async () => {
          if (await confirmDialog(`Remove ${c.name} from ${selYear}?`, 'Remove')) deleteRow('overhead_costs', 'id', c.id).catch((err) => toast(niceError(err), 'bad'));
        } }, '×') : null))),
        O.lines.length ? h('tr', { class: 'oh-total' }, h('td', null, 'Total'), h('td', { class: 'num strong' }, money(O.monthly, 0)), h('td', { class: 'muted small' }, `${dollars(O.annual)} a year`), h('td')) : null));
    const costsPanel = h('section', { class: 'panel people-panel' },
      h('h2', null, h('span', { class: 'grow' }, `${selYear} overhead costs`, !ownRows && F.fromYear && !empty ? h('span', { class: 'fc-tag' }, `forecast · ${F.fromYear} + ${qty(F.inflation, 2)}%`) : null),
        can && (ownRows || empty) ? h('button', { class: 'btn ghost', onclick: addLine }, '+ Add cost') : null,
        can && !ownRows && !empty ? h('button', { class: 'btn ghost', onclick: confirmForecast }, F.needsReview ? `Confirm ${selYear}’s overhead` : `Give ${selYear} its own overhead`) : null),
      O.lines.length ? h('div', { class: 'people-body' }, costTable) : h('p', { class: 'panel-note' }, `No overhead entered for ${selYear} yet.`),
      h('p', { class: 'panel-note' }, 'Everything it costs to run the plant that isn’t ingredients, packaging or line labor: rent, utilities, insurance, equipment upkeep, cleaning, supplies… Amounts are per month.'));
    const forecastNote = !ownRows && F.fromYear && !empty ? h('section', { class: 'panel forecast-note' + (F.needsReview ? ' review' : '') },
      h('div', { class: 'empty-year' },
        h('p', null, h('strong', null, F.needsReview ? `${selYear} has begun and still uses the forecast.` : `${selYear} is a forecast.`), ' ',
          `It starts from ${F.fromYear}’s overhead raised ${qty(F.inflation, 2)}% (set below). `,
          F.needsReview ? `Review it and confirm ${selYear}’s overhead.` : `To change anything besides inflation, give ${selYear} its own overhead.`))) : null;
    const emptyNote = empty ? h('section', { class: 'panel' }, h('h2', null, `${selYear} isn’t set up yet`),
      h('div', { class: 'empty-year' }, h('p', null, 'Add this year’s overhead costs. Overhead has no cost for this year until it is set up.'),
        can ? h('div', { class: 'controls' }, h('button', { class: 'btn primary', onclick: addLine }, '+ Add cost')) : null)) : null;

    const basisNow = O.basis;
    const setBasis = (v) => saveRow('year_settings', { year: selYear }, { overhead_basis: v }).catch((err) => toast(niceError(err), 'bad'));
    const spread = h('section', { class: 'panel batch-panel' },
      h('h2', null, `${selYear} spread over`),
      h('div', { class: 'seg oh-basis', role: 'group', 'aria-label': 'Spread overhead over' },
        h('button', { type: 'button', disabled: !can, 'aria-pressed': String(basisNow === 'line'), onclick: () => setBasis('line') }, 'Line minutes'),
        h('button', { type: 'button', disabled: !can, 'aria-pressed': String(basisNow === 'labor'), onclick: () => setBasis('labor') }, 'Labor minutes')),
      h('table', { class: 't batch-table' }, h('tbody', null,
        h('tr', null, h('td', null, 'Line minutes a year', h('div', { class: 'small muted' }, `${qty(O.lineHoursWeek, 2)} production hours a week × ${qty(O.prodWeeks, 2)} weeks × 60, from the Labor tab’s line assumptions.`)), h('td', { class: 'num strong' }, fmt(O.lineMinutes))),
        h('tr', null, h('td', null, 'Labor minutes a year', h('div', { class: 'small muted' }, `Line minutes × ${qty(O.crew, 2)} people on the line, the way BOM labor minutes count.`)), h('td', { class: 'num strong' }, fmt(O.laborMinutes))),
        selYear > years[0] ? h('tr', null, h('td', null, `Inflation adjustment from ${selYear - 1} (%)`, h('div', { class: 'small muted' }, ownRows ? `Not used: ${selYear} has its own overhead.` : `While ${selYear} is forecast from ${selYear - 1}, every cost goes up by this %.`)),
          numberCell(ys.overhead_inflation_pct ?? null, (v) => saveRow('year_settings', { year: selYear }, { overhead_inflation_pct: v }), { disabled: !can, key: `oy|${selYear}|infl`, title: 'Overhead inflation %', placeholder: '0' })) : null)),
      h('p', { class: 'panel-note' }, `BOMs charge overhead for each labor minute in a batch. “Labor minutes” spreads the year’s overhead exactly over the year’s production. “Line minutes” is how the workbook did it: with ${qty(O.crew, 2)} people on the line, a year’s production charges ${qty(O.crew, 2)} times the year’s overhead.`));

    // ---------- main: every year ----------
    let prior = null;
    const yearTable = h('table', { class: 't labor-years side-years' },
      h('thead', null, h('tr', null, h('th', null, 'Year'), h('th', { class: 'num' }, '$ / min'), h('th', { class: 'num' }, 'vs. prior'), h('th', { class: 'num' }, 'A year'), h('th', null, 'Spread over'))),
      h('tbody', null, years.map((y) => {
        const r = byYear.get(y); const set = r.lines.length > 0; const rate = set ? r.rate : 0;
        const change = prior && rate ? rate / prior - 1 : null; if (rate) prior = rate;
        const fc = r.setup.forecast && set;
        return h('tr', { class: [y === selYear ? 'picked' : '', set ? '' : 'unset', fc ? 'forecast' : ''].join(' ').trim() || null, onclick: () => { selYear = y; rerender(); } },
          h('td', null, h('button', { class: 'linkish', 'aria-pressed': String(y === selYear), 'aria-label': `Show ${y}`, onclick: (e) => { e.stopPropagation(); selYear = y; rerender(); } }, y),
            fc ? h('span', { class: 'fc-tag' }, r.setup.needsReview ? 'review' : 'forecast') : null),
          set ? h('td', { class: 'num strong' }, perMin(rate)) : h('td', { class: 'num muted', colspan: 4 }, 'Not set up'),
          set ? h('td', { class: 'num' + (change > 0.0005 ? ' up' : change < -0.0005 ? ' down' : '') }, change === null ? '' : ratio(1 + change)) : null,
          set ? h('td', { class: 'num' }, dollars(r.annual)) : null,
          set ? h('td', { class: 'muted' }, r.basis === 'labor' ? 'Labor minutes' : 'Line minutes') : null);
      })));
    const other = overheadRate(d, selYear, { basis: basisNow === 'labor' ? 'line' : 'labor' });
    const summary = h('div', { class: 'cards labor-cards' },
      stat(`${selYear} overhead rate${isFc ? ' (forecast)' : ''}`, empty ? '—' : perMin(O.rate), empty ? 'Add this year’s costs' : `per ${basisNow === 'labor' ? 'labor' : 'line'} minute · ${money(O.rate * 60)} an hour`, 'key' + (isFc ? ' forecast' : '')),
      stat('Overhead a year', dollars(O.annual), `${money(O.monthly, 0)} a month`),
      stat(`Minutes it’s spread over`, fmt(O.minutes), basisNow === 'labor' ? `${fmt(O.lineMinutes)} line minutes × ${qty(O.crew, 2)} people` : `${qty(O.lineHoursWeek, 2)} hours × ${qty(O.prodWeeks, 2)} weeks × 60`),
      empty ? null : stat(`With ${basisNow === 'labor' ? 'line' : 'labor'} minutes instead`, perMin(other.rate), 'for comparison'));

    return h('div', { class: 'labor overhead' + (isFc ? ' fc-year' : '') },
      pageHead('Overhead Rate', `The standard overhead cost per minute for each year, which ${item ? `${item.name} (#${OVERHEAD_ITEM})` : `item #${OVERHEAD_ITEM}`} uses on Master List and in every BOM: the year’s overhead costs, divided by the year’s production minutes. The line’s hours a week and weeks come from the Labor tab. A new year starts from the year before with an inflation adjustment and is a forecast until it begins; give it its own overhead to change anything else. Click a year in the table to change it on the left.` + (admin ? '' : ' Your role can view these but not change them.'),
        h('div', { class: 'labor-side' + (isFc ? ' fc-year' : '') }, yearHead, emptyNote || forecastNote, costsPanel, spread),
        locked ? h('div', { class: 'note closed-note' }, '🔒 ', lockedNote(selYear)) : null,
        !live ? h('div', { class: 'note warn' }, 'The database hasn’t been updated for the overhead rate yet, so Master List uses the overhead cost typed in there and this can’t be edited. It becomes editable after the next deploy to main.') : null),
      h('section', { class: 'panel years-panel' }, h('div', { class: 'tablewrap flat' }, yearTable)),
      summary);
  },
};
