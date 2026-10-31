// What each role can see and change (Settings → Roles). The database enforces
// the same rules (public.can() in supabase/schema.sql); this decides what the
// site shows and which cells can be typed in.
import { state } from './store.js';

// What a role can be given, page by page, grouped the way the menu is.
// `edit: false` pages are reports: hidden or view only. Permission keys are
// the tabs' ids (the database uses the same keys).
export const SECTIONS = [
  { label: 'Dashboard', tabs: [{ id: 'dashboard', label: 'Dashboard', edit: false }] },
  { label: 'Accounting', tabs: [{ id: 'journals', label: 'Journals', edit: false }, { id: 'taccounts', label: 'T-Accounts', edit: false }] },
  { label: 'Sales', tabs: [
    { id: 'sales', label: 'Sales Detail', edit: true, note: 'Edit: add and change sales, load QuickBooks reports' },
    { id: 'sales-customers', label: 'By Customer', edit: false }, { id: 'sales-products', label: 'By Product', edit: false },
    { id: 'prices', label: 'Standard Price', edit: true }] },
  { label: 'Inventory', tabs: [
    { id: 'production', label: 'Production', edit: true },
    { id: 'newreceipts', label: 'New Receipts', edit: true, note: 'Edit: enter deliveries' }, { id: 'receipts', label: 'All Receipts', edit: true, note: 'Edit: fix past deliveries' },
    { id: 'newcounts', label: 'New Counts', edit: true, note: 'Edit: enter counts' }, { id: 'counts', label: 'All Counts', edit: true, note: 'Edit: fix past counts' },
    { id: 'inventory', label: 'Daily Inventory', edit: false }, { id: 'consumption', label: 'Consumption', edit: false }] },
  { label: 'Planning', tabs: [
    { id: 'planning', label: 'Production', edit: true, note: 'Edit: the production plan' }, { id: 'purchasing', label: 'Purchases', edit: false },
    { id: 'safety', label: 'Safety Stocks', edit: true }] },
  { label: 'Standards', tabs: [
    { id: 'costs', label: 'Master List', edit: true, note: 'Edit: items and standard costs' }, { id: 'bom', label: 'BOMs', edit: true },
    { id: 'labor', label: 'Labor', edit: true }, { id: 'overhead', label: 'Overhead', edit: true }] },
  // Settings pages (My Account is everyone's). Only an admin can give the Admin
  // role or change an admin's account, whoever else can edit Users.
  { label: 'Settings', settings: true, tabs: [
    { id: 'users', label: 'Users', edit: true, note: 'Edit: add people, change their roles, turn accounts off and on (never an admin’s)' },
    { id: 'roles', label: 'Roles', edit: true, note: 'Edit: change what each role can see and do' },
    { id: 'periods', label: 'Periods', edit: true, note: 'Edit: close and reopen months, Beginnings and Endings' },
    { id: 'security', label: 'Security', edit: false }, { id: 'history', label: 'Change history', edit: false }] },
];
export const PAGES = SECTIONS.flatMap((s) => s.tabs);
export const LEVELS = [['none', 'Hidden'], ['view', 'View'], ['edit', 'Edit']];

// Staff, until the database has roles (and as the built-in starting point):
// enters production, deliveries, counts and sales; views everything else.
const STAFF_EDITS = new Set(['sales', 'production', 'newreceipts', 'receipts', 'newcounts', 'counts']);
export const STAFF_DEFAULT = Object.fromEntries(SECTIONS.filter((s) => !s.settings).flatMap((s) => s.tabs).map((t) => [t.id, STAFF_EDITS.has(t.id) ? 'edit' : 'view']));
export const FALLBACK_ROLES = [
  { id: 'admin', name: 'Admin', builtin: true, permissions: {}, sort: 0 },
  { id: 'staff', name: 'Accountant', builtin: true, permissions: STAFF_DEFAULT, sort: 1 },
];

export const roleList = () => {
  const rs = state.data?.roles || [];
  // Admin and Staff are always there (built in), even before the database has roles.
  return [...rs, ...FALLBACK_ROLES.filter((f) => !rs.some((r) => r.id === f.id))].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || a.name.localeCompare(b.name));
};
export const roleName = (id) => roleList().find((r) => r.id === id)?.name || id || '';

// Someone's roles (they can have several).
export const rolesOf = (p) => (p?.roles?.length ? p.roles : p?.role ? [p.role] : []);
// The roles the site is acting on: an admin viewing as other roles gets theirs.
export const activeRoles = () => (state.simulate ? state.simulate.roles : rolesOf(state.profile));
const RANK = { none: 0, view: 1, edit: 2 };
// The level a set of roles gives for a page: the most any of them gives.
export function levelFor(roleIds, area) {
  if (roleIds.includes('admin')) return 'edit';
  let best = 'none';
  for (const id of roleIds) {
    const role = roleList().find((r) => r.id === id);
    const lvl = (role ? role.permissions : id === 'staff' ? STAFF_DEFAULT : {})?.[area] || 'none';
    if (RANK[lvl] > RANK[best]) best = lvl;
  }
  return best;
}
// Can the signed-in person view (or, with 'edit', change) this page?
export function can(area, need = 'view') {
  const p = state.profile;
  if (!p || p.disabled) return false;
  const roles = activeRoles();
  if (roles.includes('admin')) return true;
  if (!area) return true;
  const lvl = levelFor(roles, area);
  return lvl === 'edit' || (lvl === 'view' && need === 'view');
}
// Sales lines and prices only reach someone who can see a page built from them (as in the database).
export const canSeeSales = () => ['sales', 'sales-customers', 'sales-products', 'prices', 'dashboard', 'journals', 'taccounts'].some((k) => can(k));

// "View as": an admin sees the site exactly as these roles would (what shows,
// what can be typed in). Anything changed while viewing as is still real.
export const viewAs = (roles, label) => window.dispatchEvent(new CustomEvent('stans:simulate', { detail: { roles, label } }));
export const stopViewingAs = () => window.dispatchEvent(new CustomEvent('stans:simulate', { detail: null }));

// Closed months (Settings → Periods): 'YYYY-MM' of every closed month.
export function closedMonths() { return new Set((state.data?.closed_periods || []).map((c) => String(c.month).slice(0, 7))); }
// A year's Beginning closed: its standards can't change (Settings → Periods).
export const standardsLocked = (year) => (state.data?.closed_beginnings || []).some((y) => Number(y.year) === Number(year));
export const lockedNote = (year) => `${year}’s standards are locked (Settings → Periods → ${year} Beginning), so they can’t be changed.`;
export const yearClosed = (year) => (state.data?.closed_years || []).some((y) => Number(y.year) === Number(year));
export const isClosed = (date) => !!date && (closedMonths().has(String(date).slice(0, 7)) || yearClosed(String(date).slice(0, 4)));
export const monthName = (ym) => new Date(`${ym}-01T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
export const closedNote = (ym) => `${monthName(ym)} is closed, so its entries can’t be changed.${state.profile?.role === 'admin' ? ' Reopen it in Settings → Periods.' : ' An admin can reopen it.'}`;
