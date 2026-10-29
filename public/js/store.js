// Talks to Supabase: sign-in, loading every table, and saving changes.
// All data is small enough to keep in memory, so the app loads it once,
// recalculates locally, and writes each change straight to the database.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import * as C from './calc.js';
import { todayIso } from './ui.js';

const cfg = window.STANS_CONFIG || {};
export const configured = Boolean(cfg.supabaseUrl && cfg.supabaseKey);
export const sb = configured ? createClient(cfg.supabaseUrl, cfg.supabaseKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } }) : null;

export const state = { data: null, profile: null, user: null, version: 0, loadedAt: 0 };
const listeners = new Set();
export const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
function changed() { state.version++; derivedCache.clear(); for (const fn of listeners) fn(); }

// ---------- loading ----------
const TABLES = {
  items: 'sort', standard_costs: 'year', standard_prices: 'year', boms: 'item_no', bom_lines: 'sort', year_settings: 'year', purchase_settings: 'item_no', production: 'date',
  sales_imports: 'created_at', qb_name_map: 'kind',
  labor_positions: 'sort', demand_forecast: 'week',
  goods_receipts: 'date', cycle_counts: 'date', sales: 'date',
};

// Tables added after the first release: until the database has been updated
// (schema.sql), they load as empty instead of stopping the whole site.
const OPTIONAL = new Set(['labor_positions', 'demand_forecast']);
const missingTable = (e) => /does not exist|could not find the table|schema cache/i.test(e?.message || '') || e?.code === '42P01' || e?.code === 'PGRST205';

const missing = new Set();
async function fetchAll(table, order) {
  const rows = []; const page = 1000;
  for (let from = 0; ; from += page) {
    let q = sb.from(table).select('*').order(order).range(from, from + page - 1);
    if (table === 'sales') q = q.order('id');
    const { data, error } = await q;
    if (error && OPTIONAL.has(table) && missingTable(error)) { missing.add(table); return []; }
    if (error) throw error;
    rows.push(...data);
    if (data.length < page) return rows;
  }
}

export async function loadAll() {
  const entries = await Promise.all(Object.entries(TABLES).map(async ([t, o]) => [t, await fetchAll(t, o)]));
  const data = Object.fromEntries(entries);
  const { data: s, error } = await sb.from('settings').select('*').eq('id', 1).maybeSingle();
  if (error) throw error;
  data.settings = s || { id: 1 };
  data.missingTables = new Set(missing);
  state.data = data; state.loadedAt = Date.now();
  changed();
  return data;
}

export async function loadProfile() {
  const { data: { user } } = await sb.auth.getUser();
  state.user = user;
  if (!user) { state.profile = null; return null; }
  const { data, error } = await sb.from('profiles').select('*').eq('user_id', user.id).maybeSingle();
  if (error) throw error;
  state.profile = data || { role: 'staff', email: user.email };
  return state.profile;
}

export const isAdmin = () => state.profile?.role === 'admin';

// ---------- derived results (recomputed only when data changes) ----------
const derivedCache = new Map();
function memo(key, fn) { if (!derivedCache.has(key)) derivedCache.set(key, fn()); return derivedCache.get(key); }
export const derived = {
  ix: () => memo('ix', () => C.index(state.data)),
  costs: () => memo('costs', () => C.costModel(state.data)),
  prices: () => memo('prices', () => C.priceModel(state.data)),
  production: () => memo('production', () => C.productionDays(state.data)),
  consumption: () => memo('consumption', () => C.consumptionByDate(state.data)),
  horizon: () => memo('horizon', () => {
    const d = state.data; const dates = [...d.production, ...d.goods_receipts, ...d.cycle_counts, ...d.sales].map((r) => r.date);
    const lastYear = Math.max(new Date().getFullYear(), ...dates.map(C.yearOf));
    return `${lastYear}-12-31`;
  }),
  inventory: () => memo('inventory', () => C.dailyInventory(state.data, derived.horizon())),
  demand: () => memo('demand', () => C.purchaseDemand(state.data, derived.inventory())),
  plan: () => memo('plan', () => C.demandPlan(state.data, { today: todayIso(), inv: derived.inventory() })),
  materials: () => memo('materials', () => C.materialPlan(state.data, derived.plan(), { today: todayIso(), inv: derived.inventory() })),
  counts: () => memo('counts', () => C.countToCount(state.data)),
  lots: () => memo('lots', () => C.productionLots(state.data)),
  sales: () => memo('sales', () => C.salesRows(state.data)),
  // 2026 through next year, everywhere on the site.
  years: () => memo('years', () => C.siteYears()),
};

