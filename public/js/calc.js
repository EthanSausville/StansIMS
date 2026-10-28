// Stans IMS calculation engine.
// Pure functions that reproduce the workbook's formulas. They take plain data
// (rows exactly as they come out of the database) and return plain results, so
// the same code runs in the browser and in tests/calc.test.mjs, which checks it
// against the numbers Excel calculated.

export const TYPES = ['Raw Material', 'Component', 'Indirect Cost', 'Recipe', 'Finished Good'];
export const LABOR_ITEM = 10019;    // "Direct Labor" (cost per minute comes from Labor Scenarios)
export const OVERHEAD_ITEM = 10020; // "Overhead" (cost per minute is entered)
export const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

// ---------- dates (ISO strings, UTC math so time zones never shift a day) ----------
export const toDate = (iso) => new Date(iso + 'T00:00:00Z');
export const isoOf = (d) => d.toISOString().slice(0, 10);
export const addDays = (iso, n) => { const d = toDate(iso); d.setUTCDate(d.getUTCDate() + n); return isoOf(d); };
export const yearOf = (iso) => Number(iso.slice(0, 4));
export const monthOf = (iso) => Number(iso.slice(5, 7)); // 1-12
export const monthEnd = (year, month) => isoOf(new Date(Date.UTC(year, month, 0)));
export const isWeekend = (iso) => { const w = toDate(iso).getUTCDay(); return w === 0 || w === 6; };
export function* eachDay(from, to) { for (let d = from; d <= to; d = addDays(d, 1)) yield d; }

const n = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? 0 : Number(v));

// Evaluates what a person types into a cell: "175*45", "=6240+2376", "1,250", "(2/3)".
// Returns a number, null for an empty cell, or throws on anything else.
export function evalEntry(text) {
  if (text === null || text === undefined) return null;
  let s = String(text).trim().replace(/,/g, '');
  if (s.startsWith('=')) s = s.slice(1);
  if (s === '') return null;
  let i = 0;
  const peek = () => s[i];
  const skip = () => { while (s[i] === ' ') i++; };
  function expr() { let v = term(); skip(); while (peek() === '+' || peek() === '-') { const op = s[i++]; const r = term(); v = op === '+' ? v + r : v - r; skip(); } return v; }
  function term() { let v = factor(); skip(); while (peek() === '*' || peek() === '/') { const op = s[i++]; const r = factor(); v = op === '*' ? v * r : v / r; skip(); } return v; }
  function factor() {
    skip();
    if (peek() === '-') { i++; return -factor(); }
    if (peek() === '+') { i++; return factor(); }
    if (peek() === '(') { i++; const v = expr(); skip(); if (s[i++] !== ')') throw new Error('Missing )'); return v; }
    const m = /^\d*\.?\d+(e[+-]?\d+)?/i.exec(s.slice(i));
    if (!m) throw new Error(`Can't read "${text}"`);
    i += m[0].length; return Number(m[0]);
  }
  const v = expr(); skip();
  if (i < s.length) throw new Error(`Can't read "${text}"`);
  if (!Number.isFinite(v)) throw new Error('Not a number');
  return v;
}

// ---------- Bills of materials ----------
// A BOM says what an item is made of. `boms` holds one row per item that has a
// BOM, with how much one run of it makes (yield_qty, e.g. 1 case or a 3,220 oz
// batch). `bom_lines` lists what goes into one run; a line can be any item,
// including one that has its own BOM, to any depth. A line flagged
// uses_batch_minutes takes its quantity from its BOM's labor minutes per run
// (boms.labor_minutes; the old single minutes-per-batch setting if blank).
//
// Data from before multi-level BOMs (recipes / recipe_lines / fg_lines) is
// converted here, so older exports still calculate the same way.
export function bomData(data) {
  if (Array.isArray(data.boms) && Array.isArray(data.bom_lines)) return { boms: data.boms, lines: data.bom_lines };
  const boms = []; const lines = [];
  for (const r of data.recipes || []) boms.push({ item_no: r.item_no, yield_qty: r.batch_size, yield_unit: 'oz' });
  for (const l of data.recipe_lines || []) lines.push({ id: `r${lines.length}`, parent_item_no: l.recipe_item_no, item_no: l.item_no, qty: l.qty, uses_batch_minutes: !!l.uses_batch_minutes, sort: l.sort });
  for (const fg of new Set((data.fg_lines || []).map((l) => l.fg_item_no))) boms.push({ item_no: fg, yield_qty: 1, yield_unit: 'case' });
  for (const l of data.fg_lines || []) lines.push({ id: `f${lines.length}`, parent_item_no: l.fg_item_no, item_no: l.item_no, qty: l.qty, uses_batch_minutes: false, sort: l.sort });
  return { boms, lines };
}

