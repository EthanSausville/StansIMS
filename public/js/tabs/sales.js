import { h, pageHead, money, qty, toast, niceError, confirmDialog, todayIso } from '../ui.js';
import { state, derived, insertRow, updateRow, deleteRow } from '../store.js';
import { MONTHS, yearOf, evalEntry } from '../calc.js';
import { loadButton, pendingPreview, historyTable, importCount } from './qbpanel.js';
import { xtable, filteredRows, prefTotals, setPrefTotals, activeFilterCount, clearFilters, setFilter, showValue } from '../xtable.js';

let open = null; // 'add' or 'history': what's open under the bar

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

const TID = 'sales-detail';
const mdy = (d) => `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(0, 4)}`;
const sum = (rows, k) => rows.reduce((s, r) => s + (Number(r[k]) || 0), 0);
const blankOr = (v, f) => (v === null || v === undefined ? '' : f(v));
// The workbook's SalesReport columns, in order. value = what sorts, text = what
// the filter list shows, total = the totals row (filtered rows only).
const COLUMNS = [
  { key: 'date', label: 'Date', sticky: true, value: (r) => r.date, text: (r) => mdy(r.date),
    cell: (r) => h('td', { class: 'sticky-col', title: r.import_id ? `Loaded from QuickBooks: ${r.qb_product || ''}${r.description ? ' · ' + r.description : ''}` : 'Entered by hand' }, mdy(r.date)) },
  { key: 'invoice', label: 'Inv Num', value: (r) => r.invoice || '', cell: (r) => h('td', null, r.invoice || '') },
  { key: 'quantity', label: 'Quantity', num: true, value: (r) => r.quantity, text: (r) => blankOr(r.quantity, qty),
    cell: (r) => h('td', { class: 'num' }, blankOr(r.quantity, qty)), total: (rows) => qty(sum(rows, 'quantity')) },
  { key: 'price', label: 'Sales price', num: true, value: (r) => r.price, text: (r) => blankOr(r.price, money),
    cell: (r) => h('td', { class: 'num' }, blankOr(r.price, money)) },
  { key: 'amount', label: 'Amount', num: true, value: (r) => Number(r.amount), text: (r) => money(r.amount),
    cell: (r) => h('td', { class: 'num' + (r.amount < 0 ? ' neg' : '') }, money(r.amount)), total: (rows) => money(sum(rows, 'amount')) },
  { key: 'customer', label: 'Customer', value: (r) => r.customer || '', cell: (r) => h('td', null, r.customer || '') },
  { key: 'product', label: 'Product', value: (r) => r.product || '', cell: (r) => h('td', null, r.product || '') },
  { key: 'month', label: 'Month', value: (r) => r.month, text: (r) => MONTHS[r.month - 1], cell: (r) => h('td', { class: 'calc' }, MONTHS[r.month - 1]) },
  { key: 'year', label: 'Year', num: true, value: (r) => r.year, cell: (r) => h('td', { class: 'num calc' }, r.year) },
  { key: 'oz', label: 'oz', num: true, value: (r) => r.oz || 0, text: (r) => (r.oz ? qty(r.oz, 0) : ''),
    cell: (r) => h('td', { class: 'num calc' }, r.oz ? qty(r.oz, 0) : ''), total: (rows) => qty(sum(rows, 'oz'), 0) },
  { key: 'stdPrice', label: 'Std Price', num: true, value: (r) => r.stdPrice || 0, text: (r) => (r.stdPrice ? money(r.stdPrice) : ''),
    cell: (r) => h('td', { class: 'num calc' }, r.stdPrice ? money(r.stdPrice) : ''), total: (rows) => money(sum(rows, 'stdPrice')) },
  { key: 'stdCost', label: 'Std Cost', num: true, value: (r) => r.stdCost || 0, text: (r) => (r.stdCost ? money(r.stdCost) : ''),
    cell: (r) => h('td', { class: 'num calc' }, r.stdCost ? money(r.stdCost) : ''), total: (rows) => money(sum(rows, 'stdCost')) },
  { key: 'stdMargin', label: 'Std Margin', num: true, value: (r) => (r.stdPrice || r.stdCost ? r.stdMargin : null), text: (r) => (r.stdPrice || r.stdCost ? money(r.stdMargin) : ''),
    cell: (r) => h('td', { class: 'num calc' }, r.stdPrice || r.stdCost ? money(r.stdMargin) : ''), total: (rows) => money(sum(rows, 'stdMargin')) },
];
const DEFAULT_SORT = { key: 'date', dir: 'desc' };
let startedYear = false;

