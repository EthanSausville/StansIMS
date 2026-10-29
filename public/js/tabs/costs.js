import { h, pageHead, numberCell, typePill, toast, niceError, confirmDialog, acctText, acctCell } from '../ui.js';
import { state, derived, saveCell, isAdmin, insertRow, updateRow, deleteRow } from '../store.js';
import { TYPES, isLaborItem, nextItemNo, itemNoProblem } from '../calc.js';
import { xtable, filteredRows, activeFilterCount, clearFilters } from '../xtable.js';

// Costs typed in: raw materials, packaging, and indirect costs other than direct labor (overhead, marketing, ...).
const enterable = (it) => it.type === 'Raw Material' || it.type === 'Component' || (it.type === 'Indirect Cost' && !isLaborItem(it.item_no));

function itemDialog(item) {
  const isNew = !item;
  const f = {
    item_no: h('input', { type: 'number', required: true, value: item?.item_no ?? '', disabled: !isNew, min: 100000, max: 599999 }),
    name: h('input', { type: 'text', required: true, value: item?.name ?? '' }),
    type: h('select', { disabled: !isNew }, TYPES.map((t) => h('option', { selected: t === item?.type }, t))),
    unit: h('input', { type: 'text', value: item?.unit ?? '', placeholder: 'lb, c, ea, min, oz' }),
    pack_note: h('input', { type: 'text', value: item?.pack_note ?? '', placeholder: 'e.g. 30lbs ea' }),
  };
  if (isNew) f.item_no.value = nextItemNo(state.data.items, f.type.value);
  f.type.addEventListener('change', () => { f.item_no.value = nextItemNo(state.data.items, f.type.value); });
  const dlg = h('dialog', null, h('form', { method: 'dialog', onsubmit: async (e) => {
      const action = e.submitter?.value; if (action === 'cancel') return;
      e.preventDefault();
      try {
        if (action === 'delete') {
          if (!(await confirmDialog(`Delete ${item.name}? This only works if nothing uses it yet.`))) return;
          await deleteRow('items', 'item_no', item.item_no); toast('Item deleted.');
        } else if (isNew) {
          const bad = itemNoProblem(f.item_no.value, f.type.value);
          if (bad) { toast(bad, 'bad'); return; }
          const sort = Math.max(0, ...state.data.items.map((i) => i.sort)) + 1;
          const row = { item_no: Number(f.item_no.value), name: f.name.value.trim(), type: f.type.value, unit: f.unit.value.trim() || null, pack_note: f.pack_note.value.trim() || null, sort };
          await insertRow('items', row);
          toast(`${row.name} added.`);
        } else {
          await updateRow('items', 'item_no', item.item_no, { name: f.name.value.trim(), unit: f.unit.value.trim() || null, pack_note: f.pack_note.value.trim() || null });
          toast('Item saved.');
        }
        dlg.close();
      } catch (err) { toast(niceError(err), 'bad'); }
    } },
    h('h3', null, isNew ? 'Add item' : `Edit ${item.name}`),
    h('div', { class: 'row' }, h('label', { class: 'field' }, 'Item #', f.item_no), h('label', { class: 'field' }, 'Type', f.type)),
    h('label', { class: 'field' }, 'Name', f.name),
    h('div', { class: 'row' }, h('label', { class: 'field' }, 'Unit', f.unit), h('label', { class: 'field' }, 'Pack size note', f.pack_note)),
    isNew ? h('p', { class: 'small muted', style: { margin: 0 } }, 'Item numbers are 6 digits and start with the type: 1 raw material, 2 packaging, 3 indirect (labor, overhead, marketing), 4 recipe, 5 finished good. New raw materials and packaging appear on Goods Receipt, Cycle Counts and Daily Inventory. New finished goods appear on Production. Build what any item is made of on the BOMs tab.') : null,
    h('div', { class: 'actions' },
      !isNew ? h('button', { class: 'btn danger', value: 'delete', formnovalidate: true, style: { marginRight: 'auto' } }, 'Delete item') : null,
      h('button', { class: 'btn', value: 'cancel', formnovalidate: true }, 'Cancel'), h('button', { class: 'btn primary', value: 'save' }, isNew ? 'Add' : 'Save'))));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg); dlg.showModal();
}

