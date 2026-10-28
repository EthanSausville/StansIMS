import { h, pageHead, monthPicker, numberCell, qty, todayIso, longDate, seg } from '../ui.js';
import { state, derived, saveField, isAdmin } from '../store.js';
import { viewGrid, view } from './grid.js';
import { xtable, filteredRows, activeFilterCount, clearFilters } from '../xtable.js';

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
      const info = (it) => ({ s: settings.get(it.item_no) || {}, onHand: inv.byItem.get(it.item_no)?.get(today), safety: pd.get(it.item_no)?.safety, nx: next(it.item_no) });
      const columns = [
        { key: 'name', label: 'Item', sticky: true, value: (it) => it.name, cell: (it) => h('td', { class: 'sticky-col' }, it.name) },
        { key: 'unit', label: 'Unit', value: (it) => it.pack_note || it.unit || '', cell: (it) => h('td', { class: 'muted' }, it.pack_note || it.unit) },
        ...FIELDS.map(([f, l]) => ({ key: f, label: l, num: true, value: (it) => info(it).s[f] ?? null, text: (it) => (info(it).s[f] ?? '') === '' ? '' : qty(info(it).s[f], 2),
          cell: (it) => numberCell(info(it).s[f] ?? null, (v) => saveField('purchase_settings', { item_no: it.item_no }, f, v), { disabled: !admin, key: `ps|${it.item_no}|${f}`, title: `${l}, ${it.name}` }) })),
        { key: 'safety', label: 'Safety stock', num: true, value: (it) => info(it).safety ?? null, text: (it) => (info(it).safety !== undefined ? qty(info(it).safety, 1) : ''),
          cell: (it) => h('td', { class: 'num calc' }, info(it).safety !== undefined ? qty(info(it).safety, 1) : '') },
        { key: 'onhand', label: 'On hand today', num: true, value: (it) => info(it).onHand ?? null, text: (it) => (info(it).onHand !== undefined ? qty(info(it).onHand, 1) : ''),
          cell: (it) => { const v = info(it).onHand; return h('td', { class: 'num' + (v < 0 ? ' neg' : '') }, v !== undefined ? qty(v, 1) : '—'); } },
        { key: 'next', label: 'Next suggested purchase', value: (it) => info(it).nx || '', text: (it) => (info(it).nx ? longDate(info(it).nx) : ''),
          cell: (it) => h('td', null, info(it).nx ? longDate(info(it).nx) : '') },
      ];
      const rows = filteredRows({ id: 'purchase-settings', columns, rows: items });
      const nFilters = activeFilterCount('purchase-settings');
      return h('div', null,
        pageHead('Purchase Settings', 'Safety stock = safety threshold × lead time × planning usage. A purchase is suggested when inventory plus purchases already suggested drops below it.' + (admin ? '' : ' Only admins can change these.'), switcher,
          h('span', { class: 'legend-entry' }, h('i'), 'Type in the yellow cells'),
          nFilters ? h('button', { class: 'btn ghost', onclick: () => { clearFilters('purchase-settings'); rerender(); } }, `Clear filters (${nFilters})`) : null),
        h('div', { class: 'tablewrap', 'data-scroll': 'purchase-settings' }, xtable({ id: 'purchase-settings', columns, allRows: items, rows, rerender })));
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
