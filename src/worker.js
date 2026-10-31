// The Cloudflare Worker in front of the site:
//   /config.js        the Supabase project URL and publishable key (public by
//                     design: the data is protected by sign-in and row-level
//                     security, not by hiding them).
//   /api/admin/users  user management for admins (invite, add, change, disable,
//                     delete...). It needs the Supabase secret key, which only
//                     ever lives here as a Worker secret (SUPABASE_SERVICE_ROLE_KEY),
//                     never in the browser or the repository. Every request must
//                     carry the signed-in admin's own session; the Worker checks
//                     it with Supabase and checks the account is an enabled admin
//                     before doing anything, and records what it did in the
//                     Change history.
//   everything else   the static site in ./public (security headers: public/_headers).

const SECURITY_HEADERS = {
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
};
const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS },
});

const ROLES = new Set(['staff', 'admin']);
const EMAIL = /^[^\s@<>()[\],;:"]{1,64}@[^\s@<>()[\],;:"]{1,190}\.[a-z]{2,24}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIN_PASSWORD = 10;
const FOREVER = '876000h'; // a disabled account's sign-in ban (100 years)

// A few requests a minute per admin is plenty; this slows down anything automated.
const recent = new Map();
function tooMany(key, limit = 40, windowMs = 60_000) {
  const now = Date.now(); const list = (recent.get(key) || []).filter((t) => now - t < windowMs);
  list.push(now); recent.set(key, list);
  if (recent.size > 5000) recent.clear();
  return list.length > limit;
}

class Fail extends Error { constructor(status, message) { super(message); this.status = status; } }

function supa(env) {
  const url = (env.SUPABASE_URL || '').replace(/\/$/, '');
  const anon = env.SUPABASE_ANON_KEY || env.SUPABASE_PUBLISHABLE_KEY || '';
  const secret = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY || '';
  const service = { apikey: secret, Authorization: `Bearer ${secret}` };
  const call = async (path, { method = 'GET', body, headers = service, prefer } = {}) => {
    const res = await fetch(url + path, {
      method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { ...headers, 'content-type': 'application/json', ...(prefer ? { Prefer: prefer } : {}) },
    });
    const text = await res.text(); let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      const msg = (data && (data.msg || data.message || data.error_description || data.error)) || `Supabase said ${res.status}`;
      throw new Fail(res.status >= 500 ? 502 : 400, String(msg));
    }
    return data;
  };
  return { url, anon, secret, call };
}

// The person asking: their session must be valid, and they must be an enabled admin.
async function caller(request, s) {
  const auth = request.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token || token.length > 4096) throw new Fail(401, 'Sign in again.');
  let user;
  try { user = await s.call('/auth/v1/user', { headers: { apikey: s.anon, Authorization: `Bearer ${token}` } }); }
  catch { throw new Fail(401, 'Your session has ended. Sign in again.'); }
  if (!user?.id) throw new Fail(401, 'Sign in again.');
  const rows = await s.call(`/rest/v1/profiles?user_id=eq.${user.id}&select=role,disabled,email`);
  const p = rows?.[0];
  if (!p || p.role !== 'admin' || p.disabled) throw new Fail(403, 'Only admins can manage users.');
  return { id: user.id, email: p.email || user.email };
}

async function audit(s, who, action, row) {
  try {
    await s.call('/rest/v1/audit_log', { method: 'POST', prefer: 'return=minimal',
      body: { user_id: who.id, email: who.email, table_name: 'users', action, new_row: row } });
  } catch { /* the change itself still happened */ }
}

async function profiles(s) { return s.call('/rest/v1/profiles?select=*'); }
async function setProfile(s, id, patch) {
  const rows = await s.call(`/rest/v1/profiles?user_id=eq.${id}`, { method: 'PATCH', body: patch, prefer: 'return=representation' });
  if (!rows?.length) throw new Fail(404, 'That user wasn’t found.');
  return rows[0];
}
async function waitForProfile(s, id) {
  for (let i = 0; i < 10; i++) { const r = await s.call(`/rest/v1/profiles?user_id=eq.${id}&select=user_id`); if (r?.length) return; await new Promise((ok) => setTimeout(ok, 200)); }
  throw new Fail(502, 'The account was made, but its profile didn’t appear. Refresh and try again.');
}
// Never leave the site without an enabled admin.
async function otherAdmins(s, id) {
  const all = await profiles(s);
  return all.filter((p) => p.role === 'admin' && !p.disabled && p.user_id !== id).length;
}

