// Settings (the gear at the far right): My Account for everyone; for admins
// also Users (users.js), Security, and Change history (history.js).
import { h, pageHead, toast, niceError, longDate, MIN_PASSWORD, IDLE_MINUTES } from '../ui.js';
import { sb, state, listAudit, adminApi, listProfiles } from '../store.js';
import { accountSecurityCards, questionsByUser } from '../security.js';

const refresh = () => window.dispatchEvent(new Event('stans:refresh'));

// ---------- My Account ----------
export const account = {
  id: 'account',
  label: 'My Account',
  render({ rerender }) {
    const p = state.profile || {};
    return h('div', null,
      pageHead('My Account', 'Who you’re signed in as, your password and your security questions. Staff can enter production, deliveries, counts and sales; admins can also change costs, prices, BOMs, planning settings and users.'),
      h('div', { class: 'set-grid' },
        h('section', { class: 'set-card' }, h('h2', null, 'Signed in as'),
          h('dl', { class: 'kv' }, h('dt', null, 'Email'), h('dd', null, p.email || state.user?.email || ''), h('dt', null, 'Role'), h('dd', null, h('span', { class: 'role' }, p.role || 'staff'))),
          h('div', { class: 'set-actions' },
            h('button', { class: 'btn', onclick: () => refresh() }, 'Refresh data'),
            h('button', { class: 'btn', onclick: () => sb.auth.signOut() }, 'Sign out'),
            h('button', { class: 'btn', title: 'Signs you out on every computer and phone, e.g. after using a shared one', onclick: async () => {
              const { error } = await sb.auth.signOut({ scope: 'global' }); if (error) toast(niceError(error), 'bad');
            } }, 'Sign out everywhere'))),
        ...accountSecurityCards(rerender)));
  },
};

// ---------- Security ----------
// Checks on how well the site is locked down, what protects it, and the latest
// changes to who can get in.
let checked = null; // { signups, key, users, people, audit, db }
let checking = false;
// Supabase's public sign-in settings (no key needed beyond the publishable one).
async function authSettings() {
  if (window.__MOCK_AUTH_SETTINGS__) return window.__MOCK_AUTH_SETTINGS__;
  const cfg = window.STANS_CONFIG || {}; const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 6000);
  try { const r = await fetch(`${cfg.supabaseUrl}/auth/v1/settings`, { headers: { apikey: cfg.supabaseKey }, signal: ctl.signal }); return r.ok ? await r.json() : null; }
  catch { return null; } finally { clearTimeout(t); }
}
function runChecks(rerender) {
  if (checking) return; checking = true;
  const soft = (p) => p.catch(() => null);
  Promise.all([
    soft(authSettings()),
    soft(adminApi('GET')),
    soft(listProfiles()),
    soft(listAudit(300)),
    soft(questionsByUser()),
    Promise.resolve().then(() => sb.from('profiles').select('name,disabled').range(0, 0)).then(({ error }) => !error).catch(() => false),
    Promise.resolve().then(() => sb.from('security_answers').select('slot').range(0, 0)).then(({ error }) => !error).catch(() => false),
  ]).then(([auth, api, people, audit, sq, db, sqDb]) => {
    checked = { signups: auth ? !auth.disable_signup : null, key: api ? !!api.configured : null, users: api?.configured ? api.users : null, people: people || [], audit, sq, db, sqDb };
  }).finally(() => { checking = false; rerender(); });
}
const daysAgo = (iso) => (iso ? Math.floor((Date.now() - new Date(iso)) / 864e5) : null);
const ACTION_WORDS = { invite: 'Invited', create: 'Added', update: 'Changed', disable: 'Turned off', enable: 'Turned on', delete: 'Deleted', reset: 'Sent a password reset',
  'password reset email': 'Sent a password reset', password: 'Set a password', 'set password': 'Set a password', resend: 'Re-sent the invitation', 'security questions': 'Set security questions', 'reset security questions': 'Reset the security questions of', 'changed own password': 'Changed their password', 'resend invite': 'Re-sent the invitation', insert: 'Added' };

