import { h, toast, niceError } from './ui.js';
import { sb, configured, state, loadAll, loadProfile, isAdmin, onChange } from './store.js';
import dashboard from './tabs/dashboard.js';
import production from './tabs/production.js';
import receipts from './tabs/receipts.js';
import counts from './tabs/counts.js';
import inventory from './tabs/inventory.js';
import demand from './tabs/demand.js';
import sales from './tabs/sales.js';
import costs from './tabs/costs.js';
import recipes from './tabs/recipes.js';
import finished from './tabs/finished.js';
import prices from './tabs/prices.js';
import labor from './tabs/labor.js';
import journals from './tabs/journals.js';
import users from './tabs/users.js';

// Tabs across the top, in workbook order. null draws a divider.
const TABS = [dashboard, production, receipts, counts, inventory, demand, sales, null,
  costs, recipes, finished, prices, labor, journals, null, users];
const app = document.getElementById('app');
let current = null;

function brand() { return h('span', { class: 'brand' }, 'Stan’s ', h('span', null, 'IMS')); }

// ---------- sign-in screens ----------
function signInScreen(message) {
  const msg = h('div', { class: 'msg bad', role: 'alert' }, message || '');
  const email = h('input', { type: 'email', required: true, autocomplete: 'username', autofocus: true });
  const pass = h('input', { type: 'password', required: true, autocomplete: 'current-password' });
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Sign in');
  const form = h('form', { onsubmit: async (e) => {
      e.preventDefault(); btn.disabled = true; msg.textContent = '';
      const { error } = await sb.auth.signInWithPassword({ email: email.value.trim(), password: pass.value });
      btn.disabled = false;
      if (error) { msg.className = 'msg bad'; msg.textContent = /invalid/i.test(error.message) ? 'That email and password don’t match.' : error.message; }
    } },
    h('h1', null, 'Stan’s ', h('span', null, 'IMS')),
    h('p', null, 'Sign in to manage production, inventory and sales.'),
    h('label', { class: 'field' }, 'Email', email),
    h('label', { class: 'field' }, 'Password', pass),
    btn, msg,
    h('div', { class: 'links' },
      h('button', { type: 'button', onclick: async () => {
        if (!email.value.trim()) { msg.className = 'msg bad'; msg.textContent = 'Type your email first, then choose “Forgot password”.'; email.focus(); return; }
        const { error } = await sb.auth.resetPasswordForEmail(email.value.trim(), { redirectTo: location.origin + '/' });
        msg.className = error ? 'msg bad' : 'msg good';
        msg.textContent = error ? error.message : 'Check your email for a link to set a new password.';
      } }, 'Forgot password?'),
      h('span', { class: 'muted' }, 'Need an account? Ask an admin.')));
  app.replaceChildren(h('div', { class: 'auth' }, form));
}

function setPasswordScreen(kind) {
  const msg = h('div', { class: 'msg bad', role: 'alert' });
  const p1 = h('input', { type: 'password', required: true, minlength: 8, autocomplete: 'new-password', autofocus: true });
  const p2 = h('input', { type: 'password', required: true, minlength: 8, autocomplete: 'new-password' });
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Save password');
  app.replaceChildren(h('div', { class: 'auth' }, h('form', { onsubmit: async (e) => {
      e.preventDefault();
      if (p1.value !== p2.value) { msg.textContent = 'The passwords don’t match.'; return; }
      btn.disabled = true;
      const { error } = await sb.auth.updateUser({ password: p1.value });
      btn.disabled = false;
      if (error) { msg.textContent = error.message; return; }
      history.replaceState(null, '', location.pathname);
      window.STANS_AUTH_TYPE = null; toast('Password saved.');
      if (!started) { started = true; start(); }
    } },
    h('h1', null, kind === 'invite' ? 'Welcome to Stan’s ' : 'New password for Stan’s ', h('span', null, 'IMS')),
    h('p', null, kind === 'invite' ? 'Choose a password to finish setting up your account.' : 'Choose a new password.'),
    h('label', { class: 'field' }, 'New password (8+ characters)', p1),
    h('label', { class: 'field' }, 'Type it again', p2),
    btn, msg)));
}

function notConfigured() {
  app.replaceChildren(h('div', { class: 'auth' }, h('form', null,
    h('h1', null, 'Stan’s ', h('span', null, 'IMS')),
    h('p', null, 'This site isn’t connected to its database yet.'),
    h('p', { class: 'small' }, 'In Cloudflare, open the Worker → Settings → Variables and Secrets, and add SUPABASE_URL and SUPABASE_ANON_KEY (your Supabase project URL and publishable key). Then reload this page.'))));
}

// ---------- the app ----------
function routeId() { const id = location.hash.slice(1).split('?')[0]; return TABS.find((t) => t && t.id === id && (!t.adminOnly || isAdmin())) ? id : 'dashboard'; }

