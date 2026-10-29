// Planning: a dashboard; the demand plan for finished goods (forecast sales,
// planned production, projected stock); the purchase plan for raw materials and
// packaging (what to order, how much and by when, and the order schedule ahead);
// and safety stocks (lead times, safety stock, order sizes). Purchase orders
// themselves are placed and tracked in QuickBooks. The rules are in calc.js
// (demandPlan, materialPlan).
import { h, pageHead, numberCell, qty, seg, chip, longDate, typePill, todayIso, toast, niceError } from '../ui.js';
import { state, derived, saveCell, saveField, isAdmin } from '../store.js';
import { DEFAULT_LEAD_DAYS, FG_SAFETY_WEEKS, PLAN_WEEKS, HISTORY_WEEKS, addDays, evalEntry, holdsLabel, inReceiving, hasReceiving, unitWord, mondayOf } from '../calc.js';
import { barChart } from '../charts.js';

// "2,640 box" for a quantity in base units, when the item has a receiving unit.
const asReceived = (it, q) => { if (!hasReceiving(it)) return ''; const x = inReceiving(it, q); return `${qty(x, 1)} ${unitWord(it.receiving_unit, x)}`; };
import { xtable, filteredRows, activeFilterCount, clearFilters, downloadButton, downloadCsv } from '../xtable.js';

const shortDate = (iso) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;
const weekHead = (w) => h('th', { class: 'num', title: `Week of ${longDate(w)}` }, h('span', { class: 'wk-label' }, 'Wk of'), h('br'), shortDate(w));
const num = (v, d = 0) => (v ? qty(v, d) : '');
const STATUS = { now: ['Order now', 'bad'], soon: ['Order this week', 'warn'], planned: ['Planned', 'info'], ok: ['OK', 'good'] };
const statusPill = (s) => h('span', { class: `status ${STATUS[s][1]}` }, STATUS[s][0]);
const noData = () => (state.data.missingTables?.has('demand_forecast')
  ? h('div', { class: 'note warn' }, 'The database hasn’t been updated for planning yet, so typed-in forecasts can’t be saved. The plan below uses average weekly sales.') : null);

// ---------- Demand Plan ----------
let dpView = 'forecast';
let dpSelected = null; // item_no of the product selected for adjusting

// Sets a product's forecast to a % of its average for a range of weeks
// (typed-in values), or clears typed-in weeks back to the average.
function adjustForm(r, plan, rerender) {
  const pct = h('input', { id: 'adj-pct', type: 'text', inputmode: 'decimal', value: '120' });
  const from = h('select', { id: 'adj-from' }, plan.weeks.map((w, i) => h('option', { value: w, selected: i === 0 }, `Week of ${shortDate(w)}`)));
  const to = h('select', { id: 'adj-to' }, plan.weeks.map((w, i) => h('option', { value: w, selected: i === 3 }, `Week of ${shortDate(w)}`)));
  const weeksIn = () => plan.weeks.filter((w) => w >= from.value && w <= to.value);
  const apply = async (e) => {
    e.preventDefault();
    try {
      const p = evalEntry(pct.value); if (p === null || p < 0) throw new Error('Enter a percent, like 120.');
      for (const w of weeksIn()) await saveCell('demand_forecast', { item_no: r.item.item_no, week: w }, 'cases', Math.round((r.avg * p) / 100));
      toast(`${r.item.name}: ${weeksIn().length} weeks set to ${p}% of average.`); rerender();
    } catch (err) { toast(niceError(err), 'bad'); }
  };
  const clear = async () => {
    try { for (const c of r.weeks) if (c.typed) await saveCell('demand_forecast', { item_no: r.item.item_no, week: c.week }, 'cases', null); toast(`${r.item.name} is back to the average.`); rerender(); }
    catch (err) { toast(niceError(err), 'bad'); }
  };
  return h('form', { class: 'item-form adjust-form', onsubmit: apply },
    h('strong', { class: 'tb-title' }, r.item.name),
    h('div', { class: 'small muted' }, `Average ${qty(r.avg, 1)} cases a week`),
    h('div', { class: 'item-fields' }, h('label', { class: 'field span2' }, '% of average', pct), h('label', { class: 'field' }, 'From', from), h('label', { class: 'field' }, 'Through', to)),
    h('p', { class: 'small muted' }, 'For a promotion, a new account or a slow season: 150 = half again as much, 80 = a fifth less.'),
    h('div', { class: 'controls' }, r.weeks.some((c) => c.typed) ? h('button', { type: 'button', class: 'btn', onclick: clear }, 'Back to average') : null, h('button', { type: 'submit', class: 'btn primary' }, 'Apply')));
}

