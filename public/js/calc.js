// Stans IMS calculation engine.
// Pure functions that reproduce the workbook's formulas. They take plain data
// (rows exactly as they come out of the database) and return plain results, so
// the same code runs in the browser and in tests/calc.test.mjs, which checks it
// against the numbers Excel calculated.

export const TYPES = ['Raw Material', 'Component', 'Indirect Cost', 'Recipe', 'Finished Good'];
// Item numbers are six digits; the first digit says the type.
export const ITEM_PREFIX = { 'Raw Material': 1, Component: 2, 'Indirect Cost': 3, Recipe: 4, 'Finished Good': 5 };
export const LABOR_ITEM = 300001; // "Direct Labor": its cost per minute comes from the Labor tab
const LEGACY_LABOR_ITEM = 10019;  // the workbook's number for it
export const isLaborItem = (itemNo) => itemNo === LABOR_ITEM || itemNo === LEGACY_LABOR_ITEM;
// The next free number for a type (e.g. 100010 after raw material 100009).
export function nextItemNo(items, type) {
  const p = ITEM_PREFIX[type] || 1;
  return Math.max(p * 100000, ...items.map((i) => i.item_no).filter((no) => Math.floor(no / 100000) === p)) + 1;
}
// Why an item number won't do for a type, or '' if it's fine.
export function itemNoProblem(itemNo, type) {
  const no = Number(itemNo); const p = ITEM_PREFIX[type];
  if (!Number.isInteger(no) || no < 100000 || no > 999999) return 'Item numbers are 6 digits.';
  if (p && Math.floor(no / 100000) !== p) return `${type} item numbers start with ${p} (${p}00001 to ${p}99999).`;
  return '';
}
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
  let s = String(text).trim().replace(/[,$]/g, '');
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
export function bomData(data, year) {
  let boms; let lines;
  if (Array.isArray(data.boms) && Array.isArray(data.bom_lines)) { boms = data.boms; lines = data.bom_lines; } else {
    boms = []; lines = [];
    for (const r of data.recipes || []) boms.push({ item_no: r.item_no, yield_qty: r.batch_size, yield_unit: 'oz' });
    for (const l of data.recipe_lines || []) lines.push({ id: `r${lines.length}`, parent_item_no: l.recipe_item_no, item_no: l.item_no, qty: l.qty, uses_batch_minutes: !!l.uses_batch_minutes, sort: l.sort });
    for (const fg of new Set((data.fg_lines || []).map((l) => l.fg_item_no))) boms.push({ item_no: fg, yield_qty: 1, yield_unit: 'case' });
    for (const l of data.fg_lines || []) lines.push({ id: `f${lines.length}`, parent_item_no: l.fg_item_no, item_no: l.item_no, qty: l.qty, uses_batch_minutes: false, sort: l.sort });
  }
  // BOMs by year: each BOM row starts in its `year` and carries forward until a
  // later year has its own. A year before an item's first BOM uses that first one.
  const vy = (r) => (r.year === null || r.year === undefined ? -Infinity : Number(r.year));
  const pick = new Map();
  for (const b of boms) {
    const y = vy(b); const cur = pick.get(b.item_no);
    const better = !cur || (y <= year ? (cur.y > year || y > cur.y) : (cur.y > year && y < cur.y));
    if (better) pick.set(b.item_no, { y, b });
  }
  const versionYear = new Map([...pick].map(([k, v]) => [k, v.y]));
  return { boms: [...pick.values()].map((v) => v.b), lines: lines.filter((l) => vy(l) === versionYear.get(l.parent_item_no)), versionYear };
}

// The years that have their own BOM for an item (sorted).
export const bomYears = (data, itemNo) => [...new Set((data.boms || []).filter((b) => b.item_no === itemNo).map((b) => b.year ?? null))].sort((a, b) => (a ?? -1e9) - (b ?? -1e9));

