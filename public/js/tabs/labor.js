// Labor rate: the standard direct labor cost per minute, built the way
// manufacturers usually set it (see laborRate in calc.js):
//   fully burdened pay for each position -> split into direct labor (time on
//   the line) and indirect labor (paid time off the line, e.g. a salaried
//   person paid for 5 days who is on the line 2) -> direct labor cost divided
//   by productive line minutes.
import { h, pageHead, numberCell, money, qty, fmt, pct, toast, niceError, confirmDialog, longDate } from '../ui.js';
import { state, derived, isAdmin, saveSettings, saveRow, insertRow, updateRow, deleteRow } from '../store.js';
import { laborModel, laborRate, laborPosition, evalEntry } from '../calc.js';

const n = (v) => Number(v) || 0;
const perMin = (v) => (v ? '$' + qty(v, 4) : '—');
const dollars = (v) => money(v, 0);
const stat = (label, value, sub, cls = '') => h('div', { class: `stat ${cls}`.trim() }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), sub ? h('div', { class: 'small muted' }, sub) : null);

function textCell(value, save, { disabled, label, key }) {
  return h('td', { class: 'cell text' + (disabled ? '' : ' entry') }, h('input', { type: 'text', value: value ?? '', disabled, 'aria-label': label, 'data-k': key,
    onchange: async (e) => { const v = e.target.value.trim(); if (!v) { e.target.value = value ?? ''; return; } try { await save(v); } catch (err) { e.target.value = value ?? ''; toast(niceError(err), 'bad'); } } }));
}

function caseSizes() {
  const ix = derived.ix(); const sizes = new Map();
  for (const fg of ix.byType('Finished Good')) { const oz = ix.fgCaseOz.get(fg.item_no); if (oz) sizes.set(oz, [...(sizes.get(oz) || []), fg.name]); }
  return [...sizes].sort((a, b) => a[0] - b[0]).map(([oz, names]) => ({ oz, names }));
}

const FIELDS = [
  ['name', 'Position', 'text'], ['pay_type', 'Paid', 'pay'], ['headcount', 'People', 2],
  ['hourly_rate', 'Hourly rate', 4, 'hourly'], ['monthly_fringe', 'Monthly fringe', 2, 'hourly'],
  ['annual_salary', 'Annual salary', 2, 'salaried'], ['annual_fixed', 'Annual fixed cost', 2, 'salaried'],
  ['payroll_tax_pct', 'Payroll tax %', 2], ['paid_days', 'Days paid / wk', 2], ['production_days', 'Days on line / wk', 2], ['hours_per_day', 'Hours / day', 2],
];

// Every detail of one position, with its cost build-up as you type.
function positionDialog(p, can) {
  const plant = laborRate(state.data).plant;
  const inputs = {}; const rows = [];
  for (const [k, label, kind, only] of FIELDS) {
    let el;
    if (kind === 'text') el = h('input', { type: 'text', value: p[k] ?? '', disabled: !can, required: true });
    else if (kind === 'pay') el = h('select', { disabled: !can }, h('option', { value: 'hourly', selected: p.pay_type !== 'salaried' }, 'Hourly'), h('option', { value: 'salaried', selected: p.pay_type === 'salaried' }, 'Salaried'));
    else el = h('input', { type: 'text', inputmode: 'decimal', value: p[k] ?? '', disabled: !can });
    inputs[k] = el;
    const label2 = { hourly_rate: 'Hourly rate (per person)', monthly_fringe: 'Monthly fringe (per person)', annual_salary: 'Annual salary (per person)', annual_fixed: 'Annual fixed cost (per person)' }[k] || label;
    rows.push({ only, el: h('label', { class: 'field' }, label2, el) });
  }
  inputs.notes = h('textarea', { rows: 2, disabled: !can, placeholder: 'Who this is, what the fixed cost covers…' }, p.notes || '');
  const read = () => {
    const out = { ...p, name: inputs.name.value.trim() || p.name, pay_type: inputs.pay_type.value, notes: inputs.notes.value.trim() || null };
    for (const [k, , kind] of FIELDS) if (typeof kind === 'number') { const v = inputs[k].value.trim(); try { out[k] = v === '' ? null : evalEntry(v); } catch { out[k] = p[k]; } }
    return out;
  };
  const summary = h('div', { class: 'gd-summary' });
  const refresh = () => {
    const x = read(); const sal = x.pay_type === 'salaried';
    for (const r of rows) r.el.hidden = r.only ? (r.only === 'salaried') !== sal : false;
    const r = laborPosition(x, plant);
    summary.replaceChildren(h('table', { class: 't gd-table' }, h('tbody', null,
      [['Paid hours a year', fmt(r.paidHours)], ['Hours on the line a year', fmt(r.lineHours)], ['Base pay', dollars(r.base)], ['Payroll taxes', dollars(r.tax)],
        ['Benefits and fixed costs', dollars(r.benefits)], ['Fully burdened cost', dollars(r.burdened)], ['Burdened cost per paid hour', money(r.perPaidHour)],
        ['On the line', pct(r.share)], ['Direct labor (to the labor rate)', dollars(r.direct)], ['Indirect labor (to overhead)', dollars(r.indirect)]]
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
        for (const k of ['headcount', 'payroll_tax_pct', 'paid_days', 'production_days', 'hours_per_day']) patch[k] = patch[k] ?? 0;
        await updateRow('labor_positions', 'id', p.id, patch); dlg.close(); toast(`${patch.name} saved.`);
      } catch (err) { toast(niceError(err), 'bad'); }
    } },
    h('h3', null, `Position: ${p.name}`),
    h('div', { class: 'pd-grid' }, rows.map((r) => r.el)),
    h('label', { class: 'field' }, 'Notes', inputs.notes),
    h('h4', { class: 'pd-sub' }, 'For the year'),
    summary,
    h('div', { class: 'actions' }, h('button', { class: 'btn', value: 'cancel', formnovalidate: true }, can ? 'Cancel' : 'Close'), can ? h('button', { class: 'btn primary', value: 'save' }, 'Save') : null)));
  dlg.addEventListener('close', () => dlg.remove());
  refresh(); document.body.append(dlg); dlg.showModal();
}

