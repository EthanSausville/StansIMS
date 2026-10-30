// Planning, three tabs:
//   Production     the cases to make each week for the next 6 weeks (typed in,
//                  or the average of the last 6 weeks actually made, shown
//                  next to them).
//   Purchases      every raw material and packaging item as a colored row, and
//                  when to order, and how much, so it never drops below safety
//                  stock. Purchase orders themselves are placed and tracked in
//                  QuickBooks.
//   Safety Stocks  lead times, safety stocks, minimum orders.
// The rules are in calc.js (demandPlan, materialPlan).
import { h, pageHead, numberCell, qty, chip, longDate, typePill, todayIso, toast, niceError, acctCell, acctText, itemNoCol, itemNoTh, itemNoTd } from '../ui.js';
import { state, derived, saveCell, saveField, isAdmin } from '../store.js';
import { DEFAULT_LEAD_DAYS, SAFETY_LEAD_MULTIPLE, PLAN_WEEKS, ENTRY_WEEKS, ACTUAL_WEEKS, addDays, holdsLabel, inReceiving, hasReceiving, unitWord, mondayOf, receiptText } from '../calc.js';

// "2,640 box" for a quantity in base units, when the item has a receiving unit.
const asReceived = (it, q) => { if (!hasReceiving(it)) return ''; const x = inReceiving(it, q); return `${qty(x, 1)} ${unitWord(it.receiving_unit, x)}`; };
import { xtable, filteredRows, activeFilterCount, clearFilters, downloadButton } from '../xtable.js';

const shortDate = (iso) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;
const weekHead = (w) => h('th', { class: 'num', title: `Week of ${longDate(w)}` }, h('span', { class: 'wk-label' }, 'Wk of'), h('br'), shortDate(w));
// Status colors (the rows on Purchases).
const STATUS = { red: ['Below safety stock', 'red'], orange: ['Order overdue', 'orange'], yellow: ['Order this week', 'yellow'], white: ['OK', 'white'] };
const ORDER = ['red', 'orange', 'yellow', 'white'];
const statusPill = (s) => h('span', { class: `status ${STATUS[s][1]}` }, STATUS[s][0]);
const noData = () => (state.data.missingTables?.has('production_plan')
  ? h('div', { class: 'note warn' }, 'The database hasn’t been updated for planning yet, so production plans can’t be saved until the next deploy to main. The plan uses the average of recent production.') : null);

const orderText = (it, q) => asReceived(it, q) || `${qty(q, 0)} ${unitWord(it.unit, q)}`;
let selected = null; // item_no opened on Purchases

// The Download for Excel button (and any other table actions) at the upper
// right, just above the table.
const tableActions = (...items) => h('div', { class: 'table-actions' }, items);

