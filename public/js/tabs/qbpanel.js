// "Load a QuickBooks report" panel and import history for Sales Detail.
// A QuickBooks Sales by Product/Service Detail export is read in the browser,
// each line converted to a Sales Detail row (your customer and product names;
// fees and credits become "Other"; $0 lines are dropped), and only rows not
// already in Sales Detail are added.
import { h, money, qty, toast, niceError, confirmDialog, longDate } from '../ui.js';
import { state, derived, importSales, undoSalesImport } from '../store.js';
import { readSpreadsheet } from '../xlsx.js';
import { parseQuickBooksSales, convertLines, newSales, guessProduct, guessCustomer } from '../qbimport.js';
import { yearOf } from '../calc.js';

let pending = null;   // { fileName, report, lines, from, to, chosen: {customer: Map, product: Map} }
let busy = false;

function savedMaps() {
  const customer = new Map(); const product = new Map();
  for (const m of state.data.qb_name_map) (m.kind === 'customer' ? customer : product).set(m.qb_name, m.name);
  return { customer, product };
}

// Names in the report that aren't on the saved list, with a suggestion each.
function unknownNames(lines) {
  const saved = savedMaps(); const fgs = derived.ix().byType('Finished Good');
  const out = { customer: new Map(), product: new Map() };
  for (const l of lines) {
    if (!Number(l.amount)) continue;
    if (l.customer && !saved.customer.has(l.customer) && !out.customer.has(l.customer)) {
      const guess = guessCustomer(l.customer);
      const known = [...new Set(state.data.sales.map((s) => s.customer).filter(Boolean))].find((c) => c.toLowerCase() === guess.toLowerCase());
      out.customer.set(l.customer, known || guess);
    }
    if (!saved.product.has(l.product_service) && !out.product.has(l.product_service)) out.product.set(l.product_service, guessProduct(l.product_service, fgs));
  }
  return out;
}

function convert(p) {
  const saved = savedMaps();
  const maps = { customer: new Map([...saved.customer, ...p.chosen.customer]), product: new Map([...saved.product, ...p.chosen.product]) };
  const ix = derived.ix(); const pm = derived.prices();
  const stdPrice = (name, date) => { const fg = ix.byType('Finished Good').find((f) => f.name === name); return fg ? pm.nearest(fg.item_no, yearOf(date)) : 0; };
  const { rows, zero } = convertLines(p.lines, maps, stdPrice);
  // Duplicates are left out unless kept (an invoice can really list the same item twice).
  const all = newSales(rows, state.data.sales).duplicates;
  const { add, skipped } = newSales(rows, state.data.sales, p.keepDup);
  const duplicates = all.map((d) => ({ ...d, kept: p.keepDup.has(d.index) }));
  return { rows, zero, add, skipped, duplicates };
}

async function loadFile(file, rerender) {
  if (!file) return;
  busy = true; pending = null; rerender();
  try {
    const parsed = parseQuickBooksSales(await readSpreadsheet(file));
    if (!parsed.lines.length) throw new Error('No transaction lines were found in this report.');
    pending = { fileName: file.name, ...parsed, chosen: unknownNames(parsed.lines), keepDup: new Set() };
  } catch (err) {
    toast(err.message || 'Couldn’t read that file.', 'bad');
  } finally { busy = false; rerender(); }
}

const stat = (label, value, sub) => h('div', { class: 'stat' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), sub ? h('div', { class: 'small muted' }, sub) : null);

// Compact drop target: click to choose the export, or drop it here.
export function loadButton(rerender) {
  const input = h('input', { type: 'file', id: 'qb-file', accept: '.xlsx,.csv', class: 'visually-hidden',
    onchange: (e) => { loadFile(e.target.files[0], rerender); e.target.value = ''; } });
  return h('label', { class: 'dropzone compact' + (busy ? ' busy' : ''), for: 'qb-file', title: 'QuickBooks Sales by Product/Service Detail export (.xlsx or .csv). Lines already here are skipped.',
      ondragover: (e) => { e.preventDefault(); e.currentTarget.classList.add('over'); },
      ondragleave: (e) => e.currentTarget.classList.remove('over'),
      ondrop: (e) => { e.preventDefault(); e.currentTarget.classList.remove('over'); loadFile(e.dataTransfer.files[0], rerender); } },
    input,
    h('span', { class: 'dz-icon', 'aria-hidden': 'true' }, '⤓'),
    h('span', null, h('strong', null, busy ? 'Reading the report…' : 'Load QuickBooks report'),
      h('span', { class: 'small muted' }, 'Drop the export here or click')));
}