// ---------- saving ----------
async function run(promise) { const { data, error } = await promise; if (error) throw error; return data; }
const same = (a, b, keys) => keys.every((k) => String(a[k]) === String(b[k]));

// Upserts (value) or deletes (null) one keyed cell such as production[date,item].
export async function saveCell(table, key, field, value) {
  const keys = Object.keys(key); const list = state.data[table];
  if (value === null) {
    let q = sb.from(table).delete(); for (const k of keys) q = q.eq(k, key[k]);
    await run(q);
    const i = list.findIndex((r) => same(r, key, keys)); if (i >= 0) list.splice(i, 1);
  } else {
    const row = await run(sb.from(table).upsert({ ...key, [field]: value }, { onConflict: keys.join(',') }).select().single());
    const i = list.findIndex((r) => same(r, key, keys)); if (i >= 0) list[i] = row; else list.push(row);
  }
  changed();
}

// Sets one field on a keyed row, creating the row if needed (never deletes).
export async function saveField(table, key, field, value) {
  const keys = Object.keys(key); const list = state.data[table];
  const existing = list.find((r) => same(r, key, keys));
  const row = await run(sb.from(table).upsert({ ...(existing || {}), ...key, [field]: value }, { onConflict: keys.join(',') }).select().single());
  const i = list.findIndex((r) => same(r, key, keys)); if (i >= 0) list[i] = row; else list.push(row);
  changed();
}

// Saves a whole BOM: optionally creates the item it makes, sets what one run
// makes, and makes its lines match `lines` (updating, adding and removing).
// Saves an item's BOM for one year (from that year on, until a later year has
// its own). Lines with an id are that year's existing lines.
export async function saveBom({ newItem, itemNo, year, yieldQty, yieldUnit, laborMinutes, lines }) {
  const d = state.data;
  if (newItem) d.items.push(await run(sb.from('items').insert(newItem).select().single()));
  const bom = await run(sb.from('boms').upsert({ item_no: itemNo, year, yield_qty: yieldQty, yield_unit: yieldUnit || null, labor_minutes: laborMinutes ?? null }, { onConflict: 'item_no,year' }).select().single());
  const bi = d.boms.findIndex((b) => b.item_no === itemNo && b.year === year); if (bi >= 0) d.boms[bi] = bom; else d.boms.push(bom);
  const existing = d.bom_lines.filter((l) => l.parent_item_no === itemNo && l.year === year);
  const keep = new Set(lines.filter((l) => l.id).map((l) => l.id));
  for (const old of existing.filter((l) => !keep.has(l.id))) {
    await run(sb.from('bom_lines').delete().eq('id', old.id));
    d.bom_lines.splice(d.bom_lines.findIndex((l) => l.id === old.id), 1);
  }
  for (const [i, l] of lines.entries()) {
    const row = { parent_item_no: itemNo, year, item_no: l.item_no, qty: l.uses_batch_minutes ? null : l.qty, uses_batch_minutes: !!l.uses_batch_minutes, sort: i + 1 };
    if (l.id) {
      const saved = await run(sb.from('bom_lines').update(row).eq('id', l.id).select().single());
      d.bom_lines[d.bom_lines.findIndex((x) => x.id === l.id)] = saved;
    } else d.bom_lines.push(await run(sb.from('bom_lines').insert(row).select().single()));
  }
  changed();
}

