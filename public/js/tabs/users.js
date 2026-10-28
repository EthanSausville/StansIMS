import { h, pageHead, toast, niceError, longDate } from '../ui.js';
import { listProfiles, setRole, state } from '../store.js';

let profiles = null;
let loading = false;

export default {
  id: 'users',
  label: 'Users',
  adminOnly: true,
  render({ rerender }) {
    if (!profiles && !loading) {
      loading = true;
      listProfiles().then((p) => { profiles = p; }).catch((e) => toast(niceError(e), 'bad')).finally(() => { loading = false; rerender(); });
    }
    return h('div', null,
      pageHead('Users', 'Staff can enter production, deliveries, counts and sales. Admins can also change costs, prices, recipes and settings.'),
      h('div', { class: 'note info' }, 'To add someone: in Supabase, open Authentication → Users → Invite user and enter their email. They get a link to choose a password, then show up here as staff.'),
      !profiles ? h('div', { class: 'empty' }, 'Loading…') : h('div', { class: 'tablewrap' }, h('table', { class: 't' },
        h('thead', null, h('tr', null, h('th', null, 'Email'), h('th', null, 'Role'), h('th', null, 'Added'))),
        h('tbody', null, profiles.map((p) => h('tr', null, h('td', null, p.email, p.user_id === state.user?.id ? h('span', { class: 'muted' }, ' (you)') : null),
          h('td', null, h('select', { 'aria-label': `Role for ${p.email}`, onchange: async (e) => {
              const role = e.target.value;
              try { const saved = await setRole(p.user_id, role); Object.assign(p, saved); toast(`${p.email} is now ${role}.`); }
              catch (err) { e.target.value = p.role; toast(/at least one admin/i.test(err.message) ? 'There must be at least one admin.' : niceError(err), 'bad'); }
            } }, ['staff', 'admin'].map((r) => h('option', { value: r, selected: p.role === r }, r)))),
          h('td', { class: 'muted' }, p.created_at ? longDate(p.created_at.slice(0, 10)) : '')))))));
  },
};