export const demandPlanTab = {
  id: 'demandplan',
  label: 'Demand Plan',
  render({ rerender }) {
    const plan = derived.plan(); const admin = isAdmin();
    const views = [['forecast', 'Forecast'], ['production', 'Production'], ['onhand', 'On hand']];
    const cellsFor = (r) => r.weeks.map((c) => {
      if (dpView === 'forecast') {
        return numberCell(c.typed ? c.forecast : null, (v) => saveCell('demand_forecast', { item_no: r.item.item_no, week: c.week }, 'cases', v),
          { disabled: !admin, digits: 0, key: `df|${r.item.item_no}|${c.week}`, placeholder: qty(c.forecast, 0), cls: c.typed ? 'typed' : 'suggested',
            title: `${r.item.name}, week of ${longDate(c.week)}: ${c.typed ? 'typed-in forecast' : `average ${qty(r.avg, 1)} a week`} (clear a cell to go back to the average)` });
      }
      const v = dpView === 'production' ? c.production : c.endOnHand;
      return h('td', { class: 'num' + (v < 0 ? ' neg' : '') + (dpView === 'onhand' && v < r.safety ? ' low' : '') }, dpView === 'production' ? num(v) : qty(v, 0));
    });
    const total = (r) => (dpView === 'forecast' ? r.weeks.reduce((s, c) => s + c.forecast, 0) : dpView === 'production' ? r.weeks.reduce((s, c) => s + c.production, 0) : null);
    const colTotals = plan.weeks.map((_, i) => plan.rows.reduce((s, r) => s + (dpView === 'forecast' ? r.weeks[i].forecast : dpView === 'production' ? r.weeks[i].production : r.weeks[i].endOnHand), 0));
    const next4 = plan.rows.reduce((s, r) => s + r.weeks.slice(0, 4).reduce((a, c) => a + c.production, 0), 0);
    const table = h('table', { class: 't natural plain-cells plan-table' },
      h('thead', null, h('tr', null, h('th', { class: 'sticky-col' }, 'Product'), h('th', { class: 'num', title: `Average weekly cases sold, ${longDate(plan.history.from)} – ${longDate(plan.history.to)}` }, 'Avg / wk'),
        h('th', { class: 'num' }, 'On hand'), h('th', { class: 'num', title: `${FG_SAFETY_WEEKS} week of forecast sales` }, 'Safety'),
        plan.weeks.map(weekHead), dpView !== 'onhand' ? h('th', { class: 'num' }, 'Total') : null)),
      h('tbody', null, plan.rows.map((r) => h('tr', { class: r.item.item_no === dpSelected && dpView === 'forecast' ? 'selected' : null },
        h('td', { class: 'sticky-col' + (dpView === 'forecast' && admin ? ' pick' : ''), title: dpView === 'forecast' && admin ? 'Select to adjust this product’s forecast' : null,
          onclick: dpView === 'forecast' && admin ? () => { dpSelected = r.item.item_no === dpSelected ? null : r.item.item_no; rerender(); } : null }, r.item.name),
        h('td', { class: 'num' }, qty(r.avg, 1)), h('td', { class: 'num' + (r.onHand < 0 ? ' neg' : '') }, qty(r.onHand, 0)), h('td', { class: 'num' }, qty(r.safety, 0)),
        cellsFor(r), dpView !== 'onhand' ? h('td', { class: 'num strong' }, qty(total(r), 0)) : null))),
      h('tfoot', null, h('tr', { class: 'xt-totals' }, h('td', { class: 'sticky-col' }, 'Total cases'), h('td', { class: 'num' }, qty(plan.rows.reduce((s, r) => s + r.avg, 0), 1)),
        h('td', { class: 'num' }, qty(plan.rows.reduce((s, r) => s + r.onHand, 0), 0)), h('td', { class: 'num' }, qty(plan.rows.reduce((s, r) => s + r.safety, 0), 0)),
        colTotals.map((v) => h('td', { class: 'num' }, qty(v, 0))), dpView !== 'onhand' ? h('td', { class: 'num' }, qty(colTotals.reduce((s, v) => s + v, 0), 0)) : null)));
    return h('div', null,
      pageHead('Demand Plan', `Cases of each product expected to sell over the next ${PLAN_WEEKS} weeks, and the production that keeps a safety stock of ${FG_SAFETY_WEEKS} week of sales on hand. The forecast is each product’s average weekly sales over the last ${HISTORY_WEEKS} weeks with sales (${longDate(plan.history.from)} – ${longDate(plan.history.to)}); type a number in any week to override it, or clear it to go back to the average. Planned production feeds the Purchase Plan.`,
        seg(views, dpView, (v) => { dpView = v; rerender(); }),
        chip('Production, next 4 wks', `${qty(next4, 0)} cases`),
        chip('Forecast basis', `${shortDate(plan.history.from)}–${shortDate(plan.history.to)}`),
        h('button', { class: 'btn ghost download', onclick: () => downloadCsv(`demand-plan-${dpView}`, [
          { key: 'p', label: 'Product', value: (r) => r.item.name }, { key: 'a', label: 'Avg / wk', num: true, value: (r) => r.avg }, { key: 'o', label: 'On hand', num: true, value: (r) => r.onHand }, { key: 's', label: 'Safety', num: true, value: (r) => r.safety },
          ...plan.weeks.map((w, i) => ({ key: w, label: `Week of ${w}`, num: true, value: (r) => (dpView === 'forecast' ? r.weeks[i].forecast : dpView === 'production' ? r.weeks[i].production : r.weeks[i].endOnHand) }))], plan.rows) }, '⤓ Download for Excel'),
        dpView === 'forecast' && admin && dpSelected && plan.rows.find((r) => r.item.item_no === dpSelected) ? adjustForm(plan.rows.find((r) => r.item.item_no === dpSelected), plan, rerender) : null,
        dpView === 'forecast' ? h('p', { class: 'small muted' }, 'Grey numbers are the average; type over them to plan a promotion, a new account or a slow week, or click a product to adjust several weeks at once.') : null),
      noData(),
      h('div', { class: 'tablewrap', 'data-scroll': 'demandplan' }, table),
      dpView === 'production' && plan.batches.length ? [h('h2', { class: 'section-title' }, 'Recipe batches for planned production'),
        h('div', { class: 'tablewrap' }, h('table', { class: 't natural plain-cells plan-table batch-table' },
          h('thead', null, h('tr', null, h('th', { class: 'sticky-col' }, 'Recipe'), h('th', { class: 'num' }, 'Batch size'), plan.weeks.map(weekHead), h('th', { class: 'num' }, 'Total'))),
          h('tbody', null, plan.batches.map((b) => h('tr', null, h('td', { class: 'sticky-col' }, b.recipe.name), h('td', { class: 'num' }, `${qty(b.size, 0)} ${b.unit}`),
            b.weeks.map((w) => h('td', { class: 'num', title: `${qty(w.oz, 0)} ${b.unit} needed` }, w.batches || '')), h('td', { class: 'num strong' }, b.weeks.reduce((t, w) => t + w.batches, 0)))))))] : null);
  },
};

