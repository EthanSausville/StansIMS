import { h, pageHead, numberCell, typePill, toast, niceError, confirmDialog, acctText, acctCell, thisYear, thisMonth } from '../ui.js';
import { state, derived, saveCell, isAdmin, insertRow, updateRow, deleteRow } from '../store.js';
import { TYPES, isLaborItem, isTiedIndirect, nextItemNo, itemNoProblem, hasReceiving, receiptText, parseReceipt } from '../calc.js';

import { xtable, filteredRows, activeFilterCount, clearFilters, downloadButton } from '../xtable.js';

// Costs typed in: raw materials, packaging, and indirect costs other than direct labor (overhead, marketing, ...).
const enterable = (it) => it.type === 'Raw Material' || it.type === 'Component' || (it.type === 'Indirect Cost' && !isTiedIndirect(state.data, it.item_no));

// The add / edit item form, shown in the side bar.
let editing = null; // null, 'new', or the item_no being edited

function itemForm(item, done) {
  const isNew = !item;
  const f = {
    item_no: h('input', { id: 'item-no', type: 'number', required: true, value: item?.item_no ?? '', disabled: !isNew, min: 100000, max: 599999 }),
    name: h('input', { id: 'item-name', type: 'text', required: true, value: item?.name ?? '' }),
    type: h('select', { id: 'item-type', disabled: !isNew }, TYPES.map((t) => h('option', { selected: t === item?.type }, t))),
    unit: h('input', { id: 'item-unit', type: 'text', value: item?.unit ?? '', placeholder: 'lb, c, ea, min, oz' }),
    pack_note: h('input', { id: 'item-pack', type: 'text', value: item?.pack_note ?? '', placeholder: 'e.g. 30lbs ea' }),
    receipt: h('input', { id: 'item-receipt', type: 'text', value: item ? receiptText(item) : '', placeholder: 'e.g. 30 lb box', autocomplete: 'off' }),
  };
  if (isNew) f.item_no.value = nextItemNo(state.data.items, f.type.value);
  f.type.addEventListener('change', () => { f.item_no.value = nextItemNo(state.data.items, f.type.value); });
  // Receipt: how it's delivered, "30 lb box" (blank = loose, in its base unit).
  const receiving = () => parseReceipt(f.receipt.value, f.unit.value.trim());
  const save = async (e) => {
    e.preventDefault();
    try {
      if (isNew) {
        const bad = itemNoProblem(f.item_no.value, f.type.value);
        if (bad) { toast(bad, 'bad'); return; }
        const sort = Math.max(0, ...state.data.items.map((i) => i.sort)) + 1;
        const row = { item_no: Number(f.item_no.value), name: f.name.value.trim(), type: f.type.value, unit: f.unit.value.trim() || null, pack_note: f.pack_note.value.trim() || null, ...receiving(), sort };
        await insertRow('items', row);
        toast(`${row.name} added.`);
        done(row.item_no);
      } else {
        await updateRow('items', 'item_no', item.item_no, { name: f.name.value.trim(), unit: f.unit.value.trim() || null, pack_note: f.pack_note.value.trim() || null, ...receiving() });
        toast('Item saved.');
        done(item.item_no);
      }
    } catch (err) { toast(niceError(err), 'bad'); }
  };
  const remove = async () => {
    if (!(await confirmDialog(`Delete ${item.name}? This only works if nothing uses it yet.`))) return;
    try { await deleteRow('items', 'item_no', item.item_no); toast('Item deleted.'); done(null); } catch (err) { toast(niceError(err), 'bad'); }
  };
  return h('form', { class: 'item-form', onsubmit: save },
    h('strong', { class: 'tb-title' }, isNew ? 'Add item' : `Edit ${item.name}`),
    h('div', { class: 'item-fields' },
      h('label', { class: 'field' }, 'Type', f.type),
      h('label', { class: 'field' }, 'Item #', f.item_no),
      h('label', { class: 'field span2' }, 'Name', f.name),
      h('label', { class: 'field' }, 'Base unit', f.unit),
      h('label', { class: 'field' }, 'Pack size note', f.pack_note),
      h('label', { class: 'field span2' }, 'Receipt', f.receipt)),
    h('p', { class: 'small muted' }, 'Base unit is what recipes and BOMs use (lb, c, ea). Receipt is how it’s delivered, like “30 lb box” or “420 lb drum”: deliveries are entered as boxes, drums or cases and turned into the base unit for you. Leave it blank if it comes loose.'),
    isNew ? h('p', { class: 'small muted' }, 'Item numbers are 6 digits and start with the type: 1 raw material, 2 packaging, 3 indirect (labor, overhead, marketing), 4 recipe, 5 finished good. New raw materials and packaging appear on New Receipts, New Counts and Daily Inventory; new finished goods appear on Production. Build what an item is made of on the BOMs tab.') : null,
    h('div', { class: 'controls' },
      !isNew ? h('button', { type: 'button', class: 'btn danger', onclick: remove }, 'Delete item') : null,
      h('button', { type: 'button', class: 'btn', onclick: () => done(item?.item_no ?? null) }, 'Cancel'),
      h('button', { type: 'submit', class: 'btn primary' }, isNew ? 'Add' : 'Save')));
}

let selected = null; // item_no of the selected item

