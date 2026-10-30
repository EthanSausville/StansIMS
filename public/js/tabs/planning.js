// Planning: a dashboard; the demand plan for finished goods (forecast sales,
// planned production, projected stock); the purchase plan for raw materials and
// packaging (what to order, how much and by when, and the order schedule ahead);
// and safety stocks (lead times, safety stock, order sizes). Purchase orders
// themselves are placed and tracked in QuickBooks. The rules are in calc.js
// (demandPlan, materialPlan).
import { h, pageHead, numberCell, qty, seg, chip, longDate, typePill, todayIso, toast, niceError } from '../ui.js';
import { state, derived, saveCell, saveField, isAdmin } from '../store.js';
import { DEFAULT_LEAD_DAYS, SAFETY_LEAD_MULTIPLE, PLAN_WEEKS, HISTORY_WEEKS, ENTRY_WEEKS, addDays, holdsLabel, inReceiving, hasReceiving, unitWord, mondayOf } from '../calc.js';
import { barChart } from '../charts.js';

// "2,640 box" for a quantity in base units, when the item has a receiving unit.
const asReceived = (it, q) => { if (!hasReceiving(it)) return ''; const x = inReceiving(it, q); return `${qty(x, 1)} ${unitWord(it.receiving_unit, x)}`; };
import { xtable, filteredRows, activeFilterCount, clearFilters, downloadButton, downloadCsv } from '../xtable.js';

const shortDate = (iso) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;
const weekHead = (w) => h('th', { class: 'num', title: `Week of ${longDate(w)}` }, h('span', { class: 'wk-label' }, 'Wk of'), h('br'), shortDate(w));
const num = (v, d = 0) => (v ? qty(v, d) : '');
// Status colors (also the rows on the Planning Dashboard).
const STATUS = { red: ['Below safety stock', 'red'], orange: ['Order this week', 'orange'], yellow: ['Order next week', 'yellow'], green: ['OK', 'green'] };
const ORDER = ['red', 'orange', 'yellow', 'green'];
const statusPill = (s) => h('span', { class: `status ${STATUS[s][1]}` }, STATUS[s][0]);
const noData = () => (state.data.missingTables?.has('production_plan')
  ? h('div', { class: 'note warn' }, 'The database hasn’t been updated for planning yet, so production plans can’t be saved until the next deploy to main. The plan uses average weekly sales.') : null);

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
    const nRed = rows.filter((r) => r.status === 'red').length; const nOrange = rows.filter((r) => r.status === 'orange').length;
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
        { key: 'status', label: 'Status', value: (r) => ORDER.indexOf(r.status), text: (r) => STATUS[r.status][0], cell: (r) => h('td', null, statusPill(r.status), r.short ? h('span', { class: 'status bad short', title: 'Projected below safety stock before a new order could arrive: expedite, or adjust production' }, ' Short') : null) },
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
      pageHead('Purchase Plan', `When to order raw materials and packaging, and how much, so they cover the production plan (typed in on the Planning Dashboard). Place the orders in QuickBooks. To order shows each item’s next order; Look ahead lists every order coming up over the next ${PLAN_WEEKS} weeks by the date it needs to be placed; Weekly shows each item’s projected stock week by week. Orders arrive one lead time after they’re placed and bring stock back above safety stock plus two weeks of use, in whole boxes, bags or cases. Lead times and safety stocks are on the Safety Stocks tab. Until a delivery is entered on New Receipts, an order already placed still shows as needed.`,
        seg(views, ppView, (v) => { ppView = v; rerender(); }),
        chip('Below safety stock', nRed), chip('Order this week', nOrange),
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
      pageHead('Safety Stocks', `How much of each raw material and packaging item to keep in reserve, and how long it takes to arrive. The Purchase Plan orders so stock never drops below safety stock. Lead time is ${DEFAULT_LEAD_DAYS} days unless typed in. The calculated safety stock is enough for ${SAFETY_LEAD_MULTIPLE}× the lead time at the average weekly use (a ${DEFAULT_LEAD_DAYS}-day lead time means ${(SAFETY_LEAD_MULTIPLE * DEFAULT_LEAD_DAYS) / 7} weeks of use); type a number in Safety stock used to override it, or clear it to go back. Orders are rounded up to whole boxes, bags or cases unless an order size is typed in (in the base unit).` + (admin ? '' : ' Only admins can change these.'),
        chip('Lead time', `${DEFAULT_LEAD_DAYS} days unless set`), chip('Typed-in safety stocks', typed),
        downloadButton('safety-stocks', columns, shown),
        nFilters ? h('button', { class: 'btn ghost', onclick: () => { clearFilters('safety-stocks'); rerender(); } }, `Clear filters (${nFilters})`) : null),
      noData(),
      h('div', { class: 'tablewrap', 'data-scroll': 'safety-stocks' }, xtable({ id: 'safety-stocks', columns, allRows: rows, rows: shown, rerender, className: 'natural plain-cells' })));
  },
};

