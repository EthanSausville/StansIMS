// BOM editor (in the BOMs tab's left side bar): build a new bill of
// materials, or change an existing one.
// A line can be any item, including something that has its own BOM, so BOMs
// nest to any depth. Lines that would put an item inside itself are refused.
// Nothing is saved until Save.
import { h, qty, money, fmt, toast, niceError, confirmDialog } from '../ui.js';
import { state, derived, isAdmin, saveBom, deleteBom } from '../store.js';
import { costModel, wouldLoop, index, evalEntry, TYPES } from '../calc.js';

const stat = (label, value, sub) => h('div', { class: 'stat' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), sub ? h('div', { class: 'small muted' }, sub) : null);

let draft = null;
const THIS_YEAR = new Date().getFullYear();
let rerenderRef = () => {};

const blankLine = () => ({ key: Math.random().toString(36).slice(2), id: null, item_no: null, qty: null, uses_batch_minutes: false });

function nextItemNo(type) {
  const nums = state.data.items.map((i) => i.item_no);
  const base = type === 'Finished Good' ? 20000 : type === 'Recipe' ? 30000 : 10000;
  return Math.max(base, ...nums.filter((n) => n > base && n < base + 10000)) + 1;
}

function freshDraft(year) {
  return { year, mode: 'new', itemNo: null, newItem: { name: '', item_no: nextItemNo('Finished Good'), type: 'Finished Good', unit: 'ea' },
    yieldQty: 1, yieldUnit: 'case', laborMinutes: null, lines: [blankLine()], dirty: false };
}

// Loads the BOM an item uses in `year`. If that BOM started in an earlier year,
// the draft is a copy: saving it gives the item its own BOM from `year` on.
function loadExisting(itemNo, year) {
  const ix = index(state.data, year);
  const b = ix.bom.get(itemNo);
  const from = b ? ix.bomYear(itemNo) : null;
  const own = !!b && from === year;
  const lines = b ? ix.children(itemNo)
    .map((l) => ({ key: Math.random().toString(36).slice(2), id: own ? l.id : null, item_no: l.item_no, qty: l.qty, uses_batch_minutes: !!l.uses_batch_minutes })) : [];
  const it = state.data.items.find((i) => i.item_no === itemNo);
  return { year, mode: b ? 'edit' : 'existing', itemNo, newItem: null, own, from: b && !own && Number.isFinite(from) ? from : null,
    yieldQty: b ? Number(b.yield_qty) : 1, yieldUnit: b ? (b.yield_unit || '') : (it?.type === 'Finished Good' ? 'case' : it?.unit || ''),
    laborMinutes: b && b.labor_minutes !== null && b.labor_minutes !== undefined ? Number(b.labor_minutes) : (lines.some((l) => l.uses_batch_minutes) ? Number(state.data.settings.minutes_per_batch) || null : null),
    lines: lines.length ? lines : [blankLine()], dirty: false };
}

export const editorOpen = () => !!draft;
const closeEditor = () => { draft = null; rerenderRef(); };

// Opens the editor on an item's BOM for a year (or a blank new BOM when itemNo is null).
export function openInEditor(itemNo, year) {
  draft = itemNo === null ? freshDraft(year) : loadExisting(itemNo, year);
  if (location.hash !== '#bom') location.hash = 'bom';
  window.dispatchEvent(new Event('stans:side-open'));
  rerenderRef();
}