// ---------- lookups ----------
// `year` picks which year's BOMs to use (this year when not given).
export function index(data, year = new Date().getFullYear()) {
  const items = new Map(data.items.map((i) => [i.item_no, i]));
  const byType = (t) => data.items.filter((i) => i.type === t).sort((a, b) => a.sort - b.sort);
  const { boms, lines, versionYear } = bomData(data, year);
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
  // The year whose BOM is in use for an item (-Infinity for BOMs with no year).
  const bomYear = (itemNo) => versionYear.get(itemNo);
  return { year, items, byType, bom, children, yieldOf, laborMinutesOf, lineQty, fgCaseOz, usedIn, bomYear };
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
//   1. Paid cost of each position for the year:
//        base pay (hourly rate x paid hours, or annual salary)
//      + employer payroll taxes (% of base pay)
//      + fixed benefits (monthly for hourly people, annual for salaried).
//      Hourly people are paid for the hours they work in the weeks the line
//      runs (no paid time off); salaried people are paid all 52 weeks.
//   2. Line hours: the line runs the year's production hours a week, and
//      everyone who works the line is on it whenever it runs.
//   3. Labor rate = all labor cost / minutes on the line. A salaried
//      person's whole salary is spread over the minutes they're on the line.
// A labor minute is one person working one minute, as BOMs count minutes per batch.

export const LABOR_FIRST_YEAR = 2026;
export const FIRST_YEAR = 2026;
// The years shown everywhere on the site: 2026 through next year.
export const laborYears = (now = new Date().getFullYear()) => Array.from({ length: Math.max(1, now + 2 - LABOR_FIRST_YEAR) }, (_, i) => LABOR_FIRST_YEAR + i);
export const siteYears = laborYears;

const laborPlant = (y = {}) => ({ paidWeeks: 52, prodWeeks: y.labor_prod_weeks ?? 52, lineHours: n(y.labor_line_hours) });

// One position for the year. `lineHours` overrides the production hours a
// week (what-ifs). Everyone who works the line is on it whenever it runs:
// hourly people are paid for those hours; salaried people are paid their
// salary whatever the hours.
export function laborPosition(p, plant, lineHours) {
  const people = n(p.headcount); const sal = p.pay_type === 'salaried';
  const onLine = p.on_line !== false;
  const H = lineHours ?? plant.lineHours;
  const lineWeek = onLine ? H : 0;
  const lineHrs = people * lineWeek * plant.prodWeeks;
  const hourlyHours = onLine ? lineHrs : people * n(p.paid_hours_week) * plant.prodWeeks;
  const base = sal ? people * n(p.annual_salary) : hourlyHours * n(p.hourly_rate);
  const tax = base * n(p.payroll_tax_pct) / 100;
  const benefits = people * (sal ? n(p.annual_fixed) : n(p.monthly_fringe) * 12);
  const burdened = base + tax + benefits;
  return { position: p, people, salaried: sal, onLine, lineWeek, lineHours: lineHrs, base, tax, benefits, burdened, minutes: lineHrs * 60 };
}

// A year's labor setup. A year with its own people uses them; a year without
// starts from the year before (its own or forecast setup), with pay and fixed
// costs raised by the year's inflation adjustment %. Line hours and weeks
// carry over unless the year sets its own.
export const PAY_FIELDS = ['hourly_rate', 'monthly_fringe', 'annual_salary', 'annual_fixed'];
export function laborSetup(data, year, now = new Date().getFullYear()) {
  const ys = (data.year_settings || []).find((y) => y.year === year) || {};
  const own = (data.labor_positions || []).filter((p) => p.year === year);
  let out;
  if (own.length || year <= LABOR_FIRST_YEAR) {
    out = { year, positions: own, settings: ys, fromYear: null, inflation: 0, own: own.length > 0 };
  } else {
    const prev = laborSetup(data, year - 1, now);
    const infl = n(ys.labor_inflation_pct);
    const f = 1 + infl / 100;
    out = { year, fromYear: year - 1, inflation: infl, own: false,
      positions: prev.positions.map((p) => ({ ...p, id: `f${year}-${p.sourceId ?? p.id}`, sourceId: p.sourceId ?? p.id, year, forecast: true,
        ...Object.fromEntries(PAY_FIELDS.map((k) => [k, p[k] === null || p[k] === undefined ? p[k] : Math.round(n(p[k]) * f * 10000) / 10000])) })),
      settings: { ...ys, labor_line_hours: ys.labor_line_hours ?? prev.settings.labor_line_hours, labor_prod_weeks: ys.labor_prod_weeks ?? prev.settings.labor_prod_weeks } };
  }
  // A forecast until the year begins. A year that has begun without its own
  // people is still the forecast, and needs review.
  out.forecast = year > now || !out.own;
  out.needsReview = year <= now && !out.own && out.positions.length > 0;
  return out;
}

export function laborRate(data, { year, lineHours } = {}) {
  const setup = year === undefined ? { positions: data.labor_positions || [], settings: {} } : laborSetup(data, year);
  const plant = laborPlant(setup.settings);
  const rows = [...setup.positions].sort((a, b) => n(a.sort) - n(b.sort) || String(a.sourceId ?? a.id).localeCompare(String(b.sourceId ?? b.id), undefined, { numeric: true }))
    .map((p) => laborPosition(p, plant, lineHours));
  const sum = (f) => rows.reduce((t, r) => t + f(r), 0);
  const burdened = sum((r) => r.burdened); const minutes = sum((r) => r.minutes);
  const rate = minutes ? burdened / minutes : 0;
  const ix = data.items ? index(data, year) : null;
  const recipes = ix ? ix.byType('Recipe').filter((r) => ix.bom.has(r.item_no)).map((r) => {
    const batchOz = ix.yieldOf(r.item_no); const minutesPer = ix.laborMinutesOf(r.item_no);
    return { item: r, batchOz, minutesPer, perBatch: rate * minutesPer, perOz: batchOz ? (rate * minutesPer) / batchOz : 0, batchesPerYear: minutesPer ? minutes / minutesPer : 0 };
  }) : [];
  const H = lineHours ?? plant.lineHours;
  return { year, setup, plant, lineHoursWeek: H, crew: H ? sum((r) => r.people * r.lineWeek) / H : 0, rows, recipes, burdened, base: sum((r) => r.base), tax: sum((r) => r.tax), benefits: sum((r) => r.benefits),
    minutes, lineHours: sum((r) => r.lineHours), rate };
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
  const last = laborYears().at(-1);
  const rateFor = (year) => (hasPositions ? (year <= last ? forYear(year).rate : 0) : legacy[(years.get(year)?.labor_scenario || 0) - 1]?.ratePerMin ?? 0);
  return { hasPositions, years, forYear, rateFor };
}

// ---------- Standard Cost ----------
// Returns { years, cost(item_no, year), latest(item_no), recipeDetail, fgDetail }.
// Index of BOMs for each year, built when first needed.
function indexByYear(data) {
  const m = new Map();
  return (y) => { if (!m.has(y)) m.set(y, index(data, y)); return m.get(y); };
}

export function costModel(data) {
  const ixFor = indexByYear(data); const ix = ixFor(new Date().getFullYear());
  const entered = new Map(data.standard_costs.map((c) => [`${c.item_no}|${c.year}`, n(c.cost)]));
  const labor = laborModel(data);
  const years = siteYears();
  const memo = new Map();

  function cost(itemNo, year) {
    const key = `${itemNo}|${year}`;
    if (memo.has(key)) return memo.get(key);
    const item = ix.items.get(itemNo);
    memo.set(key, 0); // guards against a BOM loop
    let v = 0;
    const yx = ixFor(year);
    if (!item) v = 0;
    else if (yx.bom.has(itemNo)) {
      // Built from that year's BOM: cost of one run divided by what one run makes.
      v = yx.children(itemNo).reduce((s, l) => s + cost(l.item_no, year) * yx.lineQty(l), 0) / yx.yieldOf(itemNo);
    } else if (isLaborItem(itemNo)) {
      v = labor.rateFor(year);
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
  return { years, cost, latest, nearest, labor, ix, ixFor };
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
  const ix = index(data, year); const pm = priceModel(data);
  const fgs = ix.byType('Finished Good');
  if (!fgs.length) return 0;
  return fgs.reduce((s, f) => s + (ix.fgCaseOz.get(f.item_no) ? pm.price(f.item_no, year) / ix.fgCaseOz.get(f.item_no) : 0), 0) / fgs.length;
}

// ---------- Production ----------
// One row per production date: oz, batches and the estimated loss from the
// last, partly-used batch (Production!D:F). Each recipe is batched on its own,
// in its own batch size (the recipe BOM's "one run makes").
export function productionDays(data) {
  const ixFor = indexByYear(data);
  const fallbackB = n(data.settings.production_batch_size);
  // oz of each recipe in one case of each finished good, per year's BOMs
  const ozCache = new Map();
  const recipeOzFor = (ix) => {
    if (ozCache.has(ix.year)) return ozCache.get(ix.year);
    const recipeOz = new Map();
    for (const fg of ix.byType('Finished Good')) {
      const m = new Map();
      for (const l of ix.children(fg.item_no)) if (ix.items.get(l.item_no)?.type === 'Recipe') m.set(l.item_no, (m.get(l.item_no) || 0) + n(l.qty) / ix.yieldOf(fg.item_no));
      recipeOz.set(fg.item_no, m);
    }
    ozCache.set(ix.year, recipeOz); return recipeOz;
  };
  const byDate = new Map();
  for (const p of data.production) {
    if (!byDate.has(p.date)) byDate.set(p.date, { date: p.date, cases: {} });
    byDate.get(p.date).cases[p.item_no] = (byDate.get(p.date).cases[p.item_no] || 0) + n(p.cases);
  }
  const avgCache = new Map();
  const avg = (y) => { if (!avgCache.has(y)) avgCache.set(y, avgPricePerOz(data, y)); return avgCache.get(y); };
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1)).map((row) => {
    const ix = ixFor(yearOf(row.date)); const recipeOz = recipeOzFor(ix);
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
export function perCaseUsage(data, year) {
  const ix = index(data, year); const out = new Map();
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
  const byYear = new Map(); const out = new Map();
  const usageFor = (y) => { if (!byYear.has(y)) byYear.set(y, perCaseUsage(data, y)); return byYear.get(y); };
  for (const p of data.production) {
    const u = usageFor(yearOf(p.date)).get(p.item_no); if (!u) continue;
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
  const cm = costModel(data); const pm = priceModel(data);
  return data.sales.map((s) => {
    const y = yearOf(s.date); const q = n(s.quantity); const ix = cm.ixFor(y);
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

// ---------- Planning ----------
// Weeks start on Monday. Everything is planned from `today` forward.
export const mondayOf = (iso) => { const w = toDate(iso).getUTCDay(); return addDays(iso, -((w + 6) % 7)); };
export const PLAN_WEEKS = 12;        // weeks planned ahead
export const HISTORY_WEEKS = 13;     // a quarter of history behind each average
export const DEFAULT_LEAD_DAYS = 14; // every material: two weeks from order to delivery
export const FG_SAFETY_WEEKS = 1;    // finished goods: keep a week of forecast sales on hand
export const SERVICE_Z = 1.65;       // materials: 95% chance of not running out during the lead time
export const MIN_SAFETY_WEEKS = 1;   // ... and never less than a week of usage

// The 13 weeks of history an average is taken over: ending at the last week
// with activity on or before today (so a gap in entered data doesn't zero the
// forecast), as a list of Monday dates.
function historyWeeks(dates, today, weeks = HISTORY_WEEKS) {
  const past = dates.filter((d) => d <= today);
  const end = mondayOf(past.length ? past.reduce((a, b) => (a > b ? a : b)) : today);
  return Array.from({ length: weeks }, (_, i) => addDays(end, -7 * (weeks - 1 - i)));
}
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const stdev = (a) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };

// Demand plan for finished goods.
//   forecast: a typed-in number of cases for a product and week (demand_forecast),
//             otherwise the product's average weekly sales over the history weeks.
//   safety stock: FG_SAFETY_WEEKS of the average forecast.
//   planned production: enough cases in a week to end it at or above safety stock.
export function demandPlan(data, { today, inv, weeks = PLAN_WEEKS }) {
  const ix = index(data, yearOf(today));
  const fgs = ix.byType('Finished Good');
  const hist = historyWeeks(data.sales.filter((s) => s.item_no).map((s) => s.date), today);
  const histStart = hist[0]; const histEnd = addDays(hist.at(-1), 6);
  const sold = new Map();
  for (const s of data.sales) {
    if (!s.item_no || s.date < histStart || s.date > histEnd) continue;
    const k = `${s.item_no}|${mondayOf(s.date)}`; sold.set(k, (sold.get(k) || 0) + n(s.quantity));
  }
  const entered = new Map((data.demand_forecast || []).map((f) => [`${f.item_no}|${f.week}`, f.cases]));
  const start = mondayOf(today);
  const weekList = Array.from({ length: weeks }, (_, i) => addDays(start, 7 * i));
  const rows = fgs.map((item) => {
    const history = hist.map((w) => sold.get(`${item.item_no}|${w}`) || 0);
    const avg = mean(history);
    const onHand = inv?.byItem.get(item.item_no)?.get(today) ?? 0;
    const cells = weekList.map((w) => { const e = entered.get(`${item.item_no}|${w}`); const typed = e !== undefined && e !== null; return { week: w, forecast: typed ? n(e) : avg, typed }; });
    const safety = Math.ceil(mean(cells.map((c) => c.forecast)) * FG_SAFETY_WEEKS);
    let proj = onHand;
    for (const c of cells) {
      const short = c.forecast + safety - proj;
      c.production = short > 0 ? Math.ceil(short - 1e-9) : 0;
      proj = proj + c.production - c.forecast; c.endOnHand = proj;
    }
    return { item, history, avg, onHand, safety, weeks: cells };
  });
  // Recipe batches the planned production needs each week (each recipe in its own batch size).
  const batches = ix.byType('Recipe').filter((r) => ix.bom.has(r.item_no)).map((recipe) => {
    const size = ix.yieldOf(recipe.item_no);
    const perCase = new Map(fgs.map((fg) => [fg.item_no, ix.children(fg.item_no).filter((l) => l.item_no === recipe.item_no).reduce((t, l) => t + n(l.qty), 0) / ix.yieldOf(fg.item_no)]));
    const weeks = weekList.map((w, i) => { const oz = rows.reduce((t, r) => t + r.weeks[i].production * (perCase.get(r.item.item_no) || 0), 0); return { week: w, oz, batches: size ? Math.ceil(oz / size - 1e-9) : 0 }; });
    return { recipe, size, unit: ix.bom.get(recipe.item_no)?.yield_unit || recipe.unit || '', weeks };
  }).filter((b) => b.weeks.some((w) => w.oz));
  return { weeks: weekList, history: { from: histStart, to: histEnd }, rows, batches };
}

// Material requirements: what the planned production uses up each week (from
// that year's BOMs), and the purchases needed to stay above safety stock.
//   lead time: purchase_settings.lead_days, else DEFAULT_LEAD_DAYS.
//   safety stock: purchase_settings.safety_stock, else the larger of
//     SERVICE_Z x (week-to-week spread of past usage) x sqrt(lead time in weeks)
//     and MIN_SAFETY_WEEKS of planned usage.
//   order size: enough to get back to safety stock plus two weeks of planned
//     usage, rounded up to the standard purchase (case / pallet) when one is set.
export function materialPlan(data, plan, { today, inv }) {
  const ix = index(data, yearOf(today));
  const mats = [...ix.byType('Raw Material'), ...ix.byType('Component')];
  const settings = new Map((data.purchase_settings || []).map((s) => [s.item_no, s]));
  const usageByYear = new Map(); const usageFor = (y) => { if (!usageByYear.has(y)) usageByYear.set(y, perCaseUsage(data, y)); return usageByYear.get(y); };
  // planned usage per material per week
  const need = new Map();
  for (const r of plan.rows) for (const c of r.weeks) {
    if (!c.production) continue;
    for (const [m, q] of usageFor(yearOf(c.week)).get(r.item.item_no) || []) {
      const k = `${m}|${c.week}`; need.set(k, (need.get(k) || 0) + q * c.production);
    }
  }
  // past usage per material per week (standard usage from production)
  const cons = consumptionByDate(data);
  const hist = historyWeeks(data.production.map((p) => p.date), today);
  const histStart = hist[0]; const histEnd = addDays(hist.at(-1), 6);
  const used = new Map();
  for (const [d, m] of cons) {
    if (d < histStart || d > histEnd) continue;
    const w = mondayOf(d);
    for (const [it, q] of m) { const k = `${it}|${w}`; used.set(k, (used.get(k) || 0) + q); }
  }
  // open purchase orders arrive in the week they're due (overdue ones: this week)
  const onOrder = new Map();
  for (const po of openOrders(data)) {
    const w = po.due < plan.weeks[0] ? plan.weeks[0] : mondayOf(po.due);
    const k = `${po.item_no}|${w}`; onOrder.set(k, (onOrder.get(k) || 0) + n(po.qty));
  }
  const rows = mats.map((item) => {
    const s = settings.get(item.item_no) || {};
    const leadDays = s.lead_days === null || s.lead_days === undefined || s.lead_days === '' ? DEFAULT_LEAD_DAYS : n(s.lead_days);
    const past = hist.map((w) => used.get(`${item.item_no}|${w}`) || 0);
    const weeks = plan.weeks.map((w) => ({ week: w, need: need.get(`${item.item_no}|${w}`) || 0 }));
    const avgPlanned = mean(weeks.map((c) => c.need));
    const avgPast = mean(past);
    const autoSafety = Math.max(SERVICE_Z * stdev(past) * Math.sqrt(leadDays / 7), MIN_SAFETY_WEEKS * Math.max(avgPlanned, avgPast));
    const typedSafety = s.safety_stock !== null && s.safety_stock !== undefined && s.safety_stock !== '';
    const safety = typedSafety ? n(s.safety_stock) : autoSafety;
    const multiple = n(s.standard_purchase) || 0;
    const onHand = inv?.byItem.get(item.item_no)?.get(today) ?? 0;
    const orders = [];
    let proj = onHand;
    // A new order can't arrive before one lead time from today; until then only
    // open orders help, and a week that ends below safety stock is a shortage.
    const earliest = mondayOf(addDays(today, leadDays));
    for (const c of weeks) {
      c.onOrder = onOrder.get(`${item.item_no}|${c.week}`) || 0;
      proj += c.onOrder - c.need; c.receipt = 0;
      c.short = c.week < earliest && proj < safety;
      if (proj < safety && c.week >= earliest) {
        let qty = safety - proj + 2 * avgPlanned;
        qty = multiple ? Math.ceil(qty / multiple - 1e-9) * multiple : Math.ceil(qty - 1e-9);
        const orderBy = addDays(c.week, -leadDays);
        orders.push({ week: c.week, qty, orderBy, late: orderBy < today });
        c.receipt = qty; proj += qty;
      }
      c.endOnHand = proj;
    }
    const next = orders[0] || null;
    const openQty = weeks.reduce((t, c) => t + c.onOrder, 0);
    const status = !next ? 'ok' : next.orderBy <= today ? 'now' : next.orderBy <= addDays(today, 7) ? 'soon' : 'planned';
    return { item, leadDays, earliest, short: weeks.some((c) => c.short), safety, typedSafety, autoSafety, multiple, avgPlanned, avgPast, onHand, openQty,
      reorderPoint: avgPlanned * (leadDays / 7) + safety, weeks, orders, next, status };
  });
  return { weeks: plan.weeks, history: { from: histStart, to: histEnd }, rows };
}

// ---------- Consumption ----------
// Standard usage: what production used according to the BOMs (consumptionByDate).
// Actual usage between two cycle counts of an item: the first count, plus what
// was received, minus the second count (a count is taken at the start of its
// day, before that day's deliveries and production). The difference from
// standard is the variance: loss, waste, or a BOM that's off.
export function countToCount(data) {
  const cons = consumptionByDate(data);
  const counts = new Map();
  for (const c of data.cycle_counts) { const k = `${c.item_no}|${c.date}`; counts.set(k, (counts.get(k) || 0) + n(c.qty)); }
  const byItem = new Map();
  for (const k of counts.keys()) { const [i, d] = k.split('|'); if (!byItem.has(+i)) byItem.set(+i, []); byItem.get(+i).push(d); }
  const receipts = new Map();
  for (const r of data.goods_receipts) { const k = `${r.item_no}|${r.date}`; receipts.set(k, (receipts.get(k) || 0) + n(r.qty)); }
  const ix = index(data);
  const out = [];
  for (const [itemNo, dates] of byItem) {
    const item = ix.items.get(itemNo);
    if (!item || (item.type !== 'Raw Material' && item.type !== 'Component')) continue;
    dates.sort();
    for (let i = 1; i < dates.length; i++) {
      const from = dates[i - 1]; const to = dates[i];
      let received = 0; let standard = 0;
      for (const d of eachDay(from, addDays(to, -1))) { received += receipts.get(`${itemNo}|${d}`) || 0; standard += cons.get(d)?.get(itemNo) || 0; }
      const start = counts.get(`${itemNo}|${from}`); const end = counts.get(`${itemNo}|${to}`);
      const actual = start + received - end;
      out.push({ item, from, to, start, received, end, actual, standard, variance: actual - standard });
    }
  }
  return out.sort((a, b) => (a.to < b.to ? 1 : a.to > b.to ? -1 : a.item.sort - b.item.sort));
}

// Standard usage of each material by month for a year (qty).
export function usageByMonth(data, year) {
  const cons = consumptionByDate(data); const out = new Map();
  for (const [d, m] of cons) {
    if (yearOf(d) !== year) continue;
    for (const [it, q] of m) { if (!out.has(it)) out.set(it, Array(12).fill(0)); out.get(it)[monthOf(d) - 1] += q; }
  }
  return out;
}

// ---------- Purchase orders ----------
// A purchase order is open until it's received or cancelled. Receiving one
// records the delivery on Goods Receipt; its price against the standard cost
// is the purchase price variance (PPV).
export const openOrders = (data) => (data.purchase_orders || []).filter((po) => !po.received && !po.cancelled);
export function poStatus(po, today) {
  if (po.cancelled) return 'cancelled';
  if (po.received) return 'received';
  return po.due < today ? 'late' : 'open';
}
// PPV of a received order: (price paid - standard cost that year) x qty received.
// Positive is unfavorable (paid more than standard).
export function poVariance(po, cm) {
  if (!po.received || po.unit_price === null || po.unit_price === undefined || po.unit_price === '') return null;
  const std = cm.cost(po.item_no, yearOf(po.received)) || cm.latest(po.item_no);
  return (n(po.unit_price) - std) * n(po.received_qty ?? po.qty);
}

// ---------- Journal entries ----------
// The workbook's standard-cost entries (A-H) with amounts for a month, built
// from the day-to-day data. Lines are { account, dr, cr, basis }; each entry's
// debits equal its credits.
//   A/B purchases: deliveries at standard cost; received purchase orders add the
//       price variance (PPV); deliveries without an order are taken at standard.
//   C/D payroll and overhead paid: actual amounts come from the books, so they
//       aren't posted here (the variance accounts show only what production absorbed).
//   E production: finished goods at standard cost, built up from the BOMs into
//       raw materials, components, labor and overhead absorbed.
//   F cycle counts: count minus the running inventory just before it, at standard.
//   G sales: revenue at actual, cost of goods sold at standard.
//   H recosting (January only): inventory at Dec 31 revalued from last year's to
//       this year's standard costs.
export const ACCOUNTS = {
  cash: 'Cash', rm: 'Inventory: Raw Materials', cp: 'Inventory: Components', fg: 'Inventory: Finished Goods',
  revenue: 'Sales Revenue', cogs: 'COGS', ppvRm: 'PPV - Raw Materials', ppvCp: 'PPV - Components',
  labor: 'MFG Variance - Labor', overhead: 'MFG Variance - Overhead', adj: 'Inventory Adjustments',
};
const invAccount = (type) => (type === 'Raw Material' ? 'rm' : type === 'Component' ? 'cp' : 'fg');

// What one unit of an item costs, split by where the cost comes from.
function costParts(cm, ix, itemNo, year, seen = new Set()) {
  const out = { rm: 0, cp: 0, labor: 0, overhead: 0 };
  if (seen.has(itemNo)) return out; seen.add(itemNo);
  for (const l of ix.children(itemNo)) {
    const per = ix.lineQty(l) / ix.yieldOf(itemNo);
    const child = ix.items.get(l.item_no);
    if (ix.bom.has(l.item_no)) { const p = costParts(cm, ix, l.item_no, year, seen); for (const k in out) out[k] += p[k] * per; continue; }
    const v = cm.cost(l.item_no, year) * per;
    if (child?.type === 'Raw Material') out.rm += v;
    else if (child?.type === 'Component') out.cp += v;
    else if (child?.type === 'Indirect Cost') out[isLaborItem(l.item_no) ? 'labor' : 'overhead'] += v;
  }
  seen.delete(itemNo);
  return out;
}

export function journalEntries(data, year, month, inv) {
  const cm = costModel(data); const ix = cm.ixFor(year);
  const inMonth = (d) => d && yearOf(d) === year && monthOf(d) === month;
  const std = (itemNo) => cm.cost(itemNo, year) || cm.latest(itemNo);
  const L = (account, dr, cr, basis) => ({ account: ACCOUNTS[account], key: account, dr: dr || 0, cr: cr || 0, basis });
  const signed = (account, v, basis) => (v >= 0 ? L(account, v, 0, basis) : L(account, 0, -v, basis));
  const entries = [];

  // A / B purchases
  for (const [code, type, inv_, ppv, title] of [['A', 'Raw Material', 'rm', 'ppvRm', 'Purchase of Raw Materials'], ['B', 'Component', 'cp', 'ppvCp', 'Purchase of Components']]) {
    let stdTotal = 0; let unfav = 0; let fav = 0;
    for (const r of data.goods_receipts) if (inMonth(r.date) && ix.items.get(r.item_no)?.type === type) stdTotal += n(r.qty) * std(r.item_no);
    for (const po of data.purchase_orders || []) {
      if (!inMonth(po.received) || ix.items.get(po.item_no)?.type !== type) continue;
      const v = poVariance(po, cm); if (v > 0) unfav += v; else if (v < 0) fav -= v;
    }
    entries.push({ code, title, lines: [L(inv_, stdTotal, 0, 'Deliveries at standard cost'), L(ppv, unfav, 0, 'Paid more than standard'), L(ppv, 0, fav, 'Paid less than standard'),
      L('cash', 0, stdTotal + unfav - fav, 'Actual cost (standard + price variance)')] });
  }
  entries.push({ code: 'C', title: 'Paying Payroll', note: 'Actual payroll comes from the books, so it isn’t posted here.', lines: [] });
  entries.push({ code: 'D', title: 'Paying Overhead', note: 'Actual overhead comes from the books, so it isn’t posted here.', lines: [] });

  // E production
  const prod = { fg: 0, rm: 0, cp: 0, labor: 0, overhead: 0 };
  for (const p of data.production) {
    if (!inMonth(p.date)) continue;
    const parts = costParts(cm, ix, p.item_no, year); const c = n(p.cases);
    for (const k of ['rm', 'cp', 'labor', 'overhead']) prod[k] += parts[k] * c;
  }
  prod.fg = prod.rm + prod.cp + prod.labor + prod.overhead;
  entries.push({ code: 'E', title: 'Production of Goods', lines: [L('fg', prod.fg, 0, 'Cases produced at standard cost'), L('rm', 0, prod.rm, 'Standard usage'), L('cp', 0, prod.cp, 'Standard usage'),
    L('labor', 0, prod.labor, 'Labor absorbed at standard'), L('overhead', 0, prod.overhead, 'Overhead absorbed at standard')] });

  // F cycle counts
  const adjBy = { rm: 0, cp: 0, fg: 0 };
  const counted = new Map();
  for (const c of data.cycle_counts) { if (!inMonth(c.date)) continue; const k = `${c.item_no}|${c.date}`; counted.set(k, (counted.get(k) || 0) + n(c.qty)); }
  for (const [k, q] of counted) {
    const [itemNo, date] = k.split('|'); const it = ix.items.get(+itemNo); if (!it) continue;
    const before = inv?.byItem.get(+itemNo)?.get(addDays(date, -1));
    if (before === undefined) continue; // the first count of an item starts its inventory
    adjBy[invAccount(it.type)] += (q - before) * std(+itemNo);
  }
  const adjTotal = adjBy.rm + adjBy.cp + adjBy.fg;
  entries.push({ code: 'F', title: 'Cycle Counts', lines: [signed('adj', -adjTotal, adjTotal <= 0 ? 'Counted less than expected (shrinkage)' : 'Counted more than expected'),
    ...['rm', 'cp', 'fg'].map((a) => signed(a, adjBy[a], 'Count − running inventory, at standard'))] });

  // G sales
  let revenue = 0; let cogs = 0;
  for (const r of salesRows(data)) { if (!inMonth(r.date)) continue; revenue += n(r.amount); cogs += r.stdCost; }
  entries.push({ code: 'G', title: 'Sale of Goods', lines: [L('cash', revenue, 0, 'Invoiced amounts'), L('revenue', 0, revenue, 'Invoiced amounts'), L('cogs', cogs, 0, 'Cases sold at standard cost'), L('fg', 0, cogs, 'Cases sold at standard cost')] });

  // H recosting (January)
  if (month === 1 && inv) {
    const old = { rm: 0, cp: 0, fg: 0 }; const neu = { rm: 0, cp: 0, fg: 0 };
    const dec31 = `${year - 1}-12-31`;
    for (const it of inv.items) {
      const q = inv.byItem.get(it.item_no)?.get(dec31); if (!q) continue;
      const a = invAccount(it.type); old[a] += q * (cm.cost(it.item_no, year - 1) || 0); neu[a] += q * (cm.cost(it.item_no, year) || 0);
    }
    const lines = [];
    for (const a of ['rm', 'cp', 'fg']) { if (old[a] || neu[a]) lines.push(signed(a, neu[a] - old[a], `Dec 31 inventory: ${year} standard − ${year - 1} standard`)); }
    const net = ['rm', 'cp', 'fg'].reduce((s, a) => s + neu[a] - old[a], 0);
    lines.push(signed('adj', -net, 'Revaluation'));
    entries.push({ code: 'H', title: 'Updating Standards at Year Beginning', lines });
  } else entries.push({ code: 'H', title: 'Updating Standards at Year Beginning', note: 'Posted in January only.', lines: [] });

  for (const e of entries) { e.lines = e.lines.filter((l) => Math.abs(l.dr) > 0.004 || Math.abs(l.cr) > 0.004); e.dr = e.lines.reduce((s, l) => s + l.dr, 0); e.cr = e.lines.reduce((s, l) => s + l.cr, 0); }
  return entries;
}

// Debits and credits by account for a set of months' entries.
export function ledger(entriesList) {
  const acc = new Map(Object.values(ACCOUNTS).map((a) => [a, { account: a, dr: [], cr: [] }]));
  for (const { label, entries } of entriesList) for (const e of entries) for (const l of e.lines) {
    const a = acc.get(l.account);
    if (l.dr) a.dr.push({ code: e.code, title: e.title, label, amount: l.dr });
    if (l.cr) a.cr.push({ code: e.code, title: e.title, label, amount: l.cr });
  }
  for (const a of acc.values()) { a.drTotal = a.dr.reduce((s, x) => s + x.amount, 0); a.crTotal = a.cr.reduce((s, x) => s + x.amount, 0); a.balance = a.drTotal - a.crTotal; }
  return acc;
}

// ---------- Cycle count sheet ----------
// For a count date: what the running inventory expects at the start of the day
// (the end of the day before), next to what was counted.
export const COUNT_TOLERANCE = 0.1; // differences over 10% are flagged
export function countSheet(data, inv, date, items) {
  const counts = new Map();
  for (const c of data.cycle_counts) if (c.date === date) counts.set(c.item_no, (counts.get(c.item_no) || 0) + n(c.qty));
  return items.map((item) => {
    const expected = inv?.byItem.get(item.item_no)?.get(addDays(date, -1));
    const counted = counts.has(item.item_no) ? counts.get(item.item_no) : null;
    const diff = counted === null || expected === undefined ? null : counted - expected;
    const pct = diff === null ? null : expected ? diff / Math.abs(expected) : (diff ? 1 : 0);
    return { item, expected: expected ?? null, counted, diff, pct, flag: pct !== null && Math.abs(pct) > COUNT_TOLERANCE };
  });
}

// ---------- Missing standards ----------
// Items whose standard cost is typed in (raw materials, packaging, indirect
// costs other than direct labor) with no cost for the year, and finished goods
// with no standard price for the year.
export function missingStandards(data, year) {
  const ix = index(data, year);
  const has = (list, field) => new Set(list.filter((r) => r.year === year && r[field] !== null && r[field] !== undefined && r[field] !== '').map((r) => r.item_no));
  const costs = has(data.standard_costs, 'cost'); const prices = has(data.standard_prices, 'price');
  const typed = data.items.filter((i) => i.type === 'Raw Material' || i.type === 'Component' || (i.type === 'Indirect Cost' && !isLaborItem(i.item_no)));
  return { costs: typed.filter((i) => !costs.has(i.item_no)), prices: ix.byType('Finished Good').filter((i) => !prices.has(i.item_no)) };
}
