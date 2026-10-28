import { h, pageHead, monthPicker, numberCell, qty, todayIso, longDate, seg } from '../ui.js';
import { state, derived, saveField, isAdmin } from '../store.js';
import { viewGrid, view } from './grid.js';

const FIELDS = [
  ['avg_weekly', 'Avg. weekly usage'], ['max_weekly', 'Max. weekly usage'], ['manual_usage', 'Planning usage'],
  ['standard_purchase', 'Standard purchase'], ['lead_time', 'Lead time'], ['safety_threshold', 'Safety threshold'],
];
let mode = 'plan';

export default {
  id: 'demand',
  label: 'Purchase Demand',
  render({ rerender }) {
    const ix = derived.ix(); const inv = derived.inventory(); const pd = derived.demand();
    const items = [...ix.byType('Raw Material'), ...ix.byType('Component')];
    const settings = new Map(state.data.purchase_settings.map((s) => [s.item_no, s]));
    const today = todayIso(); const admin = isAdmin();
    const next = (itemNo) => { for (const [d, q] of pd.get(itemNo)?.suggestions || []) if (d >= today && q) return d; return null; };
    const due = items.filter((it) => { const n = next(it.item_no); return n && n <= today; });
    const switcher = seg([['plan', 'Suggestions'], ['settings', 'Settings']], mode, (m) => { mode = m; rerender(); });

    if (mode === 'settings') {
      return h('div', null,
        pageHead('Purchase Settings', 'Safety stock = safety threshold × lead time × planning usage. A purchase is suggested when inventory plus purchases already suggested drops below it.' + (admin ? '' : ' Only admins can change these.'), switcher),
        h('div', { class: 'tablewrap' }, h('table', { class: 't' },
          h('thead', null, h('tr', null, h('th', { class: 'sticky-col' }, 'Item'), h('th', null, 'Unit'), FIELDS.map(([, l]) => h('th', { class: 'num wrap' }, l)),
            h('th', { class: 'num wrap' }, 'Safety stock'), h('th', { class: 'num wrap' }, 'On hand today'), h('th', { class: 'wrap' }, 'Next suggested purchase'))),
          h('tbody', null, items.map((it) => {
            const s = settings.get(it.item_no) || {}; const onHand = inv.byItem.get(it.item_no)?.get(today);
            const safety = pd.get(it.item_no)?.safety; const nx = next(it.item_no);
            return h('tr', null, h('td', { class: 'sticky-col' }, it.name), h('td', { class: 'muted' }, it.pack_note || it.unit),
              FIELDS.map(([f, l]) => numberCell(s[f] ?? null, (v) => saveField('purchase_settings', { item_no: it.item_no }, f, v), { disabled: !admin, key: `ps|${it.item_no}|${f}`, title: `${l}, ${it.name}` })),
              h('td', { class: 'num calc' }, safety !== undefined ? qty(safety, 1) : ''),
              h('td', { class: 'num' + (onHand < 0 ? ' neg' : '') }, onHand !== undefined ? qty(onHand, 1) : '—'),
              h('td', null, nx ? longDate(nx) : ''));
          })))));
    }

    return h('div', null,
      pageHead('Purchase Demand', 'Suggested purchase quantities by day, based on daily inventory and each item’s purchase settings.', switcher,
        monthPicker(view.ym, (ym) => { view.ym = ym; rerender(); })),
      due.length ? h('div', { class: 'note warn' }, `Order now: ${due.map((it) => `${it.name} (${qty(settings.get(it.item_no)?.standard_purchase)} ${it.unit})`).join(', ')}.`) : null,
      viewGrid({ id: 'pd', items, ym: view.ym, digits: 0,
        value: (d, it) => pd.get(it.item_no)?.suggestions.get(d) || null,
        cellClass: (d, it, v) => (v ? 'hit' : '') }));
  },
};
