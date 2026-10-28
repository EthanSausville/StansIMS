import { h, pageHead, numberCell, qty, money, toast, niceError, yearSelect, typePill } from '../ui.js';
import { state, derived, isAdmin, insertRow, updateRow, deleteRow } from '../store.js';
import { evalEntry } from '../calc.js';

let year = new Date().getFullYear();

export default {
  id: 'finished',
  label: 'Finished Goods',
  render({ rerender }) {
    const ix = derived.ix(); const cm = derived.costs(); const admin = isAdmin();
    if (!cm.years.includes(year)) year = cm.years[0];
    const fgs = ix.byType('Finished Good');
    const choices = state.data.items.filter((i) => ['Recipe', 'Component', 'Indirect Cost'].includes(i.type));
    return h('div', null,
      pageHead('Finished Goods', 'What goes into one case: oz of recipe, containers, lids and the case box. The total is the standard cost per case.' + (admin ? '' : ' Only admins can change these.'),
        yearSelect(cm.years, year, (y) => { year = y; rerender(); }, 'Cost year')),
      h('div', { class: 'grid2' }, fgs.map((fg) => {
        const lines = state.data.fg_lines.filter((l) => l.fg_item_no === fg.item_no).sort((a, b) => a.sort - b.sort);
        const total = cm.cost(fg.item_no, year);
        const pick = h('select', null, h('option', { value: '' }, 'Add…'), choices.map((i) => h('option', { value: i.item_no }, i.name)));
        const amount = h('input', { type: 'text', inputmode: 'decimal', placeholder: 'Qty', style: { width: '90px' } });
        return h('div', { class: 'panel' },
          h('h2', null, h('span', { class: 'grow' }, fg.name), h('span', null, money(total, 2)), h('span', { class: 'muted small' }, `per case (${year})`)),
          h('table', { class: 't' },
            h('thead', null, h('tr', null, h('th', null, 'Part'), h('th', null, 'Type'), h('th', { class: 'num' }, 'Qty'), h('th', { class: 'num' }, 'Cost'), admin ? h('th') : null)),
            h('tbody', null, lines.map((l) => {
              const it = ix.items.get(l.item_no) || { name: `#${l.item_no}` };
              return h('tr', null, h('td', null, it.name), h('td', null, typePill(it.type)),
                numberCell(l.qty, (v) => updateRow('fg_lines', 'id', l.id, { qty: v }), { disabled: !admin, key: `fl|${l.id}`, title: `${it.name} per case`, placeholder: '—' }),
                h('td', { class: 'num calc' }, money(cm.cost(l.item_no, year) * (l.qty || 0), 4)),
                admin ? h('td', null, h('button', { class: 'btn ghost danger', onclick: async () => { try { await deleteRow('fg_lines', 'id', l.id); } catch (e) { toast(niceError(e), 'bad'); } } }, 'Remove')) : null);
            }))),
          admin ? h('form', { class: 'inline-form', style: { borderBottom: 0, borderTop: '1px solid var(--line)' }, onsubmit: async (e) => {
              e.preventDefault(); const itemNo = Number(pick.value); if (!itemNo) return;
              try { await insertRow('fg_lines', { fg_item_no: fg.item_no, item_no: itemNo, qty: evalEntry(amount.value), sort: Math.max(0, ...lines.map((x) => x.sort)) + 1 }); }
              catch (err) { toast(niceError(err), 'bad'); }
            } }, pick, amount, h('button', { class: 'btn', type: 'submit' }, 'Add')) : null);
      })),
      h('p', { class: 'small muted' }, `The recipe line's quantity is oz per case (it also sets oz per case on Production and Sales). ${qty(state.data.settings.minutes_per_batch)} minutes of labor and overhead are already inside the recipe cost, so those lines are left blank here, as in the workbook.`));
  },
};
