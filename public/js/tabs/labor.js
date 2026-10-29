// Labor rate: the standard direct labor cost per minute, built the way
// manufacturers usually set it (see laborRate in calc.js):
//   fully burdened pay for each position -> split into direct labor (time on
//   the line) and indirect labor (paid time off the line, e.g. a salaried
//   person paid for 5 days who is on the line 2) -> direct labor cost divided
//   by productive line minutes.
import { h, pageHead, numberCell, money, qty, fmt, pct, toast, niceError, confirmDialog } from '../ui.js';
import { state, isAdmin, saveRow, insertRow, updateRow, deleteRow } from '../store.js';
import { laborRate, laborPosition, laborYears, evalEntry } from '../calc.js';

const n = (v) => Number(v) || 0;
const perMin = (v) => (v ? '$' + qty(v, 4) : '—');
const dollars = (v) => money(v, 0);
const ratio = (v) => `${fmt(v * 100, 1, 0)}%`; // 100% = the same as the year (or schedule) it's compared with
const stat = (label, value, sub, cls = '') => h('div', { class: `stat ${cls}`.trim() }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), sub ? h('div', { class: 'small muted' }, sub) : null);

function textCell(value, save, { disabled, label, key }) {
  return h('td', { class: 'cell text' + (disabled ? '' : ' entry') }, h('input', { type: 'text', value: value ?? '', disabled, 'aria-label': label, 'data-k': key,
    onchange: async (e) => { const v = e.target.value.trim(); if (!v) { e.target.value = value ?? ''; return; } try { await save(v); } catch (err) { e.target.value = value ?? ''; toast(niceError(err), 'bad'); } } }));
}

const FIELDS = [
  ['name', 'Position', 'text'], ['pay_type', 'Paid', 'pay'], ['headcount', 'Number of people', 2],
  ['hourly_rate', 'Hourly rate', 4, 'hourly'], ['monthly_fringe', 'Monthly fringe', 2, 'hourly'],
  ['annual_salary', 'Annual salary', 2, 'salaried'], ['annual_fixed', 'Annual fixed cost', 2, 'salaried'],
  ['payroll_tax_pct', 'Payroll tax %', 2], ['on_line', 'Works the line', 'bool'],
];

