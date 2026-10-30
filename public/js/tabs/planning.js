// Planning, three tabs:
//   Production         the cases to make each week (typed in, or the average sales).
//   Purchasing         every raw material and packaging item as a colored row, and
//                      what to order, how much and by when. Purchase orders
//                      themselves are placed and tracked in QuickBooks.
//   Set Safety Stocks  lead times, safety stocks, order sizes.
// The rules are in calc.js (demandPlan, materialPlan).
import { h, pageHead, numberCell, qty, chip, longDate, typePill, todayIso, toast, niceError } from '../ui.js';
import { state, derived, saveCell, saveField, isAdmin } from '../store.js';
import { DEFAULT_LEAD_DAYS, SAFETY_LEAD_MULTIPLE, PLAN_WEEKS, HISTORY_WEEKS, ENTRY_WEEKS, addDays, holdsLabel, inReceiving, hasReceiving, unitWord, mondayOf } from '../calc.js';

// "2,640 box" for a quantity in base units, when the item has a receiving unit.
const asReceived = (it, q) => { if (!hasReceiving(it)) return ''; const x = inReceiving(it, q); return `${qty(x, 1)} ${unitWord(it.receiving_unit, x)}`; };
import { xtable, filteredRows, activeFilterCount, clearFilters, downloadButton } from '../xtable.js';

const shortDate = (iso) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;
const weekHead = (w) => h('th', { class: 'num', title: `Week of ${longDate(w)}` }, h('span', { class: 'wk-label' }, 'Wk of'), h('br'), shortDate(w));
// Status colors (the rows on Purchasing).
const STATUS = { red: ['Below safety stock', 'red'], orange: ['Order this week', 'orange'], yellow: ['Order next week', 'yellow'], green: ['OK', 'green'] };
const ORDER = ['red', 'orange', 'yellow', 'green'];
const statusPill = (s) => h('span', { class: `status ${STATUS[s][1]}` }, STATUS[s][0]);
const noData = () => (state.data.missingTables?.has('production_plan')
  ? h('div', { class: 'note warn' }, 'The database hasn’t been updated for planning yet, so production plans can’t be saved until the next deploy to main. The plan uses average weekly sales.') : null);

const orderText = (it, q) => asReceived(it, q) || `${qty(q, 0)} ${unitWord(it.unit, q)}`;
let selected = null; // item_no selected on Purchasing

// ---------- Safety Stocks ----------
export const safetyStocksTab = {
  id: 'safety',
  label: 'Set Safety Stocks',
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
      pageHead('Set Safety Stocks', `How much of each raw material and packaging item to keep in reserve, and how long it takes to arrive. The Purchase Plan orders so stock never drops below safety stock. Lead time is ${DEFAULT_LEAD_DAYS} days unless typed in. The calculated safety stock is enough for ${SAFETY_LEAD_MULTIPLE}× the lead time at the average weekly use (a ${DEFAULT_LEAD_DAYS}-day lead time means ${(SAFETY_LEAD_MULTIPLE * DEFAULT_LEAD_DAYS) / 7} weeks of use); type a number in Safety stock used to override it, or clear it to go back. Orders are rounded up to whole boxes, bags or cases unless an order size is typed in (in the base unit).` + (admin ? '' : ' Only admins can change these.'),
        chip('Lead time', `${DEFAULT_LEAD_DAYS} days unless set`), chip('Typed-in safety stocks', typed),
        downloadButton('safety-stocks', columns, shown),
        nFilters ? h('button', { class: 'btn ghost', onclick: () => { clearFilters('safety-stocks'); rerender(); } }, `Clear filters (${nFilters})`) : null),
      noData(),
      h('div', { class: 'tablewrap', 'data-scroll': 'safety-stocks' }, xtable({ id: 'safety-stocks', columns, allRows: rows, rows: shown, rerender, className: 'natural plain-cells' })));
  },
};

// ---------- Production ----------
// What to make over the next ENTRY_WEEKS weeks, typed in; a blank week shows the
// average demand in grey, and that's what the plan uses. Drives Purchasing.
export const productionPlanTab = {
  id: 'planning',
  label: 'Production',
  render() {
    const plan = derived.plan(); const admin = isAdmin();
    const weeks = plan.weeks.slice(0, ENTRY_WEEKS);
    const totals = weeks.map((_, i) => plan.rows.reduce((t, r) => t + r.weeks[i].production, 0));
    return h('div', null,
      pageHead('Production', `The cases to make each week for the next ${ENTRY_WEEKS} weeks. A grey number is the average weekly sales over the last ${HISTORY_WEEKS} weeks with sales, and is used until you type over it. This is what Purchasing orders materials for.`),
      noData(),
      h('section', { class: 'panel pd-half' }, h('div', { class: 'body' },
        h('div', { class: 'scroll-x' }, h('table', { class: 't natural plain-cells pd-prod' },
          h('thead', null, h('tr', null, h('th', null, 'Product'), weeks.map(weekHead))),
          h('tbody', null, plan.rows.map((r) => h('tr', null, h('td', null, r.item.name),
            r.weeks.slice(0, ENTRY_WEEKS).map((c) => numberCell(c.typed ? c.production : null, (v) => saveCell('production_plan', { item_no: r.item.item_no, week: c.week }, 'cases', v),
              { disabled: !admin, digits: 0, key: `pp|${r.item.item_no}|${c.week}`, placeholder: qty(Math.round(c.demand), 0), cls: c.typed ? 'typed' : 'suggested',
                title: `${r.item.name}, week of ${longDate(c.week)} (average sales ${qty(c.demand, 1)} a week; clear to use it)` }))))),
          h('tfoot', null, h('tr', { class: 'xt-totals' }, h('td', null, 'Total cases'), totals.map((v) => h('td', { class: 'num' }, qty(v, 0)))),
            plan.batches.map((b) => h('tr', { class: 'pd-batches' }, h('td', null, `${b.recipe.name.replace(/^RECIPE:\s*/, '')} batches`), b.weeks.slice(0, ENTRY_WEEKS).map((w) => h('td', { class: 'num', title: `${qty(w.oz, 0)} ${b.unit} needed; batch = ${qty(b.size, 0)} ${b.unit}` }, w.batches || ''))))))))));
  },
};