const actions = (r) => h('td', { class: 'row-actions' },
  h('button', { class: 'btn icon-btn', title: 'Edit line', 'aria-label': `Edit ${r.product} line for ${r.customer || 'no customer'}`, onclick: () => editDialog(r) }, '✎'),
  h('button', { class: 'btn icon-btn danger', title: 'Delete line', 'aria-label': `Delete ${r.product} line for ${r.customer || 'no customer'}`, onclick: async () => {
    if (await confirmDialog(`Delete this ${r.product} line for ${r.customer || 'no customer'} (${money(r.amount)})?`)) {
      try { await deleteRow('sales', 'id', r.id); toast('Line deleted.'); } catch (err) { toast(niceError(err), 'bad'); }
    } } }, '×'));

export default {
  id: 'sales',
  label: 'Sales Detail',
  render({ rerender }) {
    const rowsAll = derived.sales();
    // Open on the latest year, the way the page always has; the Year filter clears it.
    if (!startedYear && rowsAll.length) {
      startedYear = true;
      setFilter(TID, 'year', [String(Math.max(...rowsAll.map((r) => r.year)))]);
    }
    const rows = filteredRows({ id: TID, columns: COLUMNS, rows: rowsAll, defaultSort: DEFAULT_SORT });
    const showTotals = prefTotals(TID);
    const nFilters = activeFilterCount(TID);

    const add = saleFields();
    const addBtn = h('button', { class: 'btn primary', type: 'submit' }, 'Add sale');
    const addForm = h('form', { class: 'inline-form', onsubmit: async (e) => {
        e.preventDefault();
        try { addBtn.disabled = true; const row = add.read(); await insertRow('sales', row); toast('Sale added.'); showValue(TID, 'year', String(yearOf(row.date))); }
        catch (err) { toast(niceError(err), 'bad'); } finally { addBtn.disabled = false; }
      } },
      h('label', { class: 'field' }, 'Date', add.f.date), h('label', { class: 'field' }, 'Invoice #', add.f.invoice),
      h('label', { class: 'field wide' }, 'Product', add.f.product), h('label', { class: 'field wide' }, 'Customer', add.f.customer, add.datalist),
      h('label', { class: 'field' }, 'Quantity', add.f.quantity), h('label', { class: 'field' }, 'Price', add.f.price),
      h('label', { class: 'field' }, 'Amount', add.f.amount), addBtn);

    const flip = (which) => () => { open = open === which ? null : which; rerender(); };
    const preview = pendingPreview(rerender);
    const body = preview || (open === 'add' ? addForm : open === 'history' ? historyTable() : null);
    // Side bar: load a QuickBooks report, add a line by hand, see past loads.
    return h('div', null,
      pageHead('Sales Detail', 'Every invoice line, as on the workbook’s SalesReport sheet. Use the ▾ button on any column heading to filter or sort, like an Excel table; the totals at the bottom of the screen add up the lines showing. Load a QuickBooks Sales by Product/Service Detail export to add new lines (lines already here are skipped), or add one by hand.',
        loadButton(rerender),
        h('button', { class: 'btn' + (open === 'add' && !preview ? ' on' : ''), 'aria-expanded': String(open === 'add'), onclick: flip('add') }, '+ Add a line by hand'),
        importCount() ? h('button', { class: 'btn ghost' + (open === 'history' && !preview ? ' on' : ''), 'aria-expanded': String(open === 'history'), onclick: flip('history') }, `Loaded reports (${importCount()})`) : null,
        nFilters ? h('button', { class: 'btn ghost', onclick: () => { clearFilters(TID); rerender(); } }, `Clear filters (${nFilters})`) : null),
      body ? h('section', { class: 'panel sales-body' }, body) : null,
      h('div', { class: 'tablewrap tall', 'data-scroll': 'sales' },
        xtable({ id: TID, columns: COLUMNS, allRows: rowsAll, rows, rerender, defaultSort: DEFAULT_SORT, showTotals, onToggleTotals: (on) => { setPrefTotals(TID, on); rerender(); }, className: 'sales-report',
          rowClass: (r) => (r.import_id ? 'from-qb' : null), extraCells: actions })));
  },
};
