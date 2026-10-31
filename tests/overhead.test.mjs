// Overhead rate (Standards → Overhead) on made-up numbers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { overheadRate, overheadSetup, costModel, setCurrentYear, missingStandards, isTiedIndirect, laborRate } from '../public/js/calc.js';

setCurrentYear(2026);
const base = () => ({
  items: [{ item_no: 300002, name: 'Overhead', type: 'Indirect Cost', unit: 'min' }, { item_no: 300001, name: 'Direct Labor', type: 'Indirect Cost', unit: 'min' }],
  standard_costs: [{ item_no: 300002, year: 2026, cost: 9.99 }], standard_prices: [], boms: [], bom_lines: [],
  year_settings: [{ year: 2026, labor_line_hours: 20 }, { year: 2027, overhead_inflation_pct: 10 }],
  labor_positions: [{ id: 1, year: 2026, name: 'A', pay_type: 'hourly', headcount: 3, hourly_rate: 10, on_line: true }],
  overhead_costs: [{ id: 1, year: 2026, name: 'Rent', monthly_amount: 800, sort: 1 }, { id: 2, year: 2026, name: 'Power', monthly_amount: 200, sort: 2 }],
});

test('the year’s overhead over line minutes, or labor minutes', () => {
  const d = base();
  const r = overheadRate(d, 2026);
  assert.equal(r.annual, 12000); assert.equal(r.basis, 'line');
  assert.equal(r.lineMinutes, 20 * 52 * 60); assert.equal(r.laborMinutes, 3 * 20 * 52 * 60);
  assert.ok(Math.abs(r.rate - 12000 / (20 * 52 * 60)) < 1e-12);
  d.year_settings[0].overhead_basis = 'labor';
  assert.ok(Math.abs(overheadRate(d, 2026).rate - 12000 / (3 * 20 * 52 * 60)) < 1e-12);
});

test('a year without its own overhead is last year’s plus inflation, as a forecast', () => {
  const d = base(); const s = overheadSetup(d, 2027);
  assert.equal(s.own, false); assert.equal(s.forecast, true); assert.equal(s.fromYear, 2026);
  assert.deepEqual(s.lines.map((c) => c.annual_amount), [10560, 2640]);
  assert.equal(overheadRate(d, 2027).annual, 13200);
});

test('Overhead’s standard cost comes from the tab once it has costs', () => {
  const d = base(); const cm = costModel(d);
  assert.ok(Math.abs(cm.cost(300002, 2026) - 12000 / (20 * 52 * 60)) < 1e-12, 'not the 9.99 typed on Master List');
  assert.ok(isTiedIndirect(d, 300002));
  assert.ok(!missingStandards(d, 2027).costs.some((i) => i.item_no === 300002), 'no longer “missing” a typed-in cost');
  const before = { ...d, overhead_costs: [] };
  assert.equal(costModel(before).cost(300002, 2026), 9.99, 'until then, the typed-in cost');
  assert.ok(!isTiedIndirect(before, 300002));
});

test('overhead is entered per year (older lines per month still count)', () => {
  const d = base();
  d.overhead_costs = [{ id: 1, year: 2026, name: 'Electricity', annual_amount: 6000, monthly_amount: 0 }, { id: 2, year: 2026, name: 'Sewer', annual_amount: 1200 }, { id: 3, year: 2026, name: 'Old', monthly_amount: 100 }];
  const r = overheadRate(d, 2026);
  assert.equal(r.annual, 8400);
  assert.ok(Math.abs(r.rate - 8400 / (20 * 52 * 60)) < 1e-12);
});

test('past 40 hours a week: overtime for the same people, or another shift', () => {
  const d = base(); // 3 hourly people at $10, on the line
  const at = (h, over40) => laborRate(d, { year: 2026, lineHours: h, over40 });
  assert.equal(at(40).base, 3 * 40 * 52 * 10);
  assert.equal(at(60, 'overtime').base, 3 * (40 + 20 * 1.5) * 52 * 10);  // time and a half past 40
  assert.equal(at(60, 'shift').base, 3 * 60 * 52 * 10);                  // straight time…
  assert.equal(at(60, 'shift').paidPeople, 6);                            // …with a second crew
  assert.equal(at(60, 'overtime').minutes, at(60, 'shift').minutes);      // the same line minutes either way
  assert.ok(at(60, 'overtime').rate > at(40).rate);                       // overtime costs more per minute
});
