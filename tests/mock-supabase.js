// In-memory stand-in for @supabase/supabase-js, used only by tests/ui_test.py
// to exercise the site in a headless browser without a real database.
// It supports the small part of the API the app uses.
const KEYS = {
  items: ['item_no'], standard_costs: ['item_no', 'year'], standard_prices: ['item_no', 'year'], recipes: ['item_no'],
  recipe_lines: ['id'], fg_lines: ['id'], boms: ['item_no', 'year'], bom_lines: ['id'], settings: ['id'], year_settings: ['year'], purchase_settings: ['item_no'],
  production: ['date', 'item_no'], goods_receipts: ['date', 'item_no'], cycle_counts: ['date', 'item_no'], sales: ['id'], profiles: ['user_id'], sales_imports: ['id'], qb_name_map: ['kind', 'qb_name'],
  labor_positions: ['id'], audit_log: ['id'], production_plan: ['item_no', 'week'],
};
const ADMIN_ONLY = new Set(['boms', 'bom_lines', 'items', 'standard_costs', 'standard_prices', 'recipes', 'recipe_lines', 'fg_lines', 'settings', 'year_settings', 'purchase_settings', 'labor_positions', 'production_plan']);

// Supabase's public sign-in settings, as Site Health reads them.
window.__MOCK_AUTH_SETTINGS__ ||= { disable_signup: true };

// Stand-in for the Worker's /api/admin/users (Settings → Users), working on
// the in-memory profiles. Tests can turn it off (__MOCK_NO_ADMIN_API__) to see
// the page before the secret key is set up.
if (!window.__MOCK_NO_ADMIN_API__) window.__MOCK_ADMIN_API__ = async (method, body) => {
  const db = window.__MOCK_DB__; const ps = (db.profiles ||= []); const me = 'u1';
  const log = (action, row) => (db.audit_log ||= []).push({ id: (db.audit_log.length + 1), at: new Date().toISOString(), user_id: me, email: 'owner@stans.test', table_name: 'users', action, new_row: row });
  const find = (id) => { const p = ps.find((x) => x.user_id === id); if (!p) throw new Error('That user wasn’t found.'); return p; };
  const admins = (id) => ps.filter((p) => p.role === 'admin' && !p.disabled && p.user_id !== id).length;
  if (method === 'GET') return { configured: true, me, users: ps.map((p) => ({ id: p.user_id, email: p.email, name: p.name || null, role: p.role, disabled: !!p.disabled, created_at: p.created_at,
    last_sign_in_at: p.last_sign_in_at || null, confirmed: p.confirmed !== false })) };
  const b = body || {};
  switch (b.action) {
    case 'invite': case 'create': {
      if (!/^\S+@\S+\.\S+$/.test(b.email || '')) throw new Error('Enter a valid email address.');
      if (ps.some((p) => p.email === b.email.toLowerCase())) throw new Error('A user with this email address has already been registered');
      ps.push({ user_id: 'u' + (ps.length + 10), email: b.email.toLowerCase(), name: b.name || null, role: b.role || 'staff', disabled: false, created_at: new Date().toISOString(), confirmed: b.action === 'create' });
      log(b.action, { email: b.email, role: b.role }); return { ok: true, message: b.action === 'invite' ? `Invitation sent to ${b.email}.` : `${b.email} can sign in now with the password you set.` };
    }
    case 'update': {
      const p = find(b.id);
      if ('role' in b && b.role !== 'admin' && (b.id === me || !admins(b.id))) throw new Error('There must be at least one admin.');
      for (const k of ['name', 'role', 'email']) if (k in b) p[k] = b[k];
      log('update', b); return { ok: true, message: 'Saved.' };
    }
    case 'disable': case 'enable': {
      const p = find(b.id);
      if (b.action === 'disable' && b.id === me) throw new Error('You can’t disable your own account.');
      if (b.action === 'disable' && !admins(b.id)) throw new Error('There must be at least one admin.');
      p.disabled = b.action === 'disable'; log(b.action, { email: p.email }); return { ok: true, message: 'Done.' };
    }
    case 'reset': case 'resend': case 'password': { const p = find(b.id); p['last_' + b.action] = true; log(b.action, { email: p.email }); return { ok: true, message: 'Done.' }; }
    case 'delete': {
      if (b.id === me) throw new Error('You can’t delete your own account.');
      const i = ps.findIndex((p) => p.user_id === b.id); if (i < 0) throw new Error('That user wasn’t found.');
      ps.splice(i, 1); log('delete', { id: b.id }); return { ok: true, message: 'Deleted.' };
    }
    default: throw new Error('Unknown action.');
  }
};