const clean = {
  email(v) { const e = String(v || '').trim().toLowerCase(); if (!EMAIL.test(e)) throw new Fail(400, 'Enter a valid email address.'); return e; },
  name(v) { const n = String(v ?? '').replace(/[\u0000-\u001f<>]/g, '').trim(); if (n.length > 80) throw new Fail(400, 'Names can be up to 80 characters.'); return n || null; },
  role(v) { if (!ROLES.has(v)) throw new Fail(400, 'Role must be staff or admin.'); return v; },
  id(v) { if (!UUID.test(String(v || ''))) throw new Fail(400, 'Unknown user.'); return String(v); },
  password(v) {
    const p = String(v || '');
    if (p.length < MIN_PASSWORD) throw new Fail(400, `Passwords need at least ${MIN_PASSWORD} characters.`);
    if (p.length > 72) throw new Fail(400, 'Passwords can be up to 72 characters.');
    if (!/[a-z]/i.test(p) || !/[0-9]/.test(p)) throw new Fail(400, 'Use letters and at least one number.');
    return p;
  },
};

async function listUsers(s) {
  const [auth, profs] = await Promise.all([s.call('/auth/v1/admin/users?page=1&per_page=1000'), profiles(s)]);
  const byId = new Map(profs.map((p) => [p.user_id, p]));
  return (auth.users || []).map((u) => {
    const p = byId.get(u.id) || {};
    return { id: u.id, email: u.email, name: p.name || u.user_metadata?.name || null, role: p.role || 'staff', disabled: !!p.disabled,
      created_at: u.created_at, last_sign_in_at: u.last_sign_in_at || null, confirmed: !!(u.email_confirmed_at || u.confirmed_at),
      invited_at: u.invited_at || null, banned: !!(u.banned_until && new Date(u.banned_until) > new Date()) };
  });
}