// The data as it would be after saving this draft, for live costs and loop checks.
function previewData() {
  const d = state.data;
  const target = draft.mode === 'new' ? Number(draft.newItem.item_no) : draft.itemNo;
  const items = draft.mode === 'new' && target ? [...d.items, { ...draft.newItem, item_no: target, sort: 1e9 }] : d.items;
  const y = draft.year; const other = (r, k) => !(r[k] === target && r.year === y);
  const boms = [...d.boms.filter((b) => other(b, 'item_no')), { item_no: target, year: y, yield_qty: Number(draft.yieldQty) || 1, yield_unit: draft.yieldUnit, labor_minutes: draft.laborMinutes }];
  const lines = [...d.bom_lines.filter((l) => other(l, 'parent_item_no')),
    ...draft.lines.filter((l) => l.item_no).map((l, i) => ({ id: `draft${i}`, parent_item_no: target, year: y, item_no: l.item_no, qty: l.qty, uses_batch_minutes: l.uses_batch_minutes, sort: i + 1 }))];
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
  if (draft.lines.some((l) => l.item_no && l.uses_batch_minutes) && !(Number(draft.laborMinutes) > 0)) out.push('Enter the labor minutes per run (used by the lines marked “Labor minutes”).');
  const filled = draft.lines.filter((l) => l.item_no);
  if (!filled.length) out.push('Add at least one line.');
  for (const l of filled) {
    const it = state.data.items.find((i) => i.item_no === l.item_no);
    // Labor and overhead lines may be left blank (no cost); everything else needs a quantity.
    const blankOk = it?.type === 'Indirect Cost' && (l.qty === null || l.qty === undefined || l.qty === '');
    if (!l.uses_batch_minutes && !blankOk && !(Number(l.qty) > 0)) out.push(`Enter a quantity for ${it?.name || 'each line'}.`);
  }
  const seen = new Set();
  for (const l of filled) { if (seen.has(l.item_no)) out.push(`${state.data.items.find((i) => i.item_no === l.item_no)?.name} is listed twice.`); seen.add(l.item_no); }
  return [...new Set(out)];
}