// ---------- lookups ----------
export function index(data) {
  const items = new Map(data.items.map((i) => [i.item_no, i]));
  const byType = (t) => data.items.filter((i) => i.type === t).sort((a, b) => a.sort - b.sort);
  const { boms, lines } = bomData(data);
  const bom = new Map(boms.map((b) => [b.item_no, b]));
  const linesOf = new Map();
  for (const l of [...lines].sort((a, b) => n(a.sort) - n(b.sort))) {
    if (!linesOf.has(l.parent_item_no)) linesOf.set(l.parent_item_no, []);
    linesOf.get(l.parent_item_no).push(l);
  }
  const children = (itemNo) => linesOf.get(itemNo) || [];
  const yieldOf = (itemNo) => n(bom.get(itemNo)?.yield_qty) || 1;
  const laborMinutesOf = (itemNo) => { const m = bom.get(itemNo)?.labor_minutes; return m === null || m === undefined || m === '' ? n(data.settings?.minutes_per_batch) : n(m); };
  const lineQty = (l) => (l.uses_batch_minutes ? laborMinutesOf(l.parent_item_no) : n(l.qty));
  // Oz of recipe in one case of a finished good (Production row 2).
  const fgCaseOz = new Map();
  for (const b of boms) {
    if (items.get(b.item_no)?.type !== 'Finished Good') continue;
    const oz = children(b.item_no).filter((l) => items.get(l.item_no)?.type === 'Recipe').reduce((s, l) => s + n(l.qty), 0) / yieldOf(b.item_no);
    if (oz) fgCaseOz.set(b.item_no, oz);
  }
  // Items that appear inside another BOM are not top-level.
  const usedIn = new Map();
  for (const l of lines) { if (!usedIn.has(l.item_no)) usedIn.set(l.item_no, new Set()); usedIn.get(l.item_no).add(l.parent_item_no); }
  return { items, byType, bom, children, yieldOf, laborMinutesOf, lineQty, fgCaseOz, usedIn };
}

// True when putting `child` into `parent`'s BOM would make a loop
// (the child already contains the parent somewhere beneath it).
export function wouldLoop(data, parent, child, ix = index(data)) {
  if (parent === child) return true;
  const seen = new Set(); const stack = [child];
  while (stack.length) {
    const it = stack.pop(); if (seen.has(it)) continue; seen.add(it);
    for (const l of ix.children(it)) { if (l.item_no === parent) return true; stack.push(l.item_no); }
  }
  return false;
}

// ---------- Labor rate (standard labor cost per minute) ----------
// Set fresh every year from that year's people:
//   1. Fully burdened cost of each position for the year:
//        base pay (hourly rate x paid hours, or annual salary)
//      + employer payroll taxes (% of base pay)
//      + fixed benefits (monthly for hourly people, annual for salaried).
//      Hourly people are paid for the days they work in the weeks the line
//      runs (no paid time off); salaried people are paid all 52 weeks.
//   2. All of that paid cost goes into the labor rate, including paid time
//      off the line (a salaried person paid for 5 days who is on the line 2).
//   3. Productive minutes = hours on the line x 60 x line efficiency %.
//   4. Labor rate = total burdened cost / productive minutes.
// A labor minute is one person working one minute, as BOMs count minutes per batch.

export const LABOR_FIRST_YEAR = 2026;
// The years shown on the Labor tab: 2026 through next year.
export const laborYears = (now = new Date().getFullYear()) => Array.from({ length: Math.max(1, now + 2 - LABOR_FIRST_YEAR) }, (_, i) => LABOR_FIRST_YEAR + i);

const laborPlant = (y = {}) => ({
  paidWeeks: 52,
  prodWeeks: y.labor_prod_weeks ?? 52,
  efficiency: (y.labor_efficiency_pct ?? 100) / 100,
});

