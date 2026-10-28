import { h, pageHead } from '../ui.js';

// The standard-cost journal entries laid out in the workbook's Journals and
// Accounting sheets. The workbook has no amounts in them yet, so this tab is
// the reference layout.
const ENTRIES = [
  ['(A) Purchase of Raw Materials', [['Debit', 'Inventory: Raw Materials', 'Standard $'], ['Debit', 'PPV - Raw Materials (unfavorable variance)', 'Actual − Standard $'], ['Credit', 'PPV - Raw Materials (favorable variance)', 'Standard − Actual $'], ['Credit', 'Cash', 'Actual $']]],
  ['(B) Purchase of Components', [['Debit', 'Inventory: Components', 'Standard $'], ['Debit', 'PPV - Components (unfavorable variance)', 'Actual − Standard $'], ['Credit', 'PPV - Components (favorable variance)', 'Standard − Actual $'], ['Credit', 'Cash', 'Actual $']]],
  ['(C) Paying Payroll', [['Debit', 'MFG Variance - Labor', 'Actual payroll $'], ['Credit', 'Cash', 'Actual payroll $']]],
  ['(D) Paying Overhead', [['Debit', 'MFG Variance - Overhead', 'Actual overhead $'], ['Credit', 'Cash', 'Actual overhead $']]],
  ['(E) Production of Goods', [['Debit', 'Inventory: Finished Goods', 'Standard $'], ['Credit', 'Inventory: Raw Materials', 'Standard $'], ['Credit', 'Inventory: Components', 'Standard $'], ['Credit', 'MFG Variance - Labor', 'Standard $'], ['Credit', 'MFG Variance - Overhead', 'Standard $']]],
  ['(F) Cycle Counts (assuming shrinkage)', [['Debit', 'Inventory Adjustments', 'Count variance $'], ['Credit', 'Inventory: Raw Materials', 'Count variance $'], ['Credit', 'Inventory: Components', 'Count variance $'], ['Credit', 'Inventory: Finished Goods', 'Count variance $']]],
  ['(G) Sale of Goods', [['Debit', 'Cash', 'Actual $'], ['Credit', 'Sales Revenue', 'Actual $'], ['Debit', 'COGS', 'Standard $'], ['Credit', 'Inventory: Finished Goods', 'Standard $']]],
  ['(H) Updating Standards at Year Beginning', [['Debit', 'Inventory Adjustments', 'Old standard $'], ['Credit', 'Inventory: Raw Materials', 'Old standard $'], ['Credit', 'Inventory: Components', 'Old standard $'], ['Credit', 'Inventory: Finished Goods', 'Old standard $'], ['Debit', 'Inventory: Raw Materials', 'New standard $'], ['Debit', 'Inventory: Components', 'New standard $'], ['Debit', 'Inventory: Finished Goods', 'New standard $'], ['Credit', 'Inventory Adjustments', 'New standard $']]],
];

export default {
  id: 'journals',
  label: 'Journals',
  render() {
    return h('div', null,
      pageHead('Journal Entries', 'The standard-cost entries from the workbook’s Journals and Accounting sheets. The workbook doesn’t have amounts in them yet, so these are the layout to post from.'),
      h('div', { class: 'tablewrap' }, h('table', { class: 't journal' },
        h('thead', null, h('tr', null, h('th', null, 'Entry'), h('th', null, 'Dr / Cr'), h('th', null, 'Account'), h('th', null, 'Amount basis'))),
        h('tbody', null, ENTRIES.map(([name, lines]) => lines.map(([side, account, basis], i) => h('tr', { class: i === 0 ? 'entry' : null },
          h('td', null, i === 0 ? h('strong', null, name) : ''), h('td', null, side),
          h('td', { class: side === 'Credit' ? 'cr' : null }, side === 'Debit' ? `Dr. ${account}` : `Cr. ${account}`), h('td', { class: 'muted' }, basis))))))));
  },
};
