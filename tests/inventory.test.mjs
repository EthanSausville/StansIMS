// Daily inventory on made-up numbers: counts at the start or end of a day,
// and finished goods moved by production and sales (sales loaded from
// QuickBooks have only the product name).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dailyInventory, setCurrentYear } from '../public/js/calc.js';

setCurrentYear(2026);
const data = () => ({
  settings: {}, standard_costs: [], standard_prices: [], boms: [], bom_lines: [], recipes: [], recipe_lines: [], fg_lines: [],
  items: [{ item_no: 500001, name: 'Original 7 oz. (Case of 24)', type: 'Finished Good', unit: 'case' },
          { item_no: 100001, name: 'Cheese', type: 'Raw Material', unit: 'lb' }],
  goods_receipts: [{ date: '2026-03-03', item_no: 100001, qty: 30 }],
  production: [{ date: '2026-03-02', item_no: 500001, cases: 100 }],
  sales: [{ date: '2026-03-04', product: 'Original 7 oz. (Case of 24)', quantity: 40, item_no: null },
          { date: '2026-03-04', product: 'Other', quantity: 1, item_no: null }],
  cycle_counts: [{ date: '2026-03-01', item_no: 100001, qty: 10 }],
});

test('finished goods: production adds, sales take off on the day sold, even without an item number', () => {
  const inv = dailyInventory(data(), '2026-03-05');
  const fg = inv.byItem.get(500001);
  assert.equal(fg.get('2026-01-23'), 0); // never counted: starts at 0 when the company was purchased
  assert.equal(fg.get('2026-03-02'), 100);
  assert.equal(fg.get('2026-03-03'), 100);
  assert.equal(fg.get('2026-03-04'), 60);
  assert.deepEqual(inv.moves.get('500001|2026-03-04'), { received: 0, produced: 0, used: 0, sold: 40 });
});

test('a start-of-day count comes before the day’s movement; an end-of-day count after', () => {
  const d = data(); d.cycle_counts.push({ date: '2026-03-03', item_no: 100001, qty: 12 });
  let inv = dailyInventory(d, '2026-03-05');
  assert.equal(inv.byItem.get(100001).get('2026-03-03'), 42);            // 12 counted + 30 received
  assert.deepEqual(inv.adjust.get('100001|2026-03-03'), { counted: 12, expected: 10, adj: 2, timing: 'start' });
  assert.equal(inv.adjust.get('100001|2026-03-01').adj, null);           // the first count starts it
  d.cycle_counts[1].timing = 'end';
  inv = dailyInventory(d, '2026-03-05');
  assert.equal(inv.byItem.get(100001).get('2026-03-03'), 12);            // the day ends at the count
  assert.deepEqual(inv.adjust.get('100001|2026-03-03'), { counted: 12, expected: 40, adj: -28, timing: 'end' });
});