export function createClient() {
  const db = window.__MOCK_DB__;
  const role = () => window.__MOCK_ROLE__ || 'admin';
  let session = window.__MOCK_SIGNED_IN__ ? { user: { id: 'u1', email: 'owner@stans.test' } } : null;
  const subs = [];
  const emit = (ev) => subs.forEach((f) => f(ev, session));
  let nextId = 100000;

  class Query {
    constructor(table) { this.t = table; this.filters = []; this.op = 'select'; this.one = false; this.maybe = false; this.orders = []; this.rng = null; }
    select() { if (this.op === 'select') this.op = 'select'; this.returning = true; return this; }
    order(col, opts) { this.orders.push([col, opts?.ascending === false ? -1 : 1]); return this; }
    range(a, b) { this.rng = [a, b]; return this; }
    eq(col, v) { this.filters.push([col, v]); return this; }
    single() { this.one = true; return this; }
    maybeSingle() { this.maybe = true; return this; }
    insert(row) { this.op = 'insert'; this.payload = row; return this; }
    upsert(row) { this.op = 'upsert'; this.payload = row; return this; }
    update(patch) { this.op = 'update'; this.payload = patch; return this; }
    delete() { this.op = 'delete'; return this; }
    match(r) { return this.filters.every(([c, v]) => String(r[c]) === String(v)); }
    then(res, rej) { return Promise.resolve().then(() => this.run()).then(res, rej); }
    run() {
      const rows = (db[this.t] ||= []);
      const keys = KEYS[this.t];
      const deny = () => ({ data: null, error: { message: `new row violates row-level security policy for table "${this.t}"` } });
      if (this.op !== 'select' && ADMIN_ONLY.has(this.t) && role() !== 'admin') return deny();
      const out = (list) => {
        if (this.one) return list.length === 1 ? { data: { ...list[0] }, error: null } : { data: null, error: { message: 'Expected one row' } };
        if (this.maybe) return { data: list[0] ? { ...list[0] } : null, error: null };
        return { data: list.map((r) => ({ ...r })), error: null };
      };
      if (this.op === 'select') {
        let list = rows.filter((r) => this.match(r));
        for (const [o, dir] of [...this.orders].reverse()) list = [...list].sort((a, b) => dir * (a[o] < b[o] ? -1 : a[o] > b[o] ? 1 : 0));
        if (this.rng) list = list.slice(this.rng[0], this.rng[1] + 1);
        return out(list);
      }
      if ((this.op === 'insert' || this.op === 'upsert') && Array.isArray(this.payload)) {
        const made = this.payload.map((p) => {
          const row = { ...p }; if (keys[0] === 'id' && row.id === undefined) row.id = nextId++;
          const i = this.op === 'upsert' ? rows.findIndex((r) => keys.every((k) => String(r[k]) === String(row[k]))) : -1;
          if (i >= 0) { rows[i] = { ...rows[i], ...row }; return rows[i]; }
          rows.push(row); return row;
        });
        return out(made);
      }
      if (this.op === 'insert' || this.op === 'upsert') {
        const row = { ...this.payload };
        if (keys[0] === 'id' && row.id === undefined) row.id = nextId++;
        const i = rows.findIndex((r) => keys.every((k) => String(r[k]) === String(row[k])));
        if (i >= 0 && this.op === 'insert') return { data: null, error: { message: 'duplicate key value' } };
        if (i >= 0) rows[i] = { ...rows[i], ...row }; else rows.push(row);
        return out([i >= 0 ? rows[i] : row]);
      }
      if (this.op === 'update') {
        const hit = rows.filter((r) => this.match(r)); hit.forEach((r) => Object.assign(r, this.payload)); return out(hit);
      }
      if (this.op === 'delete') {
        for (let i = rows.length - 1; i >= 0; i--) if (this.match(rows[i])) rows.splice(i, 1);
        return { data: null, error: null };
      }
    }
  }

  return {
    from: (t) => new Query(t),
    auth: {
      async getSession() { return { data: { session } }; },
      async getUser() { return { data: { user: session?.user || null } }; },
      onAuthStateChange(f) { subs.push(f); return { data: { subscription: { unsubscribe() {} } } }; },
      async signInWithPassword({ email, password }) {
        if (password !== 'correct-horse') return { error: { message: 'Invalid login credentials' } };
        session = { user: { id: 'u1', email } }; setTimeout(() => emit('SIGNED_IN')); return { data: { session }, error: null };
      },
      async signOut() { session = null; setTimeout(() => emit('SIGNED_OUT')); return { error: null }; },
      async resetPasswordForEmail() { return { error: null }; },
      async updateUser() { return { data: {}, error: null }; },
    },
  };
}
