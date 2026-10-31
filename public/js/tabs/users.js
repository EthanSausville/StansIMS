// Settings → Users (admins): everyone who can use the site, and full control
// over them: add (by invitation email, or with a password you set), change
// name, email and role, turn an account off and on, send a password reset or
// set a password, re-send an invitation, and delete.
//
// Adding, emails, passwords and deleting go through the site's Worker
// (/api/admin/users), which holds the Supabase secret key; until that key is
// set up, this page can still change names, roles and turn accounts off/on.
import { h, pageHead, toast, niceError, longDate, confirmDialog, passwordProblem, MIN_PASSWORD, PASSWORD_RULE } from '../ui.js';
import { sb, state, adminApi, listProfiles } from '../store.js';
import { xtable, filteredRows } from '../xtable.js';
import { questionsByUser, resetAnswers } from '../security.js';

let users = null;      // rows shown
let configured = null; // does the Worker have the secret key?
let loading = false;
let loadError = '';   // why the list couldn't be loaded
let mode = 'password'; // add form: 'invite' or 'password' (password first: email isn't set up yet)
let sq = null;         // user id → how many security questions they've set (null: not available)

function load(rerender) {
  if (loading) return; loading = true; loadError = '';
  questionsByUser().then((m) => { sq = m; rerender(); });
  adminApi('GET')
    .then(async (r) => {
      configured = !!r.configured;
      if (configured) users = r.users;
      else users = (await listProfiles()).map((p) => ({ id: p.user_id, email: p.email, name: p.name || null, role: p.role, disabled: !!p.disabled, created_at: p.created_at, last_sign_in_at: null, confirmed: true }));
    })
    .catch((e) => { loadError = niceError(e); users = users || []; })
    .finally(() => { loading = false; rerender(); });
}
const reload = (rerender) => { users = null; load(rerender); rerender(); };

// One change: through the Worker when it's set up, otherwise straight to the
// profile (names, roles and on/off only).
async function act(body, rerender) {
  try {
    if (configured) { const r = await adminApi('POST', body); toast(r.message || 'Done.'); }
    else {
      const patch = body.action === 'disable' ? { disabled: true } : body.action === 'enable' ? { disabled: false } : body.action === 'update' ? Object.fromEntries(['name', 'role'].filter((k) => k in body).map((k) => [k, body[k]])) : null;
      if (!patch) throw new Error('That needs the user-management key set up (see the note above).');
      const { error } = await sb.from('profiles').update(patch).eq('user_id', body.id);
      if (error) throw error;
      toast('Saved.');
    }
    reload(rerender);
    return true;
  } catch (e) {
    toast(/at least one admin/i.test(e.message) ? 'There must be at least one admin.' : /own account/i.test(e.message) ? e.message : niceError(e), 'bad');
    return false;
  }
}

// A small dialog asking for one value (a new email).
function askText(title, label, value, type = 'text') {
  return new Promise((resolve) => {
    const input = h('input', { type, value: value || '', autocomplete: 'off' });
    const dlg = h('dialog', null, h('form', { method: 'dialog' },
      h('p', { style: { margin: 0 } }, h('strong', null, title)), h('label', { class: 'field' }, label, input),
      h('div', { class: 'actions' }, h('button', { class: 'btn', value: 'cancel' }, 'Cancel'), h('button', { class: 'btn primary', value: 'ok' }, 'Save'))));
    dlg.addEventListener('close', () => { resolve(dlg.returnValue === 'ok' ? input.value.trim() : null); dlg.remove(); });
    document.body.append(dlg); dlg.showModal(); input.select();
  });
}
// A small dialog asking for a new password.
function askPassword(u) {
  return new Promise((resolve) => {
    const p = h('input', { type: 'password', autocomplete: 'new-password', minlength: MIN_PASSWORD, maxlength: 72 });
    const msg = h('div', { class: 'msg bad', role: 'alert' });
    const dlg = h('dialog', null, h('form', { method: 'dialog', onsubmit: (e) => {
        if (e.submitter?.value !== 'ok') return;
        const bad = passwordProblem(p.value); if (bad) { e.preventDefault(); msg.textContent = bad; }
      } },
      h('p', { style: { margin: 0 } }, h('strong', null, `New password for ${u.email}`)),
      h('label', { class: 'field' }, PASSWORD_RULE, p), msg,
      h('div', { class: 'actions' }, h('button', { class: 'btn', value: 'cancel' }, 'Cancel'), h('button', { class: 'btn primary', value: 'ok' }, 'Set password'))));
    dlg.addEventListener('close', () => { resolve(dlg.returnValue === 'ok' ? p.value : null); dlg.remove(); });
    document.body.append(dlg); dlg.showModal(); p.focus();
  });
}

