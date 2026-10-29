// Journal entries A-H with amounts for a month, built from production, sales,
// deliveries, purchase orders and cycle counts (calc.js journalEntries).
import { h, pageHead, monthPicker, acctParts, chip, todayIso } from '../ui.js';
import { state, derived } from '../store.js';
import { journalEntries, MONTHS } from '../calc.js';

const t = todayIso();
export const period = { ym: { year: Number(t.slice(0, 4)), month: Number(t.slice(5, 7)) } };
export const monthLabel = ({ year, month }) => `${MONTHS[month - 1][0]}${MONTHS[month - 1].slice(1).toLowerCase()} ${year}`;
export const entriesFor = (ym) => journalEntries(state.data, ym.year, ym.month, derived.inventory());
const amt = (v) => h('td', { class: 'num acct' }, v ? acctParts(v) : '');

export default {
  id: 'journals',
  label: 'Journals',
  render({ rerender }) {
    const entries = entriesFor(period.ym);
    const dr = entries.reduce((s, e) => s + e.dr, 0); const cr = entries.reduce((s, e) => s + e.cr, 0);
    const posted = entries.filter((e) => e.lines.length).length;
    return h('div', null,
      pageHead('Journal Entries', 'The standard-cost entries from the workbook’s Journals sheet, with this month’s amounts. (A, B) deliveries at standard cost, plus the price variance on received purchase orders; (E) production at standard cost, split into the materials, packaging, labor and overhead it absorbed; (F) cycle counts against the running inventory; (G) sales at invoice amount and cost of goods sold at standard; (H) in January, inventory revalued to the new year’s standards. Payroll (C) and overhead (D) paid come from the books, so they aren’t posted here.',
        monthPicker(period.ym, (ym) => { period.ym = ym; rerender(); }),
        chip('Entries with amounts', posted),
        chip('Debits', '$' + Math.round(dr).toLocaleString()), chip('Credits', '$' + Math.round(cr).toLocaleString())),
      h('h2', { class: 'bom-year-head' }, `${monthLabel(period.ym)} journal entries`),
      h('div', { class: 'tablewrap' }, h('table', { class: 't journal' },
        h('thead', null, h('tr', null, h('th', null, 'Entry'), h('th', null, 'Account'), h('th', { class: 'num' }, 'Debit'), h('th', { class: 'num' }, 'Credit'), h('th', null, 'Basis'))),
        h('tbody', null, entries.map((e) => [
          h('tr', { class: 'entry' }, h('td', null, h('strong', null, `(${e.code}) ${e.title}`)), h('td', { class: 'muted' }, e.lines.length ? '' : (e.note || 'Nothing to post this month.')), h('td'), h('td'), h('td')),
          ...e.lines.map((l) => h('tr', null, h('td'), h('td', { class: l.cr ? 'cr' : null }, l.cr ? `Cr. ${l.account}` : `Dr. ${l.account}`), amt(l.dr), amt(l.cr), h('td', { class: 'muted' }, l.basis))),
          e.lines.length ? h('tr', { class: 'entry-total' }, h('td'), h('td', { class: 'muted' }, Math.abs(e.dr - e.cr) < 0.01 ? 'Balanced' : 'Out of balance'), amt(e.dr), amt(e.cr), h('td')) : null,
        ])))));
  },
};
