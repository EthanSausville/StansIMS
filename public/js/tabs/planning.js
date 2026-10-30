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
import { h, pageHead, numberCell, qty, chip, longDate, typePill, todayIso, toast, niceError } from '../ui.js';
import { state, derived, saveCell, saveField, isAdmin } from '../store.js';
import { DEFAULT_LEAD_DAYS, SAFETY_LEAD_MULTIPLE, PLAN_WEEKS, ENTRY_WEEKS, ACTUAL_WEEKS, addDays, holdsLabel, inReceiving, hasReceiving, unitWord, mondayOf } from '../calc.js';

// "2,640 box" for a quantity in base units, when the item has a receiving unit.
const asReceived = (it, q) => { if (!hasReceiving(it)) return ''; const x = inReceiving(it, q); return `${qty(x, 1)} ${unitWord(it.receiving_unit, x)}`; };
import { xtable, filteredRows, activeFilterCount, clearFilters, downloadButton } from '../xtable.js';

const shortDate = (iso) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;
const weekHead = (w) => h('th', { class: 'num', title: `Week of ${longDate(w)}` }, h('span', { class: 'wk-label' }, 'Wk of'), h('br'), shortDate(w));
// Status colors (the rows on Purchases).
const STATUS = { red: ['Below safety stock', 'red'], orange: ['Order this week', 'orange'], yellow: ['Order next week', 'yellow'], green: ['OK', 'green'] };
const ORDER = ['red', 'orange', 'yellow', 'green'];
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
// The (i) by each name opens a little note pad: what the item comes in, and
// notes anyone can keep about it (purchase_settings.notes).
let notepad = null; // the open note pad, if any
function closeNotepad() { if (notepad) { notepad.remove(); notepad = null; document.removeEventListener('mousedown', outsideNotepad, true); } }
function outsideNotepad(e) { if (notepad && !notepad.contains(e.target) && !e.target.closest?.('.note-btn')) closeNotepad(); }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && notepad) closeNotepad(); });
function openNotepad(btn, item, note, canEdit) {
  const same = notepad && notepad.dataset.item === String(item.item_no);
  closeNotepad(); if (same) return;
  const area = h('textarea', { rows: 6, placeholder: canEdit ? 'Type notes about this item: supplier, who to call, anything worth remembering…' : 'No notes yet.', disabled: !canEdit, 'aria-label': `Notes about ${item.name}` });
  area.value = note || '';
  const status = h('span', { class: 'small muted np-status' });
  let saved = note || '';
  const save = async () => {
    const v = area.value.trim() ? area.value : null;
    if ((v || '') === (saved || '')) return;
    status.textContent = 'Saving…';
    try { await saveField('purchase_settings', { item_no: item.item_no }, 'notes', v); saved = v || ''; status.textContent = 'Saved'; }
    catch (err) { status.textContent = ''; toast(niceError(err), 'bad'); }
  };
  area.addEventListener('blur', save);
  const facts = [['Item #', item.item_no], ['Unit', item.unit || 'each'],
    ['Comes in', hasReceiving(item) ? `${item.receiving_unit[0].toUpperCase()}${item.receiving_unit.slice(1)} of ${holdsLabel(item)}` : 'No receiving unit set (Master List)']];
  notepad = h('div', { class: 'notepad', role: 'dialog', 'aria-label': `${item.name} notes`, 'data-item': item.item_no },
    h('div', { class: 'np-head' }, h('strong', null, item.name), h('button', { type: 'button', class: 'np-close', 'aria-label': 'Close', onclick: () => { save(); closeNotepad(); } }, '×')),
    h('dl', { class: 'np-facts' }, facts.map(([k, v]) => [h('dt', null, k), h('dd', null, String(v))])),
    h('label', { class: 'np-label' }, 'Notes'), area,
    h('div', { class: 'np-foot' }, status, canEdit ? h('button', { type: 'button', class: 'btn primary', onclick: async () => { await save(); closeNotepad(); } }, 'Save') : null));
  document.body.append(notepad);
  const r = btn.getBoundingClientRect();
  const w = notepad.offsetWidth; const hgt = notepad.offsetHeight;
  notepad.style.left = `${Math.max(8, Math.min(r.right + 8, window.innerWidth - w - 8))}px`;
  notepad.style.top = `${Math.max(8, Math.min(r.top - 10, window.innerHeight - hgt - 8))}px`;
  document.addEventListener('mousedown', outsideNotepad, true);
  if (canEdit) area.focus();
}

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
    const noteBtn = (r) => { const note = set(r, 'notes');
      const b = h('button', { type: 'button', class: 'note-btn' + (note ? ' has-note' : ''), title: note ? `Notes: ${note}` : 'Details and notes', 'aria-label': `${r.item.name} details and notes`,
        onclick: (e) => { e.stopPropagation(); openNotepad(b, r.item, settings.get(r.item.item_no)?.notes, admin); } }, 'i');
      return b; };
    const columns = [
      { key: 'name', label: 'Item', sticky: true, value: (r) => r.item.name,
        cell: (r) => h('td', { class: 'sticky-col' }, h('div', { class: 'item-note' }, h('span', null, r.item.name), noteBtn(r))) },
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
      { key: 'notes', label: 'Notes', hidden: true, value: (r) => set(r, 'notes') || '' },
    ];
    const shown = filteredRows({ id: 'safety-stocks', columns, rows });
    const nFilters = activeFilterCount('safety-stocks');
    return h('div', null,
      pageHead('Safety Stocks', `How much of each raw material and packaging item to keep in reserve, and how long it takes to arrive. Purchases tells you when to order so stock never drops below safety stock. Amounts are in the item’s unit from the Master List. Click the (i) by an item for what it comes in and to keep notes about it. Demand is what the next ${ENTRY_WEEKS} weeks on the Production tab use. Grey numbers are the defaults; type over one to change it, or clear it to go back. Lead time is ${DEFAULT_LEAD_DAYS} days unless typed in. The default safety stock is enough for ${SAFETY_LEAD_MULTIPLE}× the lead time at the average weekly use (a ${DEFAULT_LEAD_DAYS}-day lead time means ${(SAFETY_LEAD_MULTIPLE * DEFAULT_LEAD_DAYS) / 7} weeks of use). Orders are in whole boxes, bags or cases and at least the Min Order.` + (admin ? '' : ' Only admins can change these.')),
      noData(),
      h('div', { class: 'table-block wide' },
        tableActions(nFilters ? h('button', { class: 'btn ghost', onclick: () => { clearFilters('safety-stocks'); rerender(); } }, `Clear filters (${nFilters})`) : null,
          downloadButton('safety-stocks', columns, shown)),
        h('div', { class: 'tablewrap full', 'data-scroll': 'safety-stocks' }, xtable({ id: 'safety-stocks', columns: columns.filter((c) => !c.hidden), allRows: rows, rows: shown, rerender, className: 'plain-cells ss-table full' }))));
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
    return h('div', null,
      pageHead('Production', `The cases made each of the last ${ACTUAL_WEEKS} weeks (from Production entries), the average of those weeks, and the cases to make each of the next ${ENTRY_WEEKS} weeks. A grey number is that average, and is used until you type over it. This is what Purchases orders materials for.`),
      noData(),
      h('div', { class: 'scroll-x' }, h('table', { class: 't plain-cells pd-prod full' },
        h('thead', null,
          h('tr', { class: 'pd-bands' }, h('th', null, ''), h('th', { colspan: ACTUAL_WEEKS, class: 'band-actual' }, `Actual, last ${ACTUAL_WEEKS} weeks`), h('th', { class: 'band-avg' }, ''), h('th', { colspan: ENTRY_WEEKS, class: 'band-plan' }, `Plan, next ${ENTRY_WEEKS} weeks`)),
          h('tr', null, h('th', null, 'Product'), plan.actualWeeks.map((w) => weekHead(w)), h('th', { class: 'num pd-avg' }, 'Average'), weeks.map(weekHead))),
        h('tbody', null, plan.rows.map((r) => h('tr', null, h('td', null, r.item.name),
          r.actuals.map((v, i) => h('td', { class: 'num pd-actual', title: `${r.item.name}: made the week of ${longDate(plan.actualWeeks[i])}` }, qty(v, 0))),
          h('td', { class: 'num pd-avg' }, qty(r.avg, 0)),
          r.weeks.slice(0, ENTRY_WEEKS).map((c) => numberCell(c.typed ? c.production : null, (v) => saveCell('production_plan', { item_no: r.item.item_no, week: c.week }, 'cases', v),
            { disabled: !admin, digits: 0, key: `pp|${r.item.item_no}|${c.week}`, placeholder: qty(Math.round(c.demand), 0), cls: c.typed ? 'typed' : 'suggested',
              title: `${r.item.name}, week of ${longDate(c.week)} (average ${qty(c.demand, 1)} a week; clear to use it)` }))))))));
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
    const mp = derived.materials(); const today = todayIso();
    const rows = [...mp.rows].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || (a.next?.orderBy || '9').localeCompare(b.next?.orderBy || '9') || a.item.sort - b.item.sort);
    const stock = (r) => (hasReceiving(r.item) ? asReceived(r.item, r.onHand) : `${qty(r.onHand, 0)} ${unitWord(r.item.unit, r.onHand)}`);
    const unit = (r) => r.item.unit || '';
    const when = (d) => (d < today ? 'Now' : longDate(d));
    const detail = (r) => h('tr', { class: 'pd-detail' }, h('td', { colspan: 5 }, h('div', { class: 'pd-detail-body' },
      h('dl', { class: 'kv' },
        h('dt', null, 'Use a week'), h('dd', null, orderText(r.item, r.avgPlanned)),
        h('dt', null, 'Safety stock'), h('dd', null, orderText(r.item, r.safety)),
        h('dt', null, 'Lead time'), h('dd', null, `${r.leadDays} days`)),
      r.orders.length ? h('div', null, h('div', { class: 'small muted' }, `Orders over the next ${PLAN_WEEKS} weeks`),
        h('table', { class: 't natural side-orders' }, h('thead', null, h('tr', null, h('th', null, 'Order by'), h('th', null, 'How much'), h('th', null, 'Arrives'), h('th', null, ''))),
          h('tbody', null, r.orders.map((o) => h('tr', { class: o.orderBy <= today ? 'late' : null }, h('td', null, when(o.orderBy)), h('td', { title: `${qty(o.qty, 0)} ${unit(r)}` }, orderText(r.item, o.qty)), h('td', null, longDate(o.arrives)),
            h('td', { class: 'small muted' }, o.short ? `Below safety stock from ${longDate(o.below)} until it arrives` : 'Just as it would drop below safety stock'))))))
        : h('p', { class: 'small muted' }, `Nothing to order in the next ${PLAN_WEEKS} weeks.`))));
    const dl = [{ key: 'item', label: 'Item', value: (r) => r.item.name }, { key: 'status', label: 'Status', value: (r) => STATUS[r.status][0] },
      { key: 'on', label: 'On hand', value: (r) => stock(r) }, { key: 'by', label: 'Order by', value: (r) => (r.next ? r.next.orderBy : '') }, { key: 'how', label: 'How much', value: (r) => (r.next ? orderText(r.item, r.next.qty) : '') }];
    return h('div', null,
      pageHead('Purchases', `Every raw material and packaging item, and when to order it so it never drops below safety stock. Stock is projected day by day from what’s on hand and the plan on the Production tab; an order is due one lead time before the day it would drop below safety stock, and is enough to get back to safety stock plus one lead time of use, in whole boxes, bags or cases and at least the Min Order (Safety Stocks). Red is below safety stock now; orange needs ordering by the end of this week; yellow by the end of next week; green not until after that. Click an item to see every order it needs over the next ${PLAN_WEEKS} weeks. Place orders in QuickBooks; until the delivery is entered on New Receipts, an item still shows as needing it.`),
      noData(),
      h('div', { class: 'table-block wide' },
        tableActions(downloadButton('purchases', dl, rows)),
        h('div', { class: 'scroll-x' }, h('table', { class: 't natural pd-status' },
          h('thead', null, h('tr', null, h('th', null, 'Item'), h('th', null, 'Status'), h('th', { class: 'num' }, 'On hand'), h('th', null, 'Order by'), h('th', null, 'How much'))),
          h('tbody', null, rows.map((r) => [h('tr', { class: `st-${r.status}` + (r.item.item_no === selected ? ' picked' : ''), title: 'Click to see its orders', onclick: () => { selected = r.item.item_no === selected ? null : r.item.item_no; rerender(); } },
            h('td', null, r.item.name), h('td', null, STATUS[r.status][0]), h('td', { class: 'num' }, stock(r)),
            h('td', null, r.next ? when(r.next.orderBy) : ''),
            h('td', null, r.next ? orderText(r.item, r.next.qty) : '')), r.item.item_no === selected ? detail(r) : null]))))));
  },
};
