// BOMs: every bill of materials gets its own top-level row, including ones
// that are also used inside other BOMs (a recipe inside a product). Click a row to open the
// next level; anything that has its own BOM opens further, to any depth.
// Each item's unit cost shows for every year, in columns. The tree is the
// selected year's (click a year); a year carries the latest earlier BOM.
// Click a BOM to select it; Edit BOM opens it in the editor.
import { h, pageHead, qty, fmt, typePill, thisYear, itemNoTh } from '../ui.js';
import { state, derived } from '../store.js';
import { can, standardsLocked, lockedNote } from '../perms.js';
import { openInEditor, bomEditor, editorOpen } from './createbom.js';

const THIS_YEAR = thisYear();
let year = THIS_YEAR;
let selected = null; // item_no of the selected BOM
const open = new Set(); // open rows, by path of item numbers ("20001>10021")

const unitCostFmt = (v) => (v ? '$' + fmt(v, Math.abs(v) < 1 ? 5 : 2, 2) : '—');

export default {
  id: 'bom',
  label: 'BOMs',
  render({ rerender }) {
    const cm = derived.costs(); const admin = can('bom', 'edit');
    const years = cm.years;
    if (!years.includes(year)) year = years.includes(THIS_YEAR) ? THIS_YEAR : years[0];
    const ix = cm.ixFor(year); // the tree as of the selected year
    const typeOrder = { 'Finished Good': 0, Recipe: 1 };
    // A BOM exists in a year from the year it's first made (later years carry it).
    const inYear = (itemNo, y) => { const i = cm.ixFor(y); return i.bom.has(itemNo) && !(i.bomYear(itemNo) > y); };
    const tops = [...new Set(years.flatMap((y) => [...cm.ixFor(y).bom.keys()].filter((no) => inYear(no, y))))]
      .map((no) => cm.ixFor(years.find((y) => inYear(no, y))).items.get(no) || ix.items.get(no)).filter(Boolean)
      .sort((a, b) => (typeOrder[a.type] ?? 2) - (typeOrder[b.type] ?? 2) || a.sort - b.sort);
    const editing = editorOpen();
    const pickYear = (y) => { if (editing) return; year = y; rerender(); };

    const rows = [];
    // guides: for each ancestor level, whether a vertical line continues past this row
    const walk = (itemNo, path, depth, guides, isLast) => {
      const it = ix.items.get(itemNo) || cm.ixFor(years.at(-1)).items.get(itemNo) || { name: `#${itemNo}`, type: '' };
      const b = ix.bom.get(itemNo) && inYear(itemNo, year);
      const key = path.join('>');
      const isOpen = !!b && open.has(key);
      const toggle = () => { if (!b) return; isOpen ? open.delete(key) : open.add(key); rerender(); };
      const pick = () => { if (!b) return; if (!editing) selected = itemNo; toggle(); };
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
        // Its unit cost each year (blank in years before a top-level BOM existed).
        years.map((y) => {
          const exists = depth > 0 || inYear(itemNo, y);
          return h('td', { class: 'num yc' + (y === year ? ' picked' : ''), 'data-year': y, title: exists ? `${it.name}, ${y}` : `No ${it.name} BOM in ${y}` },
            exists ? unitCostFmt(cm.cost(itemNo, y)) : '');
        }),
        h('td', { class: 'fill-col' })));
      if (!isOpen) return;
      const kids = ix.children(itemNo);
      kids.forEach((l, i) => {
        if (path.includes(l.item_no)) return; // never loop
        walk(l.item_no, [...path, l.item_no], depth + 1, depth > 0 ? [...guides, !isLast] : [], i === kids.length - 1);
      });
    };
    tops.filter((t) => inYear(t.item_no, year)).forEach((t, i, all) => walk(t.item_no, [t.item_no], 0, [], i === all.length - 1));

    if (selected && !inYear(selected, year)) selected = null;
    const sel = selected ? ix.items.get(selected) : null;

    // Always handed rerender, so New BOM / Edit can open it.
    const editor = admin && !standardsLocked(year) ? bomEditor({ rerender }) : null;
    const yearHead = (y) => h('th', { class: 'num yc' + (y === year ? ' picked' : '') },
      h('button', { type: 'button', class: 'year-pick', 'aria-pressed': String(y === year), disabled: editing && y !== year, title: editing ? 'Close the editor to change the year' : `Show ${y}’s BOMs and edit them`, onclick: () => pickYear(y) }, String(y)),
      h('div', { class: 'yc-note' }, y > THIS_YEAR ? 'future' : y === THIS_YEAR ? 'current' : 'past'));
    return h('div', null,
      pageHead('BOMs', 'Every bill of materials, including recipes used inside products, with its unit cost each year. Click a BOM to select it and open the next level; click a year to show and edit that year’s BOMs. BOMs are by year: a year without its own BOM for an item carries the latest earlier one. Change next year’s BOMs freely; changing the current or a past year recalculates its costs and inventory. Nothing is saved until you click Save.'),
      // Buttons above the table; the editor opens under them.
      h('div', { class: 'prod-top top-actions' },
        admin && !editing ? h('button', { class: 'btn primary', title: `A new BOM for ${year}`, onclick: () => openInEditor(null, year) }, 'New BOM') : null,
        admin && !editing && sel ? h('button', { class: 'btn', title: `Edit the ${year} ${sel.name} BOM`, onclick: () => openInEditor(selected, year) }, 'Edit BOM') : null,
        admin && !editing ? h('span', { class: 'small muted' }, sel ? `Selected: ${sel.name}, ${year}` : 'Click a BOM to select it for editing.') : null,
        !admin ? h('span', { class: 'small muted' }, 'Your role can view BOMs but not change them.') : standardsLocked(year) ? h('span', { class: 'small muted' }, lockedNote(year)) : null),
      editor && editing ? h('div', { class: 'top-editor wide' }, editor) : null,
      tops.length ? h('div', { class: 'tablewrap', 'data-scroll': 'bomtree' }, h('table', { class: 't tree-table' },
        h('thead', null, h('tr', null, itemNoTh(), h('th', { class: 'sticky-col sticky-col2' }, 'Item'), h('th', null, 'Type'),
          years.map(yearHead), h('th', { class: 'grow' }))),
        h('tbody', null, rows)))
        : h('div', { class: 'panel empty' }, 'No BOMs yet.', admin ? h('div', null, h('button', { class: 'btn primary', style: { marginTop: '10px' }, onclick: () => openInEditor(null, year) }, 'New BOM')) : null));
  },
};