// One position for the year. `days` overrides the line days a week (what-ifs).
export function laborPosition(p, plant, days) {
  const people = n(p.headcount); const hrs = p.hours_per_day ?? 8;
  const sal = p.pay_type === 'salaried';
  const paidDays = n(p.paid_days ?? 5);
  let lineDays = Math.min(n(days ?? p.production_days ?? paidDays), paidDays);
  let paidDaysUsed = paidDays;
  // Hourly people who are only paid for line days move with the line schedule.
  if (!sal && days !== undefined && n(p.production_days) >= paidDays) { paidDaysUsed = n(days); lineDays = n(days); }
  const paidHours = people * paidDaysUsed * n(hrs) * (sal ? plant.paidWeeks : plant.prodWeeks);
  const lineHours = Math.min(people * lineDays * n(hrs) * plant.prodWeeks, paidHours);
  const base = sal ? people * n(p.annual_salary) : paidHours * n(p.hourly_rate);
  const tax = base * n(p.payroll_tax_pct) / 100;
  const benefits = people * (sal ? n(p.annual_fixed) : n(p.monthly_fringe) * 12);
  const burdened = base + tax + benefits;
  return { position: p, people, salaried: sal, paidDays: paidDaysUsed, lineDays, paidHours, lineHours, base, tax, benefits, burdened,
    share: paidHours ? lineHours / paidHours : 0, minutes: lineHours * 60 * plant.efficiency, perPaidHour: paidHours ? burdened / paidHours : 0 };
}

export function laborRate(data, { year, days } = {}) {
  const ys = (data.year_settings || []).find((y) => y.year === year) || {};
  const plant = laborPlant(ys);
  const rows = (data.labor_positions || []).filter((p) => year === undefined || p.year === year)
    .sort((a, b) => n(a.sort) - n(b.sort) || n(a.id) - n(b.id)).map((p) => laborPosition(p, plant, days));
  const sum = (f) => rows.reduce((t, r) => t + f(r), 0);
  const burdened = sum((r) => r.burdened); const minutes = sum((r) => r.minutes);
  const rate = minutes ? burdened / minutes : 0;
  const ix = data.items ? index(data) : null;
  const recipes = ix ? ix.byType('Recipe').filter((r) => ix.bom.has(r.item_no)).map((r) => {
    const batchOz = ix.yieldOf(r.item_no); const minutesPer = ix.laborMinutesOf(r.item_no);
    return { item: r, batchOz, minutesPer, perBatch: rate * minutesPer, perOz: batchOz ? (rate * minutesPer) / batchOz : 0, batchesPerYear: minutesPer ? minutes / minutesPer : 0 };
  }) : [];
  return { year, plant, rows, recipes, burdened, base: sum((r) => r.base), tax: sum((r) => r.tax), benefits: sum((r) => r.benefits),
    minutes, lineHours: sum((r) => r.lineHours), paidHours: sum((r) => r.paidHours), rate };
}

// The workbook's Labor Scenarios sheet: scenario k = k days a week for everyone,
// all pay spread over line hours. Used until labor positions are set up, and
// by the tests against Excel.
export function laborScenarios(s) {
  return [1, 2, 3, 4, 5].map((k) => {
    const hrsSal = 8 * k * 52 * n(s.salaried_count);
    const hrsA = 8 * k * 52 * n(s.hourly_a_count);
    const hrsB = 8 * k * 52 * n(s.hourly_b_count);
    const wagesSal = n(s.salaried_wage) * n(s.salaried_count);
    const wagesA = n(s.hourly_a_rate) * hrsA;
    const wagesB = n(s.hourly_b_rate) * hrsB;
    const total = wagesSal + wagesA + wagesB;
    const hours = hrsSal + hrsA + hrsB;
    const avgHourly = hours ? total / hours : 0;
    const totalBatches = n(s.minutes_per_batch) ? (hours * 60) / n(s.minutes_per_batch) : 0;
    return { scenario: k, name: `Scenario ${k}`, description: `Working ${k} day${k > 1 ? 's' : ''} per week`,
      hrsSal, hrsA, hrsB, wagesSal, wagesA, wagesB, total, avgHourly, ratePerMin: avgHourly / 60,
      totalBatches, monthlyBatches: totalBatches / 12 };
  });
}

// The labor rate for each year comes from that year's people. A year with no
// people has no labor rate (it must be set up). Until any people are entered,
// the workbook scenario chosen for the year is used.
export function laborModel(data) {
  const hasPositions = (data.labor_positions || []).length > 0;
  const legacy = laborScenarios(data.settings || {});
  const years = new Map((data.year_settings || []).map((y) => [y.year, y]));
  const cache = new Map();
  const forYear = (year) => { if (!cache.has(year)) cache.set(year, laborRate(data, { year })); return cache.get(year); };
  const rateFor = (year) => (hasPositions ? forYear(year).rate : legacy[(years.get(year)?.labor_scenario || 0) - 1]?.ratePerMin ?? 0);
  return { hasPositions, years, forYear, rateFor };
}