function shell() {
  const tabBar = h('nav', { class: 'tabs', role: 'tablist', 'aria-label': 'Sections' });
  const main = h('main', { id: 'main', role: 'tabpanel' });
  const p = state.profile || {};
  app.replaceChildren(
    h('header', { class: 'topbar' },
      h('div', { class: 'brandrow' }, brand(), h('div', { class: 'spacer' }),
        h('div', { class: 'who' },
          h('span', null, p.email || state.user?.email || ''),
          h('span', { class: 'role' }, p.role || 'staff'),
          h('button', { class: 'btn ghost', title: 'Reload data from the database', onclick: () => refresh(true) }, 'Refresh'),
          h('button', { class: 'btn', onclick: () => sb.auth.signOut() }, 'Sign out'))),
      tabBar),
    main);
  renderTabs(tabBar);
  return { tabBar, main };
}

function renderTabs(tabBar) {
  const id = routeId();
  tabBar.replaceChildren(...TABS.filter((t) => t === null || !t.adminOnly || isAdmin()).map((t) => t === null
    ? h('span', { class: 'sep', 'aria-hidden': 'true' })
    : h('button', { class: 'tab', role: 'tab', 'aria-selected': String(t.id === id), onclick: () => { location.hash = t.id; } }, t.label)));
}

let ui = null;
let scheduled = false;
function render() {
  if (!ui || !state.data) return;
  const id = routeId();
  const tab = TABS.find((t) => t && t.id === id);
  // Keep focus, typing and scroll position across re-renders.
  const active = document.activeElement;
  const focusKey = active?.dataset?.k; const typed = active?.value; const sel = [active?.selectionStart, active?.selectionEnd];
  const scrolls = [...ui.main.querySelectorAll('[data-scroll]')].map((el) => [el.dataset.scroll, el.scrollTop, el.scrollLeft]);
  const pageY = current === id ? window.scrollY : 0;
  let content;
  try { content = tab.render({ rerender: schedule }); } catch (e) { console.error(e); content = h('div', { class: 'note bad' }, 'Something went wrong showing this page: ' + e.message); }
  ui.main.replaceChildren(content);
  for (const [k, top, left] of scrolls) { const el = ui.main.querySelector(`[data-scroll="${k}"]`); if (el) { el.scrollTop = top; el.scrollLeft = left; } }
  if (current === id) window.scrollTo(0, pageY);
  if (focusKey) {
    const el = ui.main.querySelector(`[data-k="${CSS.escape(focusKey)}"]`);
    if (el) { el.focus(); if (typed !== undefined && el.value !== typed) el.value = typed; try { el.setSelectionRange(sel[0], sel[1]); } catch { /* not a text input */ } }
  }
  current = id;
  if (tab.afterRender) tab.afterRender(ui.main);
}
function schedule() { if (scheduled) return; scheduled = true; requestAnimationFrame(() => { scheduled = false; render(); }); }

async function refresh(manual) {
  try { await loadAll(); if (manual) toast('Data reloaded.'); } catch (e) { toast(niceError(e), 'bad'); }
}

let started = false;
async function start() {
  try {
    await loadProfile();
    ui = shell();
    ui.main.replaceChildren(h('div', { class: 'boot' }, 'Loading data…'));
    await loadAll();
    render();
  } catch (e) {
    console.error(e);
    app.replaceChildren(h('div', { class: 'auth' }, h('form', null, h('h1', null, 'Couldn’t load'), h('p', null, niceError(e)),
      h('button', { class: 'btn primary', type: 'button', onclick: () => location.reload() }, 'Try again'))));
  }
}

window.addEventListener('hashchange', () => { if (ui) { renderTabs(ui.tabBar); render(); window.scrollTo(0, 0); } });
onChange(schedule);
let resizeTimer = null; let lastWidth = window.innerWidth;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (Math.abs(window.innerWidth - lastWidth) > 40 && routeId() === 'dashboard') { lastWidth = window.innerWidth; schedule(); } }, 200); });
// Pick up other people's changes when coming back to the tab after a while.
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && ui && Date.now() - state.loadedAt > 60000) refresh(false); });

if (!configured) notConfigured();
else {
  const type = window.STANS_AUTH_TYPE;
  sb.auth.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY') { setPasswordScreen('recovery'); return; }
    if (event === 'SIGNED_OUT') { started = false; ui = null; state.data = null; signInScreen(); return; }
    if (session && !started && !window.STANS_AUTH_TYPE) { started = true; setTimeout(start, 0); }
  });
  const { data: { session } } = await sb.auth.getSession();
  if (session && (type === 'invite' || type === 'recovery')) setPasswordScreen(type);
  else if (!session) signInScreen(window.STANS_AUTH_ERROR ? decodeURIComponent(window.STANS_AUTH_ERROR.replace(/\+/g, ' ')) : '');
  else if (!started) { started = true; start(); }
}
