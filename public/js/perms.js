// What each role can see and change (Settings → Roles). The database enforces
// the same rules (public.can() in supabase/schema.sql); this decides what the
// site shows and which cells can be typed in.
import { state } from './store.js';

// The areas of the site a role can be given. `edit: false` areas are reports:
// hidden or view only.
export const AREAS = [
  { id: 'dashboard', label: 'Dashboard', tabs: 'Dashboard', edit: false },
  { id: 'accounting', label: 'Accounting', tabs: 'Journals, T-Accounts', edit: false },
  { id: 'sales', label: 'Sales', tabs: 'Sales Detail, By Customer, By Product, QuickBooks reports', edit: true },
  { id: 'prices', label: 'Standard prices', tabs: 'Standard Price', edit: true },
  { id: 'production', label: 'Production', tabs: 'Inventory → Production', edit: true },
  { id: 'receipts', label: 'Receipts', tabs: 'New Receipts, All Receipts', edit: true },
  { id: 'counts', label: 'Counts', tabs: 'New Counts, All Counts', edit: true },
  { id: 'inventory', label: 'Inventory reports', tabs: 'Daily Inventory, Consumption', edit: false },
  { id: 'planning', label: 'Planning', tabs: 'Production plan, Purchases, Safety Stocks', edit: true },
  { id: 'standards', label: 'Standards', tabs: 'Master List, BOMs, Labor, Overhead', edit: true },
];
export const LEVELS = [['none', 'Hidden'], ['view', 'View'], ['edit', 'Edit']];

// Which area each tab belongs to.
export const TAB_AREA = {
  dashboard: 'dashboard', journals: 'accounting', taccounts: 'accounting',
  sales: 'sales', 'sales-customers': 'sales', 'sales-products': 'sales', prices: 'prices',
  production: 'production', newreceipts: 'receipts', receipts: 'receipts', newcounts: 'counts', counts: 'counts',
  inventory: 'inventory', consumption: 'inventory',
  planning: 'planning', purchasing: 'planning', safety: 'planning',
  costs: 'standards', bom: 'standards', labor: 'standards', overhead: 'standards',
};

// Staff, until the database has roles (and as the built-in starting point).
export const STAFF_DEFAULT = { dashboard: 'view', accounting: 'view', sales: 'edit', prices: 'view', production: 'edit', receipts: 'edit', counts: 'edit', inventory: 'view', planning: 'view', standards: 'view' };
export const FALLBACK_ROLES = [
  { id: 'admin', name: 'Admin', builtin: true, permissions: {}, sort: 0 },
  { id: 'staff', name: 'Staff', builtin: true, permissions: STAFF_DEFAULT, sort: 1 },
];

export const roleList = () => {
  const rs = state.data?.roles || [];
  // Admin and Staff are always there (built in), even before the database has roles.
  return [...rs, ...FALLBACK_ROLES.filter((f) => !rs.some((r) => r.id === f.id))].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || a.name.localeCompare(b.name));
};
export const roleName = (id) => roleList().find((r) => r.id === id)?.name || id || '';

// Can the signed-in person view (or, with 'edit', change) this area?
export function can(area, need = 'view') {
  const p = state.profile;
  if (!p || p.disabled) return false;
  if (p.role === 'admin') return true;
  if (!area) return true;
  const role = roleList().find((r) => r.id === p.role);
  const lvl = (role ? role.permissions : p.role === 'staff' ? STAFF_DEFAULT : {})?.[area] || 'none';
  return lvl === 'edit' || (lvl === 'view' && need === 'view');
}
export const canEditTab = (tabId) => can(TAB_AREA[tabId], 'edit');

// Closed months (Settings → Periods): 'YYYY-MM' of every closed month.
export function closedMonths() { return new Set((state.data?.closed_periods || []).map((c) => String(c.month).slice(0, 7))); }
export const isClosed = (date) => !!date && closedMonths().has(String(date).slice(0, 7));
export const monthName = (ym) => new Date(`${ym}-01T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
export const closedNote = (ym) => `${monthName(ym)} is closed, so its entries can’t be changed.${state.profile?.role === 'admin' ? ' Reopen it in Settings → Periods.' : ' An admin can reopen it.'}`;