// ---------- Standard Cost ----------
// Returns { years, cost(item_no, year), latest(item_no), recipeDetail, fgDetail }.
export function costModel(data) {
  const ix = index(data);
  const entered = new Map(data.standard_costs.map((c) => [`${c.item_no}|${c.year}`, n(c.cost)]));
  const labor = laborModel(data);
  const yearsSet = new Set([...data.standard_costs.map((c) => c.year), ...data.year_settings.map((y) => y.year),
    ...data.standard_prices.map((p) => p.year)]);
  const first = yearsSet.size ? Math.min(...yearsSet) : new Date().getFullYear();
  const years = Array.from({ length: 10 }, (_, i) => first + i); // the workbook carries ten years
  const memo = new Map();

  function cost(itemNo, year) {
    const key = `${itemNo}|${year}`;
    if (memo.has(key)) return memo.get(key);
    const item = ix.items.get(itemNo);
    memo.set(key, 0); // guards against a BOM loop
    let v = 0;
    if (!item) v = 0;
    else if (ix.bom.has(itemNo)) {
      // Built from its BOM: cost of one run divided by what one run makes.
      v = ix.children(itemNo).reduce((s, l) => s + cost(l.item_no, year) * lineQty(l), 0) / ix.yieldOf(itemNo);
    } else if (itemNo === LABOR_ITEM) {
      v = labor.rateFor(year);
    } else v = entered.get(key) ?? 0;
    memo.set(key, v);
    return v;
  }
  const { lineQty } = ix;
  // "Latest Cost": the last year with a non-zero cost.
  const latest = (itemNo) => { for (let i = years.length - 1; i >= 0; i--) { const v = cost(itemNo, years[i]); if (v) return v; } return 0; };
  // Cost for a year, falling back to the nearest year that has standards.
  const nearest = (itemNo, year) => {
    const direct = cost(itemNo, year); if (direct) return direct;
    const ys = years.filter((y) => cost(itemNo, y)).sort((a, b) => Math.abs(a - year) - Math.abs(b - year) || a - b);
    return ys.length ? cost(itemNo, ys[0]) : 0;
  };
  return { years, cost, latest, nearest, labor, ix, lineQty };
}

// Price per case, with the same nearest-year fallback.
export function priceModel(data) {
  const p = new Map(data.standard_prices.map((r) => [`${r.item_no}|${r.year}`, n(r.price)]));
  const price = (itemNo, year) => p.get(`${itemNo}|${year}`) ?? 0;
  const nearest = (itemNo, year) => {
    if (price(itemNo, year)) return price(itemNo, year);
    const ys = data.standard_prices.filter((r) => r.item_no === itemNo && n(r.price)).map((r) => r.year)
      .sort((a, b) => Math.abs(a - year) - Math.abs(b - year) || a - b);
    return ys.length ? price(itemNo, ys[0]) : 0;
  };
  return { price, nearest };
}

// StandardPrice!C1: average price per oz across every finished good for a year
// (a finished good without a price counts as 0, as in the workbook).
export function avgPricePerOz(data, year) {
  const ix = index(data); const pm = priceModel(data);
  const fgs = ix.byType('Finished Good');
  if (!fgs.length) return 0;
  return fgs.reduce((s, f) => s + (ix.fgCaseOz.get(f.item_no) ? pm.price(f.item_no, year) / ix.fgCaseOz.get(f.item_no) : 0), 0) / fgs.length;
}

