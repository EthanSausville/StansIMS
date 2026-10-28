// BOMs: every bill of materials gets its own top-level row, including ones
// that are also used inside other BOMs (a recipe inside a product). Click a row to open the
// next level; anything that has its own BOM opens further, to any depth.
// Quantities and line costs are for one run of the BOM directly above.
import { h, pageHead, qty, money, fmt, yearSelect, typePill } from '../ui.js';
import { state, derived, isAdmin } from '../store.js';
import { openInEditor } from './createbom.js';

let year = new Date().getFullYear();
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
  render({ rerender }) {
    const ix = derived.ix(); const cm = derived.costs(); const admin = isAdmin();
    if (!cm.years.includes(year)) year = cm.years[0];
    const typeOrder = { 'Finished Good': 0, Recipe: 1 };
    const tops = state.data.boms.map((b) => ix.items.get(b.item_no)).filter(Boolean)
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
      const q = line && !blankQty ? cm.lineQty(line) : null;
      const toggle = () => { if (!b) return; isOpen ? open.delete(key) : open.add(key); rerender(); };
      const nameCell = h('td', { class: 'sticky-col tree-cell' }, h('div', { class: 'tree' },
        guides.map((cont) => h('span', { class: 'guide ' + (cont ? 'pipe' : 'blank'), 'aria-hidden': 'true' })),
        depth > 0 ? h('span', { class: 'guide ' + (isLast ? 'elbow' : 'tee'), 'aria-hidden': 'true' }) : null,
        b ? h('button', { class: 'twisty' + (isOpen ? ' open' : ''), 'aria-expanded': String(isOpen), 'aria-label': `${isOpen ? 'Close' : 'Open'} ${it.name}`, onclick: (e) => { e.stopPropagation(); toggle(); } }, isOpen ? '−' : '+')
          : h('span', { class: 'leaf', 'aria-hidden': 'true' }),
        h('span', { class: 'tree-name' + (depth === 0 ? ' top' : '') }, it.name)));
      rows.push(h('tr', { class: `tree-row d${Math.min(depth, 3)}` + (b ? ' has-bom' : ''), onclick: b ? toggle : null },
        nameCell,
        h('td', { class: 'muted' }, itemNo),
        h('td', null, typePill(it.type)),
        h('td', { class: 'small muted used-in' }, depth === 0 && b ? usedInText(itemNo) : ''),
        h('td', { class: 'num' }, line && q !== null ? (line.uses_batch_minutes ? h('span', { title: 'Labor minutes per run of this BOM' }, qty(q, 4)) : qty(q, 4)) : ''),
        h('td', { class: 'muted' }, line ? (it.unit || '') : ''),
        h('td', { class: 'muted' }, b ? makes(b, it, ix) : ''),
        h('td', { class: 'num' }, unitCostFmt(unit)),
        h('td', { class: 'num' }, line && q !== null ? money(unit * q, 2) : ''),
        admin ? h('td', null, b ? h('button', { class: 'btn ghost', onclick: (e) => { e.stopPropagation(); openInEditor(itemNo); } }, 'Edit') : null) : null));
      if (!isOpen) return;
      const kids = ix.children(itemNo);
      kids.forEach((l, i) => {
        if (path.includes(l.item_no)) return; // never loop
        walk(l.item_no, [...path, l.item_no], depth + 1, depth > 0 ? [...guides, !isLast] : [], i === kids.length - 1, l);
      });
    };
    tops.forEach((t, i) => walk(t.item_no, [t.item_no], 0, [], i === tops.length - 1, null));

    const allKeys = () => {
      const keys = [];
      const go = (itemNo, path) => { if (!ix.bom.has(itemNo)) return; keys.push(path.join('>')); for (const l of ix.children(itemNo)) if (!path.includes(l.item_no)) go(l.item_no, [...path, l.item_no]); };
      tops.forEach((t) => go(t.item_no, [t.item_no]));
      return keys;
    };

    return h('div', null,
      pageHead('BOMs', 'Every bill of materials, including recipes used inside products. Click one to open the next level. Quantities and line costs are for one run of the BOM directly above (one case, one batch).',
        h('button', { class: 'btn', onclick: () => { allKeys().forEach((k) => open.add(k)); rerender(); } }, 'Open all'),
        h('button', { class: 'btn', onclick: () => { open.clear(); rerender(); } }, 'Close all'),
        admin ? h('button', { class: 'btn primary', onclick: () => openInEditor(null) }, 'Create BOM') : null,
        yearSelect(cm.years, year, (y) => { year = y; rerender(); }, 'Cost year')),
      tops.length ? h('div', { class: 'tablewrap', 'data-scroll': 'bomtree' }, h('table', { class: 't tree-table' },
        h('thead', null, h('tr', null, h('th', { class: 'sticky-col' }, 'Item'), h('th', null, 'Item #'), h('th', null, 'Type'), h('th', null, 'Used in'),
          h('th', { class: 'num' }, 'Qty'), h('th', null, 'Unit'), h('th', null, 'One run makes'),
          h('th', { class: 'num' }, `Unit cost (${year})`), h('th', { class: 'num' }, 'Line cost'), admin ? h('th') : null)),
        h('tbody', null, rows)))
        : h('div', { class: 'panel empty' }, 'No BOMs yet.', admin ? h('div', null, h('button', { class: 'btn primary', style: { marginTop: '10px' }, onclick: () => openInEditor(null) }, 'Create the first BOM')) : null));
  },
};