// ---------- Safety Stocks ----------
// One row per item; amounts are in the item's unit from the Master List, and
// the three white columns can be typed over (a grey number is the default).
// The Notes column starts with the minimum order and what the item comes in;
// type over it to keep anything else (supplier, who to call...).
export const safetyStocksTab = {
  id: 'safety',
  label: 'Safety Stocks',
  render({ rerender }) {
    const rows = derived.materials().rows; const admin = isAdmin();
    const settings = new Map(state.data.purchase_settings.map((s) => [s.item_no, s]));
    const unit = (r) => r.item.unit || 'each';
    const n0 = (v) => qty(v, 0);
    const withUnit = (r) => (v) => `${qty(v, 0)} ${unit(r)}`;
    const days = (v) => `${qty(v, 0)} day${Number(v) === 1 ? '' : 's'}`;
    const set = (r, field) => settings.get(r.item.item_no)?.[field] ?? null;
    const save = (r, field) => (v) => saveField('purchase_settings', { item_no: r.item.item_no }, field, v);
    const cls = (r, field) => (set(r, field) === null ? 'suggested' : 'typed');
    const unitMin = (r) => (hasReceiving(r.item) ? Number(r.item.units_per_receiving) : 1);
    const minOf = (r) => r.minOrder || unitMin(r);
    // Notes: what the item comes in and its minimum order, until someone types their own.
    const defaultNote = (r) => [`Min order ${withUnit(r)(minOf(r))}${hasReceiving(r.item) && minOf(r) % Number(r.item.units_per_receiving) === 0 ? ` (${qty(minOf(r) / Number(r.item.units_per_receiving), 0)} ${unitWord(r.item.receiving_unit, minOf(r) / Number(r.item.units_per_receiving))})` : ''}`,
      hasReceiving(r.item) ? `comes in a ${receiptText(r.item)}` : 'comes loose'].join('; ');
    const noteOf = (r) => set(r, 'notes') || defaultNote(r);
    const notesCell = (r) => {
      const typed = set(r, 'notes');
      const input = h('input', { type: 'text', class: 'note-input', value: noteOf(r), disabled: !admin, 'data-k': `ps|${r.item.item_no}|notes`, 'aria-label': `Notes about ${r.item.name}`,
        title: typed ? typed : 'Defaults to the minimum order and what it comes in; type over it to keep your own notes',
        onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } if (e.key === 'Escape') { input.value = noteOf(r); input.blur(); } },
        onchange: async () => {
          const v = input.value.trim(); const value = !v || v === defaultNote(r) ? null : v;
          try { await saveField('purchase_settings', { item_no: r.item.item_no }, 'notes', value); } catch (err) { input.classList.add('error'); toast(niceError(err), 'bad'); }
        } });
      return h('td', { class: 'cell entry note-cell' + (typed ? ' typed' : ' suggested') }, input);
    };
    const columns = [
      itemNoCol((r) => r.item),
      { key: 'name', label: 'Item', sticky2: true, value: (r) => r.item.name, cell: (r) => h('td', { class: 'sticky-col sticky-col2' }, r.item.name) },
      { key: 'min', label: 'Min Order', num: true, value: minOf, text: (r) => withUnit(r)(minOf(r)),
        cell: (r) => numberCell(set(r, 'standard_purchase'), save(r, 'standard_purchase'),
          { disabled: !admin, digits: 2, display: withUnit(r), key: `ps|${r.item.item_no}|standard_purchase`, placeholder: withUnit(r)(unitMin(r)), cls: cls(r, 'standard_purchase'),
            title: `${r.item.name}: the least to order, in ${unit(r)} (blank = one ${r.item.receiving_unit || unit(r)})` }) },
      { key: 'demand', label: 'Demand', num: true, value: (r) => r.demand, text: (r) => n0(r.demand),
        cell: (r) => h('td', { class: 'num', title: `${r.item.name}: what the next ${ENTRY_WEEKS} weeks on the Production tab use, in ${unit(r)}` }, n0(r.demand)) },
      { key: 'lead', label: 'Lead time', num: true, value: (r) => r.leadDays, text: (r) => days(r.leadDays),
        cell: (r) => numberCell(set(r, 'lead_days'), save(r, 'lead_days'),
          { disabled: !admin, digits: 0, display: days, key: `ps|${r.item.item_no}|lead_days`, placeholder: days(DEFAULT_LEAD_DAYS), cls: cls(r, 'lead_days'), title: `${r.item.name}: lead time in days (blank = ${DEFAULT_LEAD_DAYS})` }) },
      { key: 'safety', label: 'Safety stock', num: true, value: (r) => r.safety, text: (r) => n0(r.safety),
        cell: (r) => numberCell(set(r, 'safety_stock'), save(r, 'safety_stock'),
          { disabled: !admin, digits: 2, display: n0, key: `ps|${r.item.item_no}|safety_stock`, placeholder: n0(r.autoSafety), cls: cls(r, 'safety_stock'), title: `${r.item.name}: safety stock in ${unit(r)} (blank = calculated, ${n0(r.autoSafety)})` }) },
      { key: 'notes', label: 'Notes', grow: true, value: noteOf, cell: notesCell },
    ];
    const shown = filteredRows({ id: 'safety-stocks', columns, rows });
    const nFilters = activeFilterCount('safety-stocks');
    return h('div', null,
      pageHead('Safety Stocks', [
        `Each row is a raw material or packaging item, in its unit from the Master List. Demand is what the next ${ENTRY_WEEKS} weeks on the Production tab will use.`,
        `Grey numbers are the defaults: a ${DEFAULT_LEAD_DAYS}-day lead time, a safety stock that covers ${SAFETY_LEAD_MULTIPLE}× the lead time of use, and a minimum order of one box, bag or case. Type over one to change it; clear it to go back.`,
        'Notes start with the minimum order and what the item comes in; type over them to keep your own (supplier, who to call…), or clear them to go back.',
        'Purchases uses these to tell you when to order and how much.' + (admin ? '' : ' Only admins can change them.'),
      ]),
      noData(),
      h('div', { class: 'table-block wide' },
        tableActions(nFilters ? h('button', { class: 'btn ghost', onclick: () => { clearFilters('safety-stocks'); rerender(); } }, `Clear filters (${nFilters})`) : null,
          downloadButton('safety-stocks', columns, shown)),
        h('div', { class: 'tablewrap full', 'data-scroll': 'safety-stocks' }, xtable({ id: 'safety-stocks', columns, allRows: rows, rows: shown, rerender, className: 'plain-cells ss-table full' }))));
  },
};

