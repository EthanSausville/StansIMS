import { h, pageHead, money, qty, pct, toast, niceError, confirmDialog, todayIso, dateLabel, yearSelect } from '../ui.js';
import { state, derived, insertRow, updateRow, deleteRow } from '../store.js';
import { MONTHS, yearOf, evalEntry } from '../calc.js';

const filt = { year: new Date().getFullYear(), month: 0, customer: '', product: '', q: '' };

// The fields of one sale. Product picks a finished good (or "Other" for fees,
// credits and promotions); price fills in from the standard price.
function saleFields(initial = {}) {
  const ix = derived.ix(); const pm = derived.prices();
  const fgs = ix.byType('Finished Good');
  const customers = [...new Set(state.data.sales.map((s) => s.customer).filter(Boolean))].sort();
  const listId = 'customers-' + Math.random().toString(36).slice(2);
  const f = {
    date: h('input', { type: 'date', required: true, value: initial.date || todayIso() }),
    invoice: h('input', { type: 'text', value: initial.invoice || '', placeholder: 'e.g. 14664' }),
    product: h('select', { required: true }, h('option', { value: '' }, 'Choose…'),
      fgs.map((fg) => h('option', { value: fg.name, selected: initial.product === fg.name }, fg.name)),
      h('option', { value: 'Other', selected: initial.product === 'Other' }, 'Other (fees, credits, promos)')),
    customer: h('input', { type: 'text', list: listId, value: initial.customer || '', placeholder: 'Customer' }),
    quantity: h('input', { type: 'text', inputmode: 'decimal', value: initial.quantity ?? '', placeholder: 'Cases' }),
    price: h('input', { type: 'text', inputmode: 'decimal', value: initial.price ?? '', placeholder: 'Per case' }),
    amount: h('input', { type: 'text', inputmode: 'decimal', value: initial.amount ?? '', placeholder: 'Qty × price' }),
  };
  const datalist = h('datalist', { id: listId }, customers.map((c) => h('option', { value: c })));
  let amountTouched = initial.amount !== undefined && initial.amount !== null;
  const num = (el) => { try { return evalEntry(el.value); } catch { return null; } };
  const recalc = () => { if (!amountTouched) { const q = num(f.quantity), p = num(f.price); f.amount.value = q !== null && p !== null ? +(q * p).toFixed(2) : (p !== null && q === null ? p : ''); } };
  const fillPrice = () => {
    const fg = fgs.find((x) => x.name === f.product.value);
    if (fg && f.date.value) { const p = pm.nearest(fg.item_no, yearOf(f.date.value)); if (p) f.price.value = p; }
    recalc();
  };
  f.product.addEventListener('change', fillPrice);
  f.quantity.addEventListener('input', recalc); f.price.addEventListener('input', recalc);
  f.amount.addEventListener('input', () => { amountTouched = f.amount.value.trim() !== ''; });
  const read = () => {
    const product = f.product.value; const fg = fgs.find((x) => x.name === product);
    const row = { date: f.date.value, invoice: f.invoice.value.trim() || null, product, item_no: fg ? fg.item_no : null,
      customer: f.customer.value.trim() || null, quantity: evalEntry(f.quantity.value), price: evalEntry(f.price.value), amount: evalEntry(f.amount.value) };
    if (!row.date || !product) throw new Error('Date and product are required.');
    if (row.amount === null && row.quantity !== null && row.price !== null) row.amount = +(row.quantity * row.price).toFixed(2);
    if (row.amount === null) throw new Error('Enter an amount (or quantity and price).');
    return row;
  };
  return { f, datalist, read };
}

function editDialog(sale) {
  const { f, datalist, read } = saleFields(sale);
  const dlg = h('dialog', null, h('form', { method: 'dialog', onsubmit: async (e) => {
      if (e.submitter?.value !== 'save') return;
      e.preventDefault();
      try { await updateRow('sales', 'id', sale.id, read()); dlg.close(); toast('Sale updated.'); } catch (err) { toast(niceError(err), 'bad'); }
    } },
    h('h3', null, 'Edit sale'),
    h('div', { class: 'row' }, h('label', { class: 'field' }, 'Date', f.date), h('label', { class: 'field' }, 'Invoice #', f.invoice)),
    h('label', { class: 'field' }, 'Product', f.product), h('label', { class: 'field' }, 'Customer', f.customer, datalist),
    h('div', { class: 'row' }, h('label', { class: 'field' }, 'Quantity', f.quantity), h('label', { class: 'field' }, 'Price', f.price)),
    h('label', { class: 'field' }, 'Amount', f.amount),
    h('div', { class: 'actions' }, h('button', { class: 'btn', value: 'cancel', formnovalidate: true }, 'Cancel'), h('button', { class: 'btn primary', value: 'save' }, 'Save'))));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg); dlg.showModal();
}

