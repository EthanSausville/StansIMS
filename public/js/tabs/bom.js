// BOMs: every bill of materials gets its own top-level row, including ones
// that are also used inside other BOMs (a recipe inside a product). Click a row to open the
// next level; anything that has its own BOM opens further, to any depth.
// Quantities and line costs are for one run of the BOM directly above.
// BOMs are by year: a year shows its own BOMs, or carries the latest earlier one.
// Click a BOM to select it; Edit BOM (left) opens it in the editor.
import { h, pageHead, qty, money, fmt, yearSelect, typePill, thisYear, itemNoTh } from '../ui.js';
import { state, derived } from '../store.js';
import { can, standardsLocked, lockedNote } from '../perms.js';
import { openInEditor, bomEditor, editorOpen } from './createbom.js';

const THIS_YEAR = thisYear();
let year = THIS_YEAR;
let selected = null; // item_no of the selected BOM
const open = new Set(); // open rows, by path of item numbers ("20001>10021")

const unitCostFmt = (v) => (v ? '$' + fmt(v, Math.abs(v) < 1 ? 5 : 2, 2) : '—');
const makes = (b, it, ix) => {
  const base = `${qty(Number(b.yield_qty) || 1, 2)} ${b.yield_unit || it?.unit || ''}`.trim();
  const usesMin = ix.children(b.item_no).some((l) => l.uses_batch_minutes);
  return usesMin ? `${base} · ${qty(ix.laborMinutesOf(b.item_no), 2)} labor min` : base;
};

