// Settings → Roles: what each role can see and change, page by page, grouped
// like the menu (Settings pages included). Admin can do everything and can't
// be changed; Accountant (id 'staff') is built in. The database enforces the same rules (public.can), so a role
// that can't edit a page can't change its data from anywhere.
import { h, pageHead, toast, niceError, confirmDialog } from '../ui.js';
import { state, insertRow, updateRow, deleteRow, listProfiles } from '../store.js';
import { SECTIONS, PAGES, roleList, rolesOf, viewAs, can } from '../perms.js';

let people = null; let loading = false;
let ro = null; // watches the table's width (compact buttons)
const slug = (name) => name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'role';
const LABEL = { none: 'Hidden', view: 'View', edit: 'Edit' };
const lvlOf = (r, page) => r.permissions?.[page.id] || 'none';

// A small form in a dialog: the name and (for a new role) where to start from.
function roleDialog({ title, role, starts }) {
  return new Promise((resolve) => {
    const name = h('input', { type: 'text', maxlength: 40, value: role?.name || '', required: true, placeholder: 'e.g. Receiving' });
    const from = starts ? h('select', null, starts.map(([v, label]) => h('option', { value: v }, label))) : null;
    const dlg = h('dialog', { class: 'role-dialog' }, h('form', { method: 'dialog' },
      h('p', { style: { margin: 0 } }, h('strong', null, title)),
      h('label', { class: 'field' }, 'Name', name),
      from ? h('label', { class: 'field' }, 'Start with', from) : null,
      h('div', { class: 'actions' }, h('button', { class: 'btn', value: 'cancel', formnovalidate: true }, 'Cancel'), h('button', { class: 'btn primary', value: 'ok' }, role ? 'Save' : 'Add role'))));
    dlg.addEventListener('close', () => { resolve(dlg.returnValue === 'ok' && name.value.trim() ? { name: name.value.trim(), from: from?.value } : null); dlg.remove(); });
    document.body.append(dlg); dlg.showModal(); name.focus();
  });
}