// ---------- Production ----------
// The last ACTUAL_WEEKS weeks actually made (grey, read-only) and the next
// ENTRY_WEEKS weeks to make, typed in; a blank week shows the average of those
// actual weeks in grey, and that's what the plan uses. Drives Purchases.
export const productionPlanTab = {
  id: 'planning',
  label: 'Production',
  render() {
    const plan = derived.plan(); const admin = isAdmin();
    const weeks = plan.weeks.slice(0, ENTRY_WEEKS);
    const head = (w, i, kind) => h('th', { class: `num wk ${kind}${i === 0 ? ' first' : ''}`, title: `Week of ${longDate(w)}` },
      h('span', { class: 'wk-label' }, kind === 'plan' && i === 0 ? 'This week' : 'Week of'), h('span', { class: 'wk-date' }, shortDate(w)));
    return h('div', { class: 'page-fill' },
      pageHead('Production', [
        `The grey columns on the left are the cases actually made in each of the last ${ACTUAL_WEEKS} weeks (from Inventory → Production).`,
        `The boxes on the right are the plan for this week and the next ${ENTRY_WEEKS - 1}. A grey number in a box is the average of the last ${ACTUAL_WEEKS} weeks, and is used until you type over it.`,
        'Type the cases you plan to make in any box; press Enter or Tab to save it. Clear a box to go back to the average.',
        'Purchases and Safety Stocks use this plan to work out what materials to order and when.',
      ]),
      noData(),
      h('div', { class: 'tablewrap pd-prod-wrap', 'data-scroll': 'pd-prod' }, h('table', { class: 't plain-cells pd-prod' },
        h('thead', null,
          h('tr', { class: 'pd-bands' }, h('th', { class: 'sticky-col itemno' }, ''), h('th', { class: 'sticky-col sticky-col2' }, ''), h('th', { colspan: ACTUAL_WEEKS, class: 'band-actual' }, h('span', { class: 'band-label' }, `Made · last ${ACTUAL_WEEKS} weeks`)), h('th', { colspan: ENTRY_WEEKS, class: 'band-plan' }, h('span', { class: 'band-label' }, `Plan · next ${ENTRY_WEEKS} weeks`))),
          h('tr', null, itemNoTh(), h('th', { class: 'sticky-col sticky-col2' }, 'Product'), plan.actualWeeks.map((w, i) => head(w, i, 'actual')), weeks.map((w, i) => head(w, i, 'plan')))),
        h('tbody', null, plan.rows.map((r) => h('tr', null, itemNoTd(r.item), h('td', { class: 'sticky-col sticky-col2 pd-name' }, r.item.name),
          r.actuals.map((v, i) => h('td', { class: 'num pd-actual' + (i === 0 ? ' first' : ''), title: `${r.item.name}: made the week of ${longDate(plan.actualWeeks[i])}` }, v ? qty(v, 0) : '–')),
          r.weeks.slice(0, ENTRY_WEEKS).map((c, i) => numberCell(c.typed ? c.production : null, (v) => saveCell('production_plan', { item_no: r.item.item_no, week: c.week }, 'cases', v),
            { disabled: !admin, digits: 0, key: `pp|${r.item.item_no}|${c.week}`, placeholder: qty(Math.round(c.demand), 0), cls: (c.typed ? 'typed' : 'suggested') + ' pd-plan' + (i === 0 ? ' first' : ''),
              title: `${r.item.name}, week of ${longDate(c.week)} (average ${qty(c.demand, 1)} a week; clear to use it)` })))),
          // Fills the rest of the page so the grey of the weeks made runs to the bottom.
          h('tr', { class: 'pd-fill', 'aria-hidden': 'true' }, h('td', { class: 'sticky-col itemno' }), h('td', { class: 'sticky-col sticky-col2' }), plan.actualWeeks.map(() => h('td', { class: 'pd-actual' })), weeks.map(() => h('td', { class: 'pd-plan' })))))));
  },
};

