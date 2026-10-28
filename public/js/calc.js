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

// ---------- lookups ----------
export function index(data) {
  const items = new Map(data.items.map((i) => [i.item_no, i]));
  const byType = (t) => data.items.filter((i) => i.type === t).sort((a, b) => a.sort - b.sort);
  const fgCaseOz = new Map(); // finished good -> oz of recipe per case (Production row 2)
  const fgRecipe = new Map();
  for (const l of data.fg_lines) {
    if (items.get(l.item_no)?.type === 'Recipe') { fgCaseOz.set(l.fg_item_no, n(l.qty)); fgRecipe.set(l.fg_item_no, l.item_no); }
  }
  return { items, byType, fgCaseOz, fgRecipe };
}

// ---------- Labor Scenarios ----------
// Scenario k = working k days a week, 8 hours a day, 52 weeks.
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

// ---------- Standard Cost ----------
// Returns { years, cost(item_no, year), latest(item_no), recipeDetail, fgDetail }.
export function costModel(data) {
  const ix = index(data);
  const entered = new Map(data.standard_costs.map((c) => [`${c.item_no}|${c.year}`, n(c.cost)]));
  const scenarios = laborScenarios(data.settings);
  const scenarioByYear = new Map(data.year_settings.map((y) => [y.year, y.labor_scenario]));
  const yearsSet = new Set([...data.standard_costs.map((c) => c.year), ...data.year_settings.map((y) => y.year),
    ...data.standard_prices.map((p) => p.year)]);
  const first = yearsSet.size ? Math.min(...yearsSet) : new Date().getFullYear();
  const years = Array.from({ length: 10 }, (_, i) => first + i); // the workbook carries ten years
  const minutes = n(data.settings.minutes_per_batch);
  const memo = new Map();

  function cost(itemNo, year) {
    const key = `${itemNo}|${year}`;
    if (memo.has(key)) return memo.get(key);
    const item = ix.items.get(itemNo);
    let v = 0;
    if (!item) v = 0;
    else if (itemNo === LABOR_ITEM) {
      const sc = scenarioByYear.get(year);
      v = sc ? scenarios[sc - 1].ratePerMin : 0;
    } else if (item.type === 'Recipe') {
      const recipe = data.recipes.find((r) => r.item_no === itemNo);
      const batch = n(recipe?.batch_size);
      v = batch ? data.recipe_lines.filter((l) => l.recipe_item_no === itemNo)
        .reduce((s, l) => s + cost(l.item_no, year) * (l.uses_batch_minutes ? minutes : n(l.qty)), 0) / batch : 0;
    } else if (item.type === 'Finished Good') {
      v = data.fg_lines.filter((l) => l.fg_item_no === itemNo).reduce((s, l) => s + cost(l.item_no, year) * n(l.qty), 0);
    } else v = entered.get(key) ?? 0;
    memo.set(key, v);
    return v;
  }
  // "Latest Cost": the last year with a non-zero cost.
  const latest = (itemNo) => { for (let i = years.length - 1; i >= 0; i--) { const v = cost(itemNo, years[i]); if (v) return v; } return 0; };
  // Cost for a year, falling back to the nearest year that has standards.
  const nearest = (itemNo, year) => {
    const direct = cost(itemNo, year); if (direct) return direct;
    const ys = years.filter((y) => cost(itemNo, y)).sort((a, b) => Math.abs(a - year) - Math.abs(b - year) || a - b);
    return ys.length ? cost(itemNo, ys[0]) : 0;
  };
  return { years, cost, latest, nearest, scenarios, ix };
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
// last, partly-used batch (Production!D:F).
export function productionDays(data) {
  const ix = index(data);
  const B = n(data.settings.production_batch_size);
  const byDate = new Map();
  for (const p of data.production) {
    if (!byDate.has(p.date)) byDate.set(p.date, { date: p.date, cases: {} });
    byDate.get(p.date).cases[p.item_no] = (byDate.get(p.date).cases[p.item_no] || 0) + n(p.cases);
  }
  const avgCache = new Map();
  const avg = (y) => { if (!avgCache.has(y)) avgCache.set(y, avgPricePerOz(data, y)); return avgCache.get(y); };
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1)).map((row) => {
    const oz = Object.entries(row.cases).reduce((s, [fg, c]) => s + c * (ix.fgCaseOz.get(Number(fg)) || 0), 0);
    const batches = B ? Math.ceil(oz / B - 1e-9) : 0;
    const leftover = batches ? batches * B - oz : 0;
    return { ...row, oz, batches, leftoverOz: leftover, loss: leftover * avg(yearOf(row.date)) };
  });
}

// ---------- Consumption (hidden sheet) ----------
// How much of each raw material / component one case of a finished good uses.
export function perCaseUsage(data) {
  const ix = index(data); const out = new Map();
  for (const fg of ix.byType('Finished Good')) {
    const m = new Map();
    const recipeNo = ix.fgRecipe.get(fg.item_no);
    const caseOz = ix.fgCaseOz.get(fg.item_no) || 0;
    const recipe = data.recipes.find((r) => r.item_no === recipeNo);
    if (recipe && n(recipe.batch_size)) {
      for (const l of data.recipe_lines.filter((x) => x.recipe_item_no === recipeNo)) {
        if (l.uses_batch_minutes || ix.items.get(l.item_no)?.type !== 'Raw Material') continue;
        m.set(l.item_no, (m.get(l.item_no) || 0) + (n(l.qty) / n(recipe.batch_size)) * caseOz);
      }
    }
    for (const l of data.fg_lines.filter((x) => x.fg_item_no === fg.item_no)) {
      if (ix.items.get(l.item_no)?.type === 'Component') m.set(l.item_no, (m.get(l.item_no) || 0) + n(l.qty));
    }
    out.set(fg.item_no, m);
  }
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