// Every detail of one position, with its cost build-up as you type.
function positionDialog(p, can) {
  const plant = laborRate(state.data, { year: p.year }).plant;
  const inputs = {}; const rows = [];
  for (const [k, label, kind, only] of FIELDS) {
    let el;
    if (kind === 'text') el = h('input', { type: 'text', value: p[k] ?? '', disabled: !can, required: true });
    else if (kind === 'pay') el = h('select', { disabled: !can }, h('option', { value: 'hourly', selected: p.pay_type !== 'salaried' }, 'Hourly'), h('option', { value: 'salaried', selected: p.pay_type === 'salaried' }, 'Salaried'));
    else if (kind === 'bool') el = h('select', { disabled: !can }, h('option', { value: 'yes', selected: p.on_line !== false }, 'Yes, while it runs'), h('option', { value: 'no', selected: p.on_line === false }, 'No'));
    else el = h('input', { type: 'text', inputmode: 'decimal', value: p[k] ?? '', disabled: !can });
    inputs[k] = el;
    const label2 = { hourly_rate: 'Hourly rate (per person)', monthly_fringe: 'Monthly fringe (per person)', annual_salary: 'Annual salary (per person)', annual_fixed: 'Annual fixed cost (per person)' }[k] || label;
    rows.push({ only, el: h('label', { class: 'field' }, label2, el) });
  }
  inputs.notes = h('textarea', { rows: 2, disabled: !can, placeholder: 'Who this is, what the fixed cost covers…' }, p.notes || '');
  const read = () => {
    const out = { ...p, name: inputs.name.value.trim() || p.name, pay_type: inputs.pay_type.value, on_line: inputs.on_line.value === 'yes', notes: inputs.notes.value.trim() || null };
    for (const [k, , kind] of FIELDS) if (typeof kind === 'number') { const v = inputs[k].value.trim(); try { out[k] = v === '' ? null : evalEntry(v); } catch { out[k] = p[k]; } }
    return out;
  };
  const summary = h('div', { class: 'gd-summary' });
  const refresh = () => {
    const x = read(); const sal = x.pay_type === 'salaried';
    for (const r of rows) r.el.hidden = r.only ? (r.only === 'salaried') !== sal : false;
    const r = laborPosition(x, plant);
    summary.replaceChildren(h('table', { class: 't gd-table' }, h('tbody', null,
      [['Hours on the line a year', fmt(r.lineHours)], ['Base pay', dollars(r.base)], ['Payroll taxes', dollars(r.tax)],
        ['Fringe and fixed costs', dollars(r.benefits)], ['Labor cost', dollars(r.burdened)], ['Minutes on the line', fmt(r.minutes)],
        ['Cost per labor minute', r.minutes ? '$' + qty(r.burdened / r.minutes, 4) : '—']]
        .map(([a, b]) => h('tr', null, h('td', null, a), h('td', { class: 'num strong' }, b))))));
  };
  for (const el of Object.values(inputs)) el.addEventListener('input', refresh);
  const dlg = h('dialog', { class: 'group-dialog' }, h('form', { method: 'dialog', onsubmit: async (e) => {
      if (e.submitter?.value !== 'save') return;
      e.preventDefault();
      try {
        const x = read(); const patch = { notes: x.notes };
        for (const [k] of FIELDS) patch[k] = x[k];
        if (!patch.name) throw new Error('Give the position a name.');
        for (const k of ['headcount', 'payroll_tax_pct']) patch[k] = patch[k] ?? 0;
        await updateRow('labor_positions', 'id', p.id, patch); dlg.close(); toast(`${patch.name} saved.`);
      } catch (err) { toast(niceError(err), 'bad'); }
    } },
    h('h3', null, `Position: ${p.name}`),
    h('div', { class: 'pd-grid' }, rows.map((r) => r.el)),
    h('label', { class: 'field' }, 'Notes', inputs.notes),
    h('h4', { class: 'pd-sub' }, `For ${p.year}`),
    summary,
    h('div', { class: 'actions' }, h('button', { class: 'btn', value: 'cancel', formnovalidate: true }, can ? 'Cancel' : 'Close'), can ? h('button', { class: 'btn primary', value: 'save' }, 'Save') : null)));
  dlg.addEventListener('close', () => dlg.remove());
  refresh(); document.body.append(dlg); dlg.showModal();
}

let selYear = new Date().getFullYear();

