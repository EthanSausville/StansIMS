// Talks to Supabase: sign-in, loading every table, and saving changes.
// All data is small enough to keep in memory, so the app loads it once,
// recalculates locally, and writes each change straight to the database.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import * as C from './calc.js';

const cfg = window.STANS_CONFIG || {};
export const configured = Boolean(cfg.supabaseUrl && cfg.supabaseKey);
export const sb = configured ? createClient(cfg.supabaseUrl, cfg.supabaseKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } }) : null;

export const state = { data: null, profile: null, user: null, version: 0, loadedAt: 0 };
const listeners = new Set();
export const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
function changed() { state.version++; derivedCache.clear(); for (const fn of listeners) fn(); }

// ---------- loading ----------
const TABLES = {
  items: 'sort', standard_costs: 'year', standard_prices: 'year', recipes: 'item_no', recipe_lines: 'sort',
  fg_lines: 'sort', year_settings: 'year', purchase_settings: 'item_no', production: 'date',
  goods_receipts: 'date', cycle_counts: 'date', sales: 'date',
};

async function fetchAll(table, order) {
  const rows = []; const page = 1000;
  for (let from = 0; ; from += page) {
    let q = sb.from(table).select('*').order(order).range(from, from + page - 1);
    if (table === 'sales') q = q.order('id');
    const { data, error } = await q;
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
  sales: () => memo('sales', () => C.salesRows(state.data)),
  years: () => memo('years', () => {
    const d = state.data; const ys = new Set(derived.costs().years);
    for (const r of [...d.production, ...d.sales]) ys.add(C.yearOf(r.date));
    ys.add(new Date().getFullYear());
    return [...ys].sort((a, b) => a - b);
  }),
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

export async function listProfiles() { return run(sb.from('profiles').select('*').order('created_at')); }
export async function setRole(userId, role) { return run(sb.from('profiles').update({ role }).eq('user_id', userId).select().single()); }