// The preview of a loaded report, waiting to be added (null when none).
export function pendingPreview(rerender) {
  if (!pending) return null;
  const p = pending;
  const c = convert(p);
  const addTotal = c.add.reduce((s, r) => s + Number(r.amount || 0), 0);
  const fgs = derived.ix().byType('Finished Good');
  const customers = [...new Set([...state.data.sales.map((s) => s.customer).filter(Boolean), ...p.chosen.customer.values()])].sort();
  const toConfirm = [...p.chosen.customer.keys()].length + [...p.chosen.product.keys()].length;
  const commit = async () => {
    busy = true; rerender();
    try {
      const names = [...[...p.chosen.customer].map(([qb_name, name]) => ({ kind: 'customer', qb_name, name: name.trim() || guessCustomer(qb_name) })),
        ...[...p.chosen.product].map(([qb_name, name]) => ({ kind: 'product', qb_name, name }))];
      const { added } = await importSales({ fileName: p.fileName, period: p.report.period, from: p.from, to: p.to, rows: c.add, skipped: c.skipped + c.duplicates.filter((d) => !d.kept).length, names });
      toast(`Added ${added} line${added === 1 ? '' : 's'} from ${p.fileName}.`);
      pending = null;
    } catch (err) { toast(niceError(err), 'bad'); } finally { busy = false; rerender(); }
  };
  const listId = 'qb-customers';
  return h('div', { class: 'import-panel' },
    h('h3', { class: 'tb-title' }, h('span', { class: 'grow' }, `Ready to add: ${p.fileName}`), h('span', { class: 'small muted' }, [p.report.name, p.report.period].filter(Boolean).join(' · '))),
    h('div', null,
      p.report.warning ? h('div', { class: 'note warn' }, p.report.warning) : null,
      h('div', { class: 'cards' },
        stat('Lines in report', p.lines.length, p.from ? `${longDate(p.from)} – ${longDate(p.to)}` : ''),
        stat('$0 lines left out', c.zero, 'Voided, notes, no charge'),
        stat('Duplicate lines', c.duplicates.filter((d) => !d.kept).length, c.duplicates.length ? `Repeated in the report; left out${c.duplicates.some((d) => d.kept) ? ` (${c.duplicates.filter((d) => d.kept).length} kept)` : ''}` : 'None'),
        stat('Already in Sales Detail', c.skipped, c.skipped ? 'Will be skipped' : ''),
        stat('New lines to add', c.add.length, c.add.length ? money(addTotal) : 'Nothing new')),
      toConfirm ? h('div', { class: 'confirm-names' },
        h('h3', null, 'New QuickBooks names'),
        h('p', { class: 'small muted' }, 'These names aren’t on the saved list yet. Check what each becomes in Sales Detail; your choices are remembered for next time.'),
        h('datalist', { id: listId }, customers.map((cu) => h('option', { value: cu }))),
        h('div', { class: 'tablewrap' }, h('table', { class: 't' },
          h('thead', null, h('tr', null, h('th', null, 'In QuickBooks'), h('th', null, ''), h('th', null, 'In Sales Detail'))),
          h('tbody', null,
            [...p.chosen.customer].map(([qb, name]) => h('tr', null, h('td', null, h('span', { class: 'pill' }, 'Customer'), ' ', qb), h('td', { class: 'muted' }, '→'),
              h('td', { class: 'cell entry wide-cell' }, h('input', { type: 'text', list: listId, value: name, 'aria-label': `Customer name for ${qb}`, 'data-k': `qbc|${qb}`,
                onchange: (e) => { p.chosen.customer.set(qb, e.target.value); rerender(); } })))),
            [...p.chosen.product].map(([qb, name]) => h('tr', null, h('td', null, h('span', { class: 'pill' }, 'Product'), ' ', qb), h('td', { class: 'muted' }, '→'),
              h('td', { class: 'cell entry wide-cell' }, h('select', { 'aria-label': `Product for ${qb}`, onchange: (e) => { p.chosen.product.set(qb, e.target.value); rerender(); } },
                fgs.map((fg) => h('option', { value: fg.name, selected: fg.name === name }, fg.name)),
                h('option', { value: 'Other', selected: name === 'Other' }, 'Other (fees, credits, promos)'))))))))) : null,
      c.duplicates.length ? h('details', { class: 'new-lines dup-lines' },
        h('summary', null, `Show the ${c.duplicates.length} duplicate line${c.duplicates.length === 1 ? '' : 's'}`),
        h('p', { class: 'small muted' }, 'Each of these appears more than once in the report with everything the same (date, invoice, customer, item, description, quantity, price and amount), so only the first copy is added. If an invoice really lists the same item twice, tick Keep to add it too.'),
        h('div', { class: 'tablewrap' }, h('table', { class: 't' },
          h('thead', null, h('tr', null, h('th', null, 'Keep'), ['Date', 'Inv Num', 'Customer', 'Product', 'QuickBooks item'].map((x) => h('th', null, x)), h('th', { class: 'num' }, 'Qty'), h('th', { class: 'num' }, 'Amount'))),
          h('tbody', null, c.duplicates.slice(0, 200).map(({ index, row: r, kept }) => h('tr', null,
            h('td', null, h('input', { type: 'checkbox', checked: kept, 'aria-label': `Keep the duplicate line ${r.invoice || ''} ${r.qb_product || ''}`, onchange: (e) => { if (e.target.checked) p.keepDup.add(index); else p.keepDup.delete(index); rerender(); } })), h('td', null, `${r.date.slice(5, 7)}/${r.date.slice(8, 10)}/${r.date.slice(0, 4)}`), h('td', null, r.invoice || ''),
            h('td', null, r.customer), h('td', null, r.product), h('td', { class: 'muted' }, r.qb_product),
            h('td', { class: 'num' }, r.quantity === null || r.quantity === undefined ? '' : qty(r.quantity)), h('td', { class: 'num' + (r.amount < 0 ? ' neg' : '') }, money(r.amount)))))))) : null,
      c.add.length ? h('details', { class: 'new-lines', open: c.add.length <= 25 },
        h('summary', null, `Show the ${c.add.length} new line${c.add.length === 1 ? '' : 's'}`),
        h('div', { class: 'tablewrap' }, h('table', { class: 't' },
          h('thead', null, h('tr', null, ['Date', 'Inv Num', 'Customer', 'Product', 'QuickBooks item'].map((x) => h('th', null, x)), h('th', { class: 'num' }, 'Qty'), h('th', { class: 'num' }, 'Amount'))),
          h('tbody', null, c.add.slice(0, 200).map((r) => h('tr', null, h('td', null, `${r.date.slice(5, 7)}/${r.date.slice(8, 10)}/${r.date.slice(0, 4)}`), h('td', null, r.invoice || ''),
            h('td', null, r.customer), h('td', null, r.product), h('td', { class: 'muted' }, r.qb_product),
            h('td', { class: 'num' }, r.quantity === null || r.quantity === undefined ? '' : qty(r.quantity)), h('td', { class: 'num' + (r.amount < 0 ? ' neg' : '') }, money(r.amount))))))))
        : h('div', { class: 'note info' }, c.duplicates.length ? 'Everything else in this report is already in Sales Detail. Nothing to add.' : 'Everything in this report is already in Sales Detail. Nothing to add.'),
      h('div', { class: 'controls', style: { marginTop: '12px', justifyContent: 'flex-end' } },
        h('button', { class: 'btn', onclick: () => { pending = null; rerender(); } }, 'Cancel'),
        c.add.length ? h('button', { class: 'btn primary', disabled: busy, onclick: commit }, busy ? 'Adding…' : `Add ${c.add.length} line${c.add.length === 1 ? '' : 's'}`) : null)));
}

