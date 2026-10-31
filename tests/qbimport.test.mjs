// Reading QuickBooks "Sales by Product/Service Detail" exports.
// Needs tests/fixtures/qb-sales-detail.xlsx (company data, not in the repo).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { readSpreadsheet, parseCsv } from '../public/js/xlsx.js';
import { parseQuickBooksSales, newLines, toIsoDate, convertLines, newSales, guessProduct, guessCustomer } from '../public/js/qbimport.js';

const XLSX = new URL('./fixtures/qb-sales-detail.xlsx', import.meta.url);
const CSV = new URL('./fixtures/qb-sales-detail.csv', import.meta.url);
const asFile = (url, name) => { const b = readFileSync(url); return { name, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) }; };
const sum = (ls) => Math.round(ls.reduce((s, l) => s + l.amount, 0) * 100) / 100;

test('dates', () => {
  assert.equal(toIsoDate('03/02/2026'), '2026-03-02');
  assert.equal(toIsoDate('3/2/26'), '2026-03-02');
  assert.equal(toIsoDate(46083), '2026-03-02');
  assert.equal(toIsoDate('Total for X'), null);
});

test('reads the QuickBooks .xlsx export', { skip: !existsSync(XLSX) && 'fixture missing' }, async () => {
  const r = parseQuickBooksSales(await readSpreadsheet(asFile(XLSX, 'report.xlsx')));
  assert.equal(r.report.name, 'Sales by Product/Service Detail');
  assert.equal(r.report.period, 'February-July, 2026');
  assert.equal(r.lines.length, 313);
  assert.equal(sum(r.lines), 806878.52);
  assert.equal(r.from, '2026-02-01'); assert.equal(r.to, '2026-07-27');
  const count = (p) => r.lines.filter((l) => l.product_service === p).length;
  assert.equal(count('8 lb-Gallon - Jalapeno Pimento Cheese'), 55);
  assert.equal(count('Retail Gallon Jalapeno Pimento Cheese'), 1);    // nested heading
  assert.equal(count('UNK - Unknown deduction (to be researched)'), 4);
  assert.equal(count('--'), 9);                                       // lines with no product
  const cm = r.lines.filter((l) => l.txn_type === 'Credit Memo');
  assert.equal(cm.length, 2);
});

test('reads the same report saved as .csv', { skip: !existsSync(CSV) && 'fixture missing' }, async () => {
  const x = parseQuickBooksSales(await readSpreadsheet(asFile(XLSX, 'report.xlsx')));
  const c = parseQuickBooksSales(await readSpreadsheet(asFile(CSV, 'report.csv')));
  assert.equal(c.lines.length, x.lines.length);
  assert.equal(sum(c.lines), sum(x.lines));
  assert.deepEqual(newLines(c.lines, x.lines).add, []);               // same lines either way
});

test('skips lines already loaded, including repeated identical lines', { skip: !existsSync(XLSX) && 'fixture missing' }, async () => {
  const r = parseQuickBooksSales(await readSpreadsheet(asFile(XLSX, 'report.xlsx')));
  assert.equal(newLines(r.lines, []).add.length, 313);
  const again = newLines(r.lines, r.lines);
  assert.equal(again.add.length, 0); assert.equal(again.skipped, 313);
  // Overlap: Feb-Apr already loaded, then the full Feb-Jul report.
  const early = r.lines.filter((l) => l.date < '2026-05-01');
  const next = newLines(r.lines, early);
  assert.equal(next.add.length, 313 - early.length);
  assert.ok(next.add.every((l) => l.date >= '2026-05-01'));
  // An invoice with identical lines: if only one of three was loaded, two are added.
  const line = { date: '2026-07-08', txn_type: 'Invoice', num: '1', customer: 'Shop', product_service: '--', description: null, quantity: null, sales_price: null, amount: 0 };
  assert.equal(newLines([line, line, line], [line]).add.length, 2);
});