// ---------- Production ----------
// One row per production date: oz, batches and the estimated loss from the
// last, partly-used batch (Production!D:F). Each recipe is batched on its own,
// in its own batch size (the recipe BOM's "one run makes").
export function productionDays(data) {
  const ix = index(data);
  const fallbackB = n(data.settings.production_batch_size);
  // oz of each recipe in one case of each finished good
  const recipeOz = new Map();
  for (const fg of ix.byType('Finished Good')) {
    const m = new Map();
    for (const l of ix.children(fg.item_no)) if (ix.items.get(l.item_no)?.type === 'Recipe') m.set(l.item_no, (m.get(l.item_no) || 0) + n(l.qty) / ix.yieldOf(fg.item_no));
    recipeOz.set(fg.item_no, m);
  }
  const byDate = new Map();
  for (const p of data.production) {
    if (!byDate.has(p.date)) byDate.set(p.date, { date: p.date, cases: {} });
    byDate.get(p.date).cases[p.item_no] = (byDate.get(p.date).cases[p.item_no] || 0) + n(p.cases);
  }
  const avgCache = new Map();
  const avg = (y) => { if (!avgCache.has(y)) avgCache.set(y, avgPricePerOz(data, y)); return avgCache.get(y); };
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1)).map((row) => {
    const perRecipe = new Map(); let oz = 0;
    for (const [fg, c] of Object.entries(row.cases)) {
      const m = recipeOz.get(Number(fg));
      if (m && m.size) for (const [r, q] of m) perRecipe.set(r, (perRecipe.get(r) || 0) + c * q);
      else oz += c * (ix.fgCaseOz.get(Number(fg)) || 0);
    }
    let batches = 0; let leftover = 0; const recipes = [];
    for (const [r, q] of perRecipe) {
      const B = ix.bom.has(r) ? ix.yieldOf(r) : fallbackB;
      const b = B ? Math.ceil(q / B - 1e-9) : 0; const left = b ? b * B - q : 0;
      oz += q; batches += b; leftover += left; recipes.push({ item_no: r, oz: q, batchSize: B, batches: b, leftoverOz: left });
    }
    return { ...row, oz, batches, leftoverOz: leftover, recipes, loss: leftover * avg(yearOf(row.date)) };
  });
}

// ---------- Consumption (hidden sheet) ----------
// How much of each raw material and packaging item one unit of a finished good
// uses, following its BOM down through every level. Labor and overhead are
// costs, not stock, so they are skipped.
export function perCaseUsage(data) {
  const ix = index(data); const out = new Map();
  const expand = (itemNo, per, m, path) => {
    if (path.has(itemNo)) return; path.add(itemNo);
    for (const l of ix.children(itemNo)) {
      if (l.uses_batch_minutes) continue;
      const q = (n(l.qty) * per) / ix.yieldOf(itemNo);
      const child = ix.items.get(l.item_no);
      if (ix.bom.has(l.item_no)) expand(l.item_no, q, m, path);
      else if (child?.type === 'Raw Material' || child?.type === 'Component') m.set(l.item_no, (m.get(l.item_no) || 0) + q);
    }
    path.delete(itemNo);
  };
  for (const fg of ix.byType('Finished Good')) { const m = new Map(); expand(fg.item_no, 1, m, new Set()); out.set(fg.item_no, m); }
  return out;
}

export function consumptionByDate(data) {
  const usage = perCaseUsage(data); const out = new Map();
  for (const p of data.production) {
    const u = usage.get(p.item_no); if (!u) continue;
    if (!out.has(p.date)) out.set(p.date, new Map());
    const day = out.get(p.date);
    for (const [item, q] of u) day.set(item, (day.get(item) || 0) + q * n(p.cases));
  }
  return out;
}

// ---------- Daily Inventory ----------
// Each item starts on its first cycle count. Every day after that:
//   inventory = (that day's count, or yesterday's inventory) + receipts - consumption
// Finished goods (not calculated in the workbook) use production in and sales out.
export function dailyInventory(data, to) {
  const ix = index(data);
  const tracked = [...ix.byType('Raw Material'), ...ix.byType('Component'), ...ix.byType('Finished Good')];
  const key = (d, i) => `${d}|${i}`;
  const counts = new Map(); const firstCount = new Map();
  for (const c of data.cycle_counts) {
    counts.set(key(c.date, c.item_no), (counts.get(key(c.date, c.item_no)) || 0) + n(c.qty));
    if (!firstCount.has(c.item_no) || c.date < firstCount.get(c.item_no)) firstCount.set(c.item_no, c.date);
  }
  const ins = new Map(); const add = (d, i, q) => ins.set(key(d, i), (ins.get(key(d, i)) || 0) + q);
  for (const r of data.goods_receipts) add(r.date, r.item_no, n(r.qty));
  for (const p of data.production) add(p.date, p.item_no, n(p.cases));
  for (const s of data.sales) if (s.item_no && ix.items.get(s.item_no)?.type === 'Finished Good') add(s.date, s.item_no, -n(s.quantity));
  const cons = consumptionByDate(data);
  const starts = [...firstCount.values()].sort();
  const from = starts[0];
  const result = { from, to, items: tracked, byItem: new Map() };
  if (!from) return result;
  for (const item of tracked) {
    const series = new Map(); const start = firstCount.get(item.item_no);
    if (!start) { result.byItem.set(item.item_no, series); continue; }
    let prev = 0;
    for (const d of eachDay(start, to)) {
      const counted = counts.get(key(d, item.item_no));
      const v = (counted !== undefined ? counted : prev) + (ins.get(key(d, item.item_no)) || 0) - (cons.get(d)?.get(item.item_no) || 0);
      series.set(d, v); prev = v;
    }
    result.byItem.set(item.item_no, series);
  }
  return result;
}