// ---------- Purchase Plan ----------
let ppView = 'plan';
let selected = null;
const orderText = (it, q) => asReceived(it, q) || `${qty(q, 0)} ${unitWord(it.unit, q)}`;
// Every planned order in the next PLAN_WEEKS weeks, by the date it has to be placed.
const schedule = (rows) => rows.flatMap((r) => r.orders.map((o) => ({ ...o, r }))).sort((a, b) => (a.orderBy < b.orderBy ? -1 : a.orderBy > b.orderBy ? 1 : a.r.item.sort - b.r.item.sort));

export const purchasePlanTab = {
  id: 'purchases',
  label: 'Purchase Plan',
  render({ rerender }) {
    const mp = derived.materials(); const today = todayIso();
    const rows = mp.rows;
    const views = [['plan', 'To order'], ['schedule', 'Look ahead'], ['weekly', 'Weekly']];
    const nNow = rows.filter((r) => r.status === 'now').length; const nSoon = rows.filter((r) => r.status === 'soon').length;
    const unit = (r) => r.item.unit || '';
    const sel = selected ? rows.find((r) => r.item.item_no === selected) : null;
    const side = sel ? h('div', { class: 'side-detail' },
      h('strong', null, sel.item.name), h('div', { class: 'small muted' }, `#${sel.item.item_no}`),
      h('dl', { class: 'kv' },
        h('dt', null, 'On hand today'), h('dd', null, `${qty(sel.onHand, 1)} ${unit(sel)}`),
        h('dt', null, 'Planned use / wk'), h('dd', null, `${qty(sel.avgPlanned, 1)} ${unit(sel)}`),
        h('dt', null, 'Safety stock'), h('dd', null, `${qty(sel.safety, 1)}${sel.typedSafety ? ' (typed in)' : ''}`),
        h('dt', null, 'Lead time'), h('dd', null, `${sel.leadDays} days`),
        hasReceiving(sel.item) ? [h('dt', null, 'Comes in'), h('dd', null, `${sel.item.receiving_unit} of ${holdsLabel(sel.item)}`)] : null,
        h('dt', null, 'Reorder point'), h('dd', null, qty(sel.reorderPoint, 1))),
      sel.orders.length ? h('table', { class: 't side-orders' }, h('thead', null, h('tr', null, h('th', null, 'Order by'), h('th', null, 'How much'), h('th', null, 'Arrives'))),
        h('tbody', null, sel.orders.map((o) => h('tr', { class: o.orderBy <= today ? 'late' : null }, h('td', null, shortDate(o.orderBy)), h('td', { title: `${qty(o.qty, 0)} ${unit(sel)}` }, orderText(sel.item, o.qty)), h('td', null, `wk ${shortDate(o.week)}`)))))
        : h('p', { class: 'small muted' }, `No purchase needed in the next ${PLAN_WEEKS} weeks.`))
      : h('p', { class: 'small muted' }, 'Click a material to see its orders over the next 12 weeks.');

    let body; let planDownload = null;
    if (ppView === 'schedule') {
      const list = schedule(rows);
      const byWeek = new Map(); for (const o of list) { const w = o.orderBy < today ? 'now' : mondayOf(o.orderBy); if (!byWeek.has(w)) byWeek.set(w, []); byWeek.get(w).push(o); }
      body = list.length ? h('div', { class: 'schedule' }, [...byWeek].map(([w, os]) => h('section', { class: 'panel sched-week' + (w === 'now' || w === mondayOf(today) ? ' urgent' : '') },
        h('h2', null, w === 'now' ? 'Overdue — order now' : w === mondayOf(today) ? `This week (order by ${os.map((o) => shortDate(o.orderBy)).sort()[os.length - 1]})` : `Week of ${longDate(w)}`),
        h('div', { class: 'scroll-x' }, h('table', { class: 't natural sched-table' },
          h('thead', null, h('tr', null, h('th', null, 'Order by'), h('th', null, 'Item'), h('th', null, 'How much'), h('th', { class: 'num' }, 'In base units'), h('th', null, 'Arrives'))),
          h('tbody', null, os.map((o) => h('tr', { class: o.orderBy < today ? 'late' : null },
            h('td', null, longDate(o.orderBy)), h('td', null, h('strong', null, o.r.item.name)), h('td', { class: 'strong' }, orderText(o.r.item, o.qty)),
            h('td', { class: 'num muted' }, `${qty(o.qty, 0)} ${unit(o.r)}`), h('td', null, `week of ${shortDate(o.week)}`)))))))))
        : h('div', { class: 'panel empty' }, `Nothing to order in the next ${PLAN_WEEKS} weeks.`);
      planDownload = list.length ? downloadButton('order-schedule', [
        { key: 'by', label: 'Order by', value: (o) => o.orderBy }, { key: 'item', label: 'Item', value: (o) => o.r.item.name },
        { key: 'rcv', label: 'How much', value: (o) => orderText(o.r.item, o.qty) }, { key: 'qty', label: 'Base qty', num: true, value: (o) => o.qty },
        { key: 'unit', label: 'Base unit', value: (o) => unit(o.r) }, { key: 'wk', label: 'Arrives week of', value: (o) => o.week }], list) : null;
    } else if (ppView === 'weekly') {
      body = h('div', { class: 'tablewrap', 'data-scroll': 'purchase-weekly' }, h('table', { class: 't natural plain-cells plan-table' },
        h('thead', null, h('tr', null, h('th', { class: 'sticky-col' }, 'Item'), h('th', null, 'Unit'), h('th', { class: 'num' }, 'On hand'), h('th', { class: 'num' }, 'Safety'), mp.weeks.map(weekHead))),
        h('tbody', null, rows.map((r) => h('tr', { class: r.item.item_no === selected ? 'selected' : null, onclick: () => { selected = r.item.item_no === selected ? null : r.item.item_no; rerender(); } },
          h('td', { class: 'sticky-col' }, r.item.name), h('td', { class: 'muted' }, unit(r)), h('td', { class: 'num' + (r.onHand < 0 ? ' neg' : '') }, qty(r.onHand, 0)), h('td', { class: 'num' }, qty(r.safety, 0)),
          r.weeks.map((c) => h('td', { class: 'num wk' + (c.endOnHand < 0 ? ' neg' : '') + (c.short ? ' low' : ''), title: `Week of ${longDate(c.week)}: uses ${qty(c.need, 1)}${c.receipt ? `, planned delivery ${qty(c.receipt, 0)}` : ''}, ends at ${qty(c.endOnHand, 1)}` },
            c.receipt ? h('span', { class: 'rcpt' }, `+${qty(c.receipt, 0)}`) : null, qty(c.endOnHand, 0))))))));
    } else {
      const columns = [
        { key: 'name', label: 'Item', sticky: true, value: (r) => r.item.name, cell: (r) => h('td', { class: 'sticky-col' }, r.item.name) },
        { key: 'type', label: 'Type', value: (r) => (r.item.type === 'Component' ? 'Packaging' : r.item.type), cell: (r) => h('td', null, typePill(r.item.type)) },
        { key: 'status', label: 'Status', value: (r) => ['now', 'soon', 'planned', 'ok'].indexOf(r.status), text: (r) => STATUS[r.status][0], cell: (r) => h('td', null, statusPill(r.status), r.short ? h('span', { class: 'status bad short', title: 'Projected below safety stock before a new order could arrive: expedite, or adjust production' }, ' Short') : null) },
        { key: 'orderBy', label: 'Order by', value: (r) => r.next?.orderBy || '', text: (r) => (r.next ? longDate(r.next.orderBy) : ''), cell: (r) => h('td', { class: r.next && r.next.orderBy < today ? 'neg' : null }, r.next ? longDate(r.next.orderBy) : '') },
        { key: 'how', label: 'How much', value: (r) => (r.next ? orderText(r.item, r.next.qty) : ''), cell: (r) => h('td', { class: 'strong' }, r.next ? orderText(r.item, r.next.qty) : '') },
        { key: 'qty', label: 'Base qty', num: true, value: (r) => r.next?.qty || 0, text: (r) => (r.next ? qty(r.next.qty, 0) : ''), cell: (r) => h('td', { class: 'num muted' }, r.next ? `${qty(r.next.qty, 0)} ${unit(r)}` : '') },
        { key: 'arrives', label: 'Arrives', value: (r) => r.next?.week || '', text: (r) => (r.next ? `week of ${shortDate(r.next.week)}` : ''), cell: (r) => h('td', null, r.next ? `week of ${shortDate(r.next.week)}` : '') },
        { key: 'onhand', label: 'On hand', num: true, value: (r) => r.onHand, text: (r) => qty(r.onHand, 0), cell: (r) => h('td', { class: 'num' + (r.onHand < 0 ? ' neg' : '') }, qty(r.onHand, 0)) },
        { key: 'use', label: 'Use / wk', num: true, value: (r) => r.avgPlanned, text: (r) => qty(r.avgPlanned, 0), cell: (r) => h('td', { class: 'num' }, qty(r.avgPlanned, 0)) },
        { key: 'safety', label: 'Safety stock', num: true, value: (r) => r.safety, text: (r) => qty(r.safety, 0), cell: (r) => h('td', { class: 'num' }, qty(r.safety, 0)) },
        { key: 'lead', label: 'Lead (days)', num: true, value: (r) => r.leadDays, cell: (r) => h('td', { class: 'num' }, r.leadDays) },
      ];
      const shown = filteredRows({ id: 'purchase-plan', columns, rows, defaultSort: { key: 'status', dir: 'asc' } });
      planDownload = downloadButton('purchase-plan', columns, shown);
      body = h('div', { class: 'tablewrap', 'data-scroll': 'purchase-plan' }, xtable({ id: 'purchase-plan', columns, allRows: rows, rows: shown, rerender, defaultSort: { key: 'status', dir: 'asc' },
        className: 'natural plain-cells selectable', rowClass: (r) => (r.item.item_no === selected ? 'selected' : null),
        onRowClick: (r) => { selected = r.item.item_no === selected ? null : r.item.item_no; rerender(); } }));
    }
    const nFilters = activeFilterCount('purchase-plan');
    return h('div', null,
      pageHead('Purchase Plan', `When to order raw materials and packaging, and how much, so they cover the Demand Plan’s production. Place the orders in QuickBooks. To order shows each item’s next order; Look ahead lists every order coming up over the next ${PLAN_WEEKS} weeks by the date it needs to be placed; Weekly shows each item’s projected stock week by week. Orders arrive one lead time after they’re placed and bring stock back above safety stock plus two weeks of use, in whole boxes, bags or cases. Lead times and safety stocks are on the Safety Stocks tab. Until a delivery is entered on New Receipts, an order already placed still shows as needed.`,
        seg(views, ppView, (v) => { ppView = v; rerender(); }),
        chip('Order now', nNow), chip('Order this week', nSoon),
        ppView !== 'schedule' ? side : null,
        nFilters && ppView === 'plan' ? h('button', { class: 'btn ghost', onclick: () => { clearFilters('purchase-plan'); rerender(); } }, `Clear filters (${nFilters})`) : null,
        planDownload),
      noData(),
      body);
  },
};