export default {
  id: 'labor',
  label: 'Labor',
  sideWidth: 0.35,
  sideFold: false,
  render({ rerender }) {
    const d = state.data; const admin = isAdmin();
    const live = !d.missingTables?.has('labor_positions'); // false until the database has the labor table
    const can = admin && live;
    const years = laborYears();
    if (!years.includes(selYear)) selYear = years.includes(new Date().getFullYear()) ? new Date().getFullYear() : years.at(-1);
    const byYear = new Map(years.map((y) => [y, laborRate(d, { year: y })]));
    const L = byYear.get(selYear);
    const ys = d.year_settings.find((y) => y.year === selYear) || {};
    const prevYear = selYear - 1; const prev = byYear.get(prevYear);

    const addPosition = async () => {
      try { await insertRow('labor_positions', { year: selYear, name: 'New position', pay_type: 'hourly', headcount: 1, hourly_rate: 0, monthly_fringe: 0, payroll_tax_pct: 7.65, paid_hours_week: 40, on_line: true, sort: Math.max(0, ...d.labor_positions.filter((x) => x.year === selYear).map((x) => n(x.sort))) + 1 }); }
      catch (err) { toast(niceError(err), 'bad'); }
    };
    // Turns the forecast (last year's people + inflation) into the year's own people, to edit.
    const confirmForecast = async () => {
      try {
        for (const p of L.setup.positions) {
          const { id, sourceId, forecast, ...rest } = p; await insertRow('labor_positions', { ...rest, year: selYear });
        }
        const st = L.setup.settings;
        await saveRow('year_settings', { year: selYear }, { labor_prod_weeks: st.labor_prod_weeks ?? null, labor_line_hours: st.labor_line_hours ?? null });
        toast(`${selYear} now has its own people, starting from the forecast. Change anything that’s different.`);
      } catch (err) { toast(niceError(err), 'bad'); }
    };
    const save = (p, k) => (v) => updateRow('labor_positions', 'id', p.id, { [k]: v ?? (['headcount', 'payroll_tax_pct'].includes(k) ? 0 : null) });

    // ---------- side bar: the rate for every year ----------
    let prior = null;
    const yearTable = h('table', { class: 't labor-years side-years' },
      h('thead', null, h('tr', null, h('th', null, 'Year'), h('th', { class: 'num' }, '$ / min'), h('th', { class: 'num' }, '$ / hour'), h('th', { class: 'num' }, 'vs. prior'), h('th', { class: 'num' }, 'People'))),
      h('tbody', null, years.map((y) => {
        const r = byYear.get(y); const set = r.rows.length > 0; const rate = set ? r.rate : 0;
        const change = prior && rate ? rate / prior - 1 : null; if (rate) prior = rate;
        const fc = r.setup.forecast && set;
        return h('tr', { class: [y === selYear ? 'picked' : '', set ? '' : 'unset', fc ? 'forecast' : ''].join(' ').trim() || null, onclick: () => { selYear = y; rerender(); } },
          h('td', null, h('button', { class: 'linkish', 'aria-pressed': String(y === selYear), 'aria-label': `Show ${y}`, onclick: (e) => { e.stopPropagation(); selYear = y; rerender(); } }, y),
            fc ? h('span', { class: 'fc-tag', title: r.setup.own ? 'Set up, but a forecast until the year begins' : `Forecast: ${r.setup.fromYear} + ${qty(r.setup.inflation, 2)}%` }, r.setup.needsReview ? 'review' : 'forecast') : null),
          set ? h('td', { class: 'num strong' }, perMin(rate)) : h('td', { class: 'num muted', colspan: 3 }, 'Not set up'),
          set ? h('td', { class: 'num' }, money(rate * 60)) : null,
          set ? h('td', { class: 'num' + (change > 0.0005 ? ' up' : change < -0.0005 ? ' down' : '') }, change === null ? '' : ratio(1 + change)) : null,
          h('td', { class: 'num' }, set ? qty(r.rows.reduce((t, x) => t + x.people, 0), 2) : '—'));
      })));

    // ---------- this year ----------
    const empty = !L.rows.length;
    const F = L.setup; const isFc = F.forecast && !empty; const ownRows = F.own;
    const summary = h('div', { class: 'cards labor-cards' },
      stat(`${selYear} labor rate${isFc ? ' (forecast)' : ''}`, empty ? '—' : perMin(L.rate), empty ? 'Set up this year’s people' : `${money(L.rate * 60)} per labor hour${!ownRows && F.fromYear ? ` · ${F.fromYear} + ${qty(F.inflation, 2)}%` : ''}`, 'key' + (isFc ? ' forecast' : '')),
      stat('Labor cost', dollars(L.burdened), `${dollars(L.base)} pay · ${dollars(L.tax + L.benefits)} taxes & benefits`),
      stat('Line hours a year', fmt(L.lineHours), `${qty(L.plant.lineHours, 2)} hours × ${qty(L.plant.prodWeeks, 2)} weeks × ${qty(L.crew, 2)} people`));

    // People for the year, compact enough for the side bar: name and pay type
    // edit in place; pay and fixed cost show the right field for the type; the
    // rest is in Details. A forecast year shows last year's people + inflation,
    // read-only, until it is given its own people.
    const ps = ownRows ? [...d.labor_positions].filter((p) => p.year === selYear).sort((a, b) => n(a.sort) - n(b.sort) || a.id - b.id) : L.rows.map((r) => r.position);
    const edit = can && ownRows;
    const peopleTable = h('table', { class: 't side-people' + (ownRows ? '' : ' is-forecast') },
      h('thead', null, h('tr', null, h('th', { class: 'pos-h' }, 'Position'), h('th', { class: 'num' }, 'Pay'), h('th', { class: 'num' }, 'Fringe'), h('th', { class: 'num', title: 'Number of people' }, '#'), h('th'))),
      h('tbody', null, ps.map((p) => {
        const sal = p.pay_type === 'salaried';
        const fixedKey = sal ? 'annual_fixed' : 'monthly_fringe'; const payKey = sal ? 'annual_salary' : 'hourly_rate';
        const cellOf = (k, title, cls, digits = 2, display) => numberCell(p[k] ?? null, save(p, k), { disabled: !edit, digits, key: `lp|${p.id}|${k}`, title: `${p.name}: ${title}`, cls, display });
        const cash = (v) => money(n(v), Math.abs(n(v) % 1) > 1e-9 ? 2 : 0);
        return h('tr', null,
          h('td', { class: 'pos' + (edit ? ' cell entry' : '') },
            edit ? h('input', { type: 'text', class: 'pos-input', value: p.name, 'aria-label': 'Position name', 'data-k': `lp|${p.id}|name`,
              onchange: (e) => { const v = e.target.value.trim(); if (!v) { e.target.value = p.name; return; } save(p, 'name')(v).catch((err) => toast(niceError(err), 'bad')); } })
              : h('div', { class: 'pos-name', title: p.name }, p.name),
            edit ? h('select', { class: 'pos-pay', 'aria-label': `How ${p.name} is paid`, onchange: (e) => save(p, 'pay_type')(e.target.value).catch((err) => toast(niceError(err), 'bad')) },
              h('option', { value: 'hourly', selected: !sal }, 'Hourly'), h('option', { value: 'salaried', selected: sal }, 'Salaried'))
              : h('div', { class: 'pos-type' }, `${sal ? 'Salaried' : 'Hourly'}${p.on_line === false ? ' · off the line' : ''}`)),
          cellOf(payKey, sal ? 'annual salary per person' : 'hourly rate per person', sal ? 'unit-yr' : 'unit-hr', sal ? 2 : 4, sal ? cash : (v) => money(n(v), 2)),
          cellOf(fixedKey, sal ? 'annual fixed cost per person' : 'monthly fringe per person', sal ? 'unit-yr' : 'unit-mo', 2, cash),
          cellOf('headcount', 'number of people'),
          h('td', { class: 'row-actions' }, h('button', { class: 'btn icon-btn', title: 'Details', 'aria-label': `Details for ${p.name}`, onclick: () => positionDialog(p, edit) }, '✎'),
            edit ? h('button', { class: 'btn icon-btn danger', title: 'Remove', 'aria-label': `Remove ${p.name}`, onclick: async () => {
              if (await confirmDialog(`Remove ${p.name} from ${selYear}?`, 'Remove')) deleteRow('labor_positions', 'id', p.id).catch((err) => toast(niceError(err), 'bad'));
            } }, '×') : null));
      })));
    const thisYear = new Date().getFullYear();
    const forecastNote = !ownRows && F.fromYear && !empty ? h('section', { class: 'panel forecast-note' + (F.needsReview ? ' review' : '') },
      h('div', { class: 'empty-year' },
        h('p', null, h('strong', null, F.needsReview ? `${selYear} has begun and still uses the forecast.` : `${selYear} is a forecast.`), ' ',
          `It starts from ${F.fromYear}’s people with pay and fixed costs raised ${qty(F.inflation, 2)}% (set the inflation adjustment under ${selYear} line assumptions). `,
          F.needsReview ? `Review it and confirm ${selYear}’s people.` : `It stays a forecast until ${selYear} begins. To change anything besides inflation, give ${selYear} its own people.`),
        can ? h('div', { class: 'controls' }, h('button', { class: F.needsReview ? 'btn primary' : 'btn', onclick: confirmForecast }, F.needsReview ? `Confirm ${selYear}’s people` : `Give ${selYear} its own people`)) : null))
      : ownRows && selYear > thisYear ? h('section', { class: 'panel forecast-note' }, h('div', { class: 'empty-year' },
        h('p', null, h('strong', null, `${selYear} is a forecast`), ` until ${selYear} begins. It has its own people, so ${selYear - 1}’s changes and the inflation adjustment no longer carry into it.`))) : null;
    const people = empty ? h('section', { class: 'panel' },
      h('h2', null, `${selYear} isn’t set up yet`),
      h('div', { class: 'empty-year' },
        h('p', null, 'Add this year’s people and pay. Standard Cost has no labor cost for this year until it is set up.'),
        can ? h('div', { class: 'controls' }, h('button', { class: 'btn primary', onclick: addPosition }, '+ Add position')) : null)) : forecastNote;

    const setYear = (k, title, placeholder) => numberCell(ys[k] ?? null, (v) => saveRow('year_settings', { year: selYear }, { [k]: v }), { disabled: !can, key: `ly|${selYear}|${k}`, title,
      placeholder: k in L.setup.settings && L.setup.settings[k] !== null && L.setup.settings[k] !== undefined && ys[k] == null ? qty(L.setup.settings[k], 2) : placeholder });
    const plant = h('section', { class: 'panel batch-panel' },
      h('h2', null, `${selYear} line assumptions`),
      h('table', { class: 't batch-table' }, h('tbody', null,
        h('tr', { class: L.plant.lineHours ? null : 'needs' }, h('td', null, 'Production hours a week', h('div', { class: 'small muted' }, 'How many hours a week the line runs (e.g. 16 now; 120 is three 8-hour shifts, 5 days). Everyone who works the line is on it whenever it runs; hourly people are paid for those hours.')), setYear('labor_line_hours', 'Production hours a week', 'e.g. 16')),
        h('tr', null, h('td', null, 'Weeks the line runs', h('div', { class: 'small muted' }, 'Hourly line workers are paid only for the weeks they work (no paid time off). Salaried people are paid all 52 weeks.')), setYear('labor_prod_weeks', 'Weeks the line runs', '52')),
        selYear > years[0] ? h('tr', null, h('td', null, `Inflation adjustment from ${selYear - 1} (%)`, h('div', { class: 'small muted' }, ownRows ? `Not used: ${selYear} has its own people.` : `While ${selYear} is forecast from ${selYear - 1}, everyone’s pay and fixed costs go up by this %.`)),
          setYear('labor_inflation_pct', 'Inflation adjustment %', '0')) : null)));

    const cols = [['#', (r) => qty(r.people, 2)], ['Line hours', (r) => fmt(r.lineHours)], ['Base pay', (r) => dollars(r.base)],
      ['Payroll tax', (r) => dollars(r.tax)], ['Fringe & fixed', (r) => dollars(r.benefits)], ['Labor cost', (r) => dollars(r.burdened)],
      ['Minutes on the line', (r) => fmt(r.minutes)], ['Cost per minute', (r) => (r.minutes ? '$' + qty(r.burdened / r.minutes, 4) : '—')]];
    const tot = { people: L.rows.reduce((t, r) => t + r.people, 0), lineHours: L.lineHours, base: L.base, tax: L.tax, benefits: L.benefits, burdened: L.burdened, minutes: L.minutes };
    const build = empty ? null : h('section', { class: 'panel' },
      h('h2', null, `${selYear} cost build-up`),
      h('div', { class: 'tablewrap flat', 'data-scroll': 'labor-build' }, h('table', { class: 't build' },
        h('thead', null, h('tr', null, h('th', { class: 'sticky-col' }, 'Position'), cols.map(([l]) => h('th', { class: 'num wrap' }, l)))),
        h('tbody', null, L.rows.map((r) => h('tr', null, h('td', { class: 'sticky-col' }, r.position.name), cols.map(([, f]) => h('td', { class: 'num' }, f(r))))),
          h('tr', { class: 'total' }, h('td', { class: 'sticky-col' }, 'Total'), cols.map(([, f]) => h('td', { class: 'num' }, f(tot))))))),
      h('div', { class: 'formula' },
        h('div', null, 'Labor rate = labor cost ', h('strong', null, dollars(L.burdened)), ' ÷ minutes on the line ', h('strong', null, fmt(L.minutes)), ' = ', h('strong', { class: 'accent' }, perMin(L.rate)), ' per labor minute')));

    const cur = L.plant.lineHours;
    const steps = [...new Set([16, 24, 40, 80, 120, cur].filter((x) => x > 0))].sort((a, b) => a - b);
    const what = steps.map((hrs) => ({ hrs, r: laborRate(d, { year: selYear, lineHours: hrs }) }));
    const maxRate = Math.max(0, ...what.map((w) => w.r.rate));
    const vs = (v, base) => (base ? ratio(v / base) : '');
    const whatPanel = empty || !cur ? null : h('section', { class: 'panel' },
      h('h2', null, 'What if the line runs more hours a week?'),
      h('p', { class: 'panel-note' }, 'The same people on the line whenever it runs: salaried pay stays the same and hourly people are paid for the extra hours. Running far more hours usually means more people or shifts; add them to the year to see that cost.'),
      h('div', { class: 'tablewrap flat' }, h('table', { class: 't whatif' },
        h('thead', null, h('tr', null, h('th', null, 'Production hours a week'), h('th', null, 'Labor rate'), h('th', { class: 'num' }, 'vs. now'), h('th', { class: 'num' }, 'Labor cost'),
          L.recipes.map((rc) => h('th', { class: 'num wrap' }, `Per batch: ${rc.item.name.replace(/^RECIPE:\s*/i, '')}`)))),
        h('tbody', null, what.map(({ hrs, r }) => h('tr', { class: hrs === cur ? 'current' : null },
          h('td', null, `${qty(hrs, 2)} hours${hrs === cur ? ' (now)' : ''}`),
          h('td', { class: 'barcell' }, h('span', { class: 'bar', style: { width: `${maxRate ? (r.rate / maxRate) * 100 : 0}%` } }), h('span', { class: 'barval' }, perMin(r.rate))),
          h('td', { class: 'num' + (r.rate > L.rate * 1.0005 ? ' up' : r.rate < L.rate * 0.9995 ? ' down' : '') }, vs(r.rate, L.rate)),
          h('td', { class: 'num' }, dollars(r.burdened)),
          L.recipes.map((rc) => h('td', { class: 'num' }, money(r.rate * rc.minutesPer)))))))));

    // The right side: the selected year, with a header that folds it away.
    const rightFolded = (() => { try { return localStorage.getItem('labor:right-folded') === '1'; } catch { return false; } })();
    const foldRight = (f) => { try { localStorage.setItem('labor:right-folded', f ? '1' : '0'); } catch { /* not saved */ } rerender(); };
    const yearHead = h('div', { class: 'year-head' },
      h('h1', null, selYear, isFc ? h('span', { class: 'fc-tag big' }, F.needsReview ? 'forecast · review' : 'forecast') : null),
      h('span', { class: 'muted' }, empty ? 'Not set up' : `${perMin(L.rate)} per labor minute`),
      h('span', { class: 'grow' }),
      h('button', { class: 'btn icon right-fold', title: rightFolded ? `Show ${selYear} details` : `Hide ${selYear} details`, 'aria-label': rightFolded ? `Show ${selYear} details` : `Hide ${selYear} details`, 'aria-expanded': String(!rightFolded),
        onclick: () => foldRight(!rightFolded) }, rightFolded ? '‹' : '›'));
    const peoplePanel = h('section', { class: 'panel people-panel' },
      h('h2', null, h('span', { class: 'grow' }, `${selYear} people`, !ownRows && F.fromYear && !empty ? h('span', { class: 'fc-tag' }, `forecast · ${F.fromYear} + ${qty(F.inflation, 2)}%`) : null),
        can && (ownRows || empty) ? h('button', { class: 'btn ghost', onclick: addPosition }, '+ Add position') : null,
        can && !ownRows && !empty ? h('button', { class: 'btn ghost', onclick: confirmForecast }, F.needsReview ? `Confirm ${selYear}’s people` : `Give ${selYear} its own people`) : null),
      ps.length ? h('div', { class: 'people-body' }, peopleTable) : h('p', { class: 'panel-note' }, `No one entered for ${selYear} yet.`),
      h('p', { class: 'panel-note' }, 'Pay and fringe are per person. Hourly: pay per hour, fringe per month. Salaried: salary and fringe per year. # = number of people. ✎ opens every detail.'));

    return h('div', { class: 'labor' + (isFc ? ' fc-year' : '') + (rightFolded ? ' right-folded' : '') },
      pageHead('Labor Rate', 'The standard labor cost per minute for each year: each position’s paid cost for the year (wages or salary, payroll taxes, benefits) divided by the minutes people spend on the line. The line runs the year’s production hours a week, and everyone who works the line is on it whenever it runs. A new year starts from the year before with an inflation adjustment and is a forecast until it begins; give it its own people to change anything else. Standard Cost uses each year’s rate.' + (admin ? '' : ' Only admins can change these.'),
        yearTable,
        !live ? h('div', { class: 'note warn' }, 'The database hasn’t been updated for the labor rate yet, so Standard Cost uses the workbook’s labor scenarios and this can’t be edited. It becomes editable after the next deploy to main.') : null),
      yearHead,
      rightFolded ? null : [summary, people, peoplePanel, plant, build, whatPanel]);
  },
};
