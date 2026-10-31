// Settings (the gear at the far right): My Account for everyone; for admins
// also Site (the site's date), Site Health (is everything set up and up to
// date?), Users, Change history (history.js) and Data (backup, refresh).
import { h, pageHead, toast, niceError, longDate, todayIso, realTodayIso, siteDateSetting, PRETEND_TODAY, thisYear, passwordProblem, MIN_PASSWORD } from '../ui.js';
import { sb, state, derived, isAdmin, saveSettings, listProfiles, listAudit, adminApi } from '../store.js';
import { missingStandards, hasReceiving } from '../calc.js';

const refresh = () => window.dispatchEvent(new Event('stans:refresh'));

// ---------- My Account ----------
export const account = {
  id: 'account',
  label: 'My Account',
  render() {
    const p = state.profile || {};
    const p1 = h('input', { type: 'password', autocomplete: 'new-password', minlength: MIN_PASSWORD, maxlength: 72, 'aria-label': 'New password' });
    const p2 = h('input', { type: 'password', autocomplete: 'new-password', minlength: MIN_PASSWORD, maxlength: 72, 'aria-label': 'New password again' });
    const change = async (e) => {
      e.preventDefault();
      const bad = passwordProblem(p1.value); if (bad) { toast(bad, 'bad'); return; }
      if (p1.value !== p2.value) { toast('The two passwords don’t match.', 'bad'); return; }
      const { error } = await sb.auth.updateUser({ password: p1.value });
      if (error) toast(niceError(error), 'bad'); else { toast('Password changed.'); p1.value = ''; p2.value = ''; }
    };
    return h('div', null,
      pageHead('My Account', 'Who you’re signed in as, and your password. Staff can enter production, deliveries, counts and sales; admins can also change costs, prices, BOMs, planning settings and users.'),
      h('div', { class: 'set-grid' },
        h('section', { class: 'set-card' }, h('h2', null, 'Signed in as'),
          h('dl', { class: 'kv' }, h('dt', null, 'Email'), h('dd', null, p.email || state.user?.email || ''), h('dt', null, 'Role'), h('dd', null, h('span', { class: 'role' }, p.role || 'staff'))),
          h('div', { class: 'set-actions' },
            h('button', { class: 'btn', onclick: () => refresh() }, 'Refresh data'),
            h('button', { class: 'btn', onclick: () => sb.auth.signOut() }, 'Sign out'))),
        h('form', { class: 'set-card', onsubmit: change }, h('h2', null, 'Change password'),
          h('label', { class: 'field' }, `New password (${MIN_PASSWORD}+ characters, with a number)`, p1), h('label', { class: 'field' }, 'Again', p2),
          h('div', { class: 'set-actions' }, h('button', { class: 'btn primary', type: 'submit' }, 'Change password')))));
  },
};

// ---------- Site ----------
export const site = {
  id: 'site',
  label: 'Site',
  adminOnly: true,
  render() {
    const setting = siteDateSetting();
    const has = state.data.settings && 'site_date' in state.data.settings;
    const pinned = !!todayIso() && todayIso() !== realTodayIso();
    const input = h('input', { type: 'date', value: setting || '', 'aria-label': 'Site date' });
    const save = async (v) => {
      try { await saveSettings({ site_date: v || null }); toast(v ? `The site now treats ${longDate(v)} as today.` : 'The site now uses the real date.'); setTimeout(() => location.reload(), 600); }
      catch (err) { toast(niceError(err), 'bad'); }
    };
    return h('div', null,
      pageHead('Site', 'Settings for the whole site, for everyone who uses it.'),
      h('div', { class: 'set-grid' },
        h('section', { class: 'set-card' }, h('h2', null, 'Today’s date'),
          h('p', { class: 'small muted' }, 'Every page works from this date: Planning, the Dashboard, which month opens, New Receipts and New Counts. Pin it to the last day your data runs through while catching up; clear it to use the real date.'),
          h('dl', { class: 'kv' }, h('dt', null, 'The site uses'), h('dd', null, h('strong', null, longDate(todayIso())), pinned ? h('span', { class: 'pill ic', style: { marginLeft: '8px' } }, 'pinned') : h('span', { class: 'muted' }, ' (the real date)'))),
          has ? [h('label', { class: 'field' }, 'Pin to', input),
            h('div', { class: 'set-actions' },
              h('button', { class: 'btn primary', onclick: () => save(input.value) }, 'Save'),
              setting ? h('button', { class: 'btn', onclick: () => save(null) }, 'Use the real date') : null)]
            : h('p', { class: 'note warn' }, `Pinned to ${longDate(PRETEND_TODAY)} until the database is updated (the next deploy to main); then it can be changed here.`))));
  },
};

