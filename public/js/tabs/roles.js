// Settings → Roles (admins): what each role can see and change, area by area.
// Admin can do everything and can't be changed; Staff is built in. The
// database enforces the same rules (public.can), so a role that can't edit an
// area can't change it from anywhere.
import { h, pageHead, toast, niceError, confirmDialog } from '../ui.js';
import { state, insertRow, updateRow, deleteRow, listProfiles } from '../store.js';
import { AREAS, LEVELS, roleList } from '../perms.js';

let people = null; let loading = false;
const slug = (name) => name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'role';

export default {
  id: 'roles',
  label: 'Roles',
  adminOnly: true,
  render({ rerender }) {
    const live = !state.data.missingTables?.has('roles');
    if (!people && !loading) { loading = true; listProfiles().then((p) => { people = p; }).catch(() => { people = []; }).finally(() => { loading = false; rerender(); }); }
    const roles = roleList();
    const using = (id) => (people || []).filter((p) => p.role === id).length;

    const nameInput = h('input', { type: 'text', maxlength: 40, placeholder: 'e.g. Receiving', 'aria-label': 'New role name', disabled: !live });
    const addRole = async (e) => {
      e.preventDefault();
      const name = nameInput.value.trim(); if (!name) { nameInput.focus(); return; }
      let id = slug(name); const taken = new Set(roles.map((r) => r.id)); for (let i = 2; taken.has(id); i++) id = `${slug(name).slice(0, 36)}-${i}`;
      const staff = roles.find((r) => r.id === 'staff');
      try {
        await insertRow('roles', { id, name, permissions: { ...(staff?.permissions || {}) }, sort: Math.max(1, ...roles.map((r) => r.sort ?? 0)) + 1 });
        toast(`${name} added, starting from Staff’s access. Change what it can do below.`); nameInput.value = '';
      } catch (err) { toast(niceError(err), 'bad'); }
    };
    const setLevel = async (r, area, v, sel) => {
      try { await updateRow('roles', 'id', r.id, { permissions: { ...(r.permissions || {}), [area]: v } }); }
      catch (err) { sel.value = r.permissions?.[area] || 'none'; toast(niceError(err), 'bad'); }
    };
    const rename = async (r, v, input) => {
      if (!v) { input.value = r.name; return; }
      try { await updateRow('roles', 'id', r.id, { name: v }); toast('Role renamed.'); } catch (err) { input.value = r.name; toast(niceError(err), 'bad'); }
    };
    const remove = async (r) => {
      if (using(r.id)) { toast(`${using(r.id)} ${using(r.id) === 1 ? 'person has' : 'people have'} the ${r.name} role. Give them another role on Users first.`, 'bad'); return; }
      if (!(await confirmDialog(`Delete the ${r.name} role?`, 'Delete'))) return;
      try { await deleteRow('roles', 'id', r.id); toast(`${r.name} deleted.`); } catch (err) { toast(niceError(err), 'bad'); }
    };

    const head = h('tr', null, h('th', { class: 'role-area-h' }, 'Area'), roles.map((r) => {
      const n = using(r.id);
      const locked = r.id === 'admin' || !live;
      const input = h('input', { type: 'text', value: r.name, maxlength: 40, disabled: locked, 'aria-label': `Name of the ${r.name} role`,
        onkeydown: (e) => { if (e.key === 'Enter') e.target.blur(); }, onchange: (e) => rename(r, e.target.value.trim(), e.target) });
      return h('th', { class: 'role-col' + (r.id === 'admin' ? ' role-admin' : '') },
        h('div', { class: 'role-name' + (locked ? '' : ' cell entry') }, input),
        h('div', { class: 'role-meta' }, people ? `${n} ${n === 1 ? 'person' : 'people'}` : '', r.builtin ? ' · built in' : '',
          !r.builtin && live ? h('button', { class: 'btn icon-btn danger', title: `Delete ${r.name}`, 'aria-label': `Delete ${r.name}`, onclick: () => remove(r) }, '×') : null));
    }));
    const rows = AREAS.map((a) => h('tr', null,
      h('td', { class: 'role-area' }, h('strong', null, a.label), h('div', { class: 'small muted' }, a.tabs)),
      roles.map((r) => {
        if (r.id === 'admin') return h('td', { class: 'role-cell role-admin' }, h('span', { class: 'lvl lvl-edit' }, 'Full'));
        const cur = r.permissions?.[a.id] || 'none';
        const sel = h('select', { 'aria-label': `${r.name}: ${a.label}`, 'data-k': `role|${r.id}|${a.id}`, disabled: !live, class: `lvl-sel lvl-${cur}`,
          onchange: (e) => setLevel(r, a.id, e.target.value, e.target) },
          LEVELS.filter(([v]) => a.edit || v !== 'edit').map(([v, label]) => h('option', { value: v, selected: v === cur }, label)));
        return h('td', { class: 'role-cell' + (live ? ' cell entry' : '') }, sel);
      })));
    const settingsRow = h('tr', { class: 'role-fixed' },
      h('td', { class: 'role-area' }, h('strong', null, 'Settings'), h('div', { class: 'small muted' }, 'Users, Roles, Periods, Security, Change history')),
      roles.map((r) => h('td', { class: 'role-cell' + (r.id === 'admin' ? ' role-admin' : '') }, r.id === 'admin' ? h('span', { class: 'lvl lvl-edit' }, 'Full') : h('span', { class: 'lvl lvl-none' }, 'Hidden'))));

    return h('div', null,
      pageHead('Roles', 'What each role can see and change. Hidden: the pages don’t show. View: the pages show but nothing can be changed. Edit: the pages can be changed too. Everyone can use My Account.',
        h('form', { class: 'role-add', onsubmit: addRole }, h('label', { class: 'field' }, 'New role', nameInput), h('button', { class: 'btn primary', type: 'submit', disabled: !live }, 'Add role')),
        h('p', { class: 'small muted' }, 'A new role starts with Staff’s access. Give people a role on Users.')),
      !live ? h('div', { class: 'note warn' }, 'Roles start working after the next deploy to main. Until then everyone is Staff or Admin.') : null,
      h('div', { class: 'tablewrap' }, h('table', { class: 't roles-table' }, h('thead', null, head), h('tbody', null, rows, settingsRow))),
      h('p', { class: 'small muted roles-foot' }, 'The database enforces these too: a role that can’t edit an area can’t change it from anywhere. Hidden sales and prices aren’t even sent to that person’s browser. Changes apply the next time someone loads the site.'));
  },
};
