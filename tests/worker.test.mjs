// The Worker's user-management API (src/worker.js), against a fake Supabase.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

const ADMIN = '11111111-1111-1111-1111-111111111111';
const STAFF = '22222222-2222-2222-2222-222222222222';
const ORIGIN = 'https://stansims.example.workers.dev';
const env = (extra = {}) => ({ SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_ANON_KEY: 'sb_publishable_x', SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_y',
  ASSETS: { fetch: async () => new Response('asset') }, ...extra });

// A tiny Supabase: sessions by token, profiles, auth users, and a log of calls.
function fakeSupabase() {
  const db = {
    sessions: { 'tok-admin': ADMIN, 'tok-staff': STAFF },
    profiles: [{ user_id: ADMIN, email: 'owner@x.com', role: 'admin', disabled: false }, { user_id: STAFF, email: 'staff@x.com', role: 'staff', disabled: false }],
    users: [{ id: ADMIN, email: 'owner@x.com', email_confirmed_at: '2026-01-01' }, { id: STAFF, email: 'staff@x.com', email_confirmed_at: '2026-01-01' }],
    calls: [], audit: [],
  };
  global.fetch = async (u, opts = {}) => {
    const url = new URL(u); const path = url.pathname; const method = opts.method || 'GET';
    const body = opts.body ? JSON.parse(opts.body) : null; const hdr = opts.headers || {};
    db.calls.push({ method, path: path + url.search, body, hdr });
    const ok = (data, status = 200) => new Response(JSON.stringify(data), { status });
    const service = hdr.apikey === 'sb_secret_y' || hdr.apikey === 'eyJlegacy';
    // Supabase refuses a new-style secret key sent as a Bearer token (it isn't a JWT).
    if ((hdr.Authorization || '').startsWith('Bearer sb_')) return ok({ message: 'Invalid JWT' }, 401);
    if (path === '/rest/v1/rpc/check_identity') {
      const id = db.sessions[(hdr.Authorization || '').slice(7)]; if (!id || hdr.apikey !== 'sb_publishable_x') return ok({ message: 'JWT' }, 401);
      if (db.locked) return ok({ message: 'Too many wrong tries. Wait 15 minutes and try again.' }, 400);
      return ok(body.p_password ? body.p_password === 'Current-pass1' : (body.p_answers || []).every((a) => a.answer === 'right') && body.p_answers?.length === 3);
    }
    if (path === '/auth/v1/user') { const id = db.sessions[(hdr.Authorization || '').slice(7)]; return id ? ok({ id }) : ok({ msg: 'invalid JWT' }, 401); }
    if (!service && path !== '/auth/v1/recover') return ok({ msg: 'needs the secret key' }, 401);
    if (path === '/rest/v1/profiles') {
      const m = (url.searchParams.get('user_id') || '').replace('eq.', '');
      const rows = m ? db.profiles.filter((p) => p.user_id === m) : db.profiles;
      if (method === 'PATCH') { rows.forEach((p) => Object.assign(p, body)); return ok(rows); }
      return ok(rows);
    }
    if (path === '/rest/v1/audit_log') { db.audit.push(body); return new Response('', { status: 201 }); }
    if (path === '/auth/v1/admin/users' && method === 'GET') return ok({ users: db.users });
    if ((path === '/auth/v1/admin/users' && method === 'POST') || path === '/auth/v1/invite') {
      if (db.users.some((x) => x.email === body.email)) return ok({ msg: 'A user with this email address has already been registered' }, 422);
      const id = '33333333-3333-3333-3333-33333333333' + db.users.length;
      db.users.push({ id, email: body.email }); db.profiles.push({ user_id: id, email: body.email, role: 'staff', disabled: true });
      return ok({ id, email: body.email });
    }
    const m = path.match(/^\/auth\/v1\/admin\/users\/(.+)$/);
    if (m && method === 'PUT') return ok({ id: m[1] });
    if (m && method === 'DELETE') { db.users = db.users.filter((x) => x.id !== m[1]); db.profiles = db.profiles.filter((p) => p.user_id !== m[1]); return ok({}); }
    if (path === '/auth/v1/recover') return ok({});
    return ok({ msg: 'not found' }, 404);
  };
  return db;
}
const call = (e, { method = 'POST', token = 'tok-admin', origin = ORIGIN, body } = {}) => worker.fetch(new Request(`${ORIGIN}/api/admin/users`, {
  method, headers: { authorization: `Bearer ${token}`, origin, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }), e);

test('config.js and other paths', async () => {
  const r = await worker.fetch(new Request(`${ORIGIN}/config.js`), env());
  assert.match(await r.text(), /sb_publishable_x/);
  assert.doesNotMatch(await (await worker.fetch(new Request(`${ORIGIN}/config.js`), env())).text(), /sb_secret/, 'the secret key never reaches the browser');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal((await worker.fetch(new Request(`${ORIGIN}/api/nothing`), env())).status, 404);
  assert.equal(await (await worker.fetch(new Request(`${ORIGIN}/index.html`), env())).text(), 'asset');
});

test('without the secret key it says so and does nothing', async () => {
  fakeSupabase();
  const r = await call(env({ SUPABASE_SERVICE_ROLE_KEY: '' }), { method: 'GET' });
  assert.deepEqual(await r.json(), { configured: false, users: null });
});

test('only an enabled admin with a valid session gets in', async () => {
  const db = fakeSupabase();
  assert.equal((await call(env(), { method: 'GET', token: 'nope' })).status, 401);
  assert.equal((await call(env(), { method: 'GET', token: 'tok-staff' })).status, 403);
  db.profiles[0].disabled = true;
  assert.equal((await call(env(), { method: 'GET' })).status, 403, 'a turned-off admin is refused');
  db.profiles[0].disabled = false;
  const r = await call(env(), { method: 'GET' }); const j = await r.json();
  assert.equal(r.status, 200); assert.equal(j.users.length, 2); assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal((await call(env(), { origin: 'https://evil.example', body: { action: 'disable', id: STAFF } })).status, 403, 'other sites can’t call it');
  assert.equal(db.profiles[1].disabled, false);
});

test('invite, add, change, turn off and on, delete', async () => {
  const db = fakeSupabase();
  let r = await call(env(), { body: { action: 'invite', email: 'New@X.com', name: 'New <b>Person</b>', role: 'staff' } });
  assert.equal(r.status, 200, await r.clone().text());
  const p = db.profiles.find((x) => x.email === 'new@x.com');
  assert.equal(p.disabled, false); assert.equal(p.name, 'New bPerson/b', 'names are cleaned');
  assert.equal(db.audit.at(-1).action, 'invite');
  assert.equal((await call(env(), { body: { action: 'invite', email: 'not-an-email' } })).status, 400);
  assert.equal((await call(env(), { body: { action: 'create', email: 'p@x.com', password: 'short' } })).status, 400, 'weak passwords are refused');
  assert.equal((await call(env(), { body: { action: 'create', email: 'p@x.com', password: 'longenough12' } })).status, 400, 'passwords need a symbol');
  r = await call(env(), { body: { action: 'create', email: 'p@x.com', password: 'longenough12!', role: 'admin' } });
  assert.equal(r.status, 200); assert.equal(db.profiles.find((x) => x.email === 'p@x.com').role, 'admin');
  assert.equal((await call(env(), { body: { action: 'update', id: STAFF, role: 'boss' } })).status, 400);
  assert.equal((await call(env(), { body: { action: 'update', id: STAFF, role: 'admin', name: 'Sam' } })).status, 200);
  assert.equal(db.profiles[1].role, 'admin'); assert.equal(db.profiles[1].name, 'Sam');
  r = await call(env(), { body: { action: 'disable', id: STAFF } });
  assert.equal(r.status, 200); assert.equal(db.profiles[1].disabled, true);
  assert.ok(db.calls.some((c) => c.path === `/auth/v1/admin/users/${STAFF}` && c.body?.ban_duration === '876000h'), 'turning off also blocks sign-in');
  await call(env(), { body: { action: 'enable', id: STAFF } });
  assert.equal(db.profiles[1].disabled, false);
  assert.ok(db.calls.some((c) => c.body?.ban_duration === 'none'));
  assert.equal((await call(env(), { body: { action: 'password', id: STAFF, password: 'newpassword9$' } })).status, 200);
  assert.equal((await call(env(), { body: { action: 'reset', id: STAFF } })).status, 200);
  assert.equal((await call(env(), { body: { action: 'delete', id: STAFF } })).status, 200);
  assert.ok(!db.users.some((x) => x.id === STAFF));
  assert.equal((await call(env(), { body: { action: 'nope' } })).status, 400);
  assert.equal((await call(env(), { body: { action: 'delete', id: 'not-a-uuid' } })).status, 400);
});

test('never locks the site out', async () => {
  const db = fakeSupabase();
  assert.equal((await call(env(), { body: { action: 'delete', id: ADMIN } })).status, 400, 'can’t delete yourself');
  assert.equal((await call(env(), { body: { action: 'disable', id: ADMIN } })).status, 400, 'can’t turn yourself off');
  assert.equal((await call(env(), { body: { action: 'update', id: ADMIN, role: 'staff' } })).status, 400, 'can’t demote yourself');
  // a second admin who tries to remove the only other admin's access... is fine while one remains
  db.profiles[1].role = 'admin'; db.sessions['tok-2'] = STAFF;
  assert.equal((await call(env(), { token: 'tok-2', body: { action: 'disable', id: ADMIN } })).status, 200);
  assert.equal((await call(env(), { token: 'tok-admin', method: 'GET' })).status, 403, 'and the turned-off admin is out');
});

test('new secret keys go only in the apikey header; the old service_role JWT also as Bearer', async () => {
  const db = fakeSupabase();
  let r = await call(env(), { method: 'GET' });
  assert.equal(r.status, 200, await r.clone().text());
  assert.ok(db.calls.filter((c) => c.hdr.apikey === 'sb_secret_y').every((c) => !c.hdr.Authorization));
  const db2 = fakeSupabase();
  r = await call(env({ SUPABASE_SERVICE_ROLE_KEY: 'eyJlegacy' }), { method: 'GET' });
  assert.equal(r.status, 200);
  assert.ok(db2.calls.filter((c) => c.hdr.apikey === 'eyJlegacy').every((c) => c.hdr.Authorization === 'Bearer eyJlegacy'));
});

test('a wrong key says which key it is', async () => {
  fakeSupabase();
  for (const [key, re] of [['sb_publishable_zz', /publishable key/], ['sbp_abc', /access token/], ['hello', /doesn’t look like/]]) {
    const r = await call(env({ SUPABASE_SERVICE_ROLE_KEY: key }), { method: 'GET' });
    assert.equal(r.status, 500); assert.match((await r.json()).error, re);
  }
  const r = await call(env({ SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_wrong' }), { method: 'GET' });
  assert.match((await r.json()).error, /didn’t accept/);
});

test('too many requests are slowed down', async () => {
  fakeSupabase();
  let last;
  for (let i = 0; i < 45; i++) last = await call(env(), { method: 'GET' });
  assert.equal(last.status, 429);
});

const pw = (e, body, { token = 'tok-staff', origin = ORIGIN } = {}) => worker.fetch(new Request(`${ORIGIN}/api/account/password`, {
  method: 'POST', headers: { authorization: `Bearer ${token}`, origin, 'content-type': 'application/json' }, body: JSON.stringify(body) }), e);

test('changing your own password needs your current password or security answers', async () => {
  const db = fakeSupabase();
  const changed = () => db.calls.filter((c) => c.method === 'PUT' && c.path === `/auth/v1/admin/users/${STAFF}`).length;
  assert.equal((await pw(env(), { password: 'New-password9' })).status, 400, 'nothing to confirm with');
  assert.equal((await pw(env(), { password: 'New-password9', current_password: 'guess' })).status, 400, 'wrong current password');
  assert.equal((await pw(env(), { password: 'New-password9', answers: [{ slot: 1, answer: 'right' }, { slot: 2, answer: 'wrong' }, { slot: 3, answer: 'right' }] })).status, 400, 'a wrong answer');
  assert.equal(changed(), 0);
  assert.equal((await pw(env(), { password: 'weak', current_password: 'Current-pass1' })).status, 400, 'the new one must be strong');
  assert.equal((await pw(env(), { password: 'New-password9', current_password: 'Current-pass1' }, { origin: 'https://evil.example' })).status, 403);
  let r = await pw(env(), { password: 'New-password9', current_password: 'Current-pass1' });
  assert.equal(r.status, 200, await r.clone().text()); assert.equal(changed(), 1);
  r = await pw(env(), { password: 'New-password9', answers: [1, 2, 3].map((slot) => ({ slot, answer: 'right' })) });
  assert.equal(r.status, 200); assert.equal(changed(), 2);
  assert.equal(db.audit.at(-1).action, 'changed own password');
  db.locked = true;
  r = await pw(env(), { password: 'New-password9', current_password: 'Current-pass1' });
  assert.match((await r.json()).error, /Too many/);
  db.profiles[1].disabled = true;
  assert.equal((await pw(env(), { password: 'New-password9', current_password: 'Current-pass1' })).status, 403, 'a turned-off account can’t');
  assert.equal((await pw(env({ SUPABASE_SERVICE_ROLE_KEY: '' }), { password: 'New-password9', current_password: 'x' })).status, 200);
});
