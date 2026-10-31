// Settings → Roles (admins): what each role can see and change, page by page,
// grouped like the menu. Admin can do everything and can't be changed; Staff
// is built in. The database enforces the same rules (public.can), so a role
// that can't edit a page can't change its data from anywhere.
import { h, pageHead, toast, niceError, confirmDialog } from '../ui.js';
import { state, insertRow, updateRow, deleteRow, listProfiles } from '../store.js';
import { SECTIONS, PAGES, roleList, rolesOf, viewAs } from '../perms.js';

let people = null; let loading = false;
let ro = null; // watches the table's width (compact buttons)
const slug = (name) => name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'role';
const LABEL = { none: 'Hidden', view: 'View', edit: 'Edit' };
const lvlOf = (r, page) => r.permissions?.[page.id] || 'none';

// A small form in a dialog: name, description and (for a new role) where to start from.
function roleDialog({ title, role, starts }) {
  return new Promise((resolve) => {
    const name = h('input', { type: 'text', maxlength: 40, value: role?.name || '', required: true, placeholder: 'e.g. Receiving' });
    const desc = h('input', { type: 'text', maxlength: 140, value: role?.description || '', placeholder: 'Who it’s for, e.g. whoever unloads deliveries' });
    const from = starts ? h('select', null, starts.map(([v, label]) => h('option', { value: v }, label))) : null;
    const dlg = h('dialog', { class: 'role-dialog' }, h('form', { method: 'dialog' },
      h('p', { style: { margin: 0 } }, h('strong', null, title)),
      h('label', { class: 'field' }, 'Name', name), h('label', { class: 'field' }, 'Description (optional)', desc),
      from ? h('label', { class: 'field' }, 'Start with', from) : null,
      h('div', { class: 'actions' }, h('button', { class: 'btn', value: 'cancel', formnovalidate: true }, 'Cancel'), h('button', { class: 'btn primary', value: 'ok' }, role ? 'Save' : 'Add role'))));
    dlg.addEventListener('close', () => { resolve(dlg.returnValue === 'ok' && name.value.trim() ? { name: name.value.trim(), description: desc.value.trim() || null, from: from?.value } : null); dlg.remove(); });
    document.body.append(dlg); dlg.showModal(); name.focus();
  });
}

