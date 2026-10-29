import { h, pageHead, numberCell, typePill, toast, niceError, confirmDialog, acctText, acctCell } from '../ui.js';
import { state, derived, saveCell, isAdmin, insertRow, updateRow, deleteRow } from '../store.js';
import { TYPES, isLaborItem, nextItemNo, itemNoProblem, missingStandards, holdsLabel, hasReceiving, unitWord, evalEntry } from '../calc.js';

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');
const RECEIVING_WORDS = ['box', 'bag', 'case', 'drum', 'pail', 'jug', 'roll', 'pallet'];
import { xtable, filteredRows, activeFilterCount, clearFilters, downloadButton } from '../xtable.js';

// Costs typed in: raw materials, packaging, and indirect costs other than direct labor (overhead, marketing, ...).
const enterable = (it) => it.type === 'Raw Material' || it.type === 'Component' || (it.type === 'Indirect Cost' && !isLaborItem(it.item_no));

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
    receiving_unit: h('select', { id: 'item-rcv-unit' },
      h('option', { value: '' }, 'Loose (no box or case)'),
      [...new Set([...RECEIVING_WORDS, ...(item?.receiving_unit ? [item.receiving_unit] : [])])].map((w) => h('option', { value: w, selected: w === item?.receiving_unit }, cap(w))),
      h('option', { value: '__other' }, 'Something else…')),
    receiving_other: h('input', { id: 'item-rcv-other', type: 'text', placeholder: 'e.g. tote', hidden: true }),
    units_per_receiving: h('input', { id: 'item-rcv-per', type: 'text', inputmode: 'decimal', value: item?.units_per_receiving ?? '', placeholder: 'e.g. 30' }),
  };
  if (isNew) f.item_no.value = nextItemNo(state.data.items, f.type.value);
  f.type.addEventListener('change', () => { f.item_no.value = nextItemNo(state.data.items, f.type.value); });
  // Receiving unit and how many base units are in one (both, or neither).
  const ruValue = () => (f.receiving_unit.value === '__other' ? f.receiving_other.value.trim().toLowerCase() : f.receiving_unit.value) || null;
  const receiving = () => {
    const ru = ruValue(); let per = null; try { per = evalEntry(f.units_per_receiving.value); } catch { /* checked below */ }
    if (ru && !(per > 0)) throw new Error(`Enter how many ${unitWord(f.unit.value.trim()) || 'base units'} one ${ru} holds.`);
    return { receiving_unit: ru, units_per_receiving: ru ? per : null };
  };
  // Live sentence: "1 box of Cheese = 30 lb"
  const rcvSentence = h('div', { class: 'rcv-sentence' });
  const holdsWrap = h('label', { class: 'field' }, 'Each one holds', h('div', { class: 'with-unit' }, f.units_per_receiving, h('span', { class: 'unit-word' })));
  const syncRcv = () => {
    f.receiving_other.hidden = f.receiving_unit.value !== '__other';
    const ru = ruValue(); holdsWrap.hidden = !ru;
    let per = null; try { per = evalEntry(f.units_per_receiving.value); } catch { /* typing */ }
    holdsWrap.querySelector('.unit-word').textContent = unitWord(f.unit.value.trim(), per ?? 2) || 'base units';
    rcvSentence.textContent = ru && per > 0 ? `1 ${ru} of ${f.name.value.trim() || 'this item'} = ${Number(per).toLocaleString()} ${unitWord(f.unit.value.trim(), per)}` : ru ? `How much is in one ${ru}?` : 'Counted and received in its base unit.';
  };
  for (const el of [f.receiving_unit, f.receiving_other, f.units_per_receiving, f.unit, f.name]) el.addEventListener('input', syncRcv);
  f.receiving_unit.addEventListener('change', syncRcv);
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
  syncRcv();
  return h('form', { class: 'item-form', onsubmit: save },
    h('strong', { class: 'tb-title' }, isNew ? 'Add item' : `Edit ${item.name}`),
    h('div', { class: 'item-fields' },
      h('label', { class: 'field' }, 'Type', f.type),
      h('label', { class: 'field' }, 'Item #', f.item_no),
      h('label', { class: 'field span2' }, 'Name', f.name),
      h('label', { class: 'field' }, 'Base unit', f.unit),
      h('label', { class: 'field' }, 'Pack size note', f.pack_note),
      h('label', { class: 'field' }, 'Comes in', f.receiving_unit, f.receiving_other),
      holdsWrap,
      h('div', { class: 'span2' }, rcvSentence)),
    h('p', { class: 'small muted' }, 'Base unit is what recipes and BOMs use (lb, c, ea). Comes in is how it’s delivered: deliveries are entered as boxes, bags or cases and turned into the base unit for you.'),
    isNew ? h('p', { class: 'small muted' }, 'Item numbers are 6 digits and start with the type: 1 raw material, 2 packaging, 3 indirect (labor, overhead, marketing), 4 recipe, 5 finished good. New raw materials and packaging appear on Goods Receipt, Cycle Counts and Daily Inventory; new finished goods appear on Production. Build what an item is made of on the BOMs tab.') : null,
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
    const scen = new Map(state.data.year_settings.map((y) => [y.year, y.labor_scenario]));
    const items = [...state.data.items].sort((a, b) => a.sort - b.sort);
    const costOf = (it, y) => (enterable(it) ? entered.get(`${it.item_no}|${y}`) ?? null : cm.cost(it.item_no, y));
    const columns = [
      { key: 'name', label: 'Item', sticky: true, value: (it) => it.name, cell: (it) => h('td', { class: 'sticky-col' }, it.name) },
      { key: 'type', label: 'Type', value: (it) => it.type, cell: (it) => h('td', null, typePill(it.type)) },
      { key: 'item_no', label: 'Item #', num: true, value: (it) => it.item_no, cell: (it) => h('td', { class: 'num muted' }, it.item_no) },
      { key: 'unit', label: 'Base unit', value: (it) => it.unit || '', cell: (it) => h('td', { class: 'muted' }, it.unit || '') },
      { key: 'comes', label: 'Comes in', value: (it) => (hasReceiving(it) ? cap(it.receiving_unit) : ''), cell: (it) => h('td', null, hasReceiving(it) ? cap(it.receiving_unit) : '') },
      { key: 'holds', label: 'Each holds', value: (it) => (hasReceiving(it) ? Number(it.units_per_receiving) : null), text: (it) => holdsLabel(it), cell: (it) => h('td', { class: 'num' }, holdsLabel(it)) },
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
        admin && !editing ? h('button', { class: 'btn primary', onclick: () => { editing = 'new'; rerender(); } }, 'Add item') : null,
        admin && editing ? itemForm(editing === 'new' ? null : items.find((it) => it.item_no === editing), (no) => { editing = null; selected = no; rerender(); }) : null,
        admin && !editing && sel ? h('button', { class: 'btn primary', onclick: () => { editing = sel.item_no; rerender(); } }, 'Edit item') : null,
        nFilters ? h('button', { class: 'btn ghost', onclick: () => { clearFilters('costs'); rerender(); } }, `Clear filters (${nFilters})`) : null,
        !editing ? downloadButton('master-list', columns, rows) : null),
      cm.years.map((y) => { const m = missingStandards(state.data, y).costs; return m.length ? h('div', { class: 'note warn missing-costs' }, `${m.length} item${m.length > 1 ? 's have' : ' has'} no ${y} standard cost yet: ${m.map((i) => i.name).join(', ')}. Until ${m.length > 1 ? 'they’re' : 'it’s'} entered, ${y} product costs count ${m.length > 1 ? 'them' : 'it'} as $0.`) : null; }),
      h('div', { class: 'tablewrap tall', 'data-scroll': 'costs' },
        xtable({ id: 'costs', columns, allRows: items, rows, rerender, className: 'natural plain-cells' + (admin ? ' selectable' : ''),
          rowClass: (it) => (it.item_no === selected ? 'selected' : null),
          onRowClick: admin ? (it) => { if (editing) return; selected = it.item_no === selected ? null : it.item_no; rerender(); } : null })));
  },
};