const status = (u) => (u.disabled ? ['Turned off', 'off'] : !u.confirmed ? ['Invited', 'invited'] : ['Active', 'on']);
const when = (iso) => (iso ? longDate(iso.slice(0, 10)) : '');

export default {
  id: 'users',
  label: 'Users',
  adminOnly: true,
  render({ rerender }) {
    if (users === null && !loading) load(rerender);
    const me = state.user?.id;

    // ---- add a user ----
    const email = h('input', { type: 'email', autocomplete: 'off', placeholder: 'name@company.com', 'aria-label': 'Email' });
    const name = h('input', { type: 'text', autocomplete: 'off', maxlength: 80, placeholder: 'First Last', 'aria-label': 'Name' });
    const role = h('select', { 'aria-label': 'Role' }, h('option', { value: 'staff' }, 'Staff'), h('option', { value: 'admin' }, 'Admin'));
    const pass = h('input', { type: 'password', autocomplete: 'new-password', minlength: MIN_PASSWORD, maxlength: 72, 'aria-label': 'Password' });
    const add = async (e) => {
      e.preventDefault();
      if (mode === 'password') { const bad = passwordProblem(pass.value); if (bad) { toast(bad, 'bad'); return; } }
      const ok = await act({ action: mode === 'invite' ? 'invite' : 'create', email: email.value, name: name.value, role: role.value, password: mode === 'password' ? pass.value : undefined }, rerender);
      if (ok) { email.value = ''; name.value = ''; pass.value = ''; }
    };
    const addCard = h('form', { class: 'set-card user-add', onsubmit: add },
      h('h2', null, 'Add a user'),
      h('div', { class: 'seg', role: 'group' },
        h('button', { type: 'button', 'aria-pressed': String(mode === 'invite'), onclick: () => { mode = 'invite'; rerender(); } }, 'Email them an invitation'),
        h('button', { type: 'button', 'aria-pressed': String(mode === 'password'), onclick: () => { mode = 'password'; rerender(); } }, 'Set a password now')),
      h('div', { class: 'user-add-fields' },
        h('label', { class: 'field' }, 'Email', email), h('label', { class: 'field' }, 'Name', name), h('label', { class: 'field' }, 'Role', role),
        mode === 'password' ? h('label', { class: 'field' }, `Password (${PASSWORD_RULE})`, pass) : null,
        h('button', { class: 'btn primary', type: 'submit' }, mode === 'invite' ? 'Send invitation' : 'Add user')),
      h('p', { class: 'small muted' }, mode === 'invite' ? 'They get an email with a link to choose their own password (once email is set up; see the note above).' : 'They can sign in right away; give them the password privately. They can change it under Settings → My Account.'));

    // ---- everyone ----
    const columns = [
      { key: 'email', label: 'Email', value: (u) => u.email || '', cell: (u) => h('td', null, u.email, u.id === me ? h('span', { class: 'muted' }, ' (you)') : null) },
      { key: 'name', label: 'Name', value: (u) => u.name || '', cell: (u) => {
        const input = h('input', { type: 'text', value: u.name || '', maxlength: 80, 'aria-label': `Name for ${u.email}`, 'data-k': `un|${u.id}`,
          onkeydown: (e) => { if (e.key === 'Enter') e.target.blur(); },
          onchange: (e) => act({ action: 'update', id: u.id, name: e.target.value }, rerender) });
        return h('td', { class: 'cell entry user-name' }, input); } },
      { key: 'role', label: 'Role', value: (u) => u.role, cell: (u) => h('td', { class: 'cell entry' }, h('select', { 'aria-label': `Role for ${u.email}`, disabled: u.id === me,
        title: u.id === me ? 'You can’t change your own role' : null,
        onchange: async (e) => { const ok = await act({ action: 'update', id: u.id, role: e.target.value }, rerender); if (!ok) e.target.value = u.role; } },
        ['staff', 'admin'].map((r) => h('option', { value: r, selected: u.role === r }, r === 'admin' ? 'Admin' : 'Staff')))) },
      { key: 'status', label: 'Status', value: (u) => status(u)[0], cell: (u) => h('td', null, h('span', { class: `user-status ${status(u)[1]}` }, status(u)[0])) },
      { key: 'sq', label: 'Security questions', value: (u) => (sq?.get(u.id) ? 'Set' : 'Not set'),
        cell: (u) => h('td', null, sq === null ? '' : sq.get(u.id) ? h('span', { class: 'user-status on' }, 'Set') : h('span', { class: 'user-status invited' }, 'Not set')) },
      { key: 'last', label: 'Last sign-in', value: (u) => u.last_sign_in_at || '', text: (u) => when(u.last_sign_in_at), cell: (u) => h('td', { class: 'muted' }, configured ? when(u.last_sign_in_at) || 'Never' : '') },
      { key: 'added', label: 'Added', value: (u) => u.created_at || '', text: (u) => when(u.created_at), cell: (u) => h('td', { class: 'muted' }, when(u.created_at)) },
      { key: 'do', label: '', filter: false, value: () => '', cell: (u) => {
        const self = u.id === me;
        const b = (label, fn, cls = '', title) => h('button', { type: 'button', class: `btn small ${cls}`.trim(), title, onclick: fn }, label);
        return h('td', { class: 'user-actions' },
          configured && !u.confirmed && !u.disabled ? b('Resend invite', () => act({ action: 'resend', id: u.id }, rerender)) : null,
          configured && u.confirmed && !u.disabled ? b('Reset password', async () => { if (await confirmDialog(`Email ${u.email} a link to choose a new password?`, 'Send')) act({ action: 'reset', id: u.id }, rerender); }, '', 'Email them a link to choose a new password') : null,
          configured && !u.disabled ? b('Set password', async () => { const pw = await askPassword(u); if (pw) act({ action: 'password', id: u.id, password: pw }, rerender); }) : null,
          configured ? b('Change email', async () => {
            const v = await askText(`Change the email for ${u.email}`, 'New email (they sign in with it from now on)', u.email, 'email'); if (v && v !== u.email) act({ action: 'update', id: u.id, email: v }, rerender);
          }) : null,
          !self && sq?.get(u.id) ? b('Reset questions', async () => {
            if (!(await confirmDialog(`Clear ${u.email}’s security questions? They’ll have to pick new ones the next time they sign in.`, 'Clear'))) return;
            try { await resetAnswers(u.id); toast('Security questions cleared.'); reload(rerender); } catch (e) { toast(niceError(e), 'bad'); }
          }, '', 'For someone who forgot their answers') : null,
          self ? null : u.disabled
            ? b('Turn on', () => act({ action: 'enable', id: u.id }, rerender))
            : b('Turn off', async () => { if (await confirmDialog(`Turn off ${u.email}? They’ll be signed out and can’t sign in until you turn them back on. What they entered stays.`, 'Turn off')) act({ action: 'disable', id: u.id }, rerender); }, 'warn'),
          configured && !self ? b('Delete', async () => { if (await confirmDialog(`Delete ${u.email} for good? They can’t sign in again unless you add them back. What they entered stays.`, 'Delete')) act({ action: 'delete', id: u.id }, rerender); }, 'danger') : null);
      } },
    ];
    const rows = users || [];
    const admins = rows.filter((u) => u.role === 'admin' && !u.disabled).length;
    return h('div', null,
      pageHead('Users', 'Everyone who can use the site. Staff enter production, deliveries, counts and sales; admins can also change standards, planning settings and users. Turning someone off signs them out and keeps them out, without losing anything they entered. Every change here is recorded in Change history.'),
      loadError ? h('div', { class: 'note bad' }, h('strong', null, 'Couldn’t load the users: '), loadError, ' ', h('button', { class: 'btn small', onclick: () => reload(rerender) }, 'Try again')) : null,
      configured === false ? h('div', { class: 'note warn' },
        h('strong', null, 'Adding, deleting, emails and passwords need one more setup step. '),
        'In Supabase, open Project Settings → API Keys and copy the secret key. In Cloudflare, open the stansims Worker → Settings → Variables and Secrets → Add, choose type Secret, name it SUPABASE_SERVICE_ROLE_KEY and paste the key. Until then you can change names and roles and turn accounts off and on here.') : null,
      h('div', { class: 'note warn email-note' },
        h('strong', null, 'Email isn’t set up yet, so anything that sends an email will fail: '),
        'invitations, Resend invite, Reset password, Change email, and “Forgot password?” on the sign-in page. Until it’s set up, add people with ',
        h('em', null, 'Set a password now'), ' and give them the password in person; if someone forgets theirs, use ', h('em', null, 'Set password'), ' here. ',
        'To turn email on: sign up with an email-sending service (Resend, Brevo, Postmark…), then in Supabase open Authentication → Emails → SMTP Settings, turn on Enable Custom SMTP and enter its details. Supabase’s built-in email only reaches members of your Supabase team, about 2 emails an hour.'),
      admins === 1 && rows.length > 1 ? h('div', { class: 'note info' }, 'There’s only one admin. A second one means you can never be locked out.') : null,
      configured ? addCard : null,
      users === null ? h('div', { class: 'empty' }, 'Loading…') : h('div', { class: 'tablewrap' },
        xtable({ id: 'users', columns, allRows: rows, rows: filteredRows({ id: 'users', columns, rows }), rerender, className: 'users-table', rowClass: (u) => (u.disabled ? 'user-off' : null) })));
  },
};
