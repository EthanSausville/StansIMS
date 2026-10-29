// T-accounts: every account's debits (left) and credits (right) for a month or
// the year to date, posted from the Journals tab's entries, with the balance.
import { h, pageHead, monthPicker, seg, acctText } from '../ui.js';
import { ledger, ACCOUNTS } from '../calc.js';
import { period, monthLabel, entriesFor } from './journals.js';

let span = 'month';
const GROUPS = [
  ['Asset Accounts', ['cash', 'rm', 'cp', 'fg']],
  ['Revenue', ['revenue']],
  ['Expense and Variance Accounts', ['cogs', 'ppvRm', 'ppvCp', 'labor', 'overhead', 'adj']],
];
const money = (v) => (v < 0 ? '-$' : '$') + acctText(Math.abs(v));

export default {
  id: 'taccounts',
  label: 'T-Accounts',
  render({ rerender }) {
    const months = span === 'month' ? [period.ym.month] : Array.from({ length: period.ym.month }, (_, i) => i + 1);
    const L = ledger(months.map((m) => ({ label: m, entries: entriesFor({ year: period.ym.year, month: m }) })));
    // the same entry posted in several months shows as one line per entry letter
    const lines = (list) => { const m = new Map(); for (const x of list) { const k = `(${x.code}) ${x.title}`; m.set(k, (m.get(k) || 0) + x.amount); } return [...m]; };
    const side = (list, label) => h('div', { class: 'tside' }, h('div', { class: 'tside-label' }, label),
      list.length ? lines(list).map(([k, v]) => h('div', { class: 'tentry' }, h('strong', null, k), h('span', { class: 'tamt' }, money(v))))
        : h('div', { class: 'tentry empty-side' }, '—'));
    const title = span === 'month' ? monthLabel(period.ym) : `${period.ym.year} through ${monthLabel(period.ym)}`;
    return h('div', null,
      pageHead('T-Accounts', 'Each account’s debits (left) and credits (right) from the journal entries, for the month or the year to date, with the balance (debits − credits). Letters match the entries on the Journals tab.',
        seg([['month', 'Month'], ['ytd', 'Year to date']], span, (v) => { span = v; rerender(); }),
        monthPicker(period.ym, (ym) => { period.ym = ym; rerender(); })),
      h('h2', { class: 'bom-year-head' }, title),
      GROUPS.map(([gtitle, keys]) => h('section', { class: 'tgroup' },
        h('h2', { class: 'tgroup-title' }, gtitle),
        h('div', { class: 'taccts' }, keys.map((k) => { const a = L.get(ACCOUNTS[k]); return h('div', { class: 'tacct' },
          h('h3', null, a.account),
          h('div', { class: 'tbody' }, side(a.dr, 'Debit'), side(a.cr, 'Credit')),
          h('div', { class: 'tfoot' }, h('span', null, money(a.drTotal)), h('span', { class: 'tbal' }, `Balance ${a.balance >= 0 ? 'Dr' : 'Cr'} ${money(Math.abs(a.balance))}`), h('span', null, money(a.crTotal)))); })))));
  },
};
