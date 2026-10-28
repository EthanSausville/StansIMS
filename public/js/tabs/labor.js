// Labor rate calculator: pay groups, production scenarios, what-if on
// production days, and the standard labor cost per minute for each year.
import { h, pageHead, numberCell, money, qty, fmt, pct, toast, niceError, confirmDialog, longDate } from '../ui.js';
import { state, derived, isAdmin, saveSettings, saveCell, saveRow, insertRow, updateRow, deleteLabor } from '../store.js';
import { laborModel, laborScenario } from '../calc.js';

let whatIf = null; // scenario id for the "what if production days change" table

const perMin = (v) => (v ? '$' + qty(v, 4) : '—');
const dollars = (v) => money(v, 0);

// A text box that saves when it changes (names and notes).
function textCell(value, save, { disabled, label, placeholder, key }) {
  const input = h('input', { type: 'text', value: value ?? '', disabled, 'aria-label': label, placeholder, 'data-k': key,
    onchange: async (e) => {
      const v = e.target.value.trim();
      if (!v && !placeholder) { e.target.value = value ?? ''; return; }
      try { await save(v || null); } catch (err) { e.target.value = value ?? ''; toast(niceError(err), 'bad'); }
    } });
  return h('td', { class: 'cell text' + (disabled ? '' : ' entry') }, input);
}

// Case sizes for "labor per case": one row per distinct oz per case.
function caseSizes() {
  const ix = derived.ix(); const sizes = new Map();
  for (const fg of ix.byType('Finished Good')) {
    const oz = ix.fgCaseOz.get(fg.item_no); if (!oz) continue;
    if (!sizes.has(oz)) sizes.set(oz, []); sizes.get(oz).push(fg.name);
  }
  return [...sizes].sort((a, b) => a[0] - b[0]).map(([oz, names]) => ({ oz, names }));
}