export const importCount = () => state.data.sales_imports.length;

// Every QuickBooks report loaded so far, each with Undo.
export function historyTable() {
  const imports = [...state.data.sales_imports].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  if (!imports.length) return null;
  return h('div', { class: 'tablewrap' }, h('table', { class: 't' },
      h('thead', null, h('tr', null, h('th', null, 'Loaded'), h('th', null, 'File'), h('th', null, 'Report period'), h('th', { class: 'num' }, 'Lines added'), h('th', { class: 'num' }, 'Skipped'), h('th'))),
      h('tbody', null, imports.map((i) => h('tr', null,
        h('td', null, new Date(i.created_at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })),
        h('td', null, i.file_name || ''), h('td', null, i.period || ''),
        h('td', { class: 'num' }, i.lines_added), h('td', { class: 'num muted' }, i.lines_skipped),
        h('td', null, h('button', { class: 'btn ghost danger', onclick: async () => {
          if (!(await confirmDialog(`Undo this load? The ${i.lines_added} line${i.lines_added === 1 ? '' : 's'} it added from ${i.file_name || 'this report'} will be removed from Sales Detail.`, 'Undo load'))) return;
          try { await undoSalesImport(i.id); toast('Load undone.'); } catch (err) { toast(niceError(err), 'bad'); }
        } }, 'Undo')))))));
}
