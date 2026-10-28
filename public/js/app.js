import { h, toast, niceError } from './ui.js';
import { sb, configured, state, loadAll, loadProfile, isAdmin, onChange } from './store.js';
import dashboard from './tabs/dashboard.js';
import production from './tabs/production.js';
import receipts from './tabs/receipts.js';
import counts from './tabs/counts.js';
import inventory from './tabs/inventory.js';
import demand from './tabs/demand.js';
import sales from './tabs/sales.js';
import { byCustomer, byProduct } from './tabs/salessummary.js';
import costs from './tabs/costs.js';
import bom from './tabs/bom.js';
import createbom from './tabs/createbom.js';
import taccounts from './tabs/taccounts.js';
import prices from './tabs/prices.js';
import labor from './tabs/labor.js';
import journals from './tabs/journals.js';
import users from './tabs/users.js';

// Groups across the top; the open group's tabs show in the row beneath.
// Users isn't in a group: admins reach it from the header.
const GROUPS = [
  { id: 'overview', label: 'Dashboard', tabs: [dashboard] },
  { id: 'inventory', label: 'Inventory', tabs: [production, receipts, counts, inventory, demand] },
  { id: 'sales', label: 'Sales', tabs: [sales, byCustomer, byProduct, prices] },
  { id: 'costing', label: 'Standard Cost', tabs: [costs, bom, createbom, labor] },
  { id: 'accounting', label: 'Accounting', tabs: [journals, taccounts] },
];
const TABS = [...GROUPS.flatMap((g) => g.tabs), users];
const groupOf = (id) => GROUPS.find((g) => g.tabs.some((t) => t.id === id));
const lastInGroup = new Map(); // remembers the tab you were on in each group
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
  const groupBar = h('nav', { class: 'groups', 'aria-label': 'Sections' });
  const tabBar = h('nav', { class: 'tabs', role: 'tablist', 'aria-label': 'Pages' });
  const main = h('main', { id: 'main', role: 'tabpanel' });
  const p = state.profile || {};
  app.replaceChildren(
    h('header', { class: 'topbar' },
      h('div', { class: 'brandrow' }, brand(), h('div', { class: 'spacer' }),
        h('div', { class: 'who' },
          h('span', null, p.email || state.user?.email || ''),
          h('span', { class: 'role' }, p.role || 'staff'),
          isAdmin() ? h('a', { class: 'btn ghost', href: '#users' }, 'Users') : null,
          h('button', { class: 'btn ghost', title: 'Reload data from the database', onclick: () => refresh(true) }, 'Refresh'),
          h('button', { class: 'btn', onclick: () => sb.auth.signOut() }, 'Sign out'))),
      h('div', { class: 'grouprow' }, groupBar),
      tabBar),
    main);
  const bars = { groupBar, tabBar };
  topbarObserver.observe(app.querySelector('.topbar'));
  renderTabs(bars);
  return { tabBar: bars, main };
}