let selected = null; // item_no of the selected item

export default {
  id: 'costs',
  label: 'Master List',
  sideWidth: 170,
  render({ rerender }) {
    const cm = derived.costs(); const admin = isAdmin();
    const entered = new Map(state.data.standard_costs.map((c) => [`${c.item_no}|${c.year}`, c.cost]));
    const scen = new Map(state.data.year_settings.map((y) => [y.year, y.labor_scenario]));
    const items = [...state.data.items].sort((a, b) => a.sort - b.sort);
    const costOf = (it, y) => (enterable(it) ? entered.get(`${it.item_no}|${y}`) ?? null : cm.cost(it.item_no, y));
    const columns = [
      { key: 'name', label: 'Item', sticky: true, value: (it) => it.name, cell: (it) => h('td', { class: 'sticky-col' }, it.name) },
      { key: 'type', label: 'Type', value: (it) => it.type, cell: (it) => h('td', null, typePill(it.type)) },
      { key: 'item_no', label: 'Item #', num: true, value: (it) => it.item_no, cell: (it) => h('td', { class: 'num muted' }, it.item_no) },
      { key: 'unit', label: 'Units', value: (it) => it.unit || '', cell: (it) => h('td', { class: 'muted' }, it.unit || '') },
      ...cm.years.map((y) => ({ key: `y${y}`, label: String(y), sub: scen.get(y) ? `Scenario ${scen.get(y)}` : null, num: true,
        value: (it) => costOf(it, y), text: (it) => (costOf(it, y) ? '$' + acctText(costOf(it, y)) : ''),
        cell: (it) => (enterable(it)
          ? numberCell(entered.get(`${it.item_no}|${y}`) ?? null, (v) => saveCell('standard_costs', { item_no: it.item_no, year: y }, 'cost', v),
            { disabled: !admin, digits: 7, key: `sc|${it.item_no}|${y}`, title: `${it.name} ${y} cost per ${it.unit || 'unit'}`, display: acctText, cls: 'acct-cell', placeholder: ' ' })
          : acctCell(cm.cost(it.item_no, y), { class: 'calc', title: isLaborItem(it.item_no) ? 'From the Labor tab' : 'Calculated' })) })),
    ];
    const rows = filteredRows({ id: 'costs', columns, rows: items });
    const sel = selected ? items.find((it) => it.item_no === selected) : null;
    const nFilters = activeFilterCount('costs');
    return h('div', null,
      pageHead('Master List', 'Every item, with its standard cost for each year. Update on January 1st each year. Enter costs for raw materials, packaging and overhead; direct labor comes from the Labor tab, and recipes and finished goods add themselves up. Recipe costs are per oz; finished goods are per case. Grey cells are calculated.' + (admin ? '' : ' Only admins can change these.'),
        admin ? h('button', { class: 'btn primary', onclick: () => itemDialog(null) }, 'Add item') : null,
        admin ? (sel
          ? h('div', { class: 'item-selected' }, h('div', { class: 'small muted' }, 'Selected'), h('strong', null, sel.name), h('div', { class: 'small muted' }, `#${sel.item_no} · ${sel.type}`),
            h('button', { class: 'btn', onclick: () => itemDialog(sel) }, 'Edit item'))
          : h('p', { class: 'small muted' }, 'Click an item to select it for editing.')) : null,
        nFilters ? h('button', { class: 'btn ghost', onclick: () => { clearFilters('costs'); rerender(); } }, `Clear filters (${nFilters})`) : null),
      h('div', { class: 'tablewrap tall', 'data-scroll': 'costs' },
        xtable({ id: 'costs', columns, allRows: items, rows, rerender, className: admin ? 'selectable' : '',
          rowClass: (it) => (it.item_no === selected ? 'selected' : null),
          onRowClick: admin ? (it) => { selected = it.item_no === selected ? null : it.item_no; rerender(); } : null })));
  },
};