// ---------- Safety Stocks ----------
export const safetyStocksTab = {
  id: 'safety',
  label: 'Safety Stocks',
  render({ rerender }) {
    const rows = derived.materials().rows; const admin = isAdmin();
    const settings = new Map(state.data.purchase_settings.map((s) => [s.item_no, s]));
    const unit = (r) => r.item.unit || '';
    const columns = [
      { key: 'name', label: 'Item', sticky: true, value: (r) => r.item.name, cell: (r) => h('td', { class: 'sticky-col' }, r.item.name) },
      { key: 'type', label: 'Type', value: (r) => (r.item.type === 'Component' ? 'Packaging' : r.item.type), cell: (r) => h('td', null, typePill(r.item.type)) },
      { key: 'unit', label: 'Base unit', value: (r) => unit(r), cell: (r) => h('td', { class: 'muted' }, unit(r)) },
      { key: 'use', label: 'Planned use / wk', num: true, value: (r) => r.avgPlanned, text: (r) => qty(r.avgPlanned, 0), cell: (r) => h('td', { class: 'num' }, qty(r.avgPlanned, 0)) },
      { key: 'lead', label: 'Lead time (days)', num: true, value: (r) => r.leadDays,
        cell: (r) => numberCell(settings.get(r.item.item_no)?.lead_days ?? null, (v) => saveField('purchase_settings', { item_no: r.item.item_no }, 'lead_days', v),
          { disabled: !admin, digits: 0, key: `ps|${r.item.item_no}|lead_days`, placeholder: String(DEFAULT_LEAD_DAYS), title: `${r.item.name} lead time in days (blank = ${DEFAULT_LEAD_DAYS})` }) },
      { key: 'auto', label: 'Calculated safety stock', num: true, value: (r) => r.autoSafety, text: (r) => qty(r.autoSafety, 0), cell: (r) => h('td', { class: 'num muted' }, qty(r.autoSafety, 0)) },
      { key: 'safety', label: 'Safety stock used', num: true, value: (r) => r.safety,
        cell: (r) => numberCell(settings.get(r.item.item_no)?.safety_stock ?? null, (v) => saveField('purchase_settings', { item_no: r.item.item_no }, 'safety_stock', v),
          { disabled: !admin, digits: 2, key: `ps|${r.item.item_no}|safety_stock`, placeholder: qty(r.autoSafety, 0), title: `${r.item.name} safety stock (blank = calculated, ${qty(r.autoSafety, 1)})` }) },
      { key: 'weeks', label: 'Weeks of use', num: true, value: (r) => (r.avgPlanned ? r.safety / r.avgPlanned : null), text: (r) => (r.avgPlanned ? qty(r.safety / r.avgPlanned, 1) : ''), cell: (r) => h('td', { class: 'num' }, r.avgPlanned ? qty(r.safety / r.avgPlanned, 1) : '') },
      { key: 'rop', label: 'Reorder point', num: true, value: (r) => r.reorderPoint, text: (r) => qty(r.reorderPoint, 0), cell: (r) => h('td', { class: 'num', title: 'Use during the lead time + safety stock: order when stock gets this low' }, qty(r.reorderPoint, 0)) },
      { key: 'multiple', label: 'Order in multiples of', num: true, value: (r) => r.multiple,
        cell: (r) => numberCell(settings.get(r.item.item_no)?.standard_purchase ?? null, (v) => saveField('purchase_settings', { item_no: r.item.item_no }, 'standard_purchase', v),
          { disabled: !admin, digits: 2, key: `ps|${r.item.item_no}|standard_purchase`, placeholder: hasReceiving(r.item) ? String(r.item.units_per_receiving) : '1', title: `${r.item.name} order size in ${unit(r)} (blank = one ${r.item.receiving_unit || 'unit'})` }) },
      { key: 'comes', label: 'Comes in', value: (r) => (hasReceiving(r.item) ? `${r.item.receiving_unit} of ${holdsLabel(r.item)}` : ''), cell: (r) => h('td', { class: 'muted' }, hasReceiving(r.item) ? `${r.item.receiving_unit} of ${holdsLabel(r.item)}` : '') },
    ];
    const shown = filteredRows({ id: 'safety-stocks', columns, rows });
    const nFilters = activeFilterCount('safety-stocks');
    const typed = rows.filter((r) => r.typedSafety).length;
    return h('div', null,
      pageHead('Safety Stocks', `How much of each raw material and packaging item to keep in reserve, and how long it takes to arrive. The Purchase Plan orders so stock never drops below safety stock. Lead time is ${DEFAULT_LEAD_DAYS} days unless typed in. The calculated safety stock is the larger of one week of planned use and enough to cover normal week-to-week swings in use 95% of the time over the lead time; type a number in Safety stock used to override it, or clear it to go back. Orders are rounded up to whole boxes, bags or cases unless an order size is typed in (in the base unit).` + (admin ? '' : ' Only admins can change these.'),
        chip('Lead time', `${DEFAULT_LEAD_DAYS} days unless set`), chip('Typed-in safety stocks', typed),
        downloadButton('safety-stocks', columns, shown),
        nFilters ? h('button', { class: 'btn ghost', onclick: () => { clearFilters('safety-stocks'); rerender(); } }, `Clear filters (${nFilters})`) : null),
      noData(),
      h('div', { class: 'tablewrap', 'data-scroll': 'safety-stocks' }, xtable({ id: 'safety-stocks', columns, allRows: rows, rows: shown, rerender, className: 'natural plain-cells' })));
  },
};