// ---------- Purchasing ----------
// Every raw material and packaging item as a colored row: red below safety
// stock, orange order this week, yellow order next week, green fine. Click a
// row to see every order it needs over the next PLAN_WEEKS weeks.
export const purchasingTab = {
  id: 'purchasing',
  label: 'Purchasing',
  sideWidth: 300,
  render({ rerender }) {
    const mp = derived.materials(); const today = todayIso();
    const rows = [...mp.rows].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || (a.next?.orderBy || '9').localeCompare(b.next?.orderBy || '9') || a.item.sort - b.item.sort);
    const stock = (r) => (hasReceiving(r.item) ? asReceived(r.item, r.onHand) : `${qty(r.onHand, 0)} ${unitWord(r.item.unit, r.onHand)}`);
    const sel = selected ? rows.find((r) => r.item.item_no === selected) : null;
    const unit = (r) => r.item.unit || '';
    const side = sel ? h('div', { class: 'side-detail' },
      h('strong', null, sel.item.name),
      h('dl', { class: 'kv' },
        h('dt', null, 'On hand'), h('dd', null, stock(sel)),
        h('dt', null, 'Use a week'), h('dd', null, orderText(sel.item, sel.avgPlanned)),
        h('dt', null, 'Safety stock'), h('dd', null, orderText(sel.item, sel.safety)),
        h('dt', null, 'Lead time'), h('dd', null, `${sel.leadDays} days`)),
      sel.orders.length ? [h('div', { class: 'small muted' }, `Orders over the next ${PLAN_WEEKS} weeks:`),
        h('table', { class: 't side-orders' }, h('thead', null, h('tr', null, h('th', null, 'Order by'), h('th', null, 'How much'), h('th', null, 'Arrives'))),
          h('tbody', null, sel.orders.map((o) => h('tr', { class: o.orderBy <= today ? 'late' : null }, h('td', null, o.orderBy < today ? 'Now' : shortDate(o.orderBy)), h('td', { title: `${qty(o.qty, 0)} ${unit(sel)}` }, orderText(sel.item, o.qty)), h('td', { title: `Week of ${longDate(o.week)}` }, shortDate(o.week))))))]
        : h('p', { class: 'small muted' }, `Nothing to order in the next ${PLAN_WEEKS} weeks.`))
      : h('p', { class: 'small muted' }, `Click an item to see every order it needs over the next ${PLAN_WEEKS} weeks.`);
    const dl = [{ key: 'item', label: 'Item', value: (r) => r.item.name }, { key: 'status', label: 'Status', value: (r) => STATUS[r.status][0] },
      { key: 'on', label: 'On hand', value: (r) => stock(r) }, { key: 'by', label: 'Order by', value: (r) => (r.next ? r.next.orderBy : '') }, { key: 'how', label: 'How much', value: (r) => (r.next ? orderText(r.item, r.next.qty) : '') }];
    return h('div', null,
      pageHead('Purchasing', `Every raw material and packaging item. Red is below safety stock now; orange needs ordering by the end of this week; yellow by the end of next week; green doesn’t need ordering for at least a week after that. Place orders in QuickBooks; until the delivery is entered on New Receipts, an item still shows as needing it. Orders cover the production plan (Production tab), arrive one lead time after they’re placed, and are in whole boxes, bags or cases. Safety stock is enough for ${SAFETY_LEAD_MULTIPLE}× each item’s lead time (Set Safety Stocks).`,
        side, downloadButton('purchasing', dl, rows)),
      noData(),
      h('section', { class: 'panel pd-half' }, h('div', { class: 'body' },
        h('div', { class: 'scroll-x' }, h('table', { class: 't natural pd-status' },
          h('thead', null, h('tr', null, h('th', null, 'Item'), h('th', null, 'Status'), h('th', { class: 'num' }, 'On hand'), h('th', null, 'Order by'), h('th', null, 'How much'))),
          h('tbody', null, rows.map((r) => h('tr', { class: `st-${r.status}` + (r.item.item_no === selected ? ' picked' : ''), onclick: () => { selected = r.item.item_no === selected ? null : r.item.item_no; rerender(); } },
            h('td', null, r.item.name), h('td', null, STATUS[r.status][0]), h('td', { class: 'num' }, stock(r)),
            h('td', null, r.next ? (r.next.orderBy < today ? 'Now' : longDate(r.next.orderBy)) : ''),
            h('td', null, r.next ? orderText(r.item, r.next.qty) : '')))))))));
  },
};