// ---------- Purchase Demand ----------
// Suggests a standard purchase on any day when (all purchases suggested so far
// + that day's inventory) is below the safety stock level.
export function purchaseDemand(data, inv) {
  const settings = new Map(data.purchase_settings.map((s) => [s.item_no, s]));
  const out = new Map();
  for (const [itemNo, series] of inv.byItem) {
    const s = settings.get(itemNo); if (!s) continue;
    const safety = n(s.safety_threshold) * n(s.lead_time) * n(s.manual_usage);
    let cumulative = 0; const sugg = new Map();
    for (const [d, v] of series) {
      const q = cumulative + v < safety ? n(s.standard_purchase) : 0;
      sugg.set(d, q); cumulative += q;
    }
    out.set(itemNo, { safety, suggestions: sugg });
  }
  return out;
}

// ---------- Sales Report ----------
export function salesRows(data) {
  const ix = index(data); const cm = costModel(data); const pm = priceModel(data);
  return data.sales.map((s) => {
    const y = yearOf(s.date); const q = n(s.quantity);
    const fg = s.item_no && ix.items.get(s.item_no)?.type === 'Finished Good' ? s.item_no : null;
    const oz = fg ? (ix.fgCaseOz.get(fg) || 0) * q : 0;
    const stdPrice = fg ? pm.nearest(fg, y) * q : 0;
    const stdCost = fg ? cm.nearest(fg, y) * q : 0;
    return { ...s, year: y, month: monthOf(s.date), oz, stdPrice, stdCost, stdMargin: stdPrice - stdCost };
  });
}

// ---------- Ending Inventory ----------
export function endingInventory(data, inv, year) {
  const cm = costModel(data);
  return inv.items.map((item) => {
    const series = inv.byItem.get(item.item_no) || new Map();
    const qty = Array.from({ length: 12 }, (_, m) => series.get(monthEnd(year, m + 1)) ?? 0);
    const unitCost = cm.cost(item.item_no, year) || cm.latest(item.item_no);
    return { item, qty, value: qty.map((q) => q * unitCost), unitCost };
  });
}

// ---------- YTD Dashboard ----------
export function dashboard(data, year, throughMonth = 12) {
  const rows = salesRows(data).filter((r) => r.year === year && r.month <= throughMonth);
  const byMonth = Array.from({ length: throughMonth }, (_, m) => ({ month: MONTHS[m], sales: 0, margin: 0 }));
  const group = (keyFn) => { const m = new Map(); for (const r of rows) { const k = keyFn(r); m.set(k, (m.get(k) || 0) + n(r.amount)); } return [...m].sort((a, b) => b[1] - a[1]); };
  for (const r of rows) { byMonth[r.month - 1].sales += n(r.amount); byMonth[r.month - 1].margin += r.stdMargin; }
  for (const m of byMonth) m.marginPct = m.sales ? m.margin / m.sales : 0;
  const loss = Array.from({ length: throughMonth }, (_, m) => ({ month: MONTHS[m], loss: 0 }));
  for (const p of productionDays(data)) if (yearOf(p.date) === year && monthOf(p.date) <= throughMonth) loss[monthOf(p.date) - 1].loss += p.loss;
  const totalSales = byMonth.reduce((s, m) => s + m.sales, 0);
  const totalMargin = byMonth.reduce((s, m) => s + m.margin, 0);
  return { byMonth, byProduct: group((r) => r.product || 'Other'), byCustomer: group((r) => r.customer || '(none)'), loss,
    totalSales, totalMargin, marginPct: totalSales ? totalMargin / totalSales : 0, totalLoss: loss.reduce((s, m) => s + m.loss, 0) };
}
