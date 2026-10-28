import { h, pageHead, numberCell, qty, money, toast, niceError, yearSelect, typePill } from '../ui.js';
import { state, derived, isAdmin, insertRow, updateRow, deleteRow } from '../store.js';
import { evalEntry } from '../calc.js';

let year = new Date().getFullYear();
const perOz = (v) => (v ? '$' + qty(v, 6) : '');

export default {
  id: 'recipes',
  label: 'Recipes',
  render({ rerender }) {
    const ix = derived.ix(); const cm = derived.costs(); const admin = isAdmin();
    if (!cm.years.includes(year)) year = cm.years[0];
    const minutes = state.data.settings.minutes_per_batch;
    const choices = state.data.items.filter((i) => i.type === 'Raw Material' || i.type === 'Indirect Cost');
    return h('div', null,
      pageHead('Recipes', 'Ingredients per batch. Cost per oz = ingredient cost × quantity ÷ batch size. Direct labor and overhead use the minutes per batch from the Labor tab.' + (admin ? '' : ' Only admins can change these.'),
        yearSelect(cm.years, year, (y) => { year = y; rerender(); }, 'Cost year')),
      state.data.recipes.length ? null : h('div', { class: 'empty panel' }, 'No recipes yet. Add an item of type “Recipe” on the Standard Cost tab.'),
      state.data.recipes.map((r) => {
        const lines = state.data.recipe_lines.filter((l) => l.recipe_item_no === r.item_no).sort((a, b) => a.sort - b.sort);
        const total = cm.cost(r.item_no, year);
        const pick = h('select', null, h('option', { value: '' }, 'Add ingredient…'), choices.map((i) => h('option', { value: i.item_no }, i.name)));
        const amount = h('input', { type: 'text', inputmode: 'decimal', placeholder: 'Qty per batch', style: { width: '120px' } });
        return h('div', { class: 'panel section' },
          h('h2', null, h('span', { class: 'grow' }, r.name), h('span', { class: 'muted small' }, `Batch size (oz)`),
            h('table', { class: 't', style: { width: 'auto', minWidth: 0 } }, h('tr', null, numberCell(r.batch_size, (v) => updateRow('recipes', 'item_no', r.item_no, { batch_size: v }), { disabled: !admin, key: `rb|${r.item_no}`, title: `${r.name} batch size` }))),
            h('span', null, `${perOz(total)} per oz (${year})`)),
          h('div', { class: 'tablewrap', style: { border: 0, boxShadow: 'none', borderRadius: 0 } }, h('table', { class: 't' },
            h('thead', null, h('tr', null, h('th', { class: 'sticky-col' }, 'Ingredient'), h('th', null, 'Type'), h('th', { class: 'num' }, 'Qty per batch'), h('th', null, 'Unit'),
              h('th', { class: 'num' }, 'Used per oz'), h('th', { class: 'num' }, `${year} cost per oz`), h('th', { class: 'num' }, 'Share'), admin ? h('th') : null)),
            h('tbody', null, lines.map((l) => {
              const it = ix.items.get(l.item_no) || { name: `#${l.item_no}` };
              const q = l.uses_batch_minutes ? minutes : l.qty;
              const c = r.batch_size ? (cm.cost(l.item_no, year) * (q || 0)) / r.batch_size : 0;
              return h('tr', null, h('td', { class: 'sticky-col' }, it.name), h('td', null, typePill(it.type)),
                l.uses_batch_minutes ? h('td', { class: 'num calc', title: 'Minutes per batch, from the Labor tab' }, qty(q, 4))
                  : numberCell(l.qty, (v) => updateRow('recipe_lines', 'id', l.id, { qty: v }), { disabled: !admin, key: `rl|${l.id}`, title: `${it.name} per batch` }),
                h('td', { class: 'muted' }, it.unit || ''),
                h('td', { class: 'num calc' }, !l.uses_batch_minutes && r.batch_size ? qty((l.qty || 0) / r.batch_size, 6) : ''),
                h('td', { class: 'num calc' }, perOz(c)), h('td', { class: 'num calc' }, total ? qty((c / total) * 100, 1) + '%' : ''),
                admin ? h('td', null, h('button', { class: 'btn ghost danger', onclick: async () => { try { await deleteRow('recipe_lines', 'id', l.id); } catch (e) { toast(niceError(e), 'bad'); } } }, 'Remove')) : null);
            })),
            h('tfoot', null, h('tr', null, h('td', { class: 'sticky-col' }, 'Total'), h('td'), h('td'), h('td'), h('td'), h('td', { class: 'num' }, perOz(total)), h('td'), admin ? h('td') : null)))),
          admin ? h('form', { class: 'inline-form', style: { borderBottom: 0, borderTop: '1px solid var(--line)' }, onsubmit: async (e) => {
              e.preventDefault();
              const itemNo = Number(pick.value); if (!itemNo) return;
              const usesMinutes = ix.items.get(itemNo)?.type === 'Indirect Cost';
              try {
                const v = usesMinutes ? null : evalEntry(amount.value);
                if (!usesMinutes && v === null) throw new Error('Enter the quantity per batch.');
                await insertRow('recipe_lines', { recipe_item_no: r.item_no, item_no: itemNo, qty: v, uses_batch_minutes: usesMinutes, sort: Math.max(0, ...lines.map((x) => x.sort)) + 1 });
              } catch (err) { toast(niceError(err), 'bad'); }
            } }, pick, amount, h('button', { class: 'btn', type: 'submit' }, 'Add'),
            h('span', { class: 'small muted' }, 'Labor and overhead use minutes per batch automatically.')) : null);
      }),
      h('p', { class: 'small muted' }, `Latest costs: ${state.data.recipes.map((r) => `${r.name} ${money(cm.latest(r.item_no), 4)}/oz`).join(' · ')}`));
  },
};
