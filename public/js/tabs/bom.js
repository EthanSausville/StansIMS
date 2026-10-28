// Bill of Materials: one place for recipes and finished goods.
// Top: every finished good's standard cost, price and margin per case.
// Below: the selected product's fully expanded BOM, indented by level:
//   0  the finished good (one case)
//   1  what goes into a case: the recipe (oz per case), containers, lids, boxes
//   2  inside the recipe: each ingredient, labor and overhead, scaled to one case
// Recipe ingredients are entered per batch, as in the kitchen; the BOM converts
// them to per case. Changing a recipe changes every product made from it.
import { h, pageHead, numberCell, qty, money, pct, toast, niceError, yearSelect, typePill, fmt } from '../ui.js';
import { state, derived, isAdmin, insertRow, updateRow, deleteRow } from '../store.js';
import { evalEntry } from '../calc.js';

let year = new Date().getFullYear();
let selected = null;           // finished good item_no
const collapsed = new Set();   // recipe rows folded shut, by `${fg}|${recipe}`

const costFmt = (v) => (v ? '$' + fmt(v, Math.abs(v) < 1 ? 5 : 2, 2) : '');

export default {
  id: 'bom',
  label: 'Bill of Materials',
  render({ rerender }) {
    const ix = derived.ix(); const cm = derived.costs(); const pm = derived.prices(); const admin = isAdmin();
    if (!cm.years.includes(year)) year = cm.years[0];
    const fgs = ix.byType('Finished Good');
    if (!fgs.some((f) => f.item_no === selected)) selected = fgs[0]?.item_no ?? null;
    const minutes = Number(state.data.settings.minutes_per_batch) || 0;

    // ---------- summary of every product ----------
    const summary = h('div', { class: 'tablewrap' }, h('table', { class: 't bom-summary' },
      h('thead', null, h('tr', null, h('th', { class: 'sticky-col' }, 'Product'), h('th', null, 'Item #'), h('th', { class: 'num' }, 'Oz per case'),
        h('th', { class: 'num' }, `Std cost per case (${year})`), h('th', { class: 'num' }, `Std price (${year})`), h('th', { class: 'num' }, 'Margin'), h('th', { class: 'num' }, 'Margin %'))),
      h('tbody', null, fgs.map((fg) => {
        const cost = cm.cost(fg.item_no, year); const price = pm.price(fg.item_no, year);
        return h('tr', { class: 'pick' + (fg.item_no === selected ? ' picked' : ''), tabindex: 0, 'aria-selected': String(fg.item_no === selected),
            onclick: () => { selected = fg.item_no; rerender(); },
            onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selected = fg.item_no; rerender(); } } },
          h('td', { class: 'sticky-col' }, fg.name), h('td', { class: 'muted' }, fg.item_no), h('td', { class: 'num' }, qty(ix.fgCaseOz.get(fg.item_no) || 0)),
          h('td', { class: 'num' }, money(cost)), h('td', { class: 'num' }, price ? money(price) : '—'),
          h('td', { class: 'num' + (price && price - cost < 0 ? ' neg' : '') }, price ? money(price - cost) : ''),
          h('td', { class: 'num' }, price ? pct((price - cost) / price) : ''));
      }))));

    if (!selected) return h('div', null, pageHead('Bill of Materials', 'Add a finished good on the Standard Cost tab to build its bill of materials.'));

    // ---------- expanded BOM for the selected product ----------
    const fg = ix.items.get(selected);
    const caseCost = cm.cost(selected, year);
    const lines = state.data.fg_lines.filter((l) => l.fg_item_no === selected).sort((a, b) => a.sort - b.sort);
    const share = (v) => (caseCost ? pct(v / caseCost) : '');
    const removeBtn = (table, id, what) => admin ? h('button', { class: 'btn ghost danger', title: `Remove ${what}`, onclick: async () => {
      try { await deleteRow(table, 'id', id); } catch (e) { toast(niceError(e), 'bad'); } } }, 'Remove') : null;
    const level = (n) => h('td', { class: 'lvl' }, h('span', { class: `lvl-badge l${n}` }, n));
    const nameCell = (n, ...content) => h('td', { class: `sticky-col bom-name l${n}` }, ...content);

    const rows = [
      h('tr', { class: 'bom-l0' }, level(0), nameCell(0, fg.name), h('td', { class: 'muted' }, fg.item_no), h('td', null, typePill('Finished Good')),
        h('td'), h('td', { class: 'num' }, '1'), h('td', { class: 'muted' }, 'case'),
        h('td', { class: 'num calc' }, costFmt(caseCost)), h('td', { class: 'num calc' }, money(caseCost)), h('td', { class: 'num calc' }, caseCost ? '100%' : ''), admin ? h('td') : null),
    ];

    for (const l of lines) {
      const it = ix.items.get(l.item_no) || { name: `#${l.item_no}`, type: '' };
      const unitCost = cm.cost(l.item_no, year);
      const ext = unitCost * (Number(l.qty) || 0);
      const qtyCell = numberCell(l.qty ?? null, (v) => updateRow('fg_lines', 'id', l.id, { qty: v }),
        { disabled: !admin, key: `fl|${l.id}`, title: `${it.name} per case of ${fg.name}`, placeholder: admin ? '—' : '' });

      if (it.type !== 'Recipe') {
        rows.push(h('tr', { class: 'bom-l1' }, level(1), nameCell(1, it.name), h('td', { class: 'muted' }, l.item_no), h('td', null, typePill(it.type)),
          h('td'), qtyCell, h('td', { class: 'muted' }, it.unit || ''),
          h('td', { class: 'num calc' }, costFmt(unitCost)), h('td', { class: 'num calc' }, ext ? money(ext, 4) : ''), h('td', { class: 'num calc' }, ext ? share(ext) : ''),
          admin ? h('td', null, removeBtn('fg_lines', l.id, it.name)) : null));
        continue;
      }

      // Recipe line, with its ingredients beneath.
      const recipe = state.data.recipes.find((r) => r.item_no === l.item_no);
      const batch = Number(recipe?.batch_size) || 0;
      const perCase = batch ? (Number(l.qty) || 0) / batch : 0;   // batches per case
      const key = `${selected}|${l.item_no}`;
      const isOpen = !collapsed.has(key);
      const ingredients = state.data.recipe_lines.filter((r) => r.recipe_item_no === l.item_no).sort((a, b) => a.sort - b.sort);
      const usedBy = fgs.filter((f) => state.data.fg_lines.some((x) => x.fg_item_no === f.item_no && x.item_no === l.item_no));
      rows.push(h('tr', { class: 'bom-l1 bom-recipe' }, level(1),
        nameCell(1, h('button', { class: 'twisty', 'aria-expanded': String(isOpen), title: isOpen ? 'Hide ingredients' : 'Show ingredients',
          onclick: () => { isOpen ? collapsed.add(key) : collapsed.delete(key); rerender(); } }, isOpen ? '▾' : '▸'), ' ', it.name),
        h('td', { class: 'muted' }, l.item_no), h('td', null, typePill('Recipe')),
        recipe ? numberCell(recipe.batch_size, (v) => updateRow('recipes', 'item_no', recipe.item_no, { batch_size: v }),
          { disabled: !admin, key: `rb|${recipe.item_no}|${selected}`, title: `${it.name} batch size (oz)`, digits: 2 }) : h('td'),
        qtyCell, h('td', { class: 'muted' }, 'oz'),
        h('td', { class: 'num calc' }, costFmt(unitCost)), h('td', { class: 'num calc' }, money(ext, 4)), h('td', { class: 'num calc' }, share(ext)),
        admin ? h('td', null, removeBtn('fg_lines', l.id, it.name)) : null));

      if (!isOpen) continue;
      for (const r of ingredients) {
        const ing = ix.items.get(r.item_no) || { name: `#${r.item_no}`, type: '' };
        const perBatch = r.uses_batch_minutes ? minutes : Number(r.qty) || 0;
        const q = perBatch * perCase;
        const c = cm.cost(r.item_no, year);
        rows.push(h('tr', { class: 'bom-l2' }, level(2), nameCell(2, ing.name), h('td', { class: 'muted' }, r.item_no), h('td', null, typePill(ing.type)),
          r.uses_batch_minutes
            ? h('td', { class: 'num calc', title: 'Minutes per batch, set on the Labor tab' }, qty(perBatch, 4))
            : numberCell(r.qty ?? null, (v) => updateRow('recipe_lines', 'id', r.id, { qty: v }),
              { disabled: !admin, key: `rl|${r.id}|${selected}`, title: `${ing.name} per batch of ${it.name}` }),
          h('td', { class: 'num calc' }, qty(q, 4)), h('td', { class: 'muted' }, ing.unit || ''),
          h('td', { class: 'num calc' }, costFmt(c)), h('td', { class: 'num calc' }, money(q * c, 4)), h('td', { class: 'num calc' }, share(q * c)),
          admin ? h('td', null, removeBtn('recipe_lines', r.id, ing.name)) : null));
      }
      if (admin) {
        const pick = h('select', { 'aria-label': `Ingredient to add to ${it.name}` }, h('option', { value: '' }, `Add to ${it.name} recipe…`),
          state.data.items.filter((i) => i.type === 'Raw Material' || i.type === 'Indirect Cost').map((i) => h('option', { value: i.item_no }, i.name)));
        const amount = h('input', { type: 'text', inputmode: 'decimal', placeholder: 'Qty per batch', 'aria-label': 'Quantity per batch' });
        rows.push(h('tr', { class: 'bom-add' }, h('td'), h('td', { class: 'sticky-col bom-name l2', colspan: 10 },
          h('form', { class: 'bom-addform', onsubmit: async (e) => {
              e.preventDefault(); const itemNo = Number(pick.value); if (!itemNo) return;
              const usesMinutes = ix.items.get(itemNo)?.type === 'Indirect Cost';
              try {
                const v = usesMinutes ? null : evalEntry(amount.value);
                if (!usesMinutes && v === null) throw new Error('Enter the quantity per batch.');
                await insertRow('recipe_lines', { recipe_item_no: l.item_no, item_no: itemNo, qty: v, uses_batch_minutes: usesMinutes, sort: Math.max(0, ...ingredients.map((x) => x.sort)) + 1 });
              } catch (err) { toast(niceError(err), 'bad'); }
            } }, pick, amount, h('button', { class: 'btn', type: 'submit' }, 'Add'),
            usedBy.length > 1 ? h('span', { class: 'small muted' }, `Recipe changes apply to ${usedBy.length} products: ${usedBy.map((f) => f.name).join(', ')}.`) : null))));
      }
    }

    const total = lines.reduce((s, l) => s + cm.cost(l.item_no, year) * (Number(l.qty) || 0), 0);
    const addLine = admin ? (() => {
      const pick = h('select', { 'aria-label': 'Part to add' }, h('option', { value: '' }, `Add to ${fg.name}…`),
        state.data.items.filter((i) => ['Recipe', 'Component', 'Indirect Cost'].includes(i.type)).map((i) => h('option', { value: i.item_no }, `${i.name} (${i.type === 'Component' ? 'packaging' : i.type.toLowerCase()})`)));
      const amount = h('input', { type: 'text', inputmode: 'decimal', placeholder: 'Qty per case', 'aria-label': 'Quantity per case' });
      return h('form', { class: 'inline-form', onsubmit: async (e) => {
          e.preventDefault(); const itemNo = Number(pick.value); if (!itemNo) return;
          try { await insertRow('fg_lines', { fg_item_no: selected, item_no: itemNo, qty: evalEntry(amount.value), sort: Math.max(0, ...lines.map((x) => x.sort)) + 1 }); }
          catch (err) { toast(niceError(err), 'bad'); }
        } }, pick, amount, h('button', { class: 'btn', type: 'submit' }, 'Add'), h('span', { class: 'small muted' }, 'For a recipe, the quantity is oz per case.'));
    })() : null;

    return h('div', null,
      pageHead('Bill of Materials', 'Standard cost of every product, and the fully expanded bill of materials for the one you pick. Recipe ingredients are entered per batch and converted to one case.' + (admin ? '' : ' Only admins can change these.'),
        admin ? h('span', { class: 'legend-entry' }, h('i'), 'Type in the yellow cells') : null,
        yearSelect(cm.years, year, (y) => { year = y; rerender(); }, 'Cost year')),
      h('div', { class: 'panel' }, h('h2', null, 'Products'), summary),
      h('div', { class: 'panel', style: { marginTop: '16px' } },
        h('h2', null, h('span', { class: 'grow' }, `Expanded BOM: ${fg.name}`), h('span', { class: 'muted small' }, `${money(caseCost)} per case · ${year}`)),
        h('div', { class: 'tablewrap', 'data-scroll': 'bom', style: { border: 0, borderRadius: 0, boxShadow: 'none' } }, h('table', { class: 't bom' },
          h('thead', null, h('tr', null, h('th', null, 'Level'), h('th', { class: 'sticky-col' }, 'Item'), h('th', null, 'Item #'), h('th', null, 'Type'),
            h('th', { class: 'num', title: 'Recipe ingredients per batch; on a recipe row, the batch size in oz' }, 'Qty per batch'),
            h('th', { class: 'num' }, 'Qty per case'), h('th', null, 'Unit'), h('th', { class: 'num' }, 'Unit cost'),
            h('th', { class: 'num' }, 'Cost per case'), h('th', { class: 'num' }, 'Share'), admin ? h('th') : null)),
          h('tbody', null, rows),
          h('tfoot', null, h('tr', null, h('td'), h('td', { class: 'sticky-col' }, 'Total per case'), h('td'), h('td'), h('td'), h('td'), h('td'), h('td'),
            h('td', { class: 'num' }, money(total, 4)), h('td', { class: 'num' }, caseCost ? '100%' : ''), admin ? h('td') : null)))),
        addLine));
  },
};