export default {
  id: 'labor',
  label: 'Labor',
  render({ rerender }) {
    const d = state.data; const s = d.settings; const admin = isAdmin();
    const lm = laborModel(d);
    const cm = derived.costs();
    const live = d.labor_groups.length > 0; // false until the database has the labor tables
    const can = admin && live;
    const sizes = caseSizes();
    if (!whatIf || !lm.byId.has(whatIf)) whatIf = lm.years.get(new Date().getFullYear())?.labor_scenario || lm.results[0]?.id;

    const addGroup = async () => {
      try { await insertRow('labor_groups', { name: 'New group', pay_type: 'hourly', headcount: 1, hourly_rate: 0, fringe_pct: 0, sort: Math.max(0, ...d.labor_groups.map((g) => g.sort)) + 1 }); }
      catch (err) { toast(niceError(err), 'bad'); }
    };
    const addScenario = async () => {
      const id = Math.max(0, ...d.labor_scenarios.map((x) => x.id)) + 1;
      const base = lm.byId.get(whatIf);
      try { await insertRow('labor_scenarios', { id, name: `Scenario ${id}`, days_per_week: base?.days ?? 4, hours_per_day: base?.hoursPerDay ?? 8, weeks_per_year: base?.weeks ?? 52, productive_pct: base?.productivePct ?? 100 }); }
      catch (err) { toast(niceError(err), 'bad'); }
    };
    const saveScenario = (sc, field) => (v) => updateRow('labor_scenarios', 'id', sc.id, { [field]: v ?? (field === 'productive_pct' ? 100 : 0) });
    const saveGroup = (g, field) => (v) => updateRow('labor_groups', 'id', g.id, { [field]: v });

    // ---------- 1. standard labor cost per minute, by year ----------
    const usedBy = new Map(); for (const [y, row] of lm.years) if (row.labor_scenario) usedBy.set(row.labor_scenario, [...(usedBy.get(row.labor_scenario) || []), y]);
    let prior = null;
    const yearRows = cm.years.map((y) => {
      const row = lm.years.get(y) || {}; const calc = lm.live(y); const locked = row.labor_rate !== null && row.labor_rate !== undefined;
      const std = lm.rateFor(y);
      const change = prior && std ? std / prior - 1 : null; if (std) prior = std;
      const setYear = (patch) => saveRow('year_settings', { year: y }, patch).catch((err) => toast(niceError(err), 'bad'));
      return h('tr', { class: locked ? 'locked' : null },
        h('td', { class: 'sticky-col strong' }, y),
        h('td', null, h('select', { disabled: !admin, 'aria-label': `Scenario for ${y}`, onchange: (e) => setYear({ labor_scenario: e.target.value ? Number(e.target.value) : null }) },
          h('option', { value: '' }, '—'), lm.results.map((r) => h('option', { value: r.id, selected: row.labor_scenario === r.id }, r.name)))),
        h('td', { class: 'num calc' }, row.labor_scenario ? perMin(calc) : ''),
        h('td', { class: 'num strong std-rate' }, std ? perMin(std) : ''),
        h('td', null, locked ? h('span', { class: 'pill lockpill', title: row.labor_rate_set_at ? `Set ${longDate(row.labor_rate_set_at.slice(0, 10))}` : '' }, '🔒 Locked')
          : row.labor_scenario ? h('span', { class: 'muted small' }, 'Follows the scenario') : h('span', { class: 'muted small' }, 'Not set')),
        h('td', { class: 'num' + (change > 0 ? ' up' : change < 0 ? ' down' : '') }, change === null ? '' : (change > 0 ? '+' : '') + pct(change)),
        h('td', { class: 'num' }, std ? money(std * n(s.minutes_per_batch)) : ''),
        h('td', { class: 'row-actions' }, admin ? [
          !locked && row.labor_scenario ? h('button', { class: 'btn ghost', title: 'Freeze this rate so later pay or schedule changes don’t change this year’s standard', onclick: () => setYear({ labor_rate: +calc.toFixed(6), labor_rate_set_at: new Date().toISOString() }) }, 'Lock rate') : null,
          locked && row.labor_scenario && Math.abs(calc - row.labor_rate) > 1e-6 ? h('button', { class: 'btn ghost', title: `Replace the locked rate with today’s ${perMin(calc)}`, onclick: () => setYear({ labor_rate: +calc.toFixed(6), labor_rate_set_at: new Date().toISOString() }) }, 'Update') : null,
          locked ? h('button', { class: 'btn ghost', onclick: () => setYear({ labor_rate: null, labor_rate_set_at: null }) }, 'Unlock') : null,
        ] : null));
    });
    const standards = h('section', { class: 'panel' },
      h('h2', null, 'Standard labor cost per minute'),
      h('p', { class: 'panel-note' }, 'Pick the scenario each year’s standard is built on. Lock the rate to freeze it: Standard Cost then uses the locked rate even if pay or the schedule changes later. A labor minute is one person working one minute.'),
      h('div', { class: 'tablewrap flat' }, h('table', { class: 't labor-years' },
        h('thead', null, h('tr', null, h('th', { class: 'sticky-col' }, 'Year'), h('th', null, 'Scenario'), h('th', { class: 'num' }, 'Scenario rate today'),
          h('th', { class: 'num' }, 'Standard $/min'), h('th', null, 'Status'), h('th', { class: 'num' }, 'vs. prior year'), h('th', { class: 'num' }, `Per batch (${fmt(s.minutes_per_batch)} min)`), h('th'))),
        h('tbody', null, yearRows))));

    // ---------- 2. pay groups ----------
    const groups = h('section', { class: 'panel' },
      h('h2', null, h('span', { class: 'grow' }, 'Pay groups'), can ? h('button', { class: 'btn ghost', onclick: addGroup }, '+ Add pay group') : null),
      h('p', { class: 'panel-note' }, 'Salaried pay is a yearly cost however many days production runs. Hourly pay follows the hours worked in each scenario. Fringe covers payroll taxes and benefits.'),
      h('div', { class: 'tablewrap flat' }, h('table', { class: 't' },
        h('thead', null, h('tr', null, h('th', null, 'Group'), h('th', null, 'Paid'), h('th', { class: 'num' }, 'People'), h('th', { class: 'num' }, 'Annual salary (each)'),
          h('th', { class: 'num' }, 'Hourly rate'), h('th', { class: 'num' }, 'Fringe %'), h('th', { class: 'num' }, 'Cost'), h('th'))),
        h('tbody', null, lm.groups.map((g) => {
          const sal = g.pay_type === 'salaried'; const f = 1 + n(g.fringe_pct) / 100;
          return h('tr', null,
            textCell(g.name, saveGroup(g, 'name'), { disabled: !can, label: 'Group name', key: `lg|${g.id}|name` }),
            h('td', null, h('select', { disabled: !can, 'aria-label': `How ${g.name} is paid`, onchange: (e) => saveGroup(g, 'pay_type')(e.target.value).catch((err) => toast(niceError(err), 'bad')) },
              h('option', { value: 'salaried', selected: sal }, 'Salaried'), h('option', { value: 'hourly', selected: !sal }, 'Hourly'))),
            numberCell(n(g.headcount), saveGroup(g, 'headcount'), { disabled: !can, digits: 2, key: `lg|${g.id}|heads`, title: `${g.name}: people` }),
            sal ? numberCell(g.annual_salary ?? null, saveGroup(g, 'annual_salary'), { disabled: !can, digits: 2, key: `lg|${g.id}|sal`, title: `${g.name}: annual salary each` }) : h('td', { class: 'num blank' }, '—'),
            sal ? h('td', { class: 'num blank' }, '—') : numberCell(g.hourly_rate ?? null, saveGroup(g, 'hourly_rate'), { disabled: !can, digits: 2, key: `lg|${g.id}|rate`, title: `${g.name}: hourly rate` }),
            numberCell(n(g.fringe_pct), saveGroup(g, 'fringe_pct'), { disabled: !can, digits: 2, key: `lg|${g.id}|fringe`, title: `${g.name}: fringe %` }),
            h('td', { class: 'num calc' }, sal ? `${dollars(n(g.headcount) * n(g.annual_salary) * f)} / yr` : `${money(n(g.headcount) * n(g.hourly_rate) * f)} / hr`),
            h('td', null, can ? h('button', { class: 'btn icon-btn danger', title: 'Remove group', 'aria-label': `Remove ${g.name}`, onclick: async () => {
              if (await confirmDialog(`Remove the ${g.name} pay group from every scenario?`, 'Remove')) deleteLabor('group', g.id).catch((err) => toast(niceError(err), 'bad'));
            } }, '×') : null));
        })))));

    const batch = h('section', { class: 'panel' },
      h('h2', null, 'Batch assumptions'),
      h('table', { class: 't batch-table' }, h('tbody', null,
        h('tr', null, h('td', null, 'Labor minutes per batch', h('div', { class: 'small muted' }, 'All people’s minutes added up (3 people × 40 min = 120)')),
          numberCell(s.minutes_per_batch ?? null, (v) => saveSettings({ minutes_per_batch: v ?? 0 }), { disabled: !admin, key: 'set|minutes_per_batch', title: 'Labor minutes per batch' })),
        h('tr', null, h('td', null, 'Batch size (oz)'),
          numberCell(s.production_batch_size ?? null, (v) => saveSettings({ production_batch_size: v ?? 0 }), { disabled: !admin, key: 'set|production_batch_size', title: 'Batch size (oz)' })))));

    // ---------- 3. scenarios side by side ----------
    const R = lm.results;
    const inputRow = (label, field, digits, help) => h('tr', null, h('th', { class: 'sticky-col rowhead', title: help || null }, label),
      R.map((r) => { const sc = lm.scenarios.find((x) => x.id === r.id);
        return numberCell(sc[field] ?? null, saveScenario(sc, field), { disabled: !can, digits, key: `ls|${r.id}|${field}`, title: `${r.name}: ${label}` }); }));
    const outRow = (label, f, cls = '') => h('tr', { class: cls || null }, h('th', { class: 'sticky-col rowhead' }, label), R.map((r) => h('td', { class: 'num calc' }, f(r))));
    const scenarios = h('section', { class: 'panel' },
      h('h2', null, h('span', { class: 'grow' }, 'Scenarios'), can ? h('button', { class: 'btn ghost', onclick: addScenario }, '+ Add scenario') : null),
      h('p', { class: 'panel-note' }, 'Yellow cells are the schedule and staffing for each scenario. People per group starts from the pay group; type a number to change it for one scenario, or clear it to go back.'),
      h('div', { class: 'tablewrap flat', 'data-scroll': 'labor-scen' }, h('table', { class: 't scen-table' },
        h('thead', null, h('tr', null, h('th', { class: 'sticky-col' }),
          R.map((r) => { const sc = lm.scenarios.find((x) => x.id === r.id);
            return h('th', { class: 'scen-head' }, h('div', { class: 'scen-no' }, `#${r.id}`, usedBy.get(r.id) ? h('span', { class: 'used' }, ` · ${usedBy.get(r.id).join(', ')}`) : null),
              can ? h('input', { type: 'text', class: 'scen-name', value: sc.name, 'aria-label': `Name of scenario ${r.id}`, 'data-k': `ls|${r.id}|name`,
                onchange: (e) => { const v = e.target.value.trim(); if (v) updateRow('labor_scenarios', 'id', r.id, { name: v }).catch((err) => toast(niceError(err), 'bad')); } }) : h('div', null, r.name)); }))),
        h('tbody', null,
          h('tr', { class: 'section' }, h('th', { class: 'sticky-col', colspan: 1 }, 'Schedule'), R.map(() => h('td'))),
          inputRow('Production days a week', 'days_per_week', 2),
          inputRow('Hours a day', 'hours_per_day', 2),
          inputRow('Weeks a year', 'weeks_per_year', 2, 'Weeks production runs, after holidays and shutdowns'),
          inputRow('Productive %', 'productive_pct', 2, 'Share of paid production time spent making product (after setup, cleaning and breaks)'),
          h('tr', { class: 'section' }, h('th', { class: 'sticky-col' }, 'People'), R.map(() => h('td'))),
          lm.groups.map((g) => h('tr', null, h('th', { class: 'sticky-col rowhead' }, g.name, h('span', { class: 'muted small' }, g.pay_type === 'salaried' ? ' (salaried)' : ' (hourly)')),
            R.map((r) => { const x = r.byGroup.find((b) => b.group.id === g.id);
              return numberCell(x.overridden ? x.people : null, (v) => saveCell('labor_scenario_heads', { scenario_id: r.id, group_id: g.id }, 'headcount', v),
                { disabled: !can, digits: 2, key: `lh|${r.id}|${g.id}`, title: `${r.name}: ${g.name} people`, placeholder: qty(n(g.headcount), 2), cls: x.overridden ? 'override' : null }); }))),
          h('tr', { class: 'section' }, h('th', { class: 'sticky-col' }, 'Results'), R.map(() => h('td'))),
          outRow('Production days a year', (r) => fmt(r.productionDays, 1)),
          outRow('Paid production hours', (r) => fmt(r.hours)),
          outRow('Productive labor minutes', (r) => fmt(r.minutes)),
          outRow('Salaried cost', (r) => dollars(r.salaried)),
          outRow('Hourly cost', (r) => dollars(r.hourly)),
          outRow('Total labor cost', (r) => dollars(r.total), 'strong-row'),
          outRow('Salaried share of cost', (r) => pct(r.salariedShare)),
          outRow('Average cost per paid hour', (r) => money(r.avgHourly)),
          outRow('Cost per labor minute', (r) => perMin(r.ratePerMin), 'key-row'),
          outRow(`Labor per batch (${fmt(s.minutes_per_batch)} min)`, (r) => money(r.perBatch)),
          outRow('Labor per oz', (r) => (r.perOz ? '$' + qty(r.perOz, 5) : '—')),
          sizes.map((z) => outRow(`Labor per ${fmt(z.oz)} oz case`, (r) => (r.perOz ? money(r.perOz * z.oz, 3) : '—'))),
          outRow('Batches a year (capacity)', (r) => fmt(r.totalBatches)),
          outRow('Batches a month (capacity)', (r) => fmt(r.monthlyBatches, 1)),
          can ? h('tr', null, h('th', { class: 'sticky-col' }), R.map((r) => h('td', { class: 'num' }, h('button', { class: 'btn ghost danger', disabled: usedBy.has(r.id),
            title: usedBy.has(r.id) ? 'Used by a year’s standard' : 'Remove scenario', onclick: async () => {
              if (await confirmDialog(`Remove scenario “${r.name}”?`, 'Remove')) deleteLabor('scenario', r.id).catch((err) => toast(niceError(err), 'bad'));
            } }, 'Remove')))) : null))));

    // ---------- 4. what if production days change ----------
    const base = lm.byId.get(whatIf);
    const baseSc = lm.scenarios.find((x) => x.id === whatIf);
    const dayOptions = [1, 2, 3, 4, 5, 6];
    const what = base ? dayOptions.map((dd) => ({ days: dd, r: laborScenario(d, baseSc, { days_per_week: dd }) })) : [];
    const maxRate = Math.max(0, ...what.map((w) => w.r.ratePerMin));
    const whatPanel = base ? h('section', { class: 'panel' },
      h('h2', null, h('span', { class: 'grow' }, 'What if production days change?'),
        h('label', { class: 'field inline' }, 'Starting from', h('select', { onchange: (e) => { whatIf = Number(e.target.value); rerender(); } },
          R.map((r) => h('option', { value: r.id, selected: r.id === whatIf }, r.name))))),
      h('p', { class: 'panel-note' }, `Same people, pay and hours as “${base.name}”, with production running more or fewer days a week. Salaried pay stays the same, so it is spread over more or fewer minutes.`),
      h('div', { class: 'tablewrap flat' }, h('table', { class: 't whatif' },
        h('thead', null, h('tr', null, h('th', null, 'Days a week'), h('th', null, 'Cost per labor minute'), h('th', { class: 'num' }, `vs. ${fmt(base.days, 2)} days`),
          h('th', { class: 'num' }, 'Per batch'), sizes.map((z) => h('th', { class: 'num', title: z.names.join(', ') }, `Per ${fmt(z.oz)} oz case`)),
          h('th', { class: 'num' }, 'Salaried share'), h('th', { class: 'num' }, 'Batches a month'))),
        h('tbody', null, what.map(({ days, r }) => h('tr', { class: Math.abs(days - base.days) < 1e-9 ? 'current' : null },
          h('td', null, `${days} day${days > 1 ? 's' : ''}`),
          h('td', { class: 'barcell' }, h('span', { class: 'bar', style: { width: `${maxRate ? (r.ratePerMin / maxRate) * 100 : 0}%` } }), h('span', { class: 'barval' }, perMin(r.ratePerMin))),
          h('td', { class: 'num' + (r.ratePerMin > base.ratePerMin + 1e-9 ? ' up' : r.ratePerMin < base.ratePerMin - 1e-9 ? ' down' : '') },
            base.ratePerMin ? (r.ratePerMin >= base.ratePerMin ? '+' : '') + pct(r.ratePerMin / base.ratePerMin - 1) : ''),
          h('td', { class: 'num' }, money(r.perBatch)),
          sizes.map((z) => h('td', { class: 'num' }, r.perOz ? money(r.perOz * z.oz, 3) : '—')),
          h('td', { class: 'num' }, pct(r.salariedShare)),
          h('td', { class: 'num' }, fmt(r.monthlyBatches, 1)))))))) : null;

    return h('div', { class: 'labor' },
      pageHead('Labor Rate Calculator', 'Works out the standard labor cost per minute from your pay groups and production schedule. Salaried pay is the same whether production runs 2 or 4 days a week, so fewer production days spread it over fewer minutes and raise the rate. Compare scenarios side by side, see what changing production days does, and set each year’s standard.' + (admin ? '' : ' Only admins can change these.'),
        can ? h('button', { class: 'btn primary', onclick: addGroup }, '+ Add pay group') : null,
        can ? h('button', { class: 'btn', onclick: addScenario }, '+ Add scenario') : null,
        h('span', { class: 'legend-entry' }, h('i'), 'Type in the yellow cells'),
        !live ? h('div', { class: 'note warn' }, 'The database hasn’t been updated for the labor calculator yet, so these figures come from the old staffing settings and can’t be edited. They become editable after the next deploy to main.') : null),
      standards, h('div', { class: 'grid2 labor-grid' }, groups, batch), scenarios, whatPanel);
  },
};

const n = (v) => Number(v) || 0;