export default {
  id: 'labor',
  label: 'Labor',
  render() {
    const d = state.data; const s = d.settings; const admin = isAdmin();
    const live = Array.isArray(d.labor_positions) && (d.labor_positions.length > 0 || 'labor_paid_weeks' in s);
    const can = admin && live;
    const lm = laborModel(d); const L = lm.current; const cm = derived.costs(); const sizes = caseSizes();
    const thisYear = new Date().getFullYear();

    const addPosition = async () => {
      try { await insertRow('labor_positions', { name: 'New position', pay_type: 'hourly', headcount: 1, hourly_rate: 0, monthly_fringe: 0, payroll_tax_pct: 7.65, paid_days: 5, production_days: 5, hours_per_day: 8, sort: Math.max(0, ...d.labor_positions.map((x) => n(x.sort))) + 1 }); }
      catch (err) { toast(niceError(err), 'bad'); }
    };
    const save = (p, k) => (v) => updateRow('labor_positions', 'id', p.id, { [k]: v ?? (['headcount', 'payroll_tax_pct', 'paid_days', 'production_days', 'hours_per_day'].includes(k) ? 0 : null) });

    // ---------- summary ----------
    const summary = h('div', { class: 'cards labor-cards' },
      stat('Standard labor rate', perMin(L.rate), `${money(L.rate * 60)} per labor hour · ${L.plant.idleTo === 'labor' ? 'includes' : 'excludes'} off-line time`, 'key'),
      stat('Direct labor a year', dollars(L.direct), `${fmt(L.minutes)} productive minutes`),
      stat('Indirect labor a year', dollars(L.indirect), L.plant.idleTo === 'labor' ? 'Included in the labor rate' : `Belongs in overhead: ${perMin(L.overheadPerMin)} per labor minute`),
      stat(`Labor per batch (${fmt(s.minutes_per_batch)} min)`, money(L.perBatch), `Capacity ${fmt(L.batchesPerYear)} batches a year`));

    // ---------- standard by year ----------
    let prior = null;
    const years = h('section', { class: 'panel' },
      h('h2', null, 'Standard labor rate by year'),
      h('p', { class: 'panel-note' }, 'Set the standard once a year: lock the rate so pay changes during the year don’t change standard costs (the difference shows up as a labor variance). Unlocked years use today’s calculated rate.'),
      h('div', { class: 'tablewrap flat' }, h('table', { class: 't labor-years' },
        h('thead', null, h('tr', null, h('th', { class: 'sticky-col' }, 'Year'), h('th', { class: 'num' }, 'Standard $/min'), h('th', { class: 'num' }, 'Per labor hour'), h('th', null, 'Status'),
          h('th', { class: 'num' }, 'vs. prior year'), h('th', { class: 'num' }, 'Per batch'), h('th'))),
        h('tbody', null, cm.years.map((y) => {
          const locked = lm.locked(y); const rate = lm.rateFor(y); const row = lm.years.get(y) || {};
          const change = prior && rate ? rate / prior - 1 : null; if (rate) prior = rate;
          const set = (patch) => saveRow('year_settings', { year: y }, patch).catch((err) => toast(niceError(err), 'bad'));
          const lockNow = () => set({ labor_rate: +lm.live(y).toFixed(6), labor_rate_set_at: new Date().toISOString() });
          return h('tr', { class: [locked !== null ? 'locked' : '', y === thisYear ? 'this-year' : ''].join(' ').trim() || null },
            h('td', { class: 'sticky-col strong' }, y),
            h('td', { class: 'num strong std-rate' }, perMin(rate)), h('td', { class: 'num' }, rate ? money(rate * 60) : ''),
            h('td', null, locked !== null ? h('span', { class: 'pill lockpill' }, `🔒 Locked${row.labor_rate_set_at ? ' ' + longDate(row.labor_rate_set_at.slice(0, 10)) : ''}`) : h('span', { class: 'muted small' }, 'Uses today’s rate')),
            h('td', { class: 'num' + (change > 0 ? ' up' : change < 0 ? ' down' : '') }, change === null ? '' : (change > 0 ? '+' : '') + pct(change)),
            h('td', { class: 'num' }, rate ? money(rate * n(s.minutes_per_batch)) : ''),
            h('td', { class: 'row-actions' }, admin && lm.live(y) ? [
              locked === null ? h('button', { class: 'btn ghost', onclick: lockNow }, 'Lock rate') : null,
              locked !== null && Math.abs(lm.live(y) - locked) > 5e-7 ? h('button', { class: 'btn ghost', title: `Replace with today’s ${perMin(lm.live(y))}`, onclick: lockNow }, 'Update') : null,
              locked !== null ? h('button', { class: 'btn ghost', onclick: () => set({ labor_rate: null, labor_rate_set_at: null }) }, 'Unlock') : null] : null));
        })))));

    // ---------- people ----------
    const ps = [...d.labor_positions].sort((a, b) => n(a.sort) - n(b.sort) || a.id - b.id);
    const na = () => h('td', { class: 'num blank' }, '—');
    const people = h('section', { class: 'panel' },
      h('h2', null, h('span', { class: 'grow' }, 'People'), can ? h('button', { class: 'btn ghost', onclick: addPosition }, '+ Add position') : null),
      h('p', { class: 'panel-note' }, 'One row per position, or per group paid the same way; amounts are per person. Hourly: hourly rate + monthly fringe. Salaried: annual salary + annual fixed cost. “Days on line” is time actually on the production line; a salaried person paid for 5 days and on the line 2 has 3 days of indirect labor.'),
      h('div', { class: 'tablewrap flat', 'data-scroll': 'labor-people' }, h('table', { class: 't pay-groups' },
        h('thead', null,
          h('tr', { class: 'group' }, h('th'), h('th'), h('th'), h('th', { colspan: 2 }, 'Hourly · per person'), h('th', { colspan: 2 }, 'Salaried · per person'), h('th'), h('th', { colspan: 3 }, 'Schedule'), h('th')),
          h('tr', null, FIELDS.map(([, label, kind]) => h('th', { class: typeof kind === 'number' ? 'num wrap' : null }, label)), h('th'))),
        h('tbody', null, ps.length ? ps.map((p) => {
          const sal = p.pay_type === 'salaried';
          return h('tr', null, FIELDS.map(([k, label, kind, only]) => {
            if (kind === 'text') return textCell(p.name, save(p, 'name'), { disabled: !can, label: 'Position', key: `lp|${p.id}|name` });
            if (kind === 'pay') return h('td', null, h('select', { disabled: !can, 'aria-label': `How ${p.name} is paid`, onchange: (e) => save(p, 'pay_type')(e.target.value).catch((err) => toast(niceError(err), 'bad')) },
              h('option', { value: 'hourly', selected: !sal }, 'Hourly'), h('option', { value: 'salaried', selected: sal }, 'Salaried')));
            if (only && (only === 'salaried') !== sal) return na();
            return numberCell(p[k] ?? null, save(p, k), { disabled: !can, digits: kind, key: `lp|${p.id}|${k}`, title: `${p.name}: ${label}` });
          }),
          h('td', { class: 'row-actions' }, h('button', { class: 'btn ghost', onclick: () => positionDialog(p, can) }, can ? 'Details' : 'View'),
            can ? h('button', { class: 'btn icon-btn danger', title: 'Remove', 'aria-label': `Remove ${p.name}`, onclick: async () => {
              if (await confirmDialog(`Remove ${p.name}?`, 'Remove')) deleteRow('labor_positions', 'id', p.id).catch((err) => toast(niceError(err), 'bad'));
            } }, '×') : null));
        }) : h('tr', null, h('td', { colspan: FIELDS.length + 1, class: 'empty' }, live ? 'No positions yet. Add one to start.' : 'Not set up yet.'))))));

    // ---------- plant assumptions ----------
    const plantRow = (label, help, cellEl) => h('tr', null, h('td', null, label, help ? h('div', { class: 'small muted' }, help) : null), cellEl);
    const setting = (k, title) => numberCell(s[k] ?? null, (v) => saveSettings({ [k]: v ?? 0 }), { disabled: !can, key: `set|${k}`, title });
    const plant = h('section', { class: 'panel batch-panel' },
      h('h2', null, 'Plant assumptions'),
      h('table', { class: 't batch-table' }, h('tbody', null,
        plantRow('Weeks paid a year', 'Usually 52; paid holidays and vacation are part of the year.', setting('labor_paid_weeks', 'Weeks paid a year')),
        plantRow('Weeks the line runs a year', 'Paid weeks less holidays, vacation and shutdowns.', setting('labor_prod_weeks', 'Weeks the line runs a year')),
        plantRow('Line efficiency %', 'Share of line time spent making product, after setup, cleaning and breaks. Often 80–90%.', setting('labor_efficiency_pct', 'Line efficiency %')),
        plantRow('Paid time off the line goes to', 'Best practice is overhead, so the labor rate reflects time making product.',
          h('td', null, h('select', { disabled: !can, 'aria-label': 'Paid time off the line goes to', onchange: (e) => saveSettings({ labor_idle_to: e.target.value }).catch((err) => toast(niceError(err), 'bad')) },
            h('option', { value: 'overhead', selected: L.plant.idleTo !== 'labor' }, 'Overhead (recommended)'), h('option', { value: 'labor', selected: L.plant.idleTo === 'labor' }, 'The labor rate')))),
        plantRow('Labor minutes per batch', 'Everyone’s minutes added up (3 people × 40 min = 120).', numberCell(s.minutes_per_batch ?? null, (v) => saveSettings({ minutes_per_batch: v ?? 0 }), { disabled: !admin, key: 'set|minutes_per_batch', title: 'Labor minutes per batch' })),
        plantRow('Batch size (oz)', null, numberCell(s.production_batch_size ?? null, (v) => saveSettings({ production_batch_size: v ?? 0 }), { disabled: !admin, key: 'set|production_batch_size', title: 'Batch size (oz)' })))));

    // ---------- cost build-up ----------
    const cols = [['People', (r) => qty(r.people, 2)], ['Paid hours', (r) => fmt(r.paidHours)], ['Line hours', (r) => fmt(r.lineHours)], ['Base pay', (r) => dollars(r.base)],
      ['Payroll tax', (r) => dollars(r.tax)], ['Benefits & fixed', (r) => dollars(r.benefits)], ['Fully burdened', (r) => dollars(r.burdened)], ['On the line', (r) => pct(r.share)],
      ['Direct labor', (r) => dollars(r.direct)], ['Indirect labor', (r) => dollars(r.indirect)], ['Productive minutes', (r) => fmt(r.minutes)]];
    const tot = { people: L.rows.reduce((t, r) => t + r.people, 0), paidHours: L.paidHours, lineHours: L.lineHours, base: L.base, tax: L.tax, benefits: L.benefits, burdened: L.burdened,
      share: L.paidHours ? L.lineHours / L.paidHours : 0, direct: L.direct, indirect: L.indirect, minutes: L.minutes };
    const build = h('section', { class: 'panel' },
      h('h2', null, 'Cost build-up for the year'),
      h('div', { class: 'tablewrap flat', 'data-scroll': 'labor-build' }, h('table', { class: 't build' },
        h('thead', null, h('tr', null, h('th', { class: 'sticky-col' }, 'Position'), cols.map(([l]) => h('th', { class: 'num wrap' }, l)))),
        h('tbody', null, L.rows.map((r) => h('tr', null, h('td', { class: 'sticky-col' }, r.position.name), cols.map(([, f]) => h('td', { class: 'num' }, f(r))))),
          h('tr', { class: 'total' }, h('td', { class: 'sticky-col' }, 'Total'), cols.map(([, f]) => h('td', { class: 'num' }, f(tot))))))),
      h('div', { class: 'formula' },
        h('div', null, 'Standard labor rate = ', L.plant.idleTo === 'labor' ? 'all labor ' : 'direct labor ', h('strong', null, dollars(L.plant.idleTo === 'labor' ? L.direct + L.indirect : L.direct)),
          ' ÷ productive minutes ', h('strong', null, fmt(L.minutes)), ' = ', h('strong', { class: 'accent' }, perMin(L.rate)), ' per labor minute'),
        L.plant.idleTo === 'labor' ? null : h('div', { class: 'muted' }, `Indirect labor of ${dollars(L.indirect)} is not in the labor rate. Include it in overhead: it adds ${perMin(L.overheadPerMin)} per labor minute (fully loaded labor would be ${perMin(L.fullyLoadedRate)}).`)));

    // ---------- what if ----------
    const what = [1, 2, 3, 4, 5].map((days) => ({ days, r: laborRate(d, { days }) }));
    const curDays = Math.max(0, ...L.rows.map((r) => r.lineDays));
    const maxRate = Math.max(0, ...what.map((w) => w.r.fullyLoadedRate));
    const vs = (v, base) => { if (!base) return ''; const c = v / base - 1; return Math.abs(c) < 0.0005 ? 'same' : (c > 0 ? '+' : '') + pct(c); };
    const whatPanel = L.rows.length ? h('section', { class: 'panel' },
      h('h2', null, 'What if the line runs more or fewer days a week?'),
      h('p', { class: 'panel-note' }, 'Same people and pay. Salaried people are paid for their full week whatever the line does, so on fewer line days more of their pay is indirect labor (overhead), and the fully loaded cost of each labor minute rises. The standard labor rate only moves when the mix of people on the line changes.'),
      h('div', { class: 'tablewrap flat' }, h('table', { class: 't whatif' },
        h('thead', null, h('tr', null, h('th', null, 'Line days a week'), h('th', { class: 'num' }, 'Standard labor rate'), h('th', { class: 'num' }, 'Indirect labor (overhead)'),
          h('th', { class: 'num' }, 'Overhead per labor min'), h('th', null, 'Fully loaded $/min'), h('th', { class: 'num' }, 'vs. now'), h('th', { class: 'num' }, 'Fully loaded per batch'),
          sizes.map((z) => h('th', { class: 'num', title: z.names.join(', ') }, `Per ${fmt(z.oz)} oz case`)))),
        h('tbody', null, what.map(({ days, r }) => {
          const batchMin = n(s.minutes_per_batch); const loaded = r.fullyLoadedRate * batchMin; const ozCost = n(s.production_batch_size) ? loaded / n(s.production_batch_size) : 0;
          return h('tr', { class: days === curDays ? 'current' : null },
            h('td', null, `${days} day${days > 1 ? 's' : ''}${days === curDays ? ' (now)' : ''}`),
            h('td', { class: 'num' }, perMin(r.rate)), h('td', { class: 'num' }, dollars(r.indirect)), h('td', { class: 'num' }, perMin(r.overheadPerMin)),
            h('td', { class: 'barcell' }, h('span', { class: 'bar', style: { width: `${maxRate ? (r.fullyLoadedRate / maxRate) * 100 : 0}%` } }), h('span', { class: 'barval' }, perMin(r.fullyLoadedRate))),
            h('td', { class: 'num' + (r.fullyLoadedRate > L.fullyLoadedRate * 1.0005 ? ' up' : r.fullyLoadedRate < L.fullyLoadedRate * 0.9995 ? ' down' : '') }, vs(r.fullyLoadedRate, L.fullyLoadedRate)),
            h('td', { class: 'num' }, money(loaded)), sizes.map((z) => h('td', { class: 'num' }, ozCost ? money(ozCost * z.oz, 3) : '—')));
        }))))) : null;

    return h('div', { class: 'labor' },
      pageHead('Labor Rate', 'The standard direct labor cost per minute, set the way manufacturers usually do: each position’s fully burdened pay (wages or salary, payroll taxes, benefits) is split into direct labor (time on the production line) and indirect labor (paid time off the line, which belongs in overhead). The labor rate is direct labor cost ÷ productive line minutes. Lock each year’s rate as that year’s standard.' + (admin ? '' : ' Only admins can change these.'),
        can ? h('button', { class: 'btn primary', onclick: addPosition }, '+ Add position') : null,
        h('span', { class: 'legend-entry' }, h('i'), 'Type in the yellow cells'),
        !live ? h('div', { class: 'note warn' }, 'The database hasn’t been updated for the labor rate yet, so this shows the workbook’s labor scenarios read-only. It becomes editable after the next deploy to main.') : null),
      summary, years, people, plant, build, whatPanel);
  },
};
