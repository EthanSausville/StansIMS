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

// The workbook batched all recipes made on a day together; the site batches
// each recipe on its own (recipes can't share a batch, and each recipe BOM has
// its own batch size). Days where that gives the same number of batches must
// match Excel exactly; on the others it can only need more batches, never fewer.
test('production oz, batches and estimated loss', () => {
  const days = new Map(C.productionDays(data).map((d) => [d.date, d]));
  let single = 0;
  for (const [date, [loss, batches, oz]] of Object.entries(X.production)) {
    const d = days.get(date); assert.ok(d, `missing ${date}`);
    close(d.oz, oz, `${date} oz`);
    if (d.batches === batches) { single++; close(d.loss, loss, `${date} loss`); }
    else {
      assert.ok(d.batches >= batches && d.batches <= batches + d.recipes.length - 1, `${date} batches`);
      for (const r of d.recipes) { assert.equal(r.batches, Math.ceil(r.oz / r.batchSize - 1e-9)); close(r.leftoverOz, r.batches * r.batchSize - r.oz, `${date} leftover`); }
    }
  }
  assert.ok(single > 0);
  assert.equal(days.size, Object.keys(X.production).length);
});

test('each recipe uses its own batch size and labor minutes', () => {
  const recipe = data.items.find((i) => i.type === 'Recipe').item_no;
  const boms = C.bomData(data).boms.map((b) => (b.item_no === recipe ? { ...b, yield_qty: 1610, labor_minutes: 50 } : b));
  const lines = C.bomData(data).lines;
  const d2 = { ...data, boms, bom_lines: lines };
  const one = C.productionDays(d2).find((d) => d.recipes.some((r) => r.item_no === recipe));
  const r = one.recipes.find((x) => x.item_no === recipe);
  assert.equal(r.batchSize, 1610); assert.equal(r.batches, Math.ceil(r.oz / 1610 - 1e-9));
  const ix = C.index(d2);
  assert.equal(ix.laborMinutesOf(recipe), 50);
  const labor = ix.children(recipe).find((l) => l.uses_batch_minutes);
  if (labor) assert.equal(ix.lineQty(labor), 50);
  assert.equal(C.index(data).laborMinutesOf(recipe), data.settings.minutes_per_batch);
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
  // Months where every production day made one recipe match Excel; the rest
  // add the loss from batching each recipe on its own (see above).
  const d = C.dashboard(data, 2026, 12);
  const prod = C.productionDays(data);
  for (const [label, v] of X.dash_loss_by_month) {
    const i = C.MONTHS.indexOf(label); if (i < 0) continue;
    const days = prod.filter((p) => p.date.startsWith('2026') && C.monthOf(p.date) === i + 1);
    close(d.loss[i].loss, days.reduce((t, p) => t + p.loss, 0), `loss ${label}`);
    if (days.every((p) => X.production[p.date] && X.production[p.date][1] === p.batches)) close(d.loss[i].loss, v, `loss ${label} vs Excel`);
    else assert.ok(d.loss[i].loss >= v - 0.01, `loss ${label} not below Excel`);
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

test('multi-level BOMs: a BOM inside a BOM inside a BOM', () => {
  // Converted form gives the same costs as the original recipe / finished-good tables.
  const { boms, lines } = C.bomData(data);
  const converted = { ...data, boms, bom_lines: lines };
  const a = C.costModel(data), b = C.costModel(converted);
  for (const it of data.items) close(b.cost(it.item_no, 2026), a.cost(it.item_no, 2026), `converted item ${it.item_no}`);

  // Add a "Spice Mix" sub-recipe (makes 10 c.) and use 2 c. of it per batch of Original.
  const mix = { item_no: 30001, name: 'Spice Mix', type: 'Recipe', unit: 'c', sort: 999 };
  const nested = { ...converted, items: [...data.items, mix],
    boms: [...boms, { item_no: 30001, yield_qty: 10, yield_unit: 'c' }],
    bom_lines: [...lines,
      { id: 'm1', parent_item_no: 30001, item_no: 10003, qty: 4, uses_batch_minutes: false, sort: 1 },   // 4 c. pepper
      { id: 'm2', parent_item_no: 30001, item_no: 10006, qty: 6, uses_batch_minutes: false, sort: 2 },   // 6 c. brown sugar
      { id: 'm3', parent_item_no: 10021, item_no: 30001, qty: 2, uses_batch_minutes: false, sort: 99 }] };
  const cm = C.costModel(nested);
  const mixCost = (4 * 1.64 + 6 * 0.5) / 10;
  close(cm.cost(30001, 2026), mixCost, 'spice mix per cup');
  close(cm.cost(10021, 2026), a.cost(10021, 2026) + (2 * mixCost) / 3220, 'Original recipe per oz with the mix');
  close(cm.cost(20001, 2026), a.cost(20001, 2026) + 168 * (2 * mixCost) / 3220, 'Original 7 oz case with the mix');

  // Usage follows all three levels: pepper per case gains 168/3220 x 2 x 4/10 cups.
  const before = C.perCaseUsage(converted).get(20001).get(10003);
  const after = C.perCaseUsage(nested).get(20001).get(10003);
  close(after - before, (168 / 3220) * 2 * (4 / 10), 'extra pepper per case');

  // Loops are refused: the mix can't contain Original (Original already contains the mix).
  assert.equal(C.wouldLoop(nested, 30001, 10021), true);
  assert.equal(C.wouldLoop(nested, 30001, 20001), true);  // the 7 oz case contains Original, which contains the mix
  assert.equal(C.wouldLoop(nested, 10021, 30001), false);
  assert.equal(C.wouldLoop(nested, 30001, 30001), true);
});

test('BOMs by year: a later year’s BOM leaves earlier years alone', () => {
  const base = { ...data, boms: C.bomData(data).boms.map((b) => ({ ...b, year: 2026 })), bom_lines: C.bomData(data).lines.map((l) => ({ ...l, year: 2026 })) };
  const box = base.bom_lines.find((l) => l.parent_item_no === 20001 && !l.uses_batch_minutes && base.items.find((i) => i.item_no === l.item_no)?.type === 'Component' && Number(l.qty) === 1);
  assert.ok(box, 'the 7 oz case has a one-per-case component');
  const v27 = base.bom_lines.filter((l) => l.parent_item_no === 20001).map((l) => ({ ...l, id: `y${l.id}`, year: 2027, qty: l === box ? 2 : l.qty }));
  const byYear = { ...base, boms: [...base.boms, { ...base.boms.find((b) => b.item_no === 20001), year: 2027 }], bom_lines: [...base.bom_lines, ...v27] };
  // usage: 2026 (and earlier) keep one box per case, 2027 and later use two
  assert.equal(C.perCaseUsage(byYear, 2026).get(20001).get(box.item_no), 1);
  assert.equal(C.perCaseUsage(byYear, 2025).get(20001).get(box.item_no), 1);
  assert.equal(C.perCaseUsage(byYear, 2027).get(20001).get(box.item_no), 2);
  assert.equal(C.perCaseUsage(byYear, 2030).get(20001).get(box.item_no), 2);
  // costs: 2026 unchanged; 2027 adds one box at the 2027 box cost
  const a = C.costModel(base); const b = C.costModel(byYear);
  close(b.cost(20001, 2026), a.cost(20001, 2026), '2026 case cost unchanged');
  close(b.cost(20001, 2027), a.cost(20001, 2027) + a.cost(box.item_no, 2027), '2027 case cost has one more box');
  // production on a 2027 date uses up the 2027 BOM
  const prod = { ...byYear, production: [{ date: '2026-12-31', item_no: 20001, cases: 10 }, { date: '2027-01-04', item_no: 20001, cases: 10 }] };
  const cons = C.consumptionByDate(prod);
  assert.equal(cons.get('2026-12-31').get(box.item_no), 10);
  assert.equal(cons.get('2027-01-04').get(box.item_no), 20);
});

test('planning: demand plan, material plan', () => {
  const d = { ...data, boms: C.bomData(data).boms, bom_lines: C.bomData(data).lines, demand_forecast: [] };
  const today = '2026-10-28';
  assert.equal(C.mondayOf('2026-10-28'), '2026-10-26');
  assert.equal(C.mondayOf('2026-11-01'), '2026-10-26');
  assert.equal(C.mondayOf('2026-11-02'), '2026-11-02');
  const inv = C.dailyInventory(d, '2026-12-31');
  const p = C.demandPlan(d, { today, inv });
  assert.equal(p.weeks.length, 12); assert.equal(p.weeks[0], '2026-10-26');
  const fg = p.rows[0];
  // average of the 13 history weeks, each week's cases sold
  const hist = d.sales.filter((s) => s.item_no === fg.item.item_no && s.date >= p.history.from && s.date <= p.history.to).reduce((s, r) => s + r.quantity, 0);
  close(fg.avg, hist / 13, 'average weekly sales');
  // every week ends at or above safety stock, and production only tops up to it
  for (const r of p.rows) for (const c of r.weeks) assert.ok(c.endOnHand >= r.safety - 1e-9, `${r.item.name} ${c.week} ends above safety`);
  // a typed-in forecast replaces the average for that week
  const typed = C.demandPlan({ ...d, demand_forecast: [{ item_no: fg.item.item_no, week: p.weeks[2], cases: 500 }] }, { today, inv });
  assert.equal(typed.rows[0].weeks[2].forecast, 500); assert.equal(typed.rows[0].weeks[2].typed, true);
  // materials: two-week lead time, never below safety stock after planned receipts, orders placed lead time ahead
  const m = C.materialPlan(d, p, { today, inv });
  for (const r of m.rows) {
    assert.equal(r.leadDays, 14);
    assert.ok(r.safety >= r.avgPlanned - 1e-9, `${r.item.name} safety at least a week of use`);
    for (const c of r.weeks) if (c.week >= r.earliest) assert.ok(c.endOnHand >= r.safety - 1e-6, `${r.item.name} ${c.week} stays above safety once an order can arrive`);
    assert.equal(r.earliest, C.mondayOf(C.addDays(today, r.leadDays)));
    for (const o of r.orders) assert.ok(o.week >= r.earliest, 'no order planned to arrive sooner than the lead time allows');
    for (const o of r.orders) assert.equal(o.orderBy, C.addDays(o.week, -14));
  }
  // a typed-in lead time and safety stock win; order sizes round up to the standard purchase
  const cheese = m.rows.find((r) => r.item.name === 'Cheese').item.item_no;
  const m2 = C.materialPlan({ ...d, purchase_settings: [{ item_no: cheese, lead_days: 21, safety_stock: 100, standard_purchase: 1000 }] }, p, { today, inv });
  const r2 = m2.rows.find((r) => r.item.item_no === cheese);
  assert.equal(r2.leadDays, 21); assert.equal(r2.safety, 100);
  for (const o of r2.orders) { assert.equal(o.qty % 1000, 0); assert.equal(o.orderBy, C.addDays(o.week, -21)); }
});

test('consumption: count to count', () => {
  const d = { ...data, boms: C.bomData(data).boms, bom_lines: C.bomData(data).lines };
  const rows = C.countToCount(d);
  assert.ok(rows.length > 0);
  for (const r of rows) {
    close(r.actual, r.start + r.received - r.end, 'actual = start + received - end');
    close(r.variance, r.actual - r.standard, 'variance');
  }
  // standard usage by month adds up to the daily consumption
  const byMonth = C.usageByMonth(d, 2026); const cons = C.consumptionByDate(d);
  const cheese = d.items.find((i) => i.name === 'Cheese').item_no;
  let total = 0; for (const [, m] of cons) total += m.get(cheese) || 0;
  close(byMonth.get(cheese).reduce((s, v) => s + v, 0), total, 'monthly usage total');
});

test('journal entries balance and tie to the data', () => {
  const d = { ...data, boms: C.bomData(data).boms, bom_lines: C.bomData(data).lines };
  const inv = C.dailyInventory(d, '2026-12-31');
  for (let m = 1; m <= 12; m++) {
    for (const e of C.journalEntries(d, 2026, m, inv)) close(e.dr, e.cr, `2026-${m} entry ${e.code} balances`);
  }
  const jul = C.journalEntries(d, 2026, 7, inv);
  const g = jul.find((e) => e.code === 'G');
  const julSales = d.sales.filter((s) => s.date.startsWith('2026-07')).reduce((s, r) => s + (r.amount || 0), 0);
  close(g.lines.find((l) => l.key === 'revenue').cr, julSales, 'July revenue');
  // production at standard = cases x standard cost
  const cm = C.costModel(d);
  const julFg = d.production.filter((p) => p.date.startsWith('2026-07')).reduce((s, p) => s + p.cases * cm.cost(p.item_no, 2026), 0);
  close(jul.find((e) => e.code === 'E').dr, julFg, 'July production at standard');
  const L = C.ledger([{ label: 'Jul', entries: jul }]);
  let dr = 0, cr = 0; for (const a of L.values()) { dr += a.drTotal; cr += a.crTotal; }
  close(dr, cr, 'ledger debits = credits');
});

test('plan batches and count sheet', () => {
  const d = { ...data, boms: C.bomData(data).boms, bom_lines: C.bomData(data).lines, demand_forecast: [] };
  const today = '2026-10-28'; const inv = C.dailyInventory(d, '2026-12-31');
  const p = C.demandPlan(d, { today, inv });
  assert.ok(p.batches.length >= 1);
  for (const b of p.batches) for (const w of b.weeks) {
    assert.ok(w.batches * b.size >= w.oz - 1e-6 && (w.batches - 1) * b.size < w.oz + 1e-6, 'whole batches cover the oz needed');
  }
  // count sheet: expected is the running inventory at the end of the day before
  const c = d.cycle_counts.find((x) => x.date > '2026-02-01');
  const it = d.items.find((i) => i.item_no === c.item_no);
  const row = C.countSheet(d, inv, c.date, [it])[0];
  close(row.expected, inv.byItem.get(c.item_no).get(C.addDays(c.date, -1)), 'expected');
  close(row.diff, row.counted - row.expected, 'difference');
  assert.equal(row.flag, Math.abs(row.pct) > 0.1);
});

test('production lots: FIFO trace to customers', () => {
  const d = { ...data, boms: C.bomData(data).boms, bom_lines: C.bomData(data).lines };
  const { lots, unmatched } = C.productionLots(d);
  assert.ok(lots.length > 0);
  for (const l of lots) {
    const shipped = l.shipments.reduce((s, x) => s + x.cases, 0);
    close(shipped + l.left, l.cases, `${l.code} cases = shipped + left`);
    for (const x of l.shipments) assert.ok(x.date >= l.date, 'never ships before it is made');
  }
  // every case sold is either matched to a lot or reported as unmatched
  const fg = new Set(d.items.filter((i) => i.type === 'Finished Good').map((i) => i.item_no));
  const sold = d.sales.filter((s) => fg.has(s.item_no) && s.quantity > 0).reduce((s, x) => s + x.quantity, 0);
  const matched = lots.reduce((s, l) => s + l.shipments.reduce((a, x) => a + x.cases, 0), 0);
  close(matched + unmatched.reduce((s, u) => s + u.cases, 0), sold, 'all cases sold accounted for');
  assert.equal(C.lotCode('2026-07-14', 500001), '260714-500001');
});