async function handleAdmin(request, env, url) {
  const s = supa(env);
  if (!s.url || !s.anon) throw new Fail(500, 'The site isn’t connected to Supabase.');
  if (!s.secret) return json(200, { configured: false, users: null });
  // Only this site's own pages may call this.
  const origin = request.headers.get('origin');
  if (request.method !== 'GET' && origin !== url.origin) throw new Fail(403, 'Not allowed.');
  const who = await caller(request, s);
  if (tooMany(who.id)) throw new Fail(429, 'Too many requests. Wait a minute and try again.');

  if (request.method === 'GET') return json(200, { configured: true, users: await listUsers(s), me: who.id });
  if (request.method !== 'POST') throw new Fail(405, 'Not allowed.');
  const raw = await request.text();
  if (raw.length > 10_000) throw new Fail(413, 'Too much.');
  let b; try { b = JSON.parse(raw); } catch { throw new Fail(400, 'Bad request.'); }
  const redirectTo = `${url.origin}/`;

  switch (b.action) {
    case 'invite': {
      const email = clean.email(b.email); const role = clean.role(b.role || 'staff'); const name = clean.name(b.name);
      const u = await s.call(`/auth/v1/invite?redirect_to=${encodeURIComponent(redirectTo)}`, { method: 'POST', body: { email, data: { name } } });
      await waitForProfile(s, u.id);
      await setProfile(s, u.id, { role, name, disabled: false, email });
      await audit(s, who, 'invite', { email, role, name });
      return json(200, { ok: true, message: `Invitation sent to ${email}.` });
    }
    case 'create': {
      const email = clean.email(b.email); const role = clean.role(b.role || 'staff'); const name = clean.name(b.name); const password = clean.password(b.password);
      const u = await s.call('/auth/v1/admin/users', { method: 'POST', body: { email, password, email_confirm: true, user_metadata: { name } } });
      await waitForProfile(s, u.id);
      await setProfile(s, u.id, { role, name, disabled: false, email });
      await audit(s, who, 'create', { email, role, name });
      return json(200, { ok: true, message: `${email} can sign in now with the password you set.` });
    }
    case 'update': {
      const id = clean.id(b.id); const patch = {};
      if ('name' in b) patch.name = clean.name(b.name);
      if ('role' in b) {
        patch.role = clean.role(b.role);
        if (patch.role !== 'admin' && id === who.id) throw new Fail(400, 'You can’t remove your own admin access.');
        if (patch.role !== 'admin' && !(await otherAdmins(s, id))) throw new Fail(400, 'There must be at least one admin.');
      }
      if ('email' in b) {
        patch.email = clean.email(b.email);
        await s.call(`/auth/v1/admin/users/${id}`, { method: 'PUT', body: { email: patch.email, email_confirm: true } });
      }
      const p = await setProfile(s, id, patch);
      await audit(s, who, 'update', { email: p.email, ...patch });
      return json(200, { ok: true, message: 'Saved.' });
    }
    case 'disable': case 'enable': {
      const id = clean.id(b.id); const off = b.action === 'disable';
      if (off && id === who.id) throw new Fail(400, 'You can’t disable your own account.');
      if (off && !(await otherAdmins(s, id))) throw new Fail(400, 'There must be at least one admin.');
      const p = await setProfile(s, id, { disabled: off });
      await s.call(`/auth/v1/admin/users/${id}`, { method: 'PUT', body: { ban_duration: off ? FOREVER : 'none' } });
      await audit(s, who, b.action, { email: p.email });
      return json(200, { ok: true, message: off ? `${p.email} can no longer sign in.` : `${p.email} can sign in again.` });
    }
    case 'reset': {
      const id = clean.id(b.id);
      const p = (await s.call(`/rest/v1/profiles?user_id=eq.${id}&select=email`))?.[0];
      if (!p?.email) throw new Fail(404, 'That user wasn’t found.');
      await s.call(`/auth/v1/recover?redirect_to=${encodeURIComponent(redirectTo)}`, { method: 'POST', body: { email: p.email }, headers: { apikey: s.anon } });
      await audit(s, who, 'password reset email', { email: p.email });
      return json(200, { ok: true, message: `Password reset email sent to ${p.email}.` });
    }
    case 'password': {
      const id = clean.id(b.id); const password = clean.password(b.password);
      await s.call(`/auth/v1/admin/users/${id}`, { method: 'PUT', body: { password } });
      const p = (await s.call(`/rest/v1/profiles?user_id=eq.${id}&select=email`))?.[0];
      await audit(s, who, 'set password', { email: p?.email });
      return json(200, { ok: true, message: 'Password changed. Give it to them privately; they can change it under Settings → My Account.' });
    }
    case 'resend': {
      const id = clean.id(b.id);
      const p = (await s.call(`/rest/v1/profiles?user_id=eq.${id}&select=email`))?.[0];
      if (!p?.email) throw new Fail(404, 'That user wasn’t found.');
      await s.call(`/auth/v1/invite?redirect_to=${encodeURIComponent(redirectTo)}`, { method: 'POST', body: { email: p.email } });
      await audit(s, who, 'resend invite', { email: p.email });
      return json(200, { ok: true, message: `Invitation sent again to ${p.email}.` });
    }
    case 'delete': {
      const id = clean.id(b.id);
      if (id === who.id) throw new Fail(400, 'You can’t delete your own account.');
      if (!(await otherAdmins(s, id))) throw new Fail(400, 'There must be at least one admin.');
      const p = (await s.call(`/rest/v1/profiles?user_id=eq.${id}&select=email`))?.[0];
      await s.call(`/auth/v1/admin/users/${id}`, { method: 'DELETE' });
      await audit(s, who, 'delete', { email: p?.email });
      return json(200, { ok: true, message: `${p?.email || 'The user'} was deleted. What they entered stays.` });
    }
    default: throw new Fail(400, 'Unknown action.');
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/config.js') {
      const config = {
        supabaseUrl: env.SUPABASE_URL || env.VITE_SUPABASE_URL || '',
        supabaseKey: env.SUPABASE_ANON_KEY || env.SUPABASE_PUBLISHABLE_KEY || env.VITE_SUPABASE_ANON_KEY || '',
      };
      return new Response(`window.STANS_CONFIG = ${JSON.stringify(config)};\n`, {
        headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS },
      });
    }
    if (url.pathname === '/api/admin/users') {
      try { return await handleAdmin(request, env, url); }
      catch (e) { return json(e instanceof Fail ? e.status : 500, { error: e instanceof Fail ? e.message : 'Something went wrong.' }); }
    }
    if (url.pathname.startsWith('/api/')) return json(404, { error: 'Not found.' });
    return env.ASSETS.fetch(request);
  },
};
