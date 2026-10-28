// Create BOM: build a new bill of materials, or change an existing one.
// A line can be any item, including something that has its own BOM, so BOMs
// nest to any depth. Lines that would put an item inside itself are refused.
// Nothing is saved until Save.
import { h, pageHead, qty, money, fmt, toast, niceError, confirmDialog, typePill, yearSelect } from '../ui.js';
import { state, derived, isAdmin, saveBom, deleteBom } from '../store.js';
import { costModel, wouldLoop, index, evalEntry, TYPES } from '../calc.js';

let draft = null;
let year = new Date().getFullYear();
let rerenderRef = () => {};

const blankLine = () => ({ key: Math.random().toString(36).slice(2), id: null, item_no: null, qty: null, uses_batch_minutes: false });

function nextItemNo(type) {
  const nums = state.data.items.map((i) => i.item_no);
  const base = type === 'Finished Good' ? 20000 : type === 'Recipe' ? 30000 : 10000;
  return Math.max(base, ...nums.filter((n) => n > base && n < base + 10000)) + 1;
}

function freshDraft() {
  return { mode: 'new', itemNo: null, newItem: { name: '', item_no: nextItemNo('Finished Good'), type: 'Finished Good', unit: 'ea' },
    yieldQty: 1, yieldUnit: 'case', lines: [blankLine()], dirty: false };
}

function loadExisting(itemNo) {
  const b = state.data.boms.find((x) => x.item_no === itemNo);
  const lines = state.data.bom_lines.filter((l) => l.parent_item_no === itemNo).sort((a, c) => a.sort - c.sort)
    .map((l) => ({ key: String(l.id), id: l.id, item_no: l.item_no, qty: l.qty, uses_batch_minutes: !!l.uses_batch_minutes }));
  const it = state.data.items.find((i) => i.item_no === itemNo);
  return { mode: b ? 'edit' : 'existing', itemNo, newItem: null,
    yieldQty: b ? Number(b.yield_qty) : 1, yieldUnit: b ? (b.yield_unit || '') : (it?.type === 'Finished Good' ? 'case' : it?.unit || ''),
    lines: lines.length ? lines : [blankLine()], dirty: false };
}

// Opens the editor on an item's BOM (or a blank new BOM when itemNo is null).
export function openInEditor(itemNo) {
  draft = itemNo === null ? freshDraft() : loadExisting(itemNo);
  location.hash = 'createbom';
  rerenderRef();
}

// The data as it would be after saving this draft, for live costs and loop checks.
function previewData() {
  const d = state.data;
  const target = draft.mode === 'new' ? Number(draft.newItem.item_no) : draft.itemNo;
  const items = draft.mode === 'new' && target ? [...d.items, { ...draft.newItem, item_no: target, sort: 1e9 }] : d.items;
  const boms = [...d.boms.filter((b) => b.item_no !== target), { item_no: target, yield_qty: Number(draft.yieldQty) || 1, yield_unit: draft.yieldUnit }];
  const lines = [...d.bom_lines.filter((l) => l.parent_item_no !== target),
    ...draft.lines.filter((l) => l.item_no).map((l, i) => ({ id: `draft${i}`, parent_item_no: target, item_no: l.item_no, qty: l.qty, uses_batch_minutes: l.uses_batch_minutes, sort: i + 1 }))];
  return { target, data: { ...d, items, boms, bom_lines: lines } };
}

function problems() {
  const out = [];
  if (draft.mode === 'new') {
    const n = draft.newItem;
    if (!n.name.trim()) out.push('Give the new item a name.');
    else if (state.data.items.some((i) => i.name.toLowerCase() === n.name.trim().toLowerCase())) out.push(`An item named “${n.name.trim()}” already exists. Choose “Existing item” to give it a BOM.`);
    if (!Number.isInteger(Number(n.item_no)) || Number(n.item_no) <= 0) out.push('The item # must be a whole number.');
    else if (state.data.items.some((i) => i.item_no === Number(n.item_no))) out.push(`Item # ${n.item_no} is already used.`);
  } else if (!draft.itemNo) out.push('Choose the item this BOM makes.');
  if (!(Number(draft.yieldQty) > 0)) out.push('“One run makes” must be more than 0.');
  const filled = draft.lines.filter((l) => l.item_no);
  if (!filled.length) out.push('Add at least one line.');
  for (const l of filled) {
    const it = state.data.items.find((i) => i.item_no === l.item_no);
    if (!l.uses_batch_minutes && !(Number(l.qty) > 0)) out.push(`Enter a quantity for ${it?.name || 'each line'}.`);
  }
  const seen = new Set();
  for (const l of filled) { if (seen.has(l.item_no)) out.push(`${state.data.items.find((i) => i.item_no === l.item_no)?.name} is listed twice.`); seen.add(l.item_no); }
  return [...new Set(out)];
}

