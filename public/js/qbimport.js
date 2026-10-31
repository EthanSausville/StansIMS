// Reads a QuickBooks "Sales by Product/Service Detail" report (as rows of
// cells from xlsx.js) into sales detail lines.
//
// Report layout: a title block, a header row ("Transaction date", "Num", ...),
// then for each product/service a heading row (name in column A), its
// transactions, and a "Total for <name>" row. Headings can nest
// ("Retail (Sales Tax) Items" > "Retail Gallon ..."); a line takes the
// innermost heading. Lines outside any heading get product "--", as in QuickBooks.

const HEADERS = {
  date: ['transaction date', 'date'],
  txn_type: ['transaction type', 'type'],
  num: ['num', 'no.', 'number', 'invoice #'],
  customer: ['customer full name', 'customer', 'name', 'customer name'],
  description: ['description', 'memo/description', 'memo'],
  quantity: ['quantity', 'qty'],
  sales_price: ['sales price', 'rate', 'price'],
  amount: ['amount'],
};

const norm = (v) => String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

// Excel serial day number -> ISO date
const fromSerial = (n) => new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000).toISOString().slice(0, 10);

export function toIsoDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v > 20000 && v < 80000 ? fromSerial(v) : null;
  const s = String(v).trim();
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s);
  if (m) { const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]); return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`; }
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v;
  const s = String(v).replace(/[$,\s]/g, '').replace(/^\((.*)\)$/, '-$1');
  return /^-?\d*\.?\d+$/.test(s) ? Number(s) : null;
};

export function parseQuickBooksSales(rows) {
  // Header row: the first row that names a date column and an amount column.
  let headerAt = -1; const col = {};
  for (let r = 0; r < Math.min(rows.length, 40); r++) {
    const cells = (rows[r] || []).map(norm);
    const di = cells.findIndex((c) => HEADERS.date.includes(c));
    const ai = cells.findIndex((c) => HEADERS.amount.includes(c));
    if (di >= 0 && ai >= 0) {
      headerAt = r;
      for (const [k, names] of Object.entries(HEADERS)) { const i = cells.findIndex((c) => names.includes(c)); if (i >= 0) col[k] = i; }
      break;
    }
  }
  if (headerAt < 0) throw new Error('This doesn’t look like a QuickBooks Sales by Product/Service Detail report: no “Transaction date” and “Amount” columns were found.');

  const title = rows.slice(0, headerAt).map((r) => (r || []).find((c) => c !== null && c !== '')).filter(Boolean).map(String);
  const report = { company: title[0] || '', name: title[1] || '', period: title[2] || '' };
  if (report.name && !/product\/service detail/i.test(report.name)) report.warning = `This report is “${report.name}”, not “Sales by Product/Service Detail”. Lines were read anyway; check them before adding.`;

  const lines = []; const stack = [];
  const labelCol = 0; // product headings sit in the first column
  for (let r = headerAt + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const date = toIsoDate(row[col.date]);
    const label = row[labelCol] !== null && row[labelCol] !== undefined && labelCol !== col.date ? String(row[labelCol]).trim() : '';
    if (!date) {
      if (!label) continue;
      if (/^total\b/i.test(label)) {
        if (/^total for /i.test(label)) {
          const name = label.replace(/^total for /i, '').replace(/ with sub-items$/i, '');
          const at = stack.lastIndexOf(name);
          if (at >= 0) stack.length = at; else if (name === '--') stack.length = 0; else stack.pop();
        }
        continue;
      }
      if (/^(accrual|cash) basis\b/i.test(label)) continue;
      stack.push(label);
      continue;
    }
    const get = (k) => (col[k] !== undefined ? row[col[k]] : null);
    const amount = num(get('amount'));
    lines.push({
      date,
      txn_type: get('txn_type') ? String(get('txn_type')).trim() : null,
      num: get('num') !== null && get('num') !== undefined ? String(get('num')).trim() : null,
      customer: get('customer') ? String(get('customer')).trim() : null,
      product_service: stack.length ? stack[stack.length - 1] : '--',
      description: get('description') !== null && get('description') !== undefined && String(get('description')).trim() !== '' ? String(get('description')).trim() : null,
      quantity: num(get('quantity')),
      sales_price: num(get('sales_price')),
      amount: amount ?? 0,
    });
  }
  const dates = lines.map((l) => l.date).sort();
  return { report, lines, from: dates[0] || null, to: dates.at(-1) || null };
}

// A line's identity for spotting ones that are already loaded. QuickBooks
// gives no line id, and an invoice can hold identical lines, so lines are
// compared by every field and counted: a file with 3 matching lines adds only
// as many as are missing.
const money = (v) => (v === null || v === undefined || v === '' ? '' : (Math.round(Number(v) * 10000) / 10000).toString());
export const lineKey = (l) => [l.date, l.txn_type, l.num, l.customer, l.product_service, l.description, money(l.quantity), money(l.sales_price), money(l.amount)]
  .map((v) => String(v ?? '').trim().toLowerCase()).join('|');

export function newLines(fileLines, existing) {
  const have = new Map();
  for (const l of existing) { const k = lineKey(l); have.set(k, (have.get(k) || 0) + 1); }
  const add = []; let skipped = 0;
  for (const l of fileLines) {
    const k = lineKey(l); const n = have.get(k) || 0;
    if (n > 0) { have.set(k, n - 1); skipped++; } else add.push(l);
  }
  return { add, skipped };
}

// ---------- converting QuickBooks lines into Sales Detail rows ----------
// Sales Detail keeps the workbook's SalesReport layout: date, invoice #,
// quantity, sales price, amount, customer and product, where product is one
// of your finished goods or "Other" (fees, deductions, coupons, credits).
// QuickBooks names are converted with a saved name list (qb_name_map); names
// not on it get a suggestion the user confirms before adding.

const words = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/jalapenos?/g, 'jalapeno').replace(/[^a-z0-9/ ]+/g, ' ').replace(/\s+/g, ' ').trim();
const sizeOf = (s) => { const w = words(s); const m = /(\d+)\s*oz\b/.exec(w); return m ? `${m[1]}oz` : /\bgallon\b/.test(w) ? 'gallon' : null; };

// Best guess for a QuickBooks product: the finished good with the same size
// (7 oz, 14 oz, gallon) and flavor (the finished good's first word), else Other.
export function guessProduct(qbName, finishedGoods) {
  const w = words(qbName); const size = sizeOf(qbName);
  if (!size) return 'Other';
  const hits = finishedGoods.filter((fg) => sizeOf(fg.name) === size && w.includes(words(fg.name).split(' ')[0]));
  if (hits.length <= 1) return hits.length ? hits[0].name : 'Other';
  // Several case sizes of the same product (Case of 24, 12, 6): the count in
  // the QuickBooks name, like "(12)", picks one; otherwise the case of 24.
  const n = /\((\d+)\)/.exec(String(qbName))?.[1];
  const byCount = n && hits.find((fg) => new RegExp(`case of ${n}\\b`, 'i').test(fg.name));
  return (byCount || hits.find((fg) => /case of 24\b/i.test(fg.name)) || hits[0]).name;
}

// Best guess for a QuickBooks customer: the last part of "Parent:Customer".
export const guessCustomer = (qbName) => String(qbName || '').split(':').pop().replace(/\s+/g, ' ').trim();

// rows: QuickBooks lines. maps: { customer: Map(qb -> name), product: Map(qb -> name) }.
// stdPrice(productName, isoDate) -> standard case price, used to tell single
// units ("(1/1)" items sold at a unit price) from cases.
export function convertLines(lines, maps, stdPrice) {
  const out = []; let zero = 0;
  for (const l of lines) {
    if (!Number(l.amount)) { zero++; continue; }   // $0 lines (voided, notes, samples) don't affect sales
    const customer = maps.customer.get(l.customer) ?? guessCustomer(l.customer);
    let product = maps.product.get(l.product_service) ?? 'Other';
    // A single-unit item sold at a unit price, not a case price, isn't a case sale.
    if (product !== 'Other' && /\(1\/1\)/.test(l.product_service)) {
      const sp = stdPrice(product, l.date);
      if (sp && l.sales_price !== null && Math.abs(l.sales_price) < sp / 2) product = 'Other';
    }
    out.push({
      date: l.date, invoice: l.num, customer, product,
      quantity: product === 'Other' && l.quantity === 1 && l.sales_price === l.amount ? null : l.quantity,
      price: l.sales_price, amount: l.amount,
      txn_type: l.txn_type, description: l.description, qb_product: l.product_service, qb_customer: l.customer,
    });
  }
  return { rows: out, zero };
}

// Identity of a Sales Detail row for spotting ones already loaded (from
// QuickBooks or entered by hand): date, invoice, customer, product, amount.
const cents = (v) => Math.round(Number(v || 0) * 100);
export const saleKey = (s) => [s.date, String(s.invoice ?? '').trim().toLowerCase(), String(s.customer ?? '').trim().toLowerCase(),
  String(s.product ?? '').trim().toLowerCase(), cents(s.amount)].join('|');

// A line repeated in the report itself: every field the same, including the
// QuickBooks item, description, quantity and price.
const exactKey = (r) => [saleKey(r), r.txn_type, r.qb_customer, r.qb_product, r.description, money(r.quantity), money(r.price)]
  .map((v) => String(v ?? '').trim().toLowerCase()).join('|');

// The rows to add: duplicate lines within the report are left out (only the
// first is kept, unless its index is in `keep`: an invoice can really list the
// same item twice), and then anything already in Sales Detail is skipped.
// duplicates: [{ index, row }].
export function newSales(rows, existing, keep = new Set()) {
  const seen = new Set(); const unique = []; const duplicates = [];
  rows.forEach((r, index) => { const k = exactKey(r); if (seen.has(k) && !keep.has(index)) duplicates.push({ index, row: r }); else { seen.add(k); unique.push(r); } });
  const have = new Map();
  for (const s of existing) { const k = saleKey(s); have.set(k, (have.get(k) || 0) + 1); }
  const add = []; let skipped = 0;
  for (const r of unique) { const k = saleKey(r); const n = have.get(k) || 0; if (n > 0) { have.set(k, n - 1); skipped++; } else add.push(r); }
  return { add, skipped, duplicates };
}
