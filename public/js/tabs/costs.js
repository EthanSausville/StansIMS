import { h, pageHead, numberCell, typePill, toast, niceError, confirmDialog, fmt } from '../ui.js';
import { state, derived, saveCell, isAdmin, insertRow, updateRow, deleteRow } from '../store.js';
import { TYPES, LABOR_ITEM, OVERHEAD_ITEM } from '../calc.js';

const enterable = (it) => it.type === 'Raw Material' || it.type === 'Component' || it.item_no === OVERHEAD_ITEM;
const fmtCost = (v) => (v ? '$' + fmt(v, 5, 2) : '');

function itemDialog(item) {
  const isNew = !item;
  const f = {
    item_no: h('input', { type: 'number', required: true, value: item?.item_no ?? '', disabled: !isNew, min: 1 }),
    name: h('input', { type: 'text', required: true, value: item?.name ?? '' }),
    type: h('select', { disabled: !isNew }, TYPES.map((t) => h('option', { selected: t === item?.type }, t))),
    unit: h('input', { type: 'text', value: item?.unit ?? '', placeholder: 'lb, c, ea, min, oz' }),
    pack_note: h('input', { type: 'text', value: item?.pack_note ?? '', placeholder: 'e.g. 30lbs ea' }),
  };
  if (isNew) f.item_no.value = Math.max(0, ...state.data.items.filter((i) => i.item_no < 20000).map((i) => i.item_no)) + 1;
  f.type.addEventListener('change', () => { if (f.type.value === 'Finished Good') f.item_no.value = Math.max(20000, ...state.data.items.map((i) => i.item_no)) + 1; });
  const dlg = h('dialog', null, h('form', { method: 'dialog', onsubmit: async (e) => {
      const action = e.submitter?.value; if (action === 'cancel') return;
      e.preventDefault();
      try {
        if (action === 'delete') {
          if (!(await confirmDialog(`Delete ${item.name}? This only works if nothing uses it yet.`))) return;
          await deleteRow('items', 'item_no', item.item_no); toast('Item deleted.');
        } else if (isNew) {
          const sort = Math.max(0, ...state.data.items.map((i) => i.sort)) + 1;
          const row = { item_no: Number(f.item_no.value), name: f.name.value.trim(), type: f.type.value, unit: f.unit.value.trim() || null, pack_note: f.pack_note.value.trim() || null, sort };
          await insertRow('items', row);
          if (row.type === 'Recipe') await insertRow('recipes', { item_no: row.item_no, name: row.name.replace(/^RECIPE:\s*/i, ''), batch_size: state.data.settings.production_batch_size || 1 });
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
    isNew ? h('p', { class: 'small muted', style: { margin: 0 } }, 'New raw materials and packaging appear on Goods Receipt, Cycle Counts and Daily Inventory. New finished goods appear on Production; build their parts on the Bill of Materials tab. A new recipe starts empty; add it to a product there, then add its ingredients.') : null,
    h('div', { class: 'actions' },
      !isNew ? h('button', { class: 'btn danger', value: 'delete', formnovalidate: true, style: { marginRight: 'auto' } }, 'Delete item') : null,
      h('button', { class: 'btn', value: 'cancel', formnovalidate: true }, 'Cancel'), h('button', { class: 'btn primary', value: 'save' }, isNew ? 'Add' : 'Save'))));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg); dlg.showModal();
}

export default {
  id: 'costs',
  label: 'Standard Cost',
  render() {
    const cm = derived.costs(); const admin = isAdmin();
    const entered = new Map(state.data.standard_costs.map((c) => [`${c.item_no}|${c.year}`, c.cost]));
    const scen = new Map(state.data.year_settings.map((y) => [y.year, y.labor_scenario]));
    const items = [...state.data.items].sort((a, b) => a.sort - b.sort);
    return h('div', null,
      pageHead('Standard Cost', 'Update on January 1st each year. Enter costs for raw materials, packaging and overhead; direct labor comes from the Labor tab, and recipes and finished goods add themselves up.' + (admin ? '' : ' Only admins can change these.'),
        admin ? h('button', { class: 'btn primary', onclick: () => itemDialog(null) }, 'Add item') : null),
      h('div', { class: 'tablewrap tall', 'data-scroll': 'costs' }, h('table', { class: 't' },
        h('thead', null,
          h('tr', null, h('th', { class: 'sticky-col' }, 'Item'), h('th', null, 'Type'), h('th', { class: 'num' }, 'Item #'), h('th', null, 'Units'),
            h('th', { class: 'num' }, 'Latest cost'), cm.years.map((y) => h('th', { class: 'num' }, y)), admin ? h('th') : null),
          h('tr', null, h('th', { class: 'sticky-col' }), h('th'), h('th'), h('th'), h('th', { class: 'num' }, 'Labor scenario →'),
            cm.years.map((y) => h('th', { class: 'num' }, scen.get(y) ? `Scenario ${scen.get(y)}` : '—')), admin ? h('th') : null)),
        h('tbody', null, items.map((it) => h('tr', null,
          h('td', { class: 'sticky-col' }, it.name), h('td', null, typePill(it.type)), h('td', { class: 'num muted' }, it.item_no), h('td', { class: 'muted' }, it.unit || ''),
          h('td', { class: 'num calc' }, fmtCost(cm.latest(it.item_no))),
          cm.years.map((y) => enterable(it)
            ? numberCell(entered.get(`${it.item_no}|${y}`) ?? null, (v) => saveCell('standard_costs', { item_no: it.item_no, year: y }, 'cost', v),
              { disabled: !admin, digits: 7, key: `sc|${it.item_no}|${y}`, title: `${it.name} ${y} cost per ${it.unit || 'unit'}` })
            : h('td', { class: 'num calc', title: it.item_no === LABOR_ITEM ? 'From the Labor tab' : 'Calculated' }, fmtCost(cm.cost(it.item_no, y)))),
          admin ? h('td', null, h('button', { class: 'btn ghost', onclick: () => itemDialog(it) }, 'Edit')) : null))))),
      h('p', { class: 'small muted' }, 'Recipe costs are per oz; finished goods are per case. Grey cells are calculated.'));
  },
};