export default {
  id: 'sales',
  label: 'Sales',
  render({ rerender }) {
    const rowsAll = derived.sales();
    const years = [...new Set([...derived.years(), ...rowsAll.map((r) => r.year)])].sort((a, b) => a - b);
    const customers = [...new Set(rowsAll.map((r) => r.customer).filter(Boolean))].sort();
    const products = [...new Set(rowsAll.map((r) => r.product).filter(Boolean))].sort();
    const q = filt.q.toLowerCase();
    const rows = rowsAll.filter((r) => r.year === filt.year && (!filt.month || r.month === filt.month)
      && (!filt.customer || r.customer === filt.customer) && (!filt.product || r.product === filt.product)
      && (!q || `${r.invoice} ${r.customer} ${r.product}`.toLowerCase().includes(q)))
      .sort((a, b) => (a.date === b.date ? b.id - a.id : a.date < b.date ? 1 : -1));
    const sum = (k) => rows.reduce((s, r) => s + (Number(r[k]) || 0), 0);

    const add = saleFields();
    const addBtn = h('button', { class: 'btn primary', type: 'submit' }, 'Add sale');
    const addForm = h('form', { class: 'inline-form', onsubmit: async (e) => {
        e.preventDefault();
        try { addBtn.disabled = true; const row = add.read(); await insertRow('sales', row); toast('Sale added.'); filt.year = yearOf(row.date); }
        catch (err) { toast(niceError(err), 'bad'); } finally { addBtn.disabled = false; }
      } },
      h('label', { class: 'field' }, 'Date', add.f.date), h('label', { class: 'field' }, 'Invoice #', add.f.invoice),
      h('label', { class: 'field wide' }, 'Product', add.f.product), h('label', { class: 'field wide' }, 'Customer', add.f.customer, add.datalist),
      h('label', { class: 'field' }, 'Quantity', add.f.quantity), h('label', { class: 'field' }, 'Price', add.f.price),
      h('label', { class: 'field' }, 'Amount', add.f.amount), addBtn);

    const select = (label, value, options, onChange) => h('label', { class: 'field' }, label,
      h('select', { onchange: (e) => onChange(e.target.value) }, options.map(([v, l]) => h('option', { value: v, selected: String(v) === String(value) }, l))));

    return h('div', null,
      pageHead('Sales', 'Invoices by line. Standard price, cost and margin come from the Standard Price and Standard Cost tabs for the sale’s year.',
        yearSelect(years, filt.year, (y) => { filt.year = y; rerender(); }),
        select('Month', filt.month, [[0, 'All'], ...MONTHS.map((m, i) => [i + 1, m])], (v) => { filt.month = Number(v); rerender(); }),
        select('Customer', filt.customer, [['', 'All'], ...customers.map((c) => [c, c])], (v) => { filt.customer = v; rerender(); }),
        select('Product', filt.product, [['', 'All'], ...products.map((c) => [c, c])], (v) => { filt.product = v; rerender(); }),
        h('label', { class: 'field' }, 'Search', h('input', { type: 'text', value: filt.q, 'data-k': 'sales-search', placeholder: 'Invoice, customer…', oninput: (e) => { filt.q = e.target.value; rerender(); } }))),
      h('div', { class: 'panel' }, h('h2', null, 'Add a sale'), addForm),
      h('div', { class: 'tablewrap tall', 'data-scroll': 'sales', style: { marginTop: '16px' } }, h('table', { class: 't' },
        h('thead', null, h('tr', null, ['Date', 'Inv #', 'Customer', 'Product'].map((x, i) => h('th', { class: i === 0 ? 'sticky-col' : null }, x)),
          ['Qty', 'Price', 'Amount', 'Oz', 'Std price', 'Std cost', 'Std margin', 'Margin %'].map((x) => h('th', { class: 'num' }, x)), h('th'))),
        h('tbody', null, rows.length ? rows.map((r) => h('tr', null,
          h('td', { class: 'sticky-col' }, dateLabel(r.date)), h('td', null, r.invoice || ''), h('td', null, r.customer || ''), h('td', null, r.product || ''),
          h('td', { class: 'num' }, qty(r.quantity)), h('td', { class: 'num' }, money(r.price)), h('td', { class: 'num' + (r.amount < 0 ? ' neg' : '') }, money(r.amount)),
          h('td', { class: 'num calc' }, r.oz ? qty(r.oz, 0) : ''), h('td', { class: 'num calc' }, r.stdPrice ? money(r.stdPrice) : ''),
          h('td', { class: 'num calc' }, r.stdCost ? money(r.stdCost) : ''), h('td', { class: 'num calc' }, r.stdPrice ? money(r.stdMargin) : ''),
          h('td', { class: 'num calc' }, r.stdPrice ? pct(r.stdMargin / r.stdPrice) : ''),
          h('td', null, h('button', { class: 'btn ghost', onclick: () => editDialog(r) }, 'Edit'),
            h('button', { class: 'btn ghost danger', onclick: async () => {
              if (await confirmDialog(`Delete this ${r.product} line for ${r.customer || 'no customer'} (${money(r.amount)})?`)) {
                try { await deleteRow('sales', 'id', r.id); toast('Sale deleted.'); } catch (err) { toast(niceError(err), 'bad'); }
              } } }, 'Delete'))))
          : h('tr', null, h('td', { colspan: 13, class: 'empty' }, 'No sales match these filters.'))),
        h('tfoot', null, h('tr', null, h('td', { class: 'sticky-col' }, `${rows.length} lines`), h('td'), h('td'), h('td'),
          h('td', { class: 'num' }, qty(sum('quantity'))), h('td'), h('td', { class: 'num' }, money(sum('amount'))), h('td', { class: 'num' }, qty(sum('oz'), 0)),
          h('td', { class: 'num' }, money(sum('stdPrice'))), h('td', { class: 'num' }, money(sum('stdCost'))), h('td', { class: 'num' }, money(sum('stdMargin'))),
          h('td', { class: 'num' }, sum('stdPrice') ? pct(sum('stdMargin') / sum('stdPrice')) : ''), h('td'))))));
  },
};