// ---------- Planning Dashboard ----------
// Left: every raw material and packaging item as a colored row (red below
// safety stock, orange order this week, yellow order next week, green fine).
// Right: what to produce over the next ENTRY_WEEKS weeks, typed in; a blank
// week shows the average demand in grey and that's what the plan uses.
export const planningDashboardTab = {
  id: 'planning',
  label: 'Planning Dashboard',
  render({ rerender }) {
    const plan = derived.plan(); const mp = derived.materials(); const today = todayIso(); const admin = isAdmin();
    const rows = [...mp.rows].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || (a.next?.orderBy || '9').localeCompare(b.next?.orderBy || '9') || a.item.sort - b.item.sort);
    const stock = (r) => (hasReceiving(r.item) ? asReceived(r.item, r.onHand) : `${qty(r.onHand, 0)} ${unitWord(r.item.unit, r.onHand)}`);
    const materials = h('section', { class: 'panel pd-half' },
      h('h2', null, 'Purchase Planning'),
      h('div', { class: 'body' },
      h('div', { class: 'scroll-x' }, h('table', { class: 't natural pd-status' },
        h('thead', null, h('tr', null, h('th', null, 'Item'), h('th', null, 'Status'), h('th', { class: 'num' }, 'On hand'), h('th', null, 'Order by'), h('th', null, 'How much'))),
        h('tbody', null, rows.map((r) => h('tr', { class: `st-${r.status}`, title: `${r.item.name}: ${qty(r.onHand, 1)} on hand, safety stock ${qty(r.safety, 1)} ${unitWord(r.item.unit, 2)}` },
          h('td', null, r.item.name), h('td', null, STATUS[r.status][0]), h('td', { class: 'num' }, stock(r)),
          h('td', null, r.next ? (r.next.orderBy < today ? 'Now' : longDate(r.next.orderBy)) : ''),
          h('td', null, r.next ? orderText(r.item, r.next.qty) : ''))))))));
    const weeks = plan.weeks.slice(0, ENTRY_WEEKS);
    const totals = weeks.map((_, i) => plan.rows.reduce((t, r) => t + r.weeks[i].production, 0));
    const production = h('section', { class: 'panel pd-half' },
      h('h2', null, 'Production Planning'),
      h('div', { class: 'body' },
      h('div', { class: 'scroll-x' }, h('table', { class: 't natural plain-cells pd-prod' },
        h('thead', null, h('tr', null, h('th', null, 'Product'), weeks.map(weekHead))),
        h('tbody', null, plan.rows.map((r) => h('tr', null, h('td', null, r.item.name),
          r.weeks.slice(0, ENTRY_WEEKS).map((c) => numberCell(c.typed ? c.production : null, (v) => saveCell('production_plan', { item_no: r.item.item_no, week: c.week }, 'cases', v),
            { disabled: !admin, digits: 0, key: `pp|${r.item.item_no}|${c.week}`, placeholder: qty(Math.round(c.demand), 0), cls: c.typed ? 'typed' : 'suggested',
              title: `${r.item.name}, week of ${longDate(c.week)} (average sales ${qty(c.demand, 1)} a week; clear to use it)` }))))),
        h('tfoot', null, h('tr', { class: 'xt-totals' }, h('td', null, 'Total cases'), totals.map((v) => h('td', { class: 'num' }, qty(v, 0)))),
          plan.batches.map((b) => h('tr', { class: 'pd-batches' }, h('td', null, `${b.recipe.name.replace(/^RECIPE:\s*/, '')} batches`), b.weeks.slice(0, ENTRY_WEEKS).map((w) => h('td', { class: 'num', title: `${qty(w.oz, 0)} ${b.unit} needed; batch = ${qty(b.size, 0)} ${b.unit}` }, w.batches || '')))))))));
    return h('div', null,
      pageHead('Planning Dashboard', `Production Planning: the cases to make each week for the next ${ENTRY_WEEKS} weeks. Type over a grey number (the average weekly sales over the last ${HISTORY_WEEKS} weeks with sales) to plan something different; the grey number is used until you do. This drives the Purchase Plan. Purchase Planning: every raw material and packaging item. Red is below safety stock now; orange needs ordering by the end of this week; yellow by the end of next week; green doesn’t need ordering for at least a week after that. Order in QuickBooks. Safety stock is enough for ${SAFETY_LEAD_MULTIPLE}× each item’s lead time (Safety Stocks tab).`,
        ),
      noData(),
      h('div', { class: 'pd-stack' }, production, materials));
  },
};