export default {
  id: 'roles',
  label: 'Roles',
  render({ rerender }) {
    const live = !state.data.missingTables?.has('roles') && can('roles', 'edit'); // can change roles
    const amAdmin = state.profile?.role === 'admin';
    if (!people && !loading) { loading = true; listProfiles().then((p) => { people = p; }).catch(() => { people = []; }).finally(() => { loading = false; rerender(); }); }
    const roles = roleList();
    const using = (id) => (people || []).filter((p) => rolesOf(p).includes(id));

    const save = async (r, permissions) => {
      try { await updateRow('roles', 'id', r.id, { permissions }); } catch (err) { toast(niceError(err), 'bad'); }
    };
    const addRole = async (copyOf) => {
      const starts = [['view', 'View every page (except Settings), change nothing'], ['none', 'Nothing (pick pages below)'],
        ...roles.filter((r) => r.id !== 'admin').map((r) => [r.id, `Same as ${r.name}`])];
      const got = copyOf ? { name: `${copyOf.name} copy`, from: copyOf.id } : await roleDialog({ title: 'New role', starts });
      if (!got) return;
      let id = slug(got.name); const taken = new Set(roles.map((r) => r.id)); for (let i = 2; taken.has(id); i++) id = `${slug(got.name).slice(0, 36)}-${i}`;
      const base = roles.find((r) => r.id === got.from);
      const permissions = got.from === 'view' ? Object.fromEntries(SECTIONS.filter((x) => !x.settings).flatMap((x) => x.tabs).map((p) => [p.id, 'view'])) : got.from === 'none' ? {} : { ...(base?.permissions || {}) };
      try {
        await insertRow('roles', { id, name: got.name, permissions, sort: Math.max(1, ...roles.map((r) => r.sort ?? 0)) + 1 });
        toast(`${got.name} added. Choose what it can see and change in its column.`);
      } catch (err) { toast(niceError(err), 'bad'); }
    };
    const editRole = async (r) => {
      const got = await roleDialog({ title: `Rename ${r.name}`, role: r }); if (!got) return;
      try { await updateRow('roles', 'id', r.id, { name: got.name }); toast('Saved.'); } catch (err) { toast(niceError(err), 'bad'); }
    };
    const removeRole = async (r) => {
      const n = using(r.id).length;
      if (n) { toast(`${n} ${n === 1 ? 'person has' : 'people have'} the ${r.name} role. Give them another role on Users first.`, 'bad'); return; }
      if (!(await confirmDialog(`Delete the ${r.name} role?`, 'Delete'))) return;
      try { await deleteRow('roles', 'id', r.id); toast(`${r.name} deleted.`); } catch (err) { toast(niceError(err), 'bad'); }
    };

    // ---- header: one column per role ----
    // Columns alternate dark and light, starting with Admin's dark one.
    const tone = (i) => (i % 2 === 0 ? 'rp-dark' : 'rp-light');
    const head = h('tr', null, h('th', { class: 'rp-page-h' }, 'Page'), roles.map((r, i) => {
      const admin = r.id === 'admin'; const who = using(r.id);
      const icon = (label, title, fn, cls = '') => h('button', { type: 'button', class: `rp-icon ${cls}`.trim(), title, 'aria-label': `${title}: ${r.name}`, onclick: fn }, label);
      return h('th', { class: `rp-role ${tone(i)}` },
        h('div', { class: 'rp-name' }, admin ? '🔒 ' : '', r.name),
        h('div', { class: 'rp-meta' },
          h('a', { href: '#users', title: who.map((p) => p.email).join(', ') || 'Nobody yet' }, people ? `${who.length} ${who.length === 1 ? 'person' : 'people'}` : '…'),
          !admin && amAdmin ? icon('👁', 'View the site as', () => viewAs([r.id], r.name)) : null,
          !admin && live ? [icon('✎', 'Rename', () => editRole(r)), icon('⧉', 'Duplicate', () => addRole(r)),
            !r.builtin ? icon('×', 'Delete', () => removeRole(r), 'danger') : null] : null));
    }));

    // ---- body: a row per page, grouped by section ----
    function myAccountRow() {
      return h('tr', { class: 'rp-row rp-fixed' }, h('td', { class: 'rp-page' }, 'My Account', h('div', { class: 'small muted' }, 'Everyone: their password and security questions')),
        roles.map((r, i) => h('td', { class: tone(i) }, h('span', { class: 'rp-full' }, '✓ Always'))));
    }
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
      h('tr', { class: 'rp-sec' }, h('th', { scope: 'rowgroup' }, sec.label), roles.map(() => h('td'))),
      ...(sec.settings ? [myAccountRow()] : []),
      ...sec.tabs.map((page) => h('tr', { class: 'rp-row' },
        h('td', { class: 'rp-page' }, page.label, page.note ? h('div', { class: 'small muted' }, page.note) : !page.edit ? h('div', { class: 'small muted' }, 'Report: view only') : null),
        roles.map((r, i) => (r.id === 'admin' ? h('td', { class: tone(i) }, h('span', { class: 'rp-full' }, '✓ Full')) : h('td', { class: tone(i) }, seg(r, page)))))),
    ]);
    // ---- footer: what each role adds up to ----
    const foot = h('tr', { class: 'rp-sum' }, h('td', null, 'Adds up to'), roles.map((r, i) => {
      if (r.id === 'admin') return h('td', { class: tone(i) }, 'Everything');
      const seen = PAGES.filter((p) => lvlOf(r, p) !== 'none').length + 1; // + My Account
      const edits = PAGES.filter((p) => p.edit && lvlOf(r, p) === 'edit').length;
      return h('td', { class: tone(i) }, `Sees ${seen} of ${PAGES.length + 1} pages`, h('br'), `Changes ${edits}`);
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
      state.data.missingTables?.has('roles') ? h('div', { class: 'note warn' }, 'Roles start working after the next deploy to main. Until then everyone is Accountant or Admin.') : null,
      (wrap.append(h('table', { class: 't roles-table' }, h('thead', null, head), h('tbody', null, body), h('tfoot', null, foot))), wrap),
      h('p', { class: 'small muted rp-foot' }, 'Changes save as you click and apply the next time that person loads the site. The database enforces them too: a role that can’t edit a page can’t change its data from anywhere, and sales and prices aren’t sent at all to a role that can’t see a sales, price, dashboard or accounting page. Give people roles on Users; someone with several roles gets the most access any of them gives. Only an admin can give the Admin role or change an admin’s account, even if another role can edit Users. 👁 (admins) shows the site the way a role sees it.'));
  },
};