export const security = {
  id: 'security',
  label: 'Security',
  adminOnly: true,
  render({ rerender }) {
    if (!checked) runChecks(rerender);
    const c = checked || {};
    const checks = [];
    const add = (st, title, detail, href) => checks.push({ st, title, detail, href });
    if (!checked) add('warn', 'Checking…', '');
    else {
      add(c.signups === null ? 'warn' : c.signups ? 'bad' : 'ok', c.signups === null ? 'Couldn’t check whether anyone can sign up' : c.signups ? 'Anyone can create an account' : 'Only admins can add people',
        c.signups ? 'New accounts can’t see anything until an admin turns them on, but sign-ups should be off. They’re turned off on the next deploy to main (or in Supabase → Authentication → Sign In / Providers → Allow new users to sign up).' : '');
      add(c.key ? 'ok' : 'warn', c.key ? 'User management is set up' : 'User management needs its key',
        c.key ? 'Adding, deleting, emails and passwords on Settings → Users work.' : 'Adding, deleting and passwords on Settings → Users need the SUPABASE_SERVICE_ROLE_KEY secret on the Cloudflare Worker (Settings → Variables and Secrets, type Secret).', c.key ? null : '#users');
      add(c.db ? 'ok' : 'bad', c.db ? 'Turned-off accounts are locked out by the database' : 'The database needs updating',
        c.db ? 'A turned-off account can’t see or change anything, whatever it sends.' : 'Turning accounts off starts working after the next deploy to main.');
      const people = c.people || [];
      const admins = people.filter((p) => p.role === 'admin' && !p.disabled);
      add(admins.length < 2 ? 'warn' : 'ok', `${admins.length} admin${admins.length === 1 ? '' : 's'}`, admins.length < 2 ? 'A second admin means you can never be locked out.' : admins.map((p) => p.email).join(', '), '#users');
      const off = people.filter((p) => p.disabled);
      if (off.length) add('ok', `${off.length} account${off.length > 1 ? 's' : ''} turned off`, off.map((p) => p.email).join(', '), '#users');
      if (c.users) {
        const idle = c.users.filter((u) => u.id !== state.user?.id && !u.disabled && u.confirmed && (daysAgo(u.last_sign_in_at) ?? 999) > 90);
        add(idle.length ? 'warn' : 'ok', idle.length ? `${idle.length} account${idle.length > 1 ? 's' : ''} not used in 90 days` : 'Every account has been used in the last 90 days',
          idle.length ? `${idle.map((u) => u.email).join(', ')}. Turn off anyone who no longer needs access.` : '', idle.length ? '#users' : null);
        const waiting = c.users.filter((u) => !u.disabled && !u.confirmed);
        if (waiting.length) add((daysAgo(waiting[0].invited_at || waiting[0].created_at) ?? 0) > 14 ? 'warn' : 'ok', `${waiting.length} invitation${waiting.length > 1 ? 's' : ''} not accepted yet`,
          `${waiting.map((u) => u.email).join(', ')}. Re-send or delete invitations that aren’t needed.`, '#users');
      }
      if (!c.sqDb) add('bad', 'Security questions start after the next deploy to main', 'Until then nobody is asked for them.');
      else if (c.sq) {
        const none = people.filter((p) => !p.disabled && !c.sq.get(p.user_id));
        add(none.length ? 'warn' : 'ok', none.length ? `${none.length} account${none.length > 1 ? 's' : ''} without security questions` : 'Everyone has security questions',
          none.length ? `${none.map((p) => p.email).join(', ')}. They’ll be asked to set them the next time they sign in.` : '', none.length ? '#users' : null);
      }
      add(c.audit ? 'ok' : 'warn', c.audit ? 'Changes are being recorded' : 'Change history isn’t recording yet', c.audit ? 'Users, standards, settings and the production plan.' : 'It starts after the next deploy to main.', c.audit ? '#history' : null);
    }
    const counts = { ok: 0, warn: 0, bad: 0 }; for (const x of checks) counts[x.st]++;
    const order = { bad: 0, warn: 1, ok: 2 }; const icon = { ok: '✓', warn: '!', bad: '✕' };

    const recent = (c.audit || []).filter((r) => r.table_name === 'users' || r.table_name === 'profiles').slice(0, 12);
    const who = (r) => r.new_row?.email || r.old_row?.email || '';
    const protections = [
      ['Only admins add people', 'Nobody can create their own account. Anyone added another way starts turned off.'],
      ['Strong passwords', `${MIN_PASSWORD}+ characters with a letter, a number and a symbol.`],
      ['Proving it’s you', 'Changing a password needs the current password or all three security answers. Five wrong tries locks that for 15 minutes.'],
      ['Security questions', 'Everyone sets three before using the site. Answers are stored scrambled, so nobody can read them, admins included.'],
      ['Automatic sign-out', `After ${IDLE_MINUTES >= 60 ? `${IDLE_MINUTES / 60} hour${IDLE_MINUTES === 60 ? '' : 's'}` : `${IDLE_MINUTES} minutes`} without use.`],
      ['Locked at the database', 'Each account only reaches what its role allows; turned-off accounts reach nothing.'],
      ['Protected admin actions', 'User changes are checked on the server, only from this site, and slowed down if repeated too fast.'],
      ['Nothing is lost', 'Turning someone off keeps what they entered, and every change is recorded in Change history.'],
      ['Browser protections', 'Secure connections only, and the site can’t be embedded in other pages or run outside scripts.'],
    ];
    return h('div', null,
      pageHead('Security', 'How well the site is locked down. Red needs fixing; yellow is worth a look. Click a row to go fix it.'),
      h('div', { class: 'health-summary' },
        h('span', { class: 'hs bad' }, `${counts.bad} to fix`), h('span', { class: 'hs warn' }, `${counts.warn} to look at`), h('span', { class: 'hs ok' }, `${counts.ok} fine`),
        h('button', { class: 'btn ghost', onclick: () => { checked = null; rerender(); } }, 'Check again')),
      h('div', { class: 'tablewrap' }, h('table', { class: 't health-table security-table' },
        h('thead', null, h('tr', null, h('th', null, ''), h('th', null, 'Check'), h('th', null, 'Details'), h('th', null, ''))),
        h('tbody', null, [...checks].sort((a, b) => order[a.st] - order[b.st]).map((x) => h('tr', { class: `hc-${x.st}` + (x.href ? ' link' : ''), onclick: x.href ? () => { location.hash = x.href.slice(1); } : null },
          h('td', { class: 'hc-icon' }, h('span', null, icon[x.st])), h('td', { class: 'hc-title' }, x.title), h('td', { class: 'hc-detail' }, x.detail),
          h('td', { class: 'hc-go' }, x.href ? 'Open →' : '')))))),
      h('div', { class: 'set-grid sec-grid' },
        h('section', { class: 'set-card' }, h('h2', null, 'What protects the site'),
          h('dl', { class: 'kv sec-list' }, protections.flatMap(([t, d]) => [h('dt', null, t), h('dd', null, d)]))),
        h('section', { class: 'set-card' }, h('h2', null, 'Latest changes to users'),
          !checked ? h('p', { class: 'muted' }, 'Loading…') : !recent.length ? h('p', { class: 'muted' }, 'None yet.')
            : h('dl', { class: 'kv sec-list' }, recent.flatMap((r) => [h('dt', null, `${longDate(r.at.slice(0, 10))} ${r.at.slice(11, 16)}`),
              h('dd', null, `${ACTION_WORDS[r.action] || r.action} ${who(r)}`.trim(), h('span', { class: 'muted' }, r.email ? ` — by ${r.email}` : ''))])),
          h('a', { href: '#history', class: 'small' }, 'All changes in Change history →'))));
  },
};