export default {
  id: 'roles',
  label: 'Roles',
  adminOnly: true,
  render({ rerender }) {
    const live = !state.data.missingTables?.has('roles');
    if (!people && !loading) { loading = true; listProfiles().then((p) => { people = p; }).catch(() => { people = []; }).finally(() => { loading = false; rerender(); }); }
    const roles = roleList();
    const using = (id) => (people || []).filter((p) => rolesOf(p).includes(id));

    const save = async (r, permissions) => {
      try { await updateRow('roles', 'id', r.id, { permissions }); } catch (err) { toast(niceError(err), 'bad'); }
    };
    const addRole = async (copyOf) => {
      const starts = [['staff', 'Same as Staff'], ['view', 'View everything, change nothing'], ['none', 'Nothing (pick pages below)'],
        ...roles.filter((r) => r.id !== 'admin' && r.id !== 'staff').map((r) => [r.id, `Same as ${r.name}`])];
      const got = copyOf ? { name: `${copyOf.name} copy`, description: copyOf.description, from: copyOf.id } : await roleDialog({ title: 'New role', starts });
      if (!got) return;
      let id = slug(got.name); const taken = new Set(roles.map((r) => r.id)); for (let i = 2; taken.has(id); i++) id = `${slug(got.name).slice(0, 36)}-${i}`;
      const base = roles.find((r) => r.id === got.from);
      const permissions = got.from === 'view' ? Object.fromEntries(PAGES.map((p) => [p.id, 'view'])) : got.from === 'none' ? {} : { ...(base?.permissions || {}) };
      try {
        await insertRow('roles', { id, name: got.name, description: got.description, permissions, sort: Math.max(1, ...roles.map((r) => r.sort ?? 0)) + 1 });
        toast(`${got.name} added. Choose what it can see and change in its column.`);
      } catch (err) { toast(niceError(err), 'bad'); }
    };
    const editRole = async (r) => {
      const got = await roleDialog({ title: `Rename ${r.name}`, role: r }); if (!got) return;
      try { await updateRow('roles', 'id', r.id, { name: got.name, description: got.description }); toast('Saved.'); } catch (err) { toast(niceError(err), 'bad'); }
    };
    const removeRole = async (r) => {
      const n = using(r.id).length;
      if (n) { toast(`${n} ${n === 1 ? 'person has' : 'people have'} the ${r.name} role. Give them another role on Users first.`, 'bad'); return; }
      if (!(await confirmDialog(`Delete the ${r.name} role?`, 'Delete'))) return;
      try { await deleteRow('roles', 'id', r.id); toast(`${r.name} deleted.`); } catch (err) { toast(niceError(err), 'bad'); }
    };

    // ---- header: one column per role ----
    const head = h('tr', null, h('th', { class: 'rp-page-h' }, 'Page'), roles.map((r) => {
      const admin = r.id === 'admin'; const who = using(r.id);
      const icon = (label, title, fn, cls = '') => h('button', { type: 'button', class: `rp-icon ${cls}`.trim(), title, 'aria-label': `${title}: ${r.name}`, onclick: fn }, label);
      return h('th', { class: 'rp-role' + (admin ? ' rp-admin' : '') },
        h('div', { class: 'rp-name' }, admin ? '🔒 ' : '', r.name),
        r.description ? h('div', { class: 'rp-desc' }, r.description) : null,
        h('div', { class: 'rp-meta' },
          h('a', { href: '#users', title: who.map((p) => p.email).join(', ') || 'Nobody yet' }, people ? `${who.length} ${who.length === 1 ? 'person' : 'people'}` : '…'),
          !admin ? icon('👁', 'View the site as', () => viewAs([r.id], r.name)) : null,
          !admin && live ? [icon('✎', 'Rename', () => editRole(r)), icon('⧉', 'Duplicate', () => addRole(r)),
            !r.builtin ? icon('×', 'Delete', () => removeRole(r), 'danger') : null] : null));
    }));

    // ---- body: a row per page, grouped by section ----
    const seg = (r, page) => {
      const cur = lvlOf(r, page);
      // All three always show; Edit is greyed out on report pages (nothing to change).
      return h('div', { class: 'rp-seg', role: 'group', 'aria-label': `${r.name}: ${page.label}` }, ['none', 'view', 'edit'].map((v) => {
        const na = v === 'edit' && !page.edit;
        return h('button', { type: 'button', class: `rp-btn rp-${v}` + (na ? ' rp-na' : ''), 'aria-pressed': String(cur === v), disabled: !live || na, 'data-k': `role|${r.id}|${page.id}|${v}`,
          title: na ? `${page.label} is a report: there’s nothing to change` : LABEL[v], 'aria-label': LABEL[v],
          onclick: () => { if (cur !== v) save(r, { ...(r.permissions || {}), [page.id]: v }); } },
          h('span', { class: 'rp-long' }, LABEL[v]), h('span', { class: 'rp-short', 'aria-hidden': 'true' }, LABEL[v][0]));
      }));
    };
    const body = SECTIONS.flatMap((sec) => [
      h('tr', { class: 'rp-sec' }, h('th', { scope: 'rowgroup' }, sec.label), roles.map((r) => h('td', { class: r.id === 'admin' ? 'rp-admin' : null }))),
      ...sec.tabs.map((page) => h('tr', { class: 'rp-row' },
        h('td', { class: 'rp-page' }, page.label, page.note ? h('div', { class: 'small muted' }, page.note) : !page.edit ? h('div', { class: 'small muted' }, 'Report: view only') : null),
        roles.map((r) => (r.id === 'admin' ? h('td', { class: 'rp-admin' }, h('span', { class: 'rp-full' }, '✓ Full')) : h('td', null, seg(r, page)))))),
    ]);
    const settingsRows = [
      h('tr', { class: 'rp-sec' }, h('th', { scope: 'rowgroup' }, 'Settings'), roles.map((r) => h('td', { class: r.id === 'admin' ? 'rp-admin' : null }))),
      h('tr', { class: 'rp-row rp-fixed' }, h('td', { class: 'rp-page' }, 'My Account', h('div', { class: 'small muted' }, 'Everyone: their password and security questions')),
        roles.map((r) => h('td', { class: r.id === 'admin' ? 'rp-admin' : null }, h('span', { class: 'rp-full' }, '✓ Always')))),
      h('tr', { class: 'rp-row rp-fixed' }, h('td', { class: 'rp-page' }, 'Users, Roles, Periods, Security, Change history', h('div', { class: 'small muted' }, 'Admins only')),
        roles.map((r) => h('td', { class: r.id === 'admin' ? 'rp-admin' : null }, r.id === 'admin' ? h('span', { class: 'rp-full' }, '✓ Full') : h('span', { class: 'rp-off' }, 'Hidden')))),
    ];
    // ---- footer: what each role adds up to ----
    const foot = h('tr', { class: 'rp-sum' }, h('td', null, 'Adds up to'), roles.map((r) => {
      if (r.id === 'admin') return h('td', { class: 'rp-admin' }, 'Everything');
      const seen = PAGES.filter((p) => lvlOf(r, p) !== 'none').length; const edits = PAGES.filter((p) => p.edit && lvlOf(r, p) === 'edit').length;
      return h('td', null, `Sees ${seen} of ${PAGES.length} pages`, h('br'), `Changes ${edits}`);
    }));

    // Narrow window: H / V / E instead of the full words, before the table has to scroll sideways.
    const wrap = h('div', { class: 'tablewrap' });
    const fit = () => { const t = wrap.firstChild; if (!t) return; t.classList.remove('compact'); if (t.scrollWidth > wrap.clientWidth + 1) t.classList.add('compact'); };
    requestAnimationFrame(fit);
    ro?.disconnect(); ro = new ResizeObserver(fit); ro.observe(wrap);
    return h('div', { class: 'roles-page' },
      pageHead('Roles', 'What each role can see and change, page by page.'),
      h('div', { class: 'rp-top' },
        h('div', { class: 'rp-legend' },
          h('span', { class: 'rp-btn rp-none', 'aria-pressed': 'true' }, 'Hidden'), ' the page doesn’t show',
          h('span', { class: 'rp-btn rp-view', 'aria-pressed': 'true' }, 'View'), ' can see it, can’t change anything',
          h('span', { class: 'rp-btn rp-edit', 'aria-pressed': 'true' }, 'Edit'), ' can see and change it'),
        live ? h('button', { class: 'btn primary', onclick: () => addRole() }, '+ New role') : null),
      !live ? h('div', { class: 'note warn' }, 'Roles start working after the next deploy to main. Until then everyone is Staff or Admin.') : null,
      (wrap.append(h('table', { class: 't roles-table' }, h('thead', null, head), h('tbody', null, body, settingsRows), h('tfoot', null, foot))), wrap),
      h('p', { class: 'small muted rp-foot' }, 'Changes save as you click and apply the next time that person loads the site. The database enforces them too: a role that can’t edit a page can’t change its data from anywhere, and sales and prices aren’t sent at all to a role that can’t see a sales, price, dashboard or accounting page. Give people roles on Users; someone with several roles gets the most access any of them gives. 👁 shows the site the way a role sees it.'));
  },
};