// ---------- Purchases ----------
// Every raw material and packaging item as a colored row: red below safety
// stock, orange order this week, yellow order next week, green fine. Click a
// row to open, under it, every order it needs over the next PLAN_WEEKS weeks.
export const purchasingTab = {
  id: 'purchasing',
  label: 'Purchases',
  render({ rerender }) {
    const mp = derived.materials(); const cm = derived.costs(); const today = todayIso();
    const rows = [...mp.rows].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || (a.next?.orderBy || '9').localeCompare(b.next?.orderBy || '9') || a.item.sort - b.item.sort);
    const inUnits = (it, q) => (hasReceiving(it) ? asReceived(it, q) : `${qty(q, 0)} ${unitWord(it.unit, q)}`);
    const unit = (r) => r.item.unit || '';
    // Estimated cost of an order: how much × the item's standard cost for the year it's ordered.
    const costOf = (r, o) => o.qty * (cm.cost(r.item.item_no, Number((o.orderBy < today ? today : o.orderBy).slice(0, 4))) || cm.latest(r.item.item_no));
    const md = (iso) => longDate(iso).replace(/, \d{4}$/, '');
    const when = (o) => (o.orderBy < today ? h('span', { class: 'overdue' }, `Overdue · ${md(o.orderBy)}`) : o.orderBy === today ? 'Today' : md(o.orderBy));
    const whenText = (o) => (o.orderBy < today ? `Overdue (${o.orderBy})` : o.orderBy);
    const cols = 8;
    const detail = (r) => h('tr', { class: 'pu-detail' }, h('td', { colspan: cols }, h('div', { class: 'pd-detail-body' },
      h('dl', { class: 'kv' },
        h('dt', null, 'Use a week'), h('dd', null, orderText(r.item, r.avgPlanned)),
        h('dt', null, 'Lead time'), h('dd', null, `${r.leadDays} days`),
        h('dt', null, `Next ${ENTRY_WEEKS} weeks`), h('dd', null, orderText(r.item, r.demand))),
      r.orders.length ? h('div', null, h('div', { class: 'small muted' }, `Every order over the next ${ENTRY_WEEKS} weeks`),
        h('table', { class: 't natural side-orders' }, h('thead', null, h('tr', null, h('th', null, 'Order by'), h('th', null, 'How much'), h('th', { class: 'num' }, 'Est. cost'), h('th', null, 'Arrives'), h('th', null, ''))),
          h('tbody', null, r.orders.map((o) => h('tr', { class: o.orderBy < today ? 'late' : null }, h('td', null, when(o)), h('td', { title: `${qty(o.qty, 0)} ${unit(r)}` }, orderText(r.item, o.qty)),
            acctCell(costOf(r, o)), h('td', null, md(o.arrives)),
            h('td', { class: 'small muted' }, o.short ? `Below safety stock from ${longDate(o.below)} until it arrives` : 'Arrives as stock reaches safety stock'))))))
        : h('p', { class: 'small muted' }, `Nothing to order in the next ${ENTRY_WEEKS} weeks.`))));
    const nextCost = (r) => (r.next ? costOf(r, r.next) : 0);
    const total = rows.reduce((t, r) => t + nextCost(r), 0);
    const dueSoon = rows.filter((r) => r.status !== 'white').reduce((t, r) => t + nextCost(r), 0);
    const dl = [{ key: 'item_no', label: 'Item #', value: (r) => r.item.item_no }, { key: 'item', label: 'Item', value: (r) => r.item.name }, { key: 'status', label: 'Status', value: (r) => STATUS[r.status][0] },
      { key: 'on', label: 'On hand', value: (r) => inUnits(r.item, r.onHand) }, { key: 'safety', label: 'Safety stock', value: (r) => inUnits(r.item, r.safety) },
      { key: 'by', label: 'Order by', value: (r) => (r.next ? whenText(r.next) : '') }, { key: 'how', label: 'How much', value: (r) => (r.next ? orderText(r.item, r.next.qty) : '') },
      { key: 'cost', label: 'Est. cost', num: true, value: (r) => (r.next ? Math.round(nextCost(r) * 100) / 100 : null) }];
    const band = (label, span) => h('th', { colspan: span, class: 'band' }, label ? h('span', { class: 'band-label' }, label) : null);
    return h('div', { class: 'page-fill' },
      pageHead('Purchases', [
        `Each row is a raw material or packaging item. What to buy comes from the next ${ENTRY_WEEKS} weeks on the Production tab, so stock never drops below safety stock once an order can arrive (one lead time from today).`,
        'Red (flashing): below safety stock now. Orange: the day to order has passed. Yellow: order within the next week. White: nothing to order yet.',
        'Order by is the last day to place the order so it arrives before stock drops below safety stock. How much is in whole boxes, bags or cases, and Est. cost is How much at the standard cost (Master List).',
        `Click a row to see every order it needs over the next ${ENTRY_WEEKS} weeks. Place orders in QuickBooks; until the delivery is entered on Inventory → New Receipts, the item still shows as needing it.`,
      ]),
      noData(),
      h('div', { class: 'table-actions page-x' }, h('span', { class: 'small muted' }, 'Orders due within a week: ', h('strong', null, '$' + acctText(dueSoon))), downloadButton('purchases', dl, rows)),
      h('div', { class: 'tablewrap pu-wrap', 'data-scroll': 'pu' }, h('table', { class: 't pu-table' },
        h('thead', null,
          h('tr', { class: 'pd-bands' }, band('', 3), band('Stock', 2), band(`Next order · from the next ${ENTRY_WEEKS} weeks`, 3)),
          h('tr', null, h('th', { class: 'itemno' }, 'Item #'), h('th', null, 'Item'), h('th', null, 'Status'), h('th', { class: 'num' }, 'On hand'), h('th', { class: 'num' }, 'Safety stock'),
            h('th', null, 'Order by'), h('th', null, 'How much'), h('th', { class: 'num' }, 'Est. cost'))),
        h('tbody', null, rows.map((r) => [h('tr', { class: `st-${r.status}` + (r.item.item_no === selected ? ' picked' : ''), title: 'Click to see its orders', onclick: () => { selected = r.item.item_no === selected ? null : r.item.item_no; rerender(); } },
          h('td', { class: 'itemno' }, r.item.item_no), h('td', { class: 'pu-name' }, r.item.name), h('td', { class: 'pu-status' }, STATUS[r.status][0]),
          h('td', { class: 'num' }, inUnits(r.item, r.onHand)), h('td', { class: 'num muted' }, inUnits(r.item, r.safety)),
          h('td', null, r.next ? when(r.next) : ''),
          h('td', null, r.next ? orderText(r.item, r.next.qty) : ''),
          r.next ? acctCell(nextCost(r)) : h('td')), r.item.item_no === selected ? detail(r) : null]),
          h('tr', { class: 'pu-fill', 'aria-hidden': 'true' }, Array.from({ length: cols }, () => h('td')))),
        h('tfoot', null, h('tr', { class: 'pu-total' }, h('td', { colspan: cols - 1 }, `Next orders, all items (next ${ENTRY_WEEKS} weeks)`), acctCell(total))))));
  },
};
