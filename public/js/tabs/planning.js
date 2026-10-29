// Planning: the demand plan for finished goods (forecast sales, planned
// production, projected stock) and the purchase plan for raw materials and
// packaging (what to order, how much and by when). The rules are in calc.js
// (demandPlan, materialPlan).
import { h, pageHead, numberCell, qty, seg, chip, longDate, typePill, todayIso, toast, niceError, confirmDialog, acctCell, acctParts, acctText } from '../ui.js';
import { state, derived, saveCell, saveField, isAdmin, insertRow, updateRow, deleteRow, receivePO } from '../store.js';
import { DEFAULT_LEAD_DAYS, FG_SAFETY_WEEKS, PLAN_WEEKS, HISTORY_WEEKS, addDays, yearOf, evalEntry, poStatus, poVariance } from '../calc.js';
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
        : h('p', { class: 'small muted' }, `No purchase needed in the next ${PLAN_WEEKS} weeks.`),
      sel.openQty ? h('div', { class: 'small muted' }, `${qty(sel.openQty, 0)} ${unit(sel)} already on order.`) : null,
      sel.next ? h('button', { class: 'btn primary', onclick: async () => {
        const due = sel.next.orderBy < today ? addDays(today, sel.leadDays) : sel.next.week;
        const price = derived.costs().cost(sel.item.item_no, yearOf(due)) || null;
        try {
          const po = await insertRow('purchase_orders', { item_no: sel.item.item_no, ordered: today, due, qty: sel.next.qty, unit_price: price, cancelled: false });
          poSelected = po.id; toast(`Purchase order for ${qty(sel.next.qty, 0)} ${unit(sel)} of ${sel.item.name} created.`);
          location.hash = 'orders';
        } catch (err) { toast(niceError(err), 'bad'); }
      } }, 'Create purchase order') : null) : h('p', { class: 'small muted' }, 'Click a material to see its orders.');

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
          r.weeks.map((c) => h('td', { class: 'num wk' + (c.endOnHand < 0 ? ' neg' : ''), title: `Week of ${longDate(c.week)}: uses ${qty(c.need, 1)}${c.onOrder ? `, ${qty(c.onOrder, 0)} on order arrives` : ''}${c.receipt ? `, planned delivery ${qty(c.receipt, 0)}` : ''}, ends at ${qty(c.endOnHand, 1)}` },
            c.onOrder ? h('span', { class: 'rcpt po', title: 'On order (open purchase order)' }, `+${qty(c.onOrder, 0)} PO`) : null,
            c.receipt ? h('span', { class: 'rcpt' }, `+${qty(c.receipt, 0)}`) : null, qty(c.endOnHand, 0))))))));
    } else {
      const columns = [
        { key: 'name', label: 'Item', sticky: true, value: (r) => r.item.name, cell: (r) => h('td', { class: 'sticky-col' }, r.item.name) },
        { key: 'type', label: 'Type', value: (r) => (r.item.type === 'Component' ? 'Packaging' : r.item.type), cell: (r) => h('td', null, typePill(r.item.type)) },
        { key: 'status', label: 'Status', value: (r) => ['now', 'soon', 'planned', 'ok'].indexOf(r.status), text: (r) => STATUS[r.status][0], cell: (r) => h('td', null, statusPill(r.status), r.short ? h('span', { class: 'status bad short', title: 'Projected below safety stock before a new order could arrive: expedite, or adjust production' }, ' Short') : null) },
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

// ---------- Purchase Orders ----------
let poSelected = null; // id of the selected order
let poForm = null;     // null, 'new', 'edit' or 'receive'
let poShow = 'open';   // 'open' or 'all'
const PO_STATUS = { open: ['Open', 'info'], late: ['Late', 'bad'], received: ['Received', 'good'], cancelled: ['Cancelled', 'muted'] };

function poFormEl(po, done) {
  const ix = derived.ix(); const today = todayIso();
  const mats = [...ix.byType('Raw Material'), ...ix.byType('Component')];
  const suppliers = [...new Set((state.data.purchase_orders || []).map((p) => p.supplier).filter(Boolean))].sort();
  const listId = 'suppliers-list';
  const f = {
    item: h('select', { id: 'po-item', required: true }, h('option', { value: '' }, 'Choose…'), mats.map((m) => h('option', { value: m.item_no, selected: m.item_no === po?.item_no }, m.name))),
    supplier: h('input', { id: 'po-supplier', type: 'text', list: listId, value: po?.supplier || '' }),
    ordered: h('input', { id: 'po-ordered', type: 'date', required: true, value: po?.ordered || today }),
    due: h('input', { id: 'po-due', type: 'date', required: true, value: po?.due || addDays(today, DEFAULT_LEAD_DAYS) }),
    qty: h('input', { id: 'po-qty', type: 'text', inputmode: 'decimal', required: true, value: po?.qty ?? '' }),
    price: h('input', { id: 'po-price', type: 'text', inputmode: 'decimal', value: po?.unit_price ?? '', placeholder: 'Per unit' }),
    notes: h('input', { id: 'po-notes', type: 'text', value: po?.notes || '' }),
  };
  const unitOf = () => ix.items.get(Number(f.item.value))?.unit || 'unit';
  const unitLabel = h('span', { class: 'muted' }, unitOf());
  f.item.addEventListener('change', () => {
    unitLabel.textContent = unitOf();
    if (!f.price.value) { const c = derived.costs().cost(Number(f.item.value), yearOf(f.due.value || today)); if (c) f.price.value = +c.toFixed(4); }
  });
  const save = async (e) => {
    e.preventDefault();
    try {
      const row = { item_no: Number(f.item.value), supplier: f.supplier.value.trim() || null, ordered: f.ordered.value, due: f.due.value,
        qty: evalEntry(f.qty.value), unit_price: evalEntry(f.price.value), notes: f.notes.value.trim() || null };
      if (!row.item_no || !row.qty) throw new Error('Choose an item and enter a quantity.');
      if (po) { await updateRow('purchase_orders', 'id', po.id, row); toast('Order saved.'); done(po.id); }
      else { const saved = await insertRow('purchase_orders', { ...row, cancelled: false }); toast('Order created.'); done(saved.id); }
    } catch (err) { toast(niceError(err), 'bad'); }
  };
  return h('form', { class: 'item-form po-form', onsubmit: save },
    h('strong', { class: 'tb-title' }, po ? `Edit order #${po.id}` : 'New purchase order'),
    h('div', { class: 'item-fields' },
      h('label', { class: 'field span2' }, 'Item', f.item), h('label', { class: 'field span2' }, 'Supplier', f.supplier, h('datalist', { id: listId }, suppliers.map((x) => h('option', { value: x })))),
      h('label', { class: 'field' }, 'Ordered', f.ordered), h('label', { class: 'field' }, 'Due', f.due),
      h('label', { class: 'field' }, h('span', null, 'Quantity ', unitLabel), f.qty), h('label', { class: 'field' }, 'Unit price ($)', f.price),
      h('label', { class: 'field span2' }, 'Notes', f.notes)),
    h('div', { class: 'controls' },
      po && !po.received ? h('button', { type: 'button', class: 'btn danger', onclick: async () => {
        if (!(await confirmDialog(`Delete order #${po.id}?`))) return;
        try { await deleteRow('purchase_orders', 'id', po.id); toast('Order deleted.'); done(null); } catch (err) { toast(niceError(err), 'bad'); }
      } }, 'Delete') : null,
      h('button', { type: 'button', class: 'btn', onclick: () => done(po?.id ?? null) }, 'Cancel'),
      h('button', { type: 'submit', class: 'btn primary' }, po ? 'Save' : 'Create order')));
}

function receiveForm(po, done) {
  const it = derived.ix().items.get(po.item_no);
  const date = h('input', { id: 'rcv-date', type: 'date', required: true, value: todayIso() });
  const q = h('input', { id: 'rcv-qty', type: 'text', inputmode: 'decimal', required: true, value: po.qty });
  const price = h('input', { id: 'rcv-price', type: 'text', inputmode: 'decimal', value: po.unit_price ?? '', placeholder: 'Price paid per unit' });
  return h('form', { class: 'item-form', onsubmit: async (e) => {
      e.preventDefault();
      try {
        const qv = evalEntry(q.value); const pv = evalEntry(price.value);
        if (!qv) throw new Error('Enter the quantity received.');
        if (pv !== (po.unit_price ?? null)) await updateRow('purchase_orders', 'id', po.id, { unit_price: pv });
        await receivePO({ ...po, unit_price: pv }, date.value, qv);
        toast(`Received ${qty(qv, 0)} ${it?.unit || ''} of ${it?.name}. It’s on Goods Receipt for ${longDate(date.value)}.`); done(po.id);
      } catch (err) { toast(niceError(err), 'bad'); }
    } },
    h('strong', { class: 'tb-title' }, `Receive order #${po.id}`),
    h('div', { class: 'small muted' }, `${it?.name} · ${qty(po.qty, 0)} ${it?.unit || ''} ordered`),
    h('div', { class: 'item-fields' }, h('label', { class: 'field' }, 'Received on', date), h('label', { class: 'field' }, `Quantity (${it?.unit || 'units'})`, q),
      h('label', { class: 'field span2' }, 'Price paid per unit ($)', price)),
    h('p', { class: 'small muted' }, 'Receiving adds the quantity to Goods Receipt for that day. The price paid against standard cost is the purchase price variance on the Journals tab.'),
    h('div', { class: 'controls' }, h('button', { type: 'button', class: 'btn', onclick: () => done(po.id) }, 'Cancel'), h('button', { type: 'submit', class: 'btn primary' }, 'Receive')));
}

export const purchaseOrdersTab = {
  id: 'orders',
  label: 'Purchase Orders',
  get sideWidth() { return poForm ? 300 : null; },
  sideKey: 'orders-form',
  render({ rerender }) {
    const ix = derived.ix(); const cm = derived.costs(); const today = todayIso();
    const all = [...(state.data.purchase_orders || [])];
    const missing = state.data.missingTables?.has('purchase_orders');
    const rows = poShow === 'open' ? all.filter((p) => !p.received && !p.cancelled) : all;
    const sel = poSelected ? all.find((p) => p.id === poSelected) : null;
    const done = (id) => { poForm = null; poSelected = id; rerender(); };
    const amount = (p) => (p.unit_price === null || p.unit_price === undefined ? null : Number(p.unit_price) * Number(p.received_qty ?? p.qty));
    const columns = [
      { key: 'id', label: 'PO #', num: true, sticky: true, value: (p) => p.id, cell: (p) => h('td', { class: 'sticky-col num' }, p.id) },
      { key: 'status', label: 'Status', value: (p) => ['late', 'open', 'received', 'cancelled'].indexOf(poStatus(p, today)), text: (p) => PO_STATUS[poStatus(p, today)][0],
        cell: (p) => h('td', null, h('span', { class: `status ${PO_STATUS[poStatus(p, today)][1]}` }, PO_STATUS[poStatus(p, today)][0])) },
      { key: 'item', label: 'Item', value: (p) => ix.items.get(p.item_no)?.name || '', cell: (p) => h('td', null, ix.items.get(p.item_no)?.name || `#${p.item_no}`) },
      { key: 'supplier', label: 'Supplier', value: (p) => p.supplier || '', cell: (p) => h('td', null, p.supplier || '') },
      { key: 'ordered', label: 'Ordered', value: (p) => p.ordered, text: (p) => longDate(p.ordered), cell: (p) => h('td', null, longDate(p.ordered)) },
      { key: 'due', label: 'Due', value: (p) => p.due, text: (p) => longDate(p.due), cell: (p) => h('td', { class: poStatus(p, today) === 'late' ? 'neg' : null }, longDate(p.due)) },
      { key: 'qty', label: 'Qty', num: true, value: (p) => Number(p.qty), text: (p) => qty(p.qty, 2), cell: (p) => h('td', { class: 'num' }, qty(p.qty, 2)) },
      { key: 'unit', label: 'Unit', value: (p) => ix.items.get(p.item_no)?.unit || '', cell: (p) => h('td', { class: 'muted' }, ix.items.get(p.item_no)?.unit || '') },
      { key: 'price', label: 'Unit price', num: true, value: (p) => p.unit_price, text: (p) => (p.unit_price ? '$' + acctText(p.unit_price) : ''), cell: (p) => acctCell(p.unit_price) },
      { key: 'amount', label: 'Amount', num: true, value: (p) => amount(p), text: (p) => (amount(p) ? '$' + acctText(amount(p)) : ''), cell: (p) => acctCell(amount(p)),
        total: (rs) => acctParts(rs.reduce((s, p) => s + (amount(p) || 0), 0)) },
      { key: 'received', label: 'Received', value: (p) => p.received || '', text: (p) => (p.received ? `${longDate(p.received)}` : ''), cell: (p) => h('td', null, p.received ? `${longDate(p.received)}${p.received_qty !== null && Number(p.received_qty) !== Number(p.qty) ? ` (${qty(p.received_qty, 2)})` : ''}` : '') },
      { key: 'ppv', label: 'Price variance', num: true, value: (p) => poVariance(p, cm), text: (p) => (poVariance(p, cm) === null ? '' : '$' + acctText(poVariance(p, cm))),
        cell: (p) => { const v = poVariance(p, cm); return acctCell(v, { class: v > 0 ? 'neg' : '', title: v === null ? null : v > 0 ? 'Paid more than standard (unfavorable)' : 'Paid less than standard (favorable)' }); },
        total: (rs) => acctParts(rs.reduce((s, p) => s + (poVariance(p, cm) || 0), 0)) },
    ];
    const tid = `po-${poShow}`;
    const shown = filteredRows({ id: tid, columns, rows, defaultSort: { key: 'due', dir: 'asc' } });
    const nFilters = activeFilterCount(tid);
    const late = all.filter((p) => poStatus(p, today) === 'late').length;
    return h('div', null,
      pageHead('Purchase Orders', 'Orders placed with suppliers. Open orders count as coming in on their due date in the Purchase Plan, so it won’t suggest buying the same thing twice. Receive an order when it arrives: the quantity goes onto Goods Receipt, and the price paid against standard cost is the purchase price variance (PPV) on the Journals tab. Create an order here or from the Purchase Plan.',
        !poForm ? h('button', { class: 'btn primary', onclick: () => { poForm = 'new'; rerender(); } }, 'New order') : null,
        !poForm && sel && !sel.received && !sel.cancelled ? h('button', { class: 'btn primary', onclick: () => { poForm = 'receive'; rerender(); } }, 'Receive order') : null,
        !poForm && sel && !sel.received ? h('button', { class: 'btn primary', onclick: () => { poForm = 'edit'; rerender(); } }, 'Edit order') : null,
        !poForm && sel && !sel.received && !sel.cancelled ? h('button', { class: 'btn ghost', onclick: async () => {
          if (!(await confirmDialog(`Cancel order #${sel.id}? It stays on the list as cancelled.`, 'Cancel order'))) return;
          try { await updateRow('purchase_orders', 'id', sel.id, { cancelled: true }); toast('Order cancelled.'); rerender(); } catch (err) { toast(niceError(err), 'bad'); }
        } }, 'Cancel order') : null,
        poForm === 'new' ? poFormEl(null, done) : poForm === 'edit' && sel ? poFormEl(sel, done) : poForm === 'receive' && sel ? receiveForm(sel, done) : null,
        !poForm ? seg([['open', 'Open'], ['all', 'All orders']], poShow, (v) => { poShow = v; rerender(); }) : null,
        !poForm ? chip('Late', late) : null,
        nFilters ? h('button', { class: 'btn ghost', onclick: () => { clearFilters(tid); rerender(); } }, `Clear filters (${nFilters})`) : null),
      missing ? h('div', { class: 'note warn' }, 'The database hasn’t been updated for purchase orders yet. They’ll work after the next deploy to main.') : null,
      rows.length ? h('div', { class: 'tablewrap', 'data-scroll': tid }, xtable({ id: tid, columns, allRows: rows, rows: shown, rerender, defaultSort: { key: 'due', dir: 'asc' },
        className: 'selectable', rowClass: (p) => (p.id === poSelected ? 'selected' : null), showTotals: true,
        onRowClick: (p) => { if (poForm) return; poSelected = p.id === poSelected ? null : p.id; rerender(); } }))
        : h('div', { class: 'panel empty' }, poShow === 'open' ? 'No open purchase orders. Create one with New order, or from the Purchase Plan.' : 'No purchase orders yet.'));
  },
};