// ---------- Planning Dashboard ----------
export const planningDashboardTab = {
  id: 'planning',
  label: 'Planning Dashboard',
  render() {
    const plan = derived.plan(); const mp = derived.materials(); const today = todayIso();
    const now = mp.rows.filter((r) => r.status === 'now'); const soon = mp.rows.filter((r) => r.status === 'soon');
    const short = mp.rows.filter((r) => r.short);
    const upcoming = schedule(mp.rows).filter((o) => o.orderBy >= today && o.orderBy <= addDays(today, 27));
    const prodWeeks = plan.weeks.map((w, i) => plan.rows.reduce((t, r) => t + r.weeks[i].production, 0));
    const fcWeeks = plan.weeks.map((w, i) => plan.rows.reduce((t, r) => t + r.weeks[i].forecast, 0));
    const lowFg = plan.rows.filter((r) => r.onHand < r.safety);
    const batchesNext = plan.batches.map((b) => [b.recipe.name, b.weeks[0]?.batches || 0]).filter(([, n]) => n);
    const full = Math.max(300, Math.min(1100, window.innerWidth - (window.innerWidth <= 520 ? 54 : 340)));
    const stat = (label, value, sub, cls = '') => h('div', { class: 'stat ' + cls }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), sub ? h('div', { class: 'small muted' }, sub) : null);
    const orderList = (list, empty) => (list.length ? h('div', { class: 'scroll-x' }, h('table', { class: 't natural sched-table' },
      h('thead', null, h('tr', null, h('th', null, 'Item'), h('th', null, 'How much'), h('th', null, 'Order by'), h('th', null, 'Arrives'))),
      h('tbody', null, list.map((x) => { const o = x.next || x; const r = x.r || x; return h('tr', { class: o.orderBy < today ? 'late' : null },
        h('td', null, h('strong', null, r.item.name)), h('td', { class: 'strong' }, orderText(r.item, o.qty)), h('td', null, longDate(o.orderBy)), h('td', null, `week of ${shortDate(o.week)}`)); }))))
      : h('p', { class: 'muted' }, empty));
    return h('div', null,
      pageHead('Planning Dashboard', 'What to order now, what’s coming up, and what production the plan needs. Details are on Demand Plan, Purchase Plan and Safety Stocks.'),
      h('div', { class: 'cards' },
        stat('Order now', now.length, now.length ? 'Past or at the order-by date' : 'Nothing overdue', now.length ? 'alert' : ''),
        stat('Order this week', soon.length, 'Order-by date in the next 7 days', soon.length ? 'warn' : ''),
        stat('Could run short', short.length, short.length ? 'Before a new order could arrive' : 'Nothing at risk', short.length ? 'alert' : ''),
        stat('Production, next 4 weeks', `${qty(prodWeeks.slice(0, 4).reduce((a, b) => a + b, 0), 0)} cases`, batchesNext.length ? `This week: ${batchesNext.map(([n, b]) => `${b} ${n.replace(/^RECIPE:\s*/, '')}`).join(', ')} batch${batchesNext.reduce((t, [, b]) => t + b, 0) === 1 ? '' : 'es'}` : null)),
      h('div', { class: 'grid2', style: { marginTop: '16px' } },
        h('section', { class: 'panel' }, h('h2', null, 'Order now'), orderList(now, 'Nothing needs ordering today.'),
          short.length ? h('p', { class: 'note warn' }, `Could run short before a new order arrives: ${short.map((r) => r.item.name).join(', ')}. Expedite, or adjust production.`) : null),
        h('section', { class: 'panel' }, h('h2', null, 'Coming up in the next 4 weeks'), orderList(upcoming, 'No orders due in the next 4 weeks.'))),
      h('section', { class: 'panel', style: { marginTop: '16px' } }, h('h2', null, `Forecast sales and planned production, next ${PLAN_WEEKS} weeks (cases)`),
        h('div', { class: 'body chart' }, barChart({ width: full, height: 260, money: false, title: 'Forecast and planned production by week', labels: plan.weeks.map(shortDate),
          series: [{ name: 'Forecast sales', values: fcWeeks, cls: 'bar-b' }, { name: 'Planned production', values: prodWeeks, cls: 'bar-a' }] })),
        h('div', { class: 'legend' }, h('span', null, h('i', { style: { background: 'var(--accent-2)' } }), 'Forecast sales'), h('span', null, h('i', { style: { background: 'var(--accent)' } }), 'Planned production'))),
      lowFg.length ? h('section', { class: 'panel', style: { marginTop: '16px' } }, h('h2', null, 'Products below safety stock today'),
        h('p', null, lowFg.map((r) => `${r.item.name} (${qty(r.onHand, 0)} on hand, safety ${qty(r.safety, 0)})`).join(' · '))) : null);
  },
};