export default {
  id: 'createbom',
  label: 'Create BOM',
  render({ rerender }) {
    rerenderRef = rerender;
    const admin = isAdmin();
    if (!admin) return h('div', null, pageHead('Create BOM', null), h('div', { class: 'panel empty' }, 'Only admins can create or change BOMs. You can see every BOM on the BOMs tab.'));
    if (!draft) draft = freshDraft();
    const ix = derived.ix(); const cmNow = derived.costs();
    if (!cmNow.years.includes(year)) year = cmNow.years[0];
    const touch = () => { draft.dirty = true; rerender(); };
    const { target, data: preview } = previewData();
    const pix = index(preview); const pcm = costModel(preview);
    const unitOf = (itemNo) => (itemNo === target && draft.mode === 'new' ? draft.newItem.unit : ix.items.get(itemNo)?.unit) || '';

    // ---------- 1. what it makes ----------
    const makesExisting = draft.mode !== 'new';
    const candidates = state.data.items.filter((i) => i.type !== 'Indirect Cost').sort((a, b) => a.name.localeCompare(b.name));
    const whatPanel = h('section', { class: 'panel section' }, h('h2', null, '1. What does this BOM make?'),
      h('div', { class: 'body cb-grid' },
        h('div', { class: 'seg', role: 'group', 'aria-label': 'New or existing item' },
          h('button', { 'aria-pressed': String(!makesExisting), onclick: () => { if (makesExisting) { draft = freshDraft(); rerender(); } } }, 'New item'),
          h('button', { 'aria-pressed': String(makesExisting), onclick: () => { if (!makesExisting) { draft = { ...draft, mode: 'existing', itemNo: null, newItem: null }; rerender(); } } }, 'Existing item')),
        makesExisting
          ? h('label', { class: 'field wide' }, 'Item',
            h('select', { id: 'cb-item', onchange: (e) => { const v = Number(e.target.value) || null; draft = v ? loadExisting(v) : { ...draft, itemNo: null }; rerender(); } },
              h('option', { value: '' }, 'Choose an item…'),
              candidates.map((i) => h('option', { value: i.item_no, selected: i.item_no === draft.itemNo }, `${i.name} (#${i.item_no})${ix.bom.has(i.item_no) ? ' · has a BOM' : ''}`))))
          : [
            h('label', { class: 'field wide' }, 'Name', h('input', { id: 'cb-name', type: 'text', value: draft.newItem.name, 'data-k': 'cb-name', placeholder: 'e.g. Pimento Cheese Dip 10 oz. (Case of 12)', oninput: (e) => { draft.newItem.name = e.target.value; draft.dirty = true; } , onchange: rerender })),
            h('label', { class: 'field' }, 'Type', h('select', { id: 'cb-type', onchange: (e) => {
                const t = e.target.value; draft.newItem.type = t; draft.newItem.item_no = nextItemNo(t);
                if (t === 'Finished Good') { draft.newItem.unit = 'ea'; draft.yieldUnit = 'case'; draft.yieldQty = 1; } else if (draft.yieldUnit === 'case') { draft.newItem.unit = 'oz'; draft.yieldUnit = 'oz'; }
                touch(); } },
              TYPES.filter((t) => t !== 'Indirect Cost').map((t) => h('option', { value: t, selected: t === draft.newItem.type }, t === 'Recipe' ? 'Recipe / sub-assembly' : t)))),
            h('label', { class: 'field' }, 'Item #', h('input', { id: 'cb-no', type: 'number', value: draft.newItem.item_no, onchange: (e) => { draft.newItem.item_no = Number(e.target.value); touch(); } })),
            h('label', { class: 'field' }, 'Unit', h('input', { id: 'cb-unit', type: 'text', value: draft.newItem.unit, placeholder: 'ea, oz, lb, c', onchange: (e) => { draft.newItem.unit = e.target.value.trim(); touch(); } })),
          ],
        h('div', { class: 'cb-yield' },
          h('label', { class: 'field' }, 'One run makes', h('input', { id: 'cb-yield', type: 'text', inputmode: 'decimal', value: draft.yieldQty, onchange: (e) => { try { draft.yieldQty = evalEntry(e.target.value); } catch { draft.yieldQty = null; } touch(); } })),
          h('label', { class: 'field' }, 'Unit', h('input', { id: 'cb-yield-unit', type: 'text', value: draft.yieldUnit, placeholder: 'case, oz, batch', onchange: (e) => { draft.yieldUnit = e.target.value.trim(); touch(); } })),
          h('p', { class: 'small muted' }, 'Enter quantities for one run: one case of a product, or one batch of a recipe (e.g. a batch makes 3,220 oz).'))));

    // ---------- 2. lines ----------
    const groups = ['Recipe', 'Finished Good', 'Raw Material', 'Component', 'Indirect Cost'];
    const lineRows = draft.lines.map((l, idx) => {
      const it = l.item_no ? ix.items.get(l.item_no) : null;
      const select = h('select', { id: `cb-line-${l.key}`, 'aria-label': `Line ${idx + 1} item`, onchange: (e) => {
          l.item_no = Number(e.target.value) || null;
          const t = ix.items.get(l.item_no)?.type;
          l.uses_batch_minutes = t === 'Indirect Cost' && (Number(draft.yieldQty) > 1);
          if (idx === draft.lines.length - 1 && l.item_no) draft.lines.push(blankLine());
          touch();
        } },
        h('option', { value: '' }, 'Choose an item…'),
        groups.map((g) => {
          const opts = state.data.items.filter((i) => i.type === g).sort((a, b) => a.sort - b.sort);
          if (!opts.length) return null;
          return h('optgroup', { label: g === 'Component' ? 'Packaging' : g === 'Recipe' ? 'Recipes / sub-assemblies' : g + 's' }, opts.map((i) => {
            const loop = target && wouldLoop(preview, target, i.item_no, pix) && i.item_no !== l.item_no;
            const self = i.item_no === target;
            return h('option', { value: i.item_no, selected: i.item_no === l.item_no, disabled: (loop || self) && i.item_no !== l.item_no },
              `${i.name}${ix.bom.has(i.item_no) ? '  ▸ has BOM' : ''}${self ? ' (this item)' : loop ? ' (contains this item)' : ''}`);
          }));
        }));
      const q = l.uses_batch_minutes ? Number(state.data.settings.minutes_per_batch) || 0 : Number(l.qty) || 0;
      const c = l.item_no ? pcm.cost(l.item_no, year) : 0;
      return h('tr', null,
        h('td', { class: 'num muted' }, idx + 1),
        h('td', { class: 'cell entry wide-cell' }, select),
        h('td', null, it ? typePill(it.type) : ''),
        l.uses_batch_minutes
          ? h('td', { class: 'num calc', title: 'Minutes per batch, from the Labor tab' }, qty(q, 4))
          : h('td', { class: 'cell num entry' }, h('input', { type: 'text', inputmode: 'decimal', value: l.qty ?? '', 'data-k': `cb-qty-${l.key}`, 'aria-label': `Line ${idx + 1} quantity`,
            onchange: (e) => { try { l.qty = evalEntry(e.target.value); e.target.classList.remove('error'); } catch (err) { e.target.classList.add('error'); toast(err.message, 'bad'); return; } touch(); } })),
        h('td', { class: 'muted' }, it ? (it.unit || '') : ''),
        h('td', null, it?.type === 'Indirect Cost' ? h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: l.uses_batch_minutes, onchange: (e) => { l.uses_batch_minutes = e.target.checked; touch(); } }), ' Minutes per batch') : ''),
        h('td', { class: 'num calc' }, c ? '$' + fmt(c, Math.abs(c) < 1 ? 5 : 2, 2) : ''),
        h('td', { class: 'num calc' }, c && q ? money(c * q, 2) : ''),
        h('td', null, h('button', { class: 'btn ghost danger', 'aria-label': `Remove line ${idx + 1}`, onclick: () => { draft.lines.splice(idx, 1); if (!draft.lines.length) draft.lines.push(blankLine()); touch(); } }, 'Remove')));
    });
    const runCost = target ? draft.lines.filter((l) => l.item_no).reduce((s, l) => s + pcm.cost(l.item_no, year) * (l.uses_batch_minutes ? Number(state.data.settings.minutes_per_batch) || 0 : Number(l.qty) || 0), 0) : 0;
    const perUnit = runCost / (Number(draft.yieldQty) || 1);
    const linesPanel = h('section', { class: 'panel section' },
      h('h2', null, h('span', { class: 'grow' }, '2. What goes into one run?'), h('span', { class: 'legend-entry' }, h('i'), 'Type in the yellow cells')),
      h('div', { class: 'tablewrap', style: { border: 0, borderRadius: 0, boxShadow: 'none' } }, h('table', { class: 't cb-lines' },
        h('thead', null, h('tr', null, h('th', { class: 'num' }, '#'), h('th', null, 'Item'), h('th', null, 'Type'), h('th', { class: 'num' }, 'Qty per run'), h('th', null, 'Unit'), h('th'),
          h('th', { class: 'num' }, `Unit cost (${year})`), h('th', { class: 'num' }, 'Line cost'), h('th'))),
        h('tbody', null, lineRows),
        h('tfoot', null, h('tr', null, h('td'), h('td', null, 'Cost of one run'), h('td'), h('td'), h('td'), h('td'), h('td'), h('td', { class: 'num' }, money(runCost, 2)), h('td'))))),
      h('div', { class: 'inline-form' }, h('button', { class: 'btn', onclick: () => { draft.lines.push(blankLine()); touch(); } }, '+ Add line'),
        h('span', { class: 'small muted' }, 'Items marked ▸ have their own BOM and are included with everything inside them. Items that already contain this one can’t be added.')));

    // ---------- 3. save ----------
    const issues = problems();
    const name = draft.mode === 'new' ? (draft.newItem.name.trim() || 'New item') : ix.items.get(draft.itemNo)?.name;
    const save = async () => {
      if (issues.length) { toast(issues[0], 'bad'); return; }
      const lines = draft.lines.filter((l) => l.item_no);
      try {
        const itemNo = draft.mode === 'new' ? Number(draft.newItem.item_no) : draft.itemNo;
        const newItem = draft.mode === 'new' ? { item_no: itemNo, name: draft.newItem.name.trim(), type: draft.newItem.type, unit: draft.newItem.unit || null,
          sort: Math.max(0, ...state.data.items.map((i) => i.sort)) + 1 } : null;
        await saveBom({ newItem, itemNo, yieldQty: Number(draft.yieldQty), yieldUnit: draft.yieldUnit, lines });
        toast(`Saved the BOM for ${name}.`);
        draft = loadExisting(itemNo);
        rerender();
      } catch (err) { toast(niceError(err), 'bad'); }
    };
    const savePanel = h('section', { class: 'panel section cb-save' },
      h('div', { class: 'body cb-summary' },
        h('div', null, h('div', { class: 'small muted' }, `${name} · standard cost (${year})`),
          h('div', { class: 'cb-total' }, money(perUnit, 4), h('span', { class: 'muted' }, ` per ${draft.mode === 'new' ? (draft.newItem.unit || 'unit') : unitOf(draft.itemNo) || 'unit'}`)),
          h('div', { class: 'small muted' }, `One run makes ${qty(Number(draft.yieldQty) || 0, 2)} ${draft.yieldUnit} and costs ${money(runCost, 2)}.`)),
        issues.length && draft.dirty ? h('ul', { class: 'cb-issues' }, issues.map((i) => h('li', null, i))) : null,
        h('div', { class: 'controls' },
          draft.mode === 'edit' ? h('button', { class: 'btn danger', onclick: async () => {
            if (!(await confirmDialog(`Delete the BOM for ${name}? The item stays; it just won’t have a BOM.`))) return;
            try { await deleteBom(draft.itemNo); toast('BOM deleted.'); draft = freshDraft(); rerender(); } catch (err) { toast(niceError(err), 'bad'); }
          } }, 'Delete BOM') : null,
          h('button', { class: 'btn', onclick: () => { draft = draft.mode === 'edit' ? loadExisting(draft.itemNo) : freshDraft(); rerender(); } }, draft.mode === 'edit' ? 'Undo changes' : 'Clear'),
          h('button', { class: 'btn primary', disabled: !draft.dirty && draft.mode === 'edit', onclick: save }, draft.mode === 'edit' ? 'Save changes' : 'Save BOM'))));

    return h('div', null,
      pageHead(draft.mode === 'edit' ? `Edit BOM: ${name}` : 'Create BOM',
        'Build what an item is made of. A line can be another item with its own BOM, such as a recipe inside a product, or a sub-recipe inside a recipe. Nothing is saved until you click Save.',
        h('button', { class: 'btn', onclick: () => { draft = freshDraft(); rerender(); } }, 'Start a new BOM'),
        yearSelect(cmNow.years, year, (y) => { year = y; rerender(); }, 'Cost year')),
      whatPanel, linesPanel, savePanel);
  },
};