// ---------- Site Health ----------
// Probes for database updates that a deploy may not have applied yet.
const PROBES = [
  ['items', 'receiving_unit,units_per_receiving', 'Receipt units on items'],
  ['purchase_settings', 'lead_days,safety_stock,notes', 'Lead times, safety stocks and notes'],
  ['production_plan', 'item_no,week,cases', 'Production plan'],
  ['labor_positions', 'id', 'Labor positions'],
  ['boms', 'item_no,year', 'BOMs by year'],
  ['settings', 'site_date', 'Site date setting'],
  ['profiles', 'name,disabled', 'Turning accounts off'],
];
let probe = null; // { results, at }
let probing = false;
let people = null;
let security = null; // { signups: true|false|null, adminKey: true|false|null }
// Supabase's public sign-in settings (no key needed beyond the publishable one).
async function authSettings() {
  if (window.__MOCK_AUTH_SETTINGS__) return window.__MOCK_AUTH_SETTINGS__;
  const cfg = window.STANS_CONFIG || {}; const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 6000);
  try { const r = await fetch(`${cfg.supabaseUrl}/auth/v1/settings`, { headers: { apikey: cfg.supabaseKey }, signal: ctl.signal }); return r.ok ? await r.json() : null; }
  catch { return null; } finally { clearTimeout(t); }
}
function runProbes(rerender) {
  if (probing) return; probing = true;
  Promise.all([
    ...PROBES.map(([t, cols, label]) => Promise.resolve().then(() => sb.from(t).select(cols).range(0, 0)).then(({ error }) => ({ label, ok: !error, error: error?.message })).catch((e) => ({ label, ok: false, error: e.message }))),
    listAudit(1).then(() => ({ label: 'Change history', ok: true })).catch((e) => ({ label: 'Change history', ok: false, error: e.message })),
  ]).then((results) => { probe = { results, at: new Date() }; })
    .finally(() => { probing = false; rerender(); });
  listProfiles().then((p) => { people = p; rerender(); }).catch(() => {});
  Promise.all([authSettings(), adminApi('GET').then((r) => !!r.configured).catch(() => null)])
    .then(([a, key]) => { security = { signups: a ? !a.disable_signup : null, adminKey: key }; rerender(); });
}
const daysSince = (iso) => (iso ? Math.round((new Date(todayIso() + 'T00:00:00Z') - new Date(iso + 'T00:00:00Z')) / 864e5) : null);
const latest = (rows) => rows.reduce((a, r) => (r.date > a ? r.date : a), '');

