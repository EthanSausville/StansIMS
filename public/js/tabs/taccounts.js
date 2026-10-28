import { h, pageHead } from '../ui.js';

// T-accounts from the Accounting sheet of the Stans workbook. Each entry names
// the journal entry (A-H) that posts to the account and the amount basis.
// Debits on the left, credits on the right.
const GROUPS = [
  ['Asset Accounts', [
    ['Cash',
      [['(G) Sale of Goods', '@ Actual Price']],
      [['(A) Purchase of Raw Materials', '@ Actual Cost'], ['(B) Purchase of Components', '@ Actual Cost']]],
    ['Inventory: Raw Materials',
      [['(A) Purchase of Raw Materials', '@ Standard Cost'], ['(H) Recosting Inventory', '@ New Standard cost']],
      [['(E) Production of Goods', '@ Standard Cost'], ['(F) Cycle Counts', 'Counted variance $$$'], ['(H) Recosting Inventory', '@ Old Standard cost']]],
    ['Inventory: Components',
      [['(B) Purchase of Components', '@ Standard Price'], ['(H) Recosting Inventory', '@ New Standard cost']],
      [['(E) Production of Goods', '@ Standard Cost'], ['(F) Cycle Counts', 'Counted variance $$$'], ['(H) Recosting Inventory', '@ Old Standard cost']]],
    ['Inventory: Finished Goods',
      [['(E) Production of Goods', '@ Standard Cost'], ['(H) Recosting Inventory', '@ New Standard cost']],
      [['(F) Cycle Counts', 'Counted variance $$$'], ['(G) Sale of Goods', '@ Standard cost'], ['(H) Recosting Inventory', '@ Old Standard cost']]],
  ]],
  ['Other Accounts', [
    ['Sales Revenue (Revenue Account)',
      [],
      [['(G) Sale of Goods', '@ Actual Price']]],
  ]],
  ['Expense Accounts', [
    ['COGS',
      [['(G) Sale of Goods', '@ Standard Cost']],
      []],
    ['PPV - Raw Materials',
      [['(A) Purchase of Raw Materials', 'Unfavorable var. Actual vs Standard']],
      [['(A) Purchase of Raw Materials', 'Favorable var. Actual vs Standard']]],
    ['PPV - Components',
      [['(B) Purchase of Components', 'Unfavorable var. Actual vs Standard']],
      [['(B) Purchase of Components', 'Favorable var. Actual vs Standard']]],
    ['MFG Variance - Labor',
      [['(C) Paying Payroll', 'Actual cost of Payroll']],
      [['(E) Production of Goods', '@ Standard Cost']]],
    ['MFG Variance - Overhead',
      [['(D) Paying Overhead', 'Actual cost of Overhead']],
      [['(E) Production of Goods', '@ Standard Cost']]],
    ['Inventory Adjustments',
      [['(F) Cycle Counts', 'Counted variance $$$'], ['(H) Recosting Inventory', '@ Old Standard cost']],
      [['(H) Recosting Inventory', '@ New Standard cost']]],
  ]],
];

const side = (entries, label) => h('div', { class: 'tside' }, h('div', { class: 'tside-label' }, label),
  entries.length ? entries.map(([entry, basis]) => h('div', { class: 'tentry' }, h('strong', null, entry), h('span', null, basis)))
    : h('div', { class: 'tentry empty-side' }, '—'));

export default {
  id: 'taccounts',
  label: 'T-Accounts',
  render() {
    return h('div', null,
      pageHead('T-Accounts', 'Where each journal entry posts, from the Accounting sheet. Debits on the left, credits on the right. Letters match the entries on the Journals tab.'),
      GROUPS.map(([title, accounts]) => h('section', { class: 'tgroup' },
        h('h2', { class: 'tgroup-title' }, title),
        h('div', { class: 'taccts' }, accounts.map(([name, dr, cr]) => h('div', { class: 'tacct' },
          h('h3', null, name),
          h('div', { class: 'tbody' }, side(dr, 'Debit'), side(cr, 'Credit'))))))));
  },
};