// The editor, laid out for the side bar. `year` is the cost year shown.
export function bomEditor({ rerender }) {
  rerenderRef = rerender;
  if (!isAdmin() || !draft) return [];
  const { year } = draft;
  const ix = index(state.data, year); const cmNow = derived.costs();
  const touch = () => { draft.dirty = true; rerender(); };
  const { target, data: preview } = previewData();
  const pix = index(preview, year); const pcm = costModel(preview);
  const unitOf = (itemNo) => (itemNo === target && draft.mode === 'new' ? draft.newItem.unit : ix.items.get(itemNo)?.unit) || '';
  const name = draft.mode === 'new' ? (draft.newItem.name.trim() || 'New item') : ix.items.get(draft.itemNo)?.name;

  // ---------- 1. what it makes ----------
  const makesExisting = draft.mode !== 'new';
  const editing = draft.mode === 'edit';
  // A new BOM can be for an existing item that doesn't have one yet; BOMs that exist are changed with Edit.
  const candidates = state.data.items.filter((i) => i.type !== 'Indirect Cost' && !(ix.bom.has(i.item_no) && ix.bomYear(i.item_no) <= year)).sort((a, b) => a.name.localeCompare(b.name));
  const what = h('section', { class: 'cb-part' }, h('h3', null, editing ? 'What it makes' : '1. What does it make?'),
    editing ? null : h('div', { class: 'seg', role: 'group', 'aria-label': 'New or existing item' },
      h('button', { 'aria-pressed': String(!makesExisting), onclick: () => { if (makesExisting) { draft = freshDraft(year); rerender(); } } }, 'New item'),
      h('button', { 'aria-pressed': String(makesExisting), onclick: () => { if (!makesExisting) { draft = { ...draft, mode: 'existing', itemNo: null, newItem: null }; rerender(); } } }, 'Existing item')),
    editing ? null : makesExisting
      ? h('label', { class: 'field' }, 'Item',
        h('select', { id: 'cb-item', onchange: (e) => { const v = Number(e.target.value) || null; draft = v ? loadExisting(v, year) : { ...draft, itemNo: null }; rerender(); } },
          h('option', { value: '' }, 'Choose an item…'),
          candidates.map((i) => h('option', { value: i.item_no, selected: i.item_no === draft.itemNo }, `${i.name} (#${i.item_no})`))))
      : h('div', { class: 'cb-fields' },
        h('label', { class: 'field span2' }, 'Name', h('input', { id: 'cb-name', type: 'text', value: draft.newItem.name, 'data-k': 'cb-name', placeholder: 'e.g. Pimento Cheese Dip 10 oz. (Case of 12)', oninput: (e) => { draft.newItem.name = e.target.value; draft.dirty = true; }, onchange: rerender })),
        h('label', { class: 'field' }, 'Type', h('select', { id: 'cb-type', onchange: (e) => {
            const t = e.target.value; draft.newItem.type = t; draft.newItem.item_no = nextItemNo(t);
            if (t === 'Finished Good') { draft.newItem.unit = 'ea'; draft.yieldUnit = 'case'; draft.yieldQty = 1; } else if (draft.yieldUnit === 'case') { draft.newItem.unit = 'oz'; draft.yieldUnit = 'oz'; }
            touch(); } },
          TYPES.filter((t) => t !== 'Indirect Cost').map((t) => h('option', { value: t, selected: t === draft.newItem.type }, t === 'Recipe' ? 'Recipe / sub-assembly' : t)))),
        h('label', { class: 'field' }, 'Item #', h('input', { id: 'cb-no', type: 'number', value: draft.newItem.item_no, onchange: (e) => { draft.newItem.item_no = Number(e.target.value); touch(); } })),
        h('label', { class: 'field' }, 'Unit', h('input', { id: 'cb-unit', type: 'text', value: draft.newItem.unit, placeholder: 'ea, oz, lb, c', onchange: (e) => { draft.newItem.unit = e.target.value.trim(); touch(); } }))),
    h('div', { class: 'cb-fields three' },
      h('label', { class: 'field' }, 'One run makes', h('input', { id: 'cb-yield', type: 'text', inputmode: 'decimal', value: draft.yieldQty, onchange: (e) => { try { draft.yieldQty = evalEntry(e.target.value); } catch { draft.yieldQty = null; } touch(); } })),
      h('label', { class: 'field' }, 'Unit', h('input', { id: 'cb-yield-unit', type: 'text', value: draft.yieldUnit, placeholder: 'case, oz', onchange: (e) => { draft.yieldUnit = e.target.value.trim(); touch(); } })),
      h('label', { class: 'field', title: 'Everyone’s minutes added up for one run (3 people × 40 min = 120). Direct Labor and Overhead lines marked “Labor min” use it.' }, 'Labor min / run', h('input', { id: 'cb-minutes', type: 'text', inputmode: 'decimal', value: draft.laborMinutes ?? '', placeholder: 'e.g. 90',
        onchange: (e) => { try { draft.laborMinutes = e.target.value.trim() ? evalEntry(e.target.value) : null; } catch { draft.laborMinutes = null; } touch(); } }))),
    h('p', { class: 'small muted' }, 'Quantities are for one run: one case of a product, or one batch of a recipe (its batch size, e.g. 3,220 oz).'));

  // ---------- 2. lines ----------
  const groups = ['Recipe', 'Finished Good', 'Raw Material', 'Component', 'Indirect Cost'];
  const lineRows = draft.lines.map((l, idx) => {
    const it = l.item_no ? ix.items.get(l.item_no) : null;
    const select = h('select', { id: `cb-line-${l.key}`, 'aria-label': `Line ${idx + 1} item`, onchange: (e) => {
        l.item_no = Number(e.target.value) || null;
        const t = ix.items.get(l.item_no)?.type;
        l.uses_batch_minutes = t === 'Indirect Cost' && (Number(draft.yieldQty) > 1);
        if (l.uses_batch_minutes && draft.laborMinutes === null) draft.laborMinutes = Number(state.data.settings.minutes_per_batch) || null;
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
    const q = l.uses_batch_minutes ? Number(draft.laborMinutes) || 0 : Number(l.qty) || 0;
    const c = l.item_no ? pcm.cost(l.item_no, year) : 0;
    return h('tr', null,
      h('td', { class: 'cell entry cb-item-cell' }, select),
      l.uses_batch_minutes
        ? h('td', { class: 'num calc', title: 'Labor minutes per run (above)' }, qty(q, 4), h('span', { class: 'cb-unit' }, it?.unit || ''))
        : h('td', { class: 'cell num entry' }, h('input', { type: 'text', inputmode: 'decimal', value: l.qty ?? '', 'data-k': `cb-qty-${l.key}`, 'aria-label': `Line ${idx + 1} quantity`, title: it?.unit || '',
          onchange: (e) => { try { l.qty = evalEntry(e.target.value); e.target.classList.remove('error'); } catch (err) { e.target.classList.add('error'); toast(err.message, 'bad'); return; } touch(); } })),
      h('td', { class: 'muted cb-unit-cell' }, it?.type === 'Indirect Cost'
        ? h('label', { class: 'check', title: 'Use the labor minutes per run' }, h('input', { type: 'checkbox', checked: l.uses_batch_minutes, 'aria-label': `Line ${idx + 1}: use labor minutes`, onchange: (e) => { l.uses_batch_minutes = e.target.checked; if (e.target.checked && draft.laborMinutes === null) draft.laborMinutes = Number(state.data.settings.minutes_per_batch) || null; touch(); } }), ' min')
        : it ? (it.unit || '') : ''),
      h('td', { class: 'num calc', title: c ? `Unit cost ${year}: $${fmt(c, Math.abs(c) < 1 ? 5 : 2, 2)}` : '' }, c && q ? money(c * q, 2) : ''),
      h('td', null, h('button', { class: 'btn icon-btn danger', title: 'Remove line', 'aria-label': `Remove line ${idx + 1}`, onclick: () => { draft.lines.splice(idx, 1); if (!draft.lines.length) draft.lines.push(blankLine()); touch(); } }, '×')));
  });
  const runCost = target ? draft.lines.filter((l) => l.item_no).reduce((s, l) => s + pcm.cost(l.item_no, year) * (l.uses_batch_minutes ? Number(draft.laborMinutes) || 0 : Number(l.qty) || 0), 0) : 0;
  const perUnit = runCost / (Number(draft.yieldQty) || 1);
  const linesPart = h('section', { class: 'cb-part' }, h('h3', null, editing ? 'What goes into one run' : '2. What goes into one run?'),
    h('table', { class: 't cb-lines' },
      h('thead', null, h('tr', null, h('th', null, 'Item'), h('th', { class: 'num' }, 'Qty'), h('th'), h('th', { class: 'num' }, 'Cost'), h('th'))),
      h('tbody', null, lineRows),
      h('tfoot', null, h('tr', null, h('td', null, 'Cost of one run'), h('td'), h('td'), h('td', { class: 'num' }, money(runCost, 2)), h('td')))),
    h('button', { class: 'btn', onclick: () => { draft.lines.push(blankLine()); touch(); } }, '+ Add line'),
    h('p', { class: 'small muted' }, 'Items marked ▸ have their own BOM and bring everything inside them. Items that already contain this one can’t be added.'));

  // ---------- labor (recipes: labor minutes per batch) ----------
  const usesMinutes = draft.lines.some((l) => l.item_no && l.uses_batch_minutes);
  const laborRate = cmNow.labor.rateFor(year);
  const minutesPer = Number(draft.laborMinutes) || 0; const runSize = Number(draft.yieldQty) || 0;
  const yearLabor = cmNow.labor.hasPositions ? cmNow.labor.forYear(year) : null;
  const laborPart = usesMinutes ? h('section', { class: 'cb-part cb-labor' }, h('h3', null, `Labor (${year} rate)`),
    h('div', { class: 'cb-stats' },
      stat('Labor rate', laborRate ? '$' + qty(laborRate, 4) + '/min' : '—', yearLabor?.setup?.forecast ? `${year} forecast` : laborRate ? `${year} standard` : `None set for ${year}`),
      stat('Labor per run', laborRate && minutesPer ? money(laborRate * minutesPer, 2) : '—', minutesPer ? `${qty(minutesPer, 2)} labor minutes` : 'Enter labor minutes'),
      stat(`Labor per ${draft.yieldUnit || 'unit'}`, laborRate && minutesPer && runSize ? '$' + qty((laborRate * minutesPer) / runSize, 5) : '—', runSize ? `Run makes ${qty(runSize, 2)} ${draft.yieldUnit}` : ''),
      stat('Line capacity', yearLabor && minutesPer ? fmt(yearLabor.minutes / minutesPer) : '—', 'runs a year'))) : null;

  // ---------- 3. save ----------
  const issues = problems();
  const save = async () => {
    if (issues.length) { toast(issues[0], 'bad'); return; }
    const lines = draft.lines.filter((l) => l.item_no);
    try {
      const itemNo = draft.mode === 'new' ? Number(draft.newItem.item_no) : draft.itemNo;
      const newItem = draft.mode === 'new' ? { item_no: itemNo, name: draft.newItem.name.trim(), type: draft.newItem.type, unit: draft.newItem.unit || null,
        sort: Math.max(0, ...state.data.items.map((i) => i.sort)) + 1 } : null;
      await saveBom({ newItem, itemNo, year, yieldQty: Number(draft.yieldQty), yieldUnit: draft.yieldUnit, laborMinutes: draft.laborMinutes, lines });
      toast(`Saved the BOM for ${name}.`);
      closeEditor();
    } catch (err) { toast(niceError(err), 'bad'); }
  };
  const savePart = h('section', { class: 'cb-part cb-save' },
    h('div', { class: 'small muted' }, `${name} · standard cost (${year})`),
    h('div', { class: 'cb-total' }, money(perUnit, 4), h('span', { class: 'muted' }, ` per ${draft.mode === 'new' ? (draft.newItem.unit || 'unit') : unitOf(draft.itemNo) || 'unit'}`)),
    h('div', { class: 'small muted' }, `One run makes ${qty(Number(draft.yieldQty) || 0, 2)} ${draft.yieldUnit} and costs ${money(runCost, 2)}.`),
    issues.length && draft.dirty ? h('ul', { class: 'cb-issues' }, issues.map((i) => h('li', null, i))) : null,
    h('div', { class: 'controls' },
      draft.mode === 'edit' && draft.own ? h('button', { class: 'btn danger', onclick: async () => {
        const earlier = state.data.boms.some((b) => b.item_no === draft.itemNo && b.year < year);
        if (!(await confirmDialog(earlier ? `Delete the ${year} BOM for ${name}? From ${year} on it goes back to the earlier year’s BOM.` : `Delete the BOM for ${name}? The item stays; it just won’t have a BOM.`))) return;
        try { await deleteBom(draft.itemNo, year); toast('BOM deleted.'); closeEditor(); } catch (err) { toast(niceError(err), 'bad'); }
      } }, `Delete ${year} BOM`) : null,
      h('button', { class: 'btn', onclick: async () => { if (draft.dirty && !(await confirmDialog('Close without saving? Your changes will be lost.', 'Discard changes'))) return; closeEditor(); } }, 'Cancel'),
      h('button', { class: 'btn primary', disabled: !draft.dirty && draft.mode === 'edit', onclick: save }, draft.mode === 'edit' ? 'Save changes' : 'Save BOM')));

  return h('div', { class: 'bom-editor' },
    h('div', { class: 'cb-head' }, h('strong', { class: 'tb-title' }, editing ? `Editing ${year}: ${name}` : `New BOM for ${year}`)),
    editing && year <= THIS_YEAR ? h('div', { class: 'note warn cb-warning', role: 'note' },
      h('strong', null, `Careful: ${year} is ${year === THIS_YEAR ? 'the current year' : 'a past year'}. Changing its BOM can break things.`),
      h('div', null, `It recalculates ${year}’s standard costs, sales margins and inventory values, and the ingredients that production already used up. Only fix real mistakes here; make planned changes in a future year.`)) : null,
    editing && year > THIS_YEAR ? h('p', { class: 'small muted cb-future' }, draft.from !== null
      ? `Starts as a copy of the ${draft.from} BOM. Saving gives ${name} its own BOM from ${year} on; ${draft.from} keeps its BOM.`
      : `Changes apply from ${year} on. Earlier years keep their BOM.`) : null,
    what, linesPart, laborPart, savePart);
}
