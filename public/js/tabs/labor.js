// Standards → Labor: the standard direct labor cost per minute for each year
// (laborRate in calc.js): each position's paid cost for the year (wages or
// salary, payroll taxes, fringe) divided by the minutes people spend on the
// line. One page, no side bar: the year, its people and how the line runs,
// with the rate pinned to the bottom of the screen.
import { h, pageHead, numberCell, money, qty, fmt, toast, niceError, confirmDialog, thisYear, seg } from '../ui.js';
import { state, saveRow, insertRow, updateRow, deleteRow } from '../store.js';
import { can as canArea, standardsLocked, lockedNote } from '../perms.js';
import { laborRate, laborYears } from '../calc.js';

const n = (v) => Number(v) || 0;
const perMin = (v) => (v ? '$' + qty(v, 4) : '—');
const dollars = (v) => money(v, 0);
const cash = (v) => money(n(v), Math.abs(n(v) % 1) > 1e-9 ? 2 : 0);
const stat = (label, value, sub, cls = '') => h('div', { class: `stat ${cls}`.trim() }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), sub ? h('div', { class: 'small muted' }, sub) : null);

let selYear = thisYear();

export default {
  id: 'labor',
  label: 'Labor',
  render({ rerender }) {
    const d = state.data; const admin = canArea('labor', 'edit');
    const live = !d.missingTables?.has('labor_positions'); // false until the database has the labor table
    const locked = standardsLocked(selYear); // the year's Beginning is closed (Settings → Periods)
    const can = admin && live && !locked;
    const years = laborYears();
    if (!years.includes(selYear)) selYear = years.includes(thisYear()) ? thisYear() : years.at(-1);
    const L = laborRate(d, { year: selYear });
    const prevRate = years.includes(selYear - 1) ? laborRate(d, { year: selYear - 1 }).rate : 0;
    const ys = d.year_settings.find((y) => y.year === selYear) || {};
    const F = L.setup; const empty = !L.rows.length; const own = F.own; const isFc = F.forecast && !empty;
    const edit = can && own;

    const addPosition = async () => {
      try { await insertRow('labor_positions', { year: selYear, name: 'New position', pay_type: 'hourly', headcount: 1, hourly_rate: 0, monthly_fringe: 0, payroll_tax_pct: 7.65, paid_hours_week: 40, on_line: true, sort: Math.max(0, ...d.labor_positions.filter((x) => x.year === selYear).map((x) => n(x.sort))) + 1 }); }
      catch (err) { toast(niceError(err), 'bad'); }
    };
    // Turns the forecast (last year's people + inflation) into the year's own people, to edit.
    const confirmForecast = async () => {
      try {
        for (const p of F.positions) { const { id, sourceId, forecast, ...rest } = p; await insertRow('labor_positions', { ...rest, year: selYear }); }
        const st = F.settings;
        await saveRow('year_settings', { year: selYear }, { labor_prod_weeks: st.labor_prod_weeks ?? null, labor_line_hours: st.labor_line_hours ?? null, labor_over40: st.labor_over40 ?? null });
        toast(`${selYear} now has its own people, starting from the forecast. Change anything that’s different.`);
      } catch (err) { toast(niceError(err), 'bad'); }
    };
    const save = (p, k) => (v) => updateRow('labor_positions', 'id', p.id, { [k]: v ?? (['headcount', 'payroll_tax_pct'].includes(k) ? 0 : null) });
    const saveNow = (p, k, v) => save(p, k)(v).catch((err) => toast(niceError(err), 'bad'));

    // ---------- the year ----------
    const yearSeg = seg(years.map((y) => [String(y), String(y)]), String(selYear), (y) => { selYear = Number(y); rerender(); });
    yearSeg.classList.add('year-seg');
    const top = h('div', { class: 'prod-top top-actions' }, yearSeg,
      isFc ? h('span', { class: 'fc-tag big' }, F.needsReview ? 'forecast · review' : 'forecast') : null,
      can && !own && !empty ? h('button', { class: F.needsReview ? 'btn primary' : 'btn', onclick: confirmForecast }, F.needsReview ? `Confirm ${selYear}’s people` : `Give ${selYear} its own people`) : null);

    const change = prevRate && L.rate ? L.rate / prevRate - 1 : null;
    // The rate and its totals stay pinned to the bottom of the screen.
    const cards = h('div', { class: 'cards labor-cards pinned-cards labor-summary' },
      stat(`${selYear} labor rate${isFc ? ' (forecast)' : ''}`, empty ? '—' : h('span', null, perMin(L.rate), h('span', { class: 'per' }, ' a minute')),
        empty ? 'Add this year’s people' : `${money(L.rate * 60)} an hour${change === null ? '' : ` · ${change >= 0 ? '+' : ''}${fmt(change * 100, 1)}% vs. ${selYear - 1}`}`, 'key' + (isFc ? ' forecast' : '')),
      h('div', { class: 'sum-op', 'aria-hidden': 'true' }, '='),
      stat('Labor cost a year', dollars(L.burdened), `${dollars(L.base)} pay + ${dollars(L.tax + L.benefits)} taxes & fringe`),
      h('div', { class: 'sum-op', 'aria-hidden': 'true' }, '÷'),
      stat('Minutes on the line a year', fmt(L.minutes), `${fmt(L.lineHours)} hours: ${qty(L.plant.lineHours, 2)} a week × ${qty(L.plant.prodWeeks, 2)} weeks × ${qty(L.crew, 2)} people`));

    const notes = [
      locked ? h('div', { class: 'note closed-note' }, '🔒 ', lockedNote(selYear)) : null,
      !live ? h('div', { class: 'note warn' }, 'The database hasn’t been updated for the labor rate yet, so Master List uses the workbook’s labor scenarios and this can’t be edited. It becomes editable after the next deploy to main.') : null,
      !own && F.fromYear && !empty ? h('div', { class: 'note info' }, `${selYear} is a forecast: ${F.fromYear}’s people with pay raised ${qty(F.inflation, 2)}%. ${F.needsReview ? 'The year has begun, so confirm its people.' : 'Give it its own people to change anything else.'}`) : null,
    ];

    // ---------- people ----------
    const ps = own ? [...d.labor_positions].filter((p) => p.year === selYear).sort((a, b) => n(a.sort) - n(b.sort) || a.id - b.id) : L.rows.map((r) => r.position);
    const costOf = new Map(L.rows.map((r) => [r.position.id, r]));
    const people = h('section', { class: 'panel people-panel' },
      ps.length ? h('div', { class: 'tablewrap flat' }, h('table', { class: 't labor-people' + (own ? '' : ' is-forecast') },
        h('thead', null, h('tr', null, h('th', null, 'Position'), h('th', null, 'Paid'), h('th', { class: 'num' }, 'Pay'), h('th', { class: 'num' }, 'Fringe'),
          h('th', { class: 'num' }, 'Payroll tax %'), h('th', { class: 'num' }, 'People'), h('th', null, 'On the line'), h('th', { class: 'num' }, 'Cost a year'), h('th'))),
        h('tbody', null, ps.map((p) => {
          const sal = p.pay_type === 'salaried';
          const payKey = sal ? 'annual_salary' : 'hourly_rate'; const fringeKey = sal ? 'annual_fixed' : 'monthly_fringe';
          const num = (k, title, cls, digits = 2, display) => numberCell(p[k] ?? null, save(p, k), { disabled: !edit, digits, key: `lp|${p.id}|${k}`, title: `${p.name}: ${title}`, cls, display });
          return h('tr', null,
            h('td', { class: edit ? 'cell entry' : null }, edit ? h('input', { type: 'text', class: 'pos-input', value: p.name, 'aria-label': 'Position name', 'data-k': `lp|${p.id}|name`,
              onchange: (e) => { const v = e.target.value.trim(); if (!v) { e.target.value = p.name; return; } saveNow(p, 'name', v); } }) : p.name),
            h('td', null, edit ? h('select', { 'aria-label': `How ${p.name} is paid`, 'data-k': `lp|${p.id}|pay_type`, onchange: (e) => saveNow(p, 'pay_type', e.target.value) },
              h('option', { value: 'hourly', selected: !sal }, 'Hourly'), h('option', { value: 'salaried', selected: sal }, 'Salaried')) : sal ? 'Salaried' : 'Hourly'),
            num(payKey, sal ? 'salary a year per person' : 'pay an hour per person', sal ? 'unit-yr' : 'unit-hr', sal ? 2 : 4, sal ? cash : (v) => money(n(v), 2)),
            num(fringeKey, sal ? 'fringe a year per person' : 'fringe a month per person', sal ? 'unit-yr' : 'unit-mo', 2, cash),
            num('payroll_tax_pct', 'payroll tax %'),
            num('headcount', 'number of people'),
            h('td', null, edit ? h('select', { 'aria-label': `${p.name} on the line`, onchange: (e) => saveNow(p, 'on_line', e.target.value === 'yes') },
              h('option', { value: 'yes', selected: p.on_line !== false }, 'Yes'), h('option', { value: 'no', selected: p.on_line === false }, 'No')) : p.on_line === false ? 'No' : 'Yes'),
            h('td', { class: 'num strong' }, costOf.has(p.id) ? dollars(costOf.get(p.id).burdened) : ''),
            h('td', { class: 'row-actions' }, edit ? h('button', { class: 'btn icon-btn danger', title: 'Remove', 'aria-label': `Remove ${p.name}`, onclick: async () => {
              if (await confirmDialog(`Remove ${p.name} from ${selYear}?`, 'Remove')) deleteRow('labor_positions', 'id', p.id).catch((err) => toast(niceError(err), 'bad'));
            } }, '×') : null));
        })),
        h('tfoot', null, h('tr', { class: 'lp-total' }, h('td', null, 'Total'), h('td'), h('td'), h('td'), h('td'),
          h('td', { class: 'num' }, qty(ps.reduce((t, p) => t + n(p.headcount), 0), 2)), h('td'), h('td', { class: 'num strong' }, dollars(L.burdened)), h('td'))))) : h('p', { class: 'panel-note' }, `No one entered for ${selYear} yet.`),
      h('div', { class: 'people-foot' },
        can && (own || empty) ? h('button', { class: 'btn', onclick: addPosition }, '+ Add position') : null,
        h('span', { class: 'small muted' }, 'Pay and fringe are per person: hourly pay per hour and fringe per month; salaried pay and fringe per year.')));

    // ---------- how the line runs ----------
    const setYear = (k, title, placeholder) => numberCell(ys[k] ?? null, (v) => saveRow('year_settings', { year: selYear }, { [k]: v }), { disabled: !can, key: `ly|${selYear}|${k}`, title,
      placeholder: F.settings[k] !== null && F.settings[k] !== undefined && ys[k] == null ? qty(F.settings[k], 2) : placeholder });
    const line = h('section', { class: 'panel line-panel' },
      h('div', { class: 'tablewrap flat' }, h('table', { class: 't batch-table line-table' }, h('thead', null, h('tr', null, h('th', { colspan: 2 }, 'How the line runs'))), h('tbody', null,
        h('tr', { class: L.plant.lineHours ? null : 'needs' }, h('td', null, 'Hours a week'), setYear('labor_line_hours', 'Hours a week the line runs', 'e.g. 16')),
        h('tr', null, h('td', null, 'Weeks a year'), setYear('labor_prod_weeks', 'Weeks a year the line runs', '52')),
        h('tr', null, h('td', null, 'People on the line'), h('td', { class: 'num muted' }, qty(L.crew, 2))),
        selYear > years[0] && !own ? h('tr', null, h('td', null, `Pay increase from ${selYear - 1} (%)`), setYear('labor_inflation_pct', 'Pay increase %', '0')) : null))),
      h('p', { class: 'panel-note' }, 'Everyone on the line is on it whenever it runs.'));

    return h('div', { class: 'labor labor-page' + (isFc ? ' fc-year' : '') },
      pageHead('Labor', 'The standard labor cost per minute for each year: each position’s paid cost for the year (wages or salary, payroll taxes, fringe) divided by the minutes people spend on the line. A new year starts from the year before with a pay increase and is a forecast until it begins; give it its own people to change anything else.' + (admin ? '' : ' Your role can view these but not change them.')),
      top, notes, h('div', { class: 'labor-grid' }, people, line), cards);
  },
};