function renderTabs({ groupBar, tabBar }) {
  const id = routeId();
  const open = groupOf(id);
  if (open) lastInGroup.set(open.id, id);
  groupBar.replaceChildren(...GROUPS.map((g) => h('button', {
    class: 'group', 'aria-current': g === open ? 'true' : null,
    onclick: () => { location.hash = lastInGroup.get(g.id) || g.tabs[0].id; },
  }, g.label)));
  const tabs = open && open.tabs.length > 1 ? open.tabs : [];
  tabBar.hidden = !tabs.length;
  groupBar.closest('.topbar')?.classList.toggle('no-subtabs', !tabs.length);
  tabBar.replaceChildren(...tabs.map((t) =>
    h('button', { class: 'tab', role: 'tab', 'aria-selected': String(t.id === id), onclick: () => { location.hash = t.id; } }, t.label)));
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
  fitTables();
  pinWideHeaders();
  dockWideFooters();
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
// Tables that fit the screen don't need their own sideways scrolling, so
// they're marked .fits and their header row pins under the site header.
function fitTables() {
  if (!ui) return;
  for (const w of ui.main.querySelectorAll('.tablewrap')) {
    w.classList.remove('fits');
    w.classList.toggle('fits', w.scrollWidth <= w.clientWidth + 1);
  }
}
const topbarObserver = new ResizeObserver((entries) => {
  for (const e of entries) document.documentElement.style.setProperty('--topbar-h', `${Math.round(e.target.getBoundingClientRect().height)}px`);
});
// Wide tables scroll sideways in their own box, where a normal pinned header
// can't follow the page. While such a table's header is scrolled off, a copy
// of it floats under the site header, with the same column widths and
// following the table's sideways scroll.
function pinWideHeaders() {
  if (!ui) return;
  const top = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--topbar-h')) || 0;
  for (const w of ui.main.querySelectorAll('.tablewrap')) {
    const table = w.querySelector(':scope > table'); const head = table?.querySelector(':scope > thead');
    let float = w._float;
    const r = w.getBoundingClientRect();
    const show = head && !w.classList.contains('fits') && r.top < top && r.bottom > top + head.offsetHeight + 24;
    if (!show) { if (float) { float.remove(); w._float = null; } continue; }
    if (!float || !float.isConnected) {
      float = document.createElement('div'); float.className = 'float-head'; float.setAttribute('aria-hidden', 'true');
      const copy = document.createElement('table'); copy.className = table.className;
      const firstRow = table.querySelector(':scope > tbody > tr');
      const widths = firstRow ? [...firstRow.children].map((td) => td.getBoundingClientRect().width) : [];
      const cols = document.createElement('colgroup');
      for (const wd of widths) { const col = document.createElement('col'); col.style.width = `${wd}px`; cols.append(col); }
      copy.append(cols, head.cloneNode(true));
      copy.style.width = `${table.getBoundingClientRect().width}px`;
      for (const el of copy.querySelectorAll('[id]')) el.removeAttribute('id');
      float.append(copy); document.body.append(float); w._float = float;
      // Filter buttons in the floating copy open the real column's menu.
      float.addEventListener('click', (e) => {
        const b = e.target.closest('.xf-btn'); if (!b) return;
        const real = head.querySelectorAll('.xf-btn')[[...copy.querySelectorAll('.xf-btn')].indexOf(b)];
        if (real) { real._anchor = b; real.click(); }
      });
    }
    float.style.top = `${top}px`; float.style.left = `${r.left}px`; float.style.width = `${w.clientWidth + 2}px`;
    const copy = float.firstChild; const sl = w.scrollLeft;
    copy.style.transform = `translateX(${-sl}px)`;
    for (const th of copy.querySelectorAll('th.sticky-col')) th.style.transform = `translateX(${sl}px)`;
  }
  for (const f of document.querySelectorAll('body > .float-head')) if (![...ui.main.querySelectorAll('.tablewrap')].some((w) => w._float === f)) f.remove();
}
// Wide tables: while the bottom of the table is below the screen, a copy of
// its footer (totals) and a sideways scrollbar are docked to the bottom of the
// screen, kept in step with the table's own sideways scroll.
function dockWideFooters() {
  if (!ui) return;
  const vh = window.innerHeight;
  for (const w of ui.main.querySelectorAll('.tablewrap')) {
    const table = w.querySelector(':scope > table'); const foot = table?.querySelector(':scope > tfoot');
    const r = w.getBoundingClientRect();
    const wide = !w.classList.contains('fits') && w.scrollWidth > w.clientWidth + 1;
    const show = table && wide && r.bottom > vh && r.top < vh - 80;
    let dock = w._dock;
    if (!show) { if (dock) { dock.remove(); w._dock = null; } continue; }
    if (!dock || !dock.isConnected) {
      dock = document.createElement('div'); dock.className = 'float-foot';
      const rows = document.createElement('div'); rows.className = 'ff-rows';
      if (foot) {
        const copy = document.createElement('table'); copy.className = table.className;
        const firstRow = table.querySelector(':scope > tbody > tr');
        const cols = document.createElement('colgroup');
        for (const td of firstRow ? firstRow.children : []) { const col = document.createElement('col'); col.style.width = `${td.getBoundingClientRect().width}px`; cols.append(col); }
        copy.append(cols, foot.cloneNode(true));
        copy.style.width = `${table.getBoundingClientRect().width}px`;
        rows.append(copy);
        // Buttons in the copy (Hide / Show totals) press the real ones.
        rows.addEventListener('click', (e) => {
          const b = e.target.closest('button'); if (!b) return;
          foot.querySelectorAll('button')[[...copy.querySelectorAll('button')].indexOf(b)]?.click();
        });
      }
      // Drawn by hand rather than a browser scrollbar, so it's always visible
      // (Macs hide scrollbars until you scroll) and matches the site.
      const bar = document.createElement('div'); bar.className = 'ff-scroll'; bar.setAttribute('aria-hidden', 'true');
      const thumb = document.createElement('div'); thumb.className = 'ff-thumb'; bar.append(thumb);
      const range = () => ({ max: w.scrollWidth - w.clientWidth, travel: bar.clientWidth - thumb.offsetWidth });
      thumb.addEventListener('pointerdown', (e) => {
        e.preventDefault(); thumb.setPointerCapture(e.pointerId); thumb.classList.add('dragging');
        const x0 = e.clientX; const s0 = w.scrollLeft; const { max, travel } = range();
        const move = (ev) => { w.scrollLeft = s0 + (ev.clientX - x0) * (travel > 0 ? max / travel : 0); };
        const up = () => { thumb.classList.remove('dragging'); thumb.removeEventListener('pointermove', move); thumb.removeEventListener('pointerup', up); thumb.removeEventListener('pointercancel', up); };
        thumb.addEventListener('pointermove', move); thumb.addEventListener('pointerup', up); thumb.addEventListener('pointercancel', up);
      });
      bar.addEventListener('pointerdown', (e) => {
        if (e.target !== bar) return;
        const t = thumb.getBoundingClientRect();
        w.scrollBy({ left: (e.clientX < t.left ? -1 : 1) * w.clientWidth * 0.9, behavior: 'smooth' });
      });
      bar.addEventListener('wheel', (e) => { const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY; w.scrollLeft += d; e.preventDefault(); }, { passive: false });
      dock.append(rows, bar); document.body.append(dock); w._dock = dock;
    }
    dock.style.left = `${r.left}px`; dock.style.width = `${r.width}px`;
    const [rows, bar] = dock.children;
    const thumb = bar.firstChild; const track = bar.clientWidth;
    const tw = Math.max(48, Math.round(track * w.clientWidth / w.scrollWidth));
    const max = w.scrollWidth - w.clientWidth;
    thumb.style.width = `${tw}px`;
    thumb.style.transform = `translateX(${max > 0 ? Math.round((track - tw) * w.scrollLeft / max) : 0}px)`;
    const copy = rows.firstChild;
    if (copy) {
      const sl = w.scrollLeft;
      copy.style.transform = `translateX(${-sl}px)`;
      for (const td of copy.querySelectorAll('td.sticky-col, .xt-off-inner')) td.style.transform = `translateX(${sl}px)`;
    }
  }
  for (const f of document.querySelectorAll('body > .float-foot')) if (![...ui.main.querySelectorAll('.tablewrap')].some((w) => w._dock === f)) f.remove();
}
let pinQueued = false;
// Capture catches both page scrolling and tables scrolling sideways.
document.addEventListener('scroll', () => { if (pinQueued) return; pinQueued = true; requestAnimationFrame(() => { pinQueued = false; pinWideHeaders(); dockWideFooters(); }); }, { passive: true, capture: true });
let fitTimer = null;
window.addEventListener('resize', () => { clearTimeout(fitTimer); fitTimer = setTimeout(() => { fitTables(); pinWideHeaders(); dockWideFooters(); }, 100); });
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