export default {
  id: 'bom',
  label: 'BOMs',
  // 250px like other tabs; wider while a BOM is open in the editor.
  get sideWidth() { return editorOpen() ? 0.4 : null; },
  sideKey: 'bom-edit',
  render({ rerender }) {
    const cm = derived.costs(); const admin = can('bom', 'edit');
    if (!cm.years.includes(year)) year = cm.years.includes(THIS_YEAR) ? THIS_YEAR : cm.years[0];
    const ix = cm.ixFor(year);
    const typeOrder = { 'Finished Good': 0, Recipe: 1 };
    // BOMs that exist in this year (a BOM first made in a later year isn't listed).
    const inYear = (itemNo) => ix.bom.has(itemNo) && !(ix.bomYear(itemNo) > year);
    const tops = [...ix.bom.keys()].filter(inYear).map((no) => ix.items.get(no)).filter(Boolean)
      .sort((a, b) => (typeOrder[a.type] ?? 2) - (typeOrder[b.type] ?? 2) || a.sort - b.sort);

    const usedInText = (itemNo) => {
      const parents = [...(ix.usedIn.get(itemNo) || [])].map((p) => ix.items.get(p)?.name).filter(Boolean);
      if (!parents.length) return '';
      return h('span', { title: parents.join('\n') }, parents.length === 1 ? parents[0] : `${parents.length} BOMs`);
    };
    const rows = [];
    // guides: for each ancestor level, whether a vertical line continues past this row
    const walk = (itemNo, path, depth, guides, isLast, line) => {
      const it = ix.items.get(itemNo) || { name: `#${itemNo}`, type: '' };
      const b = ix.bom.get(itemNo);
      const key = path.join('>');
      const isOpen = !!b && open.has(key);
      const unit = cm.cost(itemNo, year);
      const blankQty = line && !line.uses_batch_minutes && (line.qty === null || line.qty === undefined);
      const q = line && !blankQty ? ix.lineQty(line) : null;
      const toggle = () => { if (!b) return; isOpen ? open.delete(key) : open.add(key); rerender(); };
      const pick = () => { if (!b) return; if (!editorOpen()) selected = itemNo; toggle(); };
      const nameCell = h('td', { class: 'sticky-col sticky-col2 tree-cell' }, h('div', { class: 'tree' },
        guides.map((cont) => h('span', { class: 'guide ' + (cont ? 'pipe' : 'blank'), 'aria-hidden': 'true' })),
        depth > 0 ? h('span', { class: 'guide ' + (isLast ? 'elbow' : 'tee'), 'aria-hidden': 'true' }) : null,
        b ? h('button', { class: 'twisty' + (isOpen ? ' open' : ''), 'aria-expanded': String(isOpen), 'aria-label': `${isOpen ? 'Close' : 'Open'} ${it.name}`, onclick: (e) => { e.stopPropagation(); toggle(); } }, isOpen ? '−' : '+')
          : h('span', { class: 'leaf', 'aria-hidden': 'true' }),
        h('span', { class: 'tree-name' + (depth === 0 ? ' top' : '') }, it.name)));
      rows.push(h('tr', { class: `tree-row d${Math.min(depth, 3)}` + (b ? ' has-bom' : '') + (b && itemNo === selected ? ' selected' : ''), onclick: b ? pick : null, 'aria-selected': b ? String(itemNo === selected) : null },
        h('td', { class: 'sticky-col itemno' }, itemNo),
        nameCell,
        h('td', null, typePill(it.type)),
        h('td', { class: 'small muted used-in' }, depth === 0 && b ? usedInText(itemNo) : ''),
        h('td', { class: 'num' }, line && q !== null ? (line.uses_batch_minutes ? h('span', { title: 'Labor minutes per run of this BOM' }, qty(q, 4)) : qty(q, 4)) : ''),
        h('td', { class: 'muted' }, line ? (it.unit || '') : ''),
        h('td', { class: 'muted' }, b ? makes(b, it, ix) : ''),
        h('td', { class: 'num' }, unitCostFmt(unit)),
        h('td', { class: 'num' }, line && q !== null ? money(unit * q, 2) : '')));
      if (!isOpen) return;
      const kids = ix.children(itemNo);
      kids.forEach((l, i) => {
        if (path.includes(l.item_no)) return; // never loop
        walk(l.item_no, [...path, l.item_no], depth + 1, depth > 0 ? [...guides, !isLast] : [], i === kids.length - 1, l);
      });
    };
    tops.forEach((t, i) => walk(t.item_no, [t.item_no], 0, [], i === tops.length - 1, null));

    if (selected && !inYear(selected)) selected = null;
    const sel = selected ? ix.items.get(selected) : null;
    const carried = tops.filter((t) => ix.bomYear(t.item_no) < year).length;
    const firstYear = Math.min(...tops.map((t) => ix.bomYear(t.item_no)).filter(Number.isFinite));
    const yearSel = yearSelect(cm.years, year, (y) => { year = y; rerender(); }, 'Year');
    if (editorOpen()) { yearSel.querySelector('select').disabled = true; yearSel.title = 'Close the editor to change the year'; }

    return h('div', null,
      pageHead('BOMs', 'Every bill of materials for the year, including recipes used inside products. Click one to select it and open the next level. Quantities and line costs are for one run of the BOM directly above (one case, one batch). BOMs are by year: a year without its own BOM for an item carries the latest earlier one. Change next year’s BOMs freely; changing the current or a past year recalculates its costs and inventory. Nothing is saved until you click Save.',
        yearSel,
        admin && !editorOpen() ? h('button', { class: 'btn primary', onclick: () => openInEditor(null, year) }, 'New BOM') : null,
        admin && !editorOpen() ? (sel
          ? h('div', { class: 'bom-selected' }, h('div', { class: 'small muted' }, 'Selected'), h('strong', null, sel.name),
            h('button', { class: 'btn', onclick: () => openInEditor(selected, year) }, 'Edit BOM'))
          : h('p', { class: 'small muted' }, 'Click a BOM on the right to select it for editing.')) : null,
        admin && !standardsLocked(year) ? bomEditor({ rerender }) : h('p', { class: 'small muted' }, admin ? lockedNote(year) : 'Your role can view BOMs but not change them.')),
      h('div', { class: 'bom-year-head' }, h('h2', null, `${year} BOMs`),
        year > THIS_YEAR ? h('span', { class: 'chip' }, 'Future year: safe to change') : year === THIS_YEAR ? h('span', { class: 'chip' }, 'Current year') : h('span', { class: 'chip' }, 'Past year'),
        carried && Number.isFinite(firstYear) && carried === tops.length && firstYear < year ? h('span', { class: 'small muted' }, `Same as ${firstYear} until changed`)
          : carried ? h('span', { class: 'small muted' }, `${carried} of ${tops.length} carried over from earlier years`) : null),
      tops.length ? h('div', { class: 'tablewrap', 'data-scroll': 'bomtree' }, h('table', { class: 't tree-table' },
        h('thead', null, h('tr', null, itemNoTh(), h('th', { class: 'sticky-col sticky-col2' }, 'Item'), h('th', null, 'Type'), h('th', null, 'Used in'),
          h('th', { class: 'num' }, 'Qty'), h('th', null, 'Unit'), h('th', null, 'One run makes'),
          h('th', { class: 'num' }, `Unit cost (${year})`), h('th', { class: 'num' }, 'Line cost'))),
        h('tbody', null, rows)))
        : h('div', { class: 'panel empty' }, `No BOMs in ${year} yet.`, admin ? h('div', null, h('button', { class: 'btn primary', style: { marginTop: '10px' }, onclick: () => openInEditor(null, year) }, 'New BOM')) : null));
  },
};
