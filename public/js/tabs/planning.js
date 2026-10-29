// Planning: the demand plan for finished goods (forecast sales, planned
// production, projected stock) and the purchase plan for raw materials and
// packaging (what to order, how much and by when). The rules are in calc.js
// (demandPlan, materialPlan).
import { h, pageHead, numberCell, qty, seg, chip, longDate, typePill, todayIso } from '../ui.js';
import { state, derived, saveCell, saveField, isAdmin } from '../store.js';
import { DEFAULT_LEAD_DAYS, FG_SAFETY_WEEKS, PLAN_WEEKS, HISTORY_WEEKS } from '../calc.js';
import { xtable, filteredRows, activeFilterCount, clearFilters } from '../xtable.js';

const shortDate = (iso) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;
const weekHead = (w) => h('th', { class: 'num', title: `Week of ${longDate(w)}` }, h('span', { class: 'wk-label' }, 'Wk of'), h('br'), shortDate(w));
const num = (v, d = 0) => (v ? qty(v, d) : '');
const STATUS = { now: ['Order now', 'bad'], soon: ['Order this week', 'warn'], planned: ['Planned', 'info'], ok: ['OK', 'good'] };
const statusPill = (s) => h('span', { class: `status ${STATUS[s][1]}` }, STATUS[s][0]);
const noData = () => (state.data.missingTables?.has('demand_forecast')
  ? h('div', { class: 'note warn' }, 'The database hasn’t been updated for planning yet, so typed-in forecasts can’t be saved. The plan below uses average weekly sales.') : null);

// ---------- Demand Plan ----------
let dpView = 'forecast';

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
      h('tbody', null, plan.rows.map((r) => h('tr', null,
        h('td', { class: 'sticky-col' }, r.item.name),
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
        dpView === 'forecast' ? h('p', { class: 'small muted' }, 'Grey numbers are the average; type over them to plan a promotion, a new account or a slow week.') : null),
      noData(),
      h('div', { class: 'tablewrap', 'data-scroll': 'demandplan' }, table));
  },
};

// ---------- Purchase Plan ----------
let ppView = 'plan';
let selected = null;

