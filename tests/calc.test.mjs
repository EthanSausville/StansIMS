// Checks the web calculations against the numbers Excel calculated in Stans.xlsm.
// Run: node --test tests/
// The fixture is produced by: python3 tools/excel_export.py Stans.xlsm tests/fixtures/workbook.json
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import * as C from '../public/js/calc.js';

// The fixture holds company data, so it is not in the repository. Create it with
// tools/excel_export.py (see README) to run these tests.
const FIXTURE = new URL('./fixtures/workbook.json', import.meta.url);
if (!existsSync(FIXTURE)) { console.log('Skipping: tests/fixtures/workbook.json not found (see README).'); process.exit(0); }
const { inputs: data, expected: X } = JSON.parse(readFileSync(FIXTURE));
const close = (a, b, label) => {
  const tol = 1e-6 * Math.max(1, Math.abs(b ?? 0));
  assert.ok(Math.abs((a ?? 0) - (b ?? 0)) <= tol, `${label}: web ${a} vs Excel ${b}`);
};

test('cell entry arithmetic', () => {
  assert.equal(C.evalEntry('175*45'), 7875);
  assert.equal(C.evalEntry('=6000+2000'), 8000);
  assert.equal(C.evalEntry(' 1,250 '), 1250);
  assert.equal(C.evalEntry('(2/3)*3'), 2);
  assert.equal(C.evalEntry(''), null);
  assert.throws(() => C.evalEntry('abc'));
  assert.throws(() => C.evalEntry('1/0'));
});

test('labor scenarios', () => {
  const s = C.laborScenarios(data.settings);
  X.labor.forEach(([total, avg, rate, batches, monthly], i) => {
    close(s[i].total, total, `scenario ${i + 1} total`); close(s[i].avgHourly, avg, 'avg hourly');
    close(s[i].ratePerMin, rate, 'rate'); close(s[i].totalBatches, batches, 'batches'); close(s[i].monthlyBatches, monthly, 'monthly');
  });
});

test('standard cost for every item (2026)', () => {
  const cm = C.costModel(data);
  for (const [item, v] of Object.entries(X.std_cost_2026)) close(cm.cost(Number(item), 2026), v, `item ${item}`);
});

test('production oz, batches and estimated loss', () => {
  const days = new Map(C.productionDays(data).map((d) => [d.date, d]));
  for (const [date, [loss, batches, oz]] of Object.entries(X.production)) {
    const d = days.get(date); assert.ok(d, `missing ${date}`);
    close(d.loss, loss, `${date} loss`); close(d.batches, batches, `${date} batches`); close(d.oz, oz, `${date} oz`);
  }
  assert.equal(days.size, Object.keys(X.production).length);
});

test('daily consumption', () => {
  const cons = C.consumptionByDate(data);
  for (const [date, row] of Object.entries(X.consumption)) for (const [item, v] of Object.entries(row)) close(cons.get(date)?.get(Number(item)), v, `${date} item ${item}`);
});

test('daily inventory (every day, raw materials and packaging)', () => {
  const inv = C.dailyInventory(data, '2035-12-31');
  let checked = 0;
  for (const [date, row] of Object.entries(X.daily_inventory)) for (const [item, v] of Object.entries(row)) { close(inv.byItem.get(Number(item)).get(date), v, `${date} item ${item}`); checked++; }
  assert.ok(checked > 60000, `checked ${checked}`);
});

test('purchase demand (every day)', () => {
  const inv = C.dailyInventory(data, '2035-12-31');
  const pd = C.purchaseDemand(data, inv);
  let checked = 0;
  for (const [date, row] of Object.entries(X.purchase_demand)) for (const [item, v] of Object.entries(row)) { close(pd.get(Number(item)).suggestions.get(date), v, `${date} item ${item}`); checked++; }
  assert.ok(checked > 60000, `checked ${checked}`);
});

test('ending inventory by month (raw materials and packaging)', () => {
  const inv = C.dailyInventory(data, '2035-12-31');
  for (const [date, row] of Object.entries(X.ending_inventory)) {
    const y = C.yearOf(date), m = C.monthOf(date);
    const rows = new Map(C.endingInventory(data, inv, y).map((r) => [String(r.item.item_no), r]));
    for (const [item, v] of Object.entries(row)) {
      if (rows.get(item).item.type === 'Finished Good') continue; // not calculated in the workbook
      close(rows.get(item).qty[m - 1], v, `${date} item ${item}`);
    }
  }
});

test('sales report standard price, cost and margin (2026 rows)', () => {
  const rows = new Map(C.salesRows(data).map((r) => [String(r.row), r]));
  let checked = 0;
  for (const [row, [oz, price, cost, margin]] of Object.entries(X.sales)) {
    const r = rows.get(row); if (!r || r.year !== 2026) continue;
    close(r.oz, oz, `row ${row} oz`); close(r.stdPrice, price, `row ${row} price`); close(r.stdCost, cost, `row ${row} cost`); close(r.stdMargin, margin, `row ${row} margin`);
    checked++;
  }
  assert.ok(checked > 100, `checked ${checked}`);
});

test('dashboard: lost inventory by month', () => {
  const d = C.dashboard(data, 2026, 12);
  for (const [label, v] of X.dash_loss_by_month) {
    const i = C.MONTHS.indexOf(label); if (i >= 0) close(d.loss[i].loss, v, `loss ${label}`);
  }
});

test('dashboard: sales and margin by month', () => {
  const d = C.dashboard(data, 2026, 12);
  const rows = X.dash_sales_by_month.filter(([label]) => C.MONTHS.includes(label));
  assert.ok(rows.length >= 6);
  // Sales come straight from the workbook's pivot table.
  for (const [label, sales] of rows) close(d.byMonth[C.MONTHS.indexOf(label)].sales, sales ?? 0, `sales ${label}`);
  // The pivot's margin figures are stale in the saved workbook (last refreshed
  // before the standard costs changed), so margin is checked against the sum of
  // the SalesReport sheet's own Std Margin column instead.
  const margin = Array(12).fill(0);
  for (const s of data.sales) if (C.yearOf(s.date) === 2026) margin[C.monthOf(s.date) - 1] += X.sales[String(s.row)][3] ?? 0;
  margin.forEach((v, i) => close(d.byMonth[i].margin, v, `margin ${C.MONTHS[i]}`));
});