export const health = {
  id: 'health',
  label: 'Site Health',
  adminOnly: true,
  render({ rerender }) {
    if (!probe) runProbes(rerender);
    const d = state.data; const ix = derived.ix(); const today = todayIso(); const y = thisYear();
    const checks = []; // [state 'ok'|'warn'|'bad', area, title, detail, link]
    const add = (st, area, title, detail, href) => checks.push({ st, area, title, detail, href });

    // Database
    const loaded = state.loadedAt ? new Date(state.loadedAt) : null;
    add('ok', 'Database', 'Connected', loaded ? `Data loaded at ${loaded.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}.` : '');
    if (!probe) add('warn', 'Database', 'Checking for database updates…', '');
    else {
      const bad = probe.results.filter((r) => !r.ok);
      add(bad.length ? 'bad' : 'ok', 'Database', bad.length ? 'Database needs updating' : 'Database is up to date',
        bad.length ? `Missing: ${bad.map((r) => r.label).join(', ')}. The update runs on the next deploy to main.` : `${probe.results.length} features checked.`);
    }
    // Site date
    const pinned = today !== realTodayIso();
    add(pinned ? 'warn' : 'ok', 'Site', pinned ? `Today is pinned to ${longDate(today)}` : 'Using the real date', pinned ? `The real date is ${longDate(realTodayIso())}. Change it on Settings → Site once the data is caught up.` : '', pinned ? '#site' : null);
    // Data freshness
    const fresh = [['Production', latest(d.production), '#production', 7], ['Deliveries', latest(d.goods_receipts), '#newreceipts', 21], ['Sales', latest(d.sales), '#sales', 14], ['Cycle counts', latest(d.cycle_counts), '#newcounts', 60]];
    for (const [what, last, href, limit] of fresh) {
      const n = daysSince(last);
      add(n === null ? 'bad' : n > limit * 2 ? 'bad' : n > limit ? 'warn' : 'ok', 'Data', `${what}: ${last ? `last entered ${longDate(last)}` : 'nothing entered'}`,
        n === null ? '' : n < 0 ? `${-n} day${n === -1 ? '' : 's'} after the site’s date (${longDate(todayIso())}).` : n > limit ? `${n} days before the site’s date.` : n === 0 ? 'On the site’s date.' : `${n} day${n === 1 ? '' : 's'} before the site’s date.`, n !== null && n <= limit ? null : href);
    }
    // Standards
    for (const yr of [y, y + 1]) {
      const m = missingStandards(d, yr);
      if (m.costs.length) add(yr === y ? 'bad' : 'warn', 'Standards', `${m.costs.length} item${m.costs.length > 1 ? 's' : ''} without a ${yr} standard cost`, yr === y ? m.costs.map((i) => i.name).join(', ') : `They’ll use the ${yr - 1} cost until entered.`, '#costs');
      if (m.prices.length) add(yr === y ? 'bad' : 'warn', 'Standards', `${m.prices.length} product${m.prices.length > 1 ? 's' : ''} without a ${yr} standard price`, m.prices.map((i) => i.name).join(', '), '#prices');
    }
    if (!checks.some((c) => c.area === 'Standards')) add('ok', 'Standards', `${y} and ${y + 1} standards are complete`, '');
    const noBom = ix.byType('Finished Good').filter((fg) => !ix.bom.has(fg.item_no));
    add(noBom.length ? 'bad' : 'ok', 'Standards', noBom.length ? `${noBom.length} product${noBom.length > 1 ? 's' : ''} without a BOM` : 'Every product has a BOM', noBom.map((i) => i.name).join(', '), noBom.length ? '#bom' : null);
    // Items
    const mats = [...ix.byType('Raw Material'), ...ix.byType('Component')];
    const noUnit = d.items.filter((i) => !i.unit);
    if (noUnit.length) add('warn', 'Items', `${noUnit.length} item${noUnit.length > 1 ? 's' : ''} without a base unit`, noUnit.map((i) => i.name).join(', '), '#costs');
    const noRcpt = mats.filter((i) => !hasReceiving(i));
    add(noRcpt.length ? 'warn' : 'ok', 'Items', noRcpt.length ? `${noRcpt.length} material${noRcpt.length > 1 ? 's' : ''} without a Receipt (how it’s delivered)` : 'Every material has a Receipt', noRcpt.length ? `${noRcpt.map((i) => i.name).join(', ')}. Deliveries and counts for these are entered in the base unit.` : '', noRcpt.length ? '#costs' : null);
    // Inventory
    const inv = derived.inventory();
    const neg = mats.filter((i) => (inv.byItem.get(i.item_no)?.get(today) ?? 0) < 0);
    add(neg.length ? 'bad' : 'ok', 'Inventory', neg.length ? `${neg.length} item${neg.length > 1 ? 's' : ''} below zero on ${longDate(today)}` : 'No negative inventory', neg.length ? `${neg.map((i) => i.name).join(', ')}. Usually a delivery that wasn’t entered, or a count that’s due.` : '', neg.length ? '#newreceipts' : null);
    const lastCount = new Map(); for (const c of d.cycle_counts) if (!lastCount.has(c.item_no) || c.date > lastCount.get(c.item_no)) lastCount.set(c.item_no, c.date);
    const stale = mats.filter((i) => { const n = daysSince(lastCount.get(i.item_no)); return n === null || n > 90; });
    add(stale.length ? 'warn' : 'ok', 'Inventory', stale.length ? `${stale.length} item${stale.length > 1 ? 's' : ''} not counted in 90 days` : 'Everything counted in the last 90 days', stale.map((i) => i.name).join(', '), stale.length ? '#newcounts' : null);
    // Planning
    const mp = derived.materials();
    const red = mp.rows.filter((r) => r.status === 'red'); const orange = mp.rows.filter((r) => r.status === 'orange');
    add(red.length ? 'bad' : orange.length ? 'warn' : 'ok', 'Planning', red.length || orange.length ? `${red.length} below safety stock, ${orange.length} overdue to order` : 'Nothing below safety stock or overdue',
      [...red, ...orange].map((r) => r.item.name).join(', '), red.length || orange.length ? '#purchasing' : null);
    // Security
    if (security) {
      add(security.signups === null ? 'warn' : security.signups ? 'bad' : 'ok', 'Security', security.signups === null ? 'Couldn’t check whether anyone can sign up' : security.signups ? 'Anyone can create an account' : 'Only admins can add people',
        security.signups ? 'New accounts can’t see anything until an admin turns them on, but sign-ups should be off. They’re turned off on the next deploy to main (or in Supabase → Authentication → Sign In / Providers → Allow new users to sign up).' : '');
      add(security.adminKey ? 'ok' : 'warn', 'Security', security.adminKey ? 'User management is set up' : 'User management needs its key',
        security.adminKey ? '' : 'Adding, deleting and passwords on Settings → Users need the SUPABASE_SERVICE_ROLE_KEY secret on the Cloudflare Worker.', security.adminKey ? null : '#users');
    }
    if (people) {
      const off = people.filter((p) => p.disabled);
      if (off.length) add('ok', 'Security', `${off.length} account${off.length > 1 ? 's' : ''} turned off`, off.map((p) => p.email).join(', '), '#users');
    }
    // Users
    if (people) {
      const admins = people.filter((p) => p.role === 'admin' && !p.disabled).length;
      add(admins < 2 ? 'warn' : 'ok', 'Users', `${people.length} user${people.length === 1 ? '' : 's'}, ${admins} admin${admins === 1 ? '' : 's'}`, admins < 2 ? 'Consider a second admin so you’re never locked out.' : '', '#users');
    }

    const counts = { ok: 0, warn: 0, bad: 0 }; for (const c of checks) counts[c.st]++;
    const order = { bad: 0, warn: 1, ok: 2 };
    const icon = { ok: '✓', warn: '!', bad: '✕' };
    return h('div', null,
      pageHead('Site Health', 'A check of everything the site depends on: the database, how up to date the data is, standards, items, inventory and planning. Red needs fixing; yellow is worth a look. Click a row to go fix it.'),
      h('div', { class: 'health-summary' },
        h('span', { class: 'hs bad' }, `${counts.bad} to fix`), h('span', { class: 'hs warn' }, `${counts.warn} to look at`), h('span', { class: 'hs ok' }, `${counts.ok} fine`),
        h('button', { class: 'btn ghost', onclick: () => { probe = null; people = null; security = null; refresh(); } }, 'Check again')),
      h('div', { class: 'tablewrap' }, h('table', { class: 't health-table' },
        h('thead', null, h('tr', null, h('th', null, ''), h('th', null, 'Area'), h('th', null, 'Check'), h('th', null, 'Details'), h('th', null, ''))),
        h('tbody', null, [...checks].sort((a, b) => order[a.st] - order[b.st]).map((c) => h('tr', { class: `hc-${c.st}` + (c.href ? ' link' : ''), onclick: c.href ? () => { location.hash = c.href.slice(1); } : null },
          h('td', { class: 'hc-icon' }, h('span', null, icon[c.st])), h('td', { class: 'muted' }, c.area), h('td', { class: 'hc-title' }, c.title), h('td', { class: 'hc-detail' }, c.detail),
          h('td', { class: 'hc-go' }, c.href ? 'Fix →' : '')))))));
  },
};