export default {
  id: 'costs',
  label: 'Master List',
  // Narrow while browsing; wider while the add / edit form is open.
  get sideWidth() { return editing ? 300 : 170; },
  get sideKey() { return editing ? 'costs-form' : 'costs'; },
  render({ rerender }) {
    const cm = derived.costs(); const admin = isAdmin();
    const entered = new Map(state.data.standard_costs.map((c) => [`${c.item_no}|${c.year}`, c.cost]));
    const items = [...state.data.items].sort((a, b) => a.sort - b.sort);
    const costOf = (it, y) => (enterable(it) ? entered.get(`${it.item_no}|${y}`) ?? null : cm.cost(it.item_no, y));
    const receiptCell = (it) => {
      const input = h('input', { type: 'text', value: receiptText(it), disabled: !admin, 'data-k': `rc|${it.item_no}`,
        'aria-label': `${it.name} receipt (how it’s delivered)`, title: `How ${it.name} is delivered, like “30 ${it.unit || 'lb'} box”. Blank = loose.`,
        onclick: (e) => e.stopPropagation(),
        onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } if (e.key === 'Escape') { input.value = receiptText(it); input.blur(); } },
        onchange: async () => {
          let v; try { v = parseReceipt(input.value, it.unit); } catch (err) { input.classList.add('error'); toast(err.message, 'bad'); return; }
          input.classList.remove('error');
          try { await updateRow('items', 'item_no', it.item_no, v); } catch (err) { input.classList.add('error'); toast(niceError(err), 'bad'); }
        } });
      return h('td', { class: 'cell entry receipt-cell' }, input);
    };
    const columns = [
      { key: 'item_no', label: 'Item #', sticky: true, value: (it) => it.item_no, cell: (it) => h('td', { class: 'sticky-col itemno' }, it.item_no) },
      { key: 'name', label: 'Item', sticky2: true, grow: true, value: (it) => it.name, cell: (it) => h('td', { class: 'sticky-col sticky-col2' }, it.name) },
      { key: 'type', label: 'Type', value: (it) => it.type, cell: (it) => h('td', null, typePill(it.type)) },
      { key: 'unit', label: 'Base unit', value: (it) => it.unit || '', cell: (it) => h('td', { class: 'muted' }, it.unit || '') },
      { key: 'receipt', label: 'Receipt', value: (it) => receiptText(it), cell: (it) => (it.type === 'Raw Material' || it.type === 'Component' ? receiptCell(it) : h('td', null, '')) },
      ...cm.years.map((y) => ({ key: `y${y}`, label: String(y), num: true,
        value: (it) => costOf(it, y), text: (it) => (costOf(it, y) ? '$' + acctText(costOf(it, y)) : ''),
        cell: (it) => (enterable(it)
          ? numberCell(entered.get(`${it.item_no}|${y}`) ?? null, (v) => saveCell('standard_costs', { item_no: it.item_no, year: y }, 'cost', v),
            { disabled: !admin, digits: 7, key: `sc|${it.item_no}|${y}`, display: acctText, cls: 'acct-cell' + (cm.carriedFrom(it.item_no, y) ? ' carried' : ''),
              placeholder: cm.carriedFrom(it.item_no, y) ? acctText(cm.cost(it.item_no, y)) : ' ',
              title: cm.carriedFrom(it.item_no, y) ? `${it.name} ${y} cost per ${it.unit || 'unit'}: none entered, so the ${cm.carriedFrom(it.item_no, y)} standard is used` : `${it.name} ${y} cost per ${it.unit || 'unit'}` })
          : acctCell(cm.cost(it.item_no, y), { class: 'calc', title: isLaborItem(it.item_no) ? 'From the Labor tab' : isTiedIndirect(state.data, it.item_no) ? 'From the Overhead tab' : 'Calculated' })) })),
    ];
    const rows = filteredRows({ id: 'costs', columns, rows: items });
    const sel = selected ? items.find((it) => it.item_no === selected) : null;
    const nFilters = activeFilterCount('costs');
    return h('div', null,
      pageHead('Master List', 'Every item, with its standard cost for each year. Update on January 1st each year; a cost left blank for a year uses the year before’s (shown in grey). Enter costs for raw materials, packaging and overhead; direct labor comes from the Labor tab and overhead from the Overhead tab, and recipes and finished goods add themselves up. Recipe costs are per oz; finished goods are per case. Grey cells are calculated.' + (admin ? '' : ' Only admins can change these.'),
        admin && !editing ? h('button', { class: 'btn primary', onclick: () => { editing = 'new'; rerender(); } }, 'Add item') : null,
        admin && editing ? itemForm(editing === 'new' ? null : items.find((it) => it.item_no === editing), (no) => { editing = null; selected = no; rerender(); }) : null,
        admin && !editing && sel ? h('button', { class: 'btn primary', onclick: () => { editing = sel.item_no; rerender(); } }, 'Edit item') : null,
        nFilters ? h('button', { class: 'btn ghost', onclick: () => { clearFilters('costs'); rerender(); } }, `Clear filters (${nFilters})`) : null,
        !editing ? downloadButton('master-list', columns, rows) : null),
      // In December, a reminder that next year's standards start from this year's.
      thisMonth() === 12 ? h('div', { class: 'note warn missing-costs' }, `Anything without a ${thisYear() + 1} standard will be set to the ${thisYear()} standard.`) : null,
      h('div', { class: 'tablewrap tall', 'data-scroll': 'costs' },
        xtable({ id: 'costs', columns, allRows: items, rows, rerender, className: 'natural plain-cells' + (admin ? ' selectable' : ''),
          rowClass: (it) => (it.item_no === selected ? 'selected' : null),
          onRowClick: admin ? (it) => { if (editing) return; selected = it.item_no === selected ? null : it.item_no; rerender(); } : null })));
  },
};
