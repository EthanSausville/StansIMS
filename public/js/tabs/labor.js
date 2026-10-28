import { h, pageHead, numberCell, money, qty, fmt, toast, niceError } from '../ui.js';
import { state, derived, isAdmin, saveSettings, saveCell } from '../store.js';
import { laborScenarios } from '../calc.js';

const SETTINGS = [
  ['salaried_count', 'Salaried people', 'Annual productive hours come from 8 h × days per week × 52.'],
  ['salaried_wage', 'Salaried wage (annual, incl. fringe)', null, 2],
  ['hourly_a_count', 'Hourly (A) people'],
  ['hourly_a_rate', 'Hourly (A) rate ($/h)', null, 2],
  ['hourly_b_count', 'Hourly (B) people'],
  ['hourly_b_rate', 'Hourly (B) rate ($/h)', null, 2],
  ['minutes_per_batch', 'Minutes worked per batch'],
  ['production_batch_size', 'Production batch size (oz)'],
];

export default {
  id: 'labor',
  label: 'Labor',
  render() {
    const s = state.data.settings; const admin = isAdmin(); const cm = derived.costs();
    const sc = laborScenarios(s);
    const chosen = new Map(state.data.year_settings.map((y) => [y.year, y.labor_scenario]));
    return h('div', null,
      pageHead('Labor Scenarios', 'Wages and staffing behind the direct labor rate. Pick which scenario sets the standard labor cost for each year.' + (admin ? '' : ' Only admins can change these.')),
      h('div', { class: 'grid2' },
        h('div', { class: 'panel' }, h('h2', null, 'Staffing and batches'),
          h('table', { class: 't' }, h('tbody', null, SETTINGS.map(([k, label, , digits]) => h('tr', null, h('td', null, label),
            numberCell(s[k] ?? null, (v) => saveSettings({ [k]: v ?? 0 }), { disabled: !admin, key: `set|${k}`, title: label, digits: digits ?? 4 })))))),
        h('div', { class: 'panel' }, h('h2', null, 'Scenario used for standard cost'),
          h('table', { class: 't' }, h('thead', null, h('tr', null, h('th', null, 'Year'), h('th', null, 'Scenario'), h('th', { class: 'num' }, 'Labor $/min'))),
            h('tbody', null, cm.years.map((y) => h('tr', null, h('td', null, y),
              h('td', null, h('select', { disabled: !admin, 'aria-label': `Scenario for ${y}`, onchange: async (e) => {
                  const v = e.target.value ? Number(e.target.value) : null;
                  try { await saveCell('year_settings', { year: y }, 'labor_scenario', v); } catch (err) { toast(niceError(err), 'bad'); }
                } }, h('option', { value: '' }, 'None'), sc.map((x) => h('option', { value: x.scenario, selected: chosen.get(y) === x.scenario }, `${x.name}: ${x.description.toLowerCase()}`)))),
              h('td', { class: 'num calc' }, chosen.get(y) ? '$' + qty(sc[chosen.get(y) - 1].ratePerMin, 4) : ''))))))),
      h('div', { class: 'tablewrap', style: { marginTop: '16px' } }, h('table', { class: 't' },
        h('thead', null,
          h('tr', { class: 'group' }, h('th'), h('th'), h('th', { colspan: 3 }, 'Annual productive hours'), h('th', { colspan: 3 }, 'Annual wages (incl. fringe)'), h('th', { colspan: 5 }, '')),
          h('tr', null, h('th', null, 'Name'), h('th', null, 'Description'), ['Salaried', 'Hourly (A)', 'Hourly (B)', 'Salaried', 'Hourly (A)', 'Hourly (B)', 'Total wages', 'Avg hourly', 'Standard rate ($/min)', 'Total batches', 'Monthly batches'].map((x) => h('th', { class: 'num wrap' }, x)))),
        h('tbody', null, sc.map((x) => h('tr', null, h('td', null, x.name), h('td', { class: 'muted' }, x.description),
          [fmt(x.hrsSal), fmt(x.hrsA), fmt(x.hrsB), money(x.wagesSal, 0), money(x.wagesA, 0), money(x.wagesB, 0), money(x.total, 0), money(x.avgHourly), '$' + qty(x.ratePerMin, 4), fmt(x.totalBatches), fmt(x.monthlyBatches)]
            .map((v) => h('td', { class: 'num' }, v))))))));
  },
};