// ---------- Data ----------
const TABLE_LABELS = { items: 'Items', standard_costs: 'Standard costs', standard_prices: 'Standard prices', boms: 'BOMs', bom_lines: 'BOM lines', year_settings: 'Year settings',
  purchase_settings: 'Safety stock settings', production: 'Production', goods_receipts: 'Deliveries', cycle_counts: 'Cycle counts', sales: 'Sales lines', sales_imports: 'QuickBooks imports',
  qb_name_map: 'QuickBooks names', labor_positions: 'Labor positions', production_plan: 'Production plan' };
export const data = {
  id: 'data',
  label: 'Data',
  adminOnly: true,
  render() {
    const d = state.data;
    const rows = Object.entries(TABLE_LABELS).filter(([t]) => Array.isArray(d[t])).map(([t, label]) => {
      const dates = d[t].map((r) => r.date || r.week || r.created_at?.slice(0, 10)).filter(Boolean).sort();
      return { t, label, n: d[t].length, from: dates[0], to: dates.at(-1) };
    });
    const backup = () => {
      const out = { exported_at: new Date().toISOString(), site_date: todayIso(), settings: d.settings };
      for (const [t] of Object.entries(TABLE_LABELS)) if (Array.isArray(d[t])) out[t] = d[t];
      const url = URL.createObjectURL(new Blob([JSON.stringify(out, null, 1)], { type: 'application/json' }));
      const a = h('a', { href: url, download: `stans-ims-backup-${realTodayIso()}.json` }); document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    return h('div', null,
      pageHead('Data', 'Everything the site keeps, table by table. Download a backup before big changes (a new year’s standards, a batch of corrections); it’s one file with every table. Refresh data reloads from the database, e.g. after someone else made changes.'),
      h('div', { class: 'set-actions page-actions' },
        h('button', { class: 'btn primary', onclick: backup }, 'Download a backup'),
        h('button', { class: 'btn', onclick: () => refresh() }, 'Refresh data')),
      h('div', { class: 'tablewrap' }, h('table', { class: 't' },
        h('thead', null, h('tr', null, h('th', null, 'Table'), h('th', { class: 'num' }, 'Rows'), h('th', null, 'From'), h('th', null, 'To'))),
        h('tbody', null, rows.map((r) => h('tr', null, h('td', null, r.label), h('td', { class: 'num' }, r.n.toLocaleString()),
          h('td', { class: 'muted' }, r.from ? longDate(r.from) : ''), h('td', { class: 'muted' }, r.to ? longDate(r.to) : '')))))));
  },
};