// Removes an item's BOM for one year (its lines go with it); an earlier
// year's BOM, if any, then carries on. The item itself stays.
export async function deleteBom(itemNo, year) {
  await run(sb.from('boms').delete().eq('item_no', itemNo).eq('year', year));
  const d = state.data;
  d.boms = d.boms.filter((b) => !(b.item_no === itemNo && b.year === year));
  d.bom_lines = d.bom_lines.filter((l) => !(l.parent_item_no === itemNo && l.year === year));
  changed();
}

// Adds converted QuickBooks lines to Sales Detail as one import (so it can be
// undone), and saves any QuickBooks names the user confirmed.
export async function importSales({ fileName, period, from, to, rows, skipped, names }) {
  if (names.length) {
    const saved = await run(sb.from('qb_name_map').upsert(names, { onConflict: 'kind,qb_name' }).select());
    for (const n of saved) {
      const i = state.data.qb_name_map.findIndex((x) => x.kind === n.kind && x.qb_name === n.qb_name);
      if (i >= 0) state.data.qb_name_map[i] = n; else state.data.qb_name_map.push(n);
    }
  }
  const imp = await run(sb.from('sales_imports').insert({ file_name: fileName, period, date_from: from, date_to: to,
    lines_added: rows.length, lines_skipped: skipped }).select().single());
  const added = [];
  try {
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500).map((r) => ({ ...r, import_id: imp.id }));
      added.push(...await run(sb.from('sales').insert(chunk).select()));
    }
  } catch (err) {
    // Leave nothing half-loaded: removing the import removes its rows.
    await sb.from('sales').delete().eq('import_id', imp.id);
    await sb.from('sales_imports').delete().eq('id', imp.id);
    throw err;
  }
  state.data.sales_imports.push(imp);
  state.data.sales.push(...added);
  changed();
  return { imp, added: added.length };
}

// Removes an import and every Sales Detail row it added.
export async function undoSalesImport(id) {
  await run(sb.from('sales').delete().eq('import_id', id));
  await run(sb.from('sales_imports').delete().eq('id', id));
  state.data.sales = state.data.sales.filter((l) => l.import_id !== id);
  state.data.sales_imports = state.data.sales_imports.filter((i) => i.id !== id);
  changed();
}

export async function insertRow(table, row) {
  const saved = await run(sb.from(table).insert(row).select().single());
  state.data[table].push(saved); changed(); return saved;
}

export async function updateRow(table, keyField, keyValue, patch) {
  const saved = await run(sb.from(table).update(patch).eq(keyField, keyValue).select().single());
  const list = state.data[table]; const i = list.findIndex((r) => r[keyField] === keyValue);
  if (i >= 0) list[i] = saved; changed(); return saved;
}

export async function deleteRow(table, keyField, keyValue) {
  await run(sb.from(table).delete().eq(keyField, keyValue));
  const list = state.data[table]; const i = list.findIndex((r) => r[keyField] === keyValue);
  if (i >= 0) list.splice(i, 1); changed();
}

export async function saveSettings(patch) {
  const saved = await run(sb.from('settings').upsert({ id: 1, ...state.data.settings, ...patch }).select().single());
  state.data.settings = saved; changed();
}

export async function listAudit(limit = 500) { return run(sb.from('audit_log').select('*').order('at', { ascending: false }).range(0, limit - 1)); }
export async function listProfiles() { return run(sb.from('profiles').select('*').order('created_at')); }
export async function setRole(userId, role) { return run(sb.from('profiles').update({ role }).eq('user_id', userId).select().single()); }

// Upserts a keyed row with several fields at once (creating it if needed).
export async function saveRow(table, key, patch) {
  const keys = Object.keys(key); const list = state.data[table];
  const existing = list.find((r) => same(r, key, keys));
  const row = await run(sb.from(table).upsert({ ...(existing || {}), ...key, ...patch }, { onConflict: keys.join(',') }).select().single());
  const i = list.findIndex((r) => same(r, key, keys)); if (i >= 0) list[i] = row; else list.push(row);
  changed(); return row;
}