export const purchasePlanTab = {
  id: 'purchases',
  label: 'Purchase Plan',
  render({ rerender }) {
    const mp = derived.materials(); const admin = isAdmin(); const today = todayIso();
    const rows = mp.rows;
    const views = [['plan', 'To order'], ['weekly', 'Weekly'], ['settings', 'Settings']];
    const nNow = rows.filter((r) => r.status === 'now').length; const nSoon = rows.filter((r) => r.status === 'soon').length;
    const unit = (r) => r.item.unit || '';
    const sel = selected ? rows.find((r) => r.item.item_no === selected) : null;
    const side = sel ? h('div', { class: 'side-detail' },
      h('strong', null, sel.item.name), h('div', { class: 'small muted' }, `#${sel.item.item_no} · ${sel.item.pack_note || unit(sel)}`),
      h('dl', { class: 'kv' },
        h('dt', null, 'On hand today'), h('dd', null, `${qty(sel.onHand, 1)} ${unit(sel)}`),
        h('dt', null, 'Planned use / wk'), h('dd', null, `${qty(sel.avgPlanned, 1)} ${unit(sel)}`),
        h('dt', null, 'Safety stock'), h('dd', null, `${qty(sel.safety, 1)}${sel.typedSafety ? ' (typed in)' : ''}`),
        h('dt', null, 'Lead time'), h('dd', null, `${sel.leadDays} days`),
        h('dt', null, 'Reorder point'), h('dd', null, qty(sel.reorderPoint, 1))),
      sel.orders.length ? h('table', { class: 't side-orders' }, h('thead', null, h('tr', null, h('th', null, 'Order by'), h('th', { class: 'num' }, 'Qty'), h('th', null, 'Arrives'))),
        h('tbody', null, sel.orders.map((o) => h('tr', { class: o.orderBy <= today ? 'late' : null }, h('td', null, shortDate(o.orderBy)), h('td', { class: 'num' }, qty(o.qty, 0)), h('td', null, `wk ${shortDate(o.week)}`)))))
        : h('p', { class: 'small muted' }, `No purchase needed in the next ${PLAN_WEEKS} weeks.`)) : h('p', { class: 'small muted' }, 'Click a material to see its orders.');

    let body;
    if (ppView === 'settings') {
      const settings = new Map(state.data.purchase_settings.map((s) => [s.item_no, s]));
      const columns = [
        { key: 'name', label: 'Item', sticky: true, value: (r) => r.item.name, cell: (r) => h('td', { class: 'sticky-col' }, r.item.name) },
        { key: 'unit', label: 'Unit', value: (r) => unit(r), cell: (r) => h('td', { class: 'muted' }, unit(r)) },
        { key: 'lead', label: 'Lead time (days)', num: true, value: (r) => r.leadDays,
          cell: (r) => numberCell(settings.get(r.item.item_no)?.lead_days ?? null, (v) => saveField('purchase_settings', { item_no: r.item.item_no }, 'lead_days', v),
            { disabled: !admin, digits: 0, key: `ps|${r.item.item_no}|lead_days`, placeholder: String(DEFAULT_LEAD_DAYS), title: `${r.item.name} lead time in days (blank = ${DEFAULT_LEAD_DAYS})` }) },
        { key: 'safety', label: 'Safety stock', num: true, value: (r) => r.safety,
          cell: (r) => numberCell(settings.get(r.item.item_no)?.safety_stock ?? null, (v) => saveField('purchase_settings', { item_no: r.item.item_no }, 'safety_stock', v),
            { disabled: !admin, digits: 2, key: `ps|${r.item.item_no}|safety_stock`, placeholder: qty(r.autoSafety, 0), title: `${r.item.name} safety stock (blank = calculated, ${qty(r.autoSafety, 1)})` }) },
        { key: 'multiple', label: 'Order in multiples of', num: true, value: (r) => r.multiple,
          cell: (r) => numberCell(settings.get(r.item.item_no)?.standard_purchase ?? null, (v) => saveField('purchase_settings', { item_no: r.item.item_no }, 'standard_purchase', v),
            { disabled: !admin, digits: 2, key: `ps|${r.item.item_no}|standard_purchase`, placeholder: '1', title: `${r.item.name} order size (a case, a pallet…)` }) },
        { key: 'pack', label: 'Pack', value: (r) => r.item.pack_note || '', cell: (r) => h('td', { class: 'muted' }, r.item.pack_note || '') },
      ];
      body = h('div', { class: 'tablewrap', 'data-scroll': 'purchase-settings' }, xtable({ id: 'purchase-settings', columns, allRows: rows, rows: filteredRows({ id: 'purchase-settings', columns, rows }), rerender, className: 'natural plain-cells' }));
    } else if (ppView === 'weekly') {
      body = h('div', { class: 'tablewrap', 'data-scroll': 'purchase-weekly' }, h('table', { class: 't natural plain-cells plan-table' },
        h('thead', null, h('tr', null, h('th', { class: 'sticky-col' }, 'Item'), h('th', null, 'Unit'), h('th', { class: 'num' }, 'On hand'), h('th', { class: 'num' }, 'Safety'), mp.weeks.map(weekHead))),
        h('tbody', null, rows.map((r) => h('tr', { class: r.item.item_no === selected ? 'selected' : null, onclick: () => { selected = r.item.item_no === selected ? null : r.item.item_no; rerender(); } },
          h('td', { class: 'sticky-col' }, r.item.name), h('td', { class: 'muted' }, unit(r)), h('td', { class: 'num' + (r.onHand < 0 ? ' neg' : '') }, qty(r.onHand, 0)), h('td', { class: 'num' }, qty(r.safety, 0)),
          r.weeks.map((c) => h('td', { class: 'num wk' + (c.endOnHand < 0 ? ' neg' : ''), title: `Week of ${longDate(c.week)}: uses ${qty(c.need, 1)}${c.receipt ? `, receives ${qty(c.receipt, 0)}` : ''}, ends at ${qty(c.endOnHand, 1)}` },
            c.receipt ? h('span', { class: 'rcpt' }, `+${qty(c.receipt, 0)}`) : null, qty(c.endOnHand, 0))))))));
    } else {
      const columns = [
        { key: 'name', label: 'Item', sticky: true, value: (r) => r.item.name, cell: (r) => h('td', { class: 'sticky-col' }, r.item.name) },
        { key: 'type', label: 'Type', value: (r) => (r.item.type === 'Component' ? 'Packaging' : r.item.type), cell: (r) => h('td', null, typePill(r.item.type)) },
        { key: 'status', label: 'Status', value: (r) => ['now', 'soon', 'planned', 'ok'].indexOf(r.status), text: (r) => STATUS[r.status][0], cell: (r) => h('td', null, statusPill(r.status)) },
        { key: 'orderBy', label: 'Order by', value: (r) => r.next?.orderBy || '', text: (r) => (r.next ? longDate(r.next.orderBy) : ''), cell: (r) => h('td', { class: r.next && r.next.orderBy < today ? 'neg' : null }, r.next ? longDate(r.next.orderBy) : '') },
        { key: 'qty', label: 'Order qty', num: true, value: (r) => r.next?.qty || 0, text: (r) => (r.next ? qty(r.next.qty, 0) : ''), cell: (r) => h('td', { class: 'num strong' }, r.next ? qty(r.next.qty, 0) : '') },
        { key: 'unit', label: 'Unit', value: (r) => unit(r), cell: (r) => h('td', { class: 'muted' }, unit(r)) },
        { key: 'onhand', label: 'On hand', num: true, value: (r) => r.onHand, text: (r) => qty(r.onHand, 0), cell: (r) => h('td', { class: 'num' + (r.onHand < 0 ? ' neg' : '') }, qty(r.onHand, 0)) },
        { key: 'use', label: 'Use / wk', num: true, value: (r) => r.avgPlanned, text: (r) => qty(r.avgPlanned, 0), cell: (r) => h('td', { class: 'num' }, qty(r.avgPlanned, 0)) },
        { key: 'safety', label: 'Safety stock', num: true, value: (r) => r.safety, text: (r) => qty(r.safety, 0), cell: (r) => h('td', { class: 'num' }, qty(r.safety, 0)) },
        { key: 'rop', label: 'Reorder point', num: true, value: (r) => r.reorderPoint, text: (r) => qty(r.reorderPoint, 0), cell: (r) => h('td', { class: 'num' }, qty(r.reorderPoint, 0)) },
        { key: 'lead', label: 'Lead (days)', num: true, value: (r) => r.leadDays, cell: (r) => h('td', { class: 'num' }, r.leadDays) },
      ];
      const shown = filteredRows({ id: 'purchase-plan', columns, rows, defaultSort: { key: 'status', dir: 'asc' } });
      body = h('div', { class: 'tablewrap', 'data-scroll': 'purchase-plan' }, xtable({ id: 'purchase-plan', columns, allRows: rows, rows: shown, rerender, defaultSort: { key: 'status', dir: 'asc' },
        className: 'natural plain-cells selectable', rowClass: (r) => (r.item.item_no === selected ? 'selected' : null),
        onRowClick: (r) => { selected = r.item.item_no === selected ? null : r.item.item_no; rerender(); } }));
    }
    const nFilters = activeFilterCount('purchase-plan');
    return h('div', null,
      pageHead('Purchase Plan', `What to buy, how much and by when, so raw materials and packaging cover the Demand Plan’s production. Lead time is ${DEFAULT_LEAD_DAYS} days unless set otherwise. Safety stock is calculated as the larger of one week of planned use and enough to cover normal week-to-week swings in use 95% of the time over the lead time; type your own in Settings. Orders bring stock back above safety stock plus two weeks of use, in multiples of the order size when one is set.`,
        seg(views, ppView, (v) => { ppView = v; rerender(); }),
        chip('Order now', nNow), chip('Order this week', nSoon),
        ppView !== 'settings' ? side : null,
        nFilters && ppView === 'plan' ? h('button', { class: 'btn ghost', onclick: () => { clearFilters('purchase-plan'); rerender(); } }, `Clear filters (${nFilters})`) : null),
      noData(),
      body);
  },
};

// For the Dashboard: materials to order today.
export const orderNow = () => derived.materials().rows.filter((r) => r.status === 'now');