test('rejects a file that is not the report', () => {
  assert.throws(() => parseQuickBooksSales(parseCsv('Name,Phone\nBob,555\n')), /Transaction date/);
});

const WB = new URL('./fixtures/workbook.json', import.meta.url);
const MAP = new URL('./fixtures/qb-name-map.json', import.meta.url);

test('the workbook SalesReport is the baseline: the Feb-Jul report adds only what it lacks', { skip: !(existsSync(XLSX) && existsSync(WB) && existsSync(MAP)) && 'fixtures missing' }, async () => {
  const lines = parseQuickBooksSales(await readSpreadsheet(asFile(XLSX, 'report.xlsx'))).lines;
  const data = JSON.parse(readFileSync(WB)).inputs;
  const names = JSON.parse(readFileSync(MAP));
  const maps = { customer: new Map(), product: new Map() };
  for (const n of names) maps[n.kind].set(n.qb_name, n.name);
  const fgs = data.items.filter((i) => i.type === 'Finished Good');
  const stdPrice = (name) => { const fg = fgs.find((f) => f.name === name); return data.standard_prices.find((p) => p.item_no === fg?.item_no)?.price || 0; };
  // Product guesses alone reproduce every product choice in the workbook.
  for (const n of names.filter((x) => x.kind === 'product')) assert.equal(guessProduct(n.qb_name, fgs), n.name, n.qb_name);
  const { rows, zero } = convertLines(lines, maps, stdPrice);
  assert.equal(zero, 19);
  const { add, skipped, duplicates } = newSales(rows, data.sales);
  // One gallon line is listed twice on invoice 14630 (it's in the books twice too): left out as a duplicate.
  assert.equal(duplicates.length, 1); assert.equal(duplicates[0].row.invoice, '14630');
  assert.equal(skipped, 292);
  assert.equal(add.length, 1);                                   // the one line not on SalesReport:
  assert.ok(add[0].amount < 0); assert.equal(add[0].txn_type, 'Credit Memo'); assert.equal(add[0].product, 'Other');
  // Every non-zero SalesReport row is accounted for by the report.
  assert.equal(newSales(data.sales.filter((s) => Number(s.amount)), rows).add.length, 0);
  // Single units sold at a unit price are "Other"; at a case price they are cases.
  const singles = rows.filter((r) => /\(1\/1\)/.test(r.qb_product || ''));
  assert.ok(singles.length && singles.every((r) => r.product === 'Other' || Number(r.price) >= stdPrice(r.product) / 2));
});

test('suggested names for new QuickBooks customers', () => {
  assert.equal(guessCustomer('Grocer Corporate:Grocer, Inc  - Springfield'), 'Grocer, Inc - Springfield');
  assert.equal(guessCustomer('Shop'), 'Shop');
});

test('duplicate lines in a report are left out', () => {
  const r = { date: '2026-07-01', invoice: '1001', customer: 'Shop', product: 'Original 7 oz.', quantity: 2, price: 30, amount: 60, txn_type: 'Invoice', qb_product: '7 oz', qb_customer: 'Shop', description: '' };
  const other = { ...r, invoice: '1002' };
  const res = newSales([r, { ...r }, other, { ...r }], []);
  assert.equal(res.add.length, 2); assert.equal(res.duplicates.length, 2); assert.deepEqual(res.duplicates.map((d) => d.index), [1, 3]);
  // ...unless kept (an invoice can list the same item twice)
  assert.equal(newSales([r, { ...r }, other, { ...r }], [], new Set([1])).add.length, 3);
  // a line differing in any detail isn't a duplicate
  assert.equal(newSales([r, { ...r, description: 'promo' }], []).duplicates.length, 0);
  // and duplicates aren't double-counted against what's already loaded
  const again = newSales([r, { ...r }], [r]);
  assert.equal(again.add.length, 0); assert.equal(again.skipped, 1); assert.equal(again.duplicates.length, 1);
});
