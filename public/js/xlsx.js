// Minimal spreadsheet reader for imports: .xlsx (first worksheet) and .csv.
// Returns the sheet as rows of cell values: strings, numbers or booleans, with
// null for empty cells. No library needed: an .xlsx file is a zip of XML
// files, unzipped with the browser's built-in DecompressionStream.

export async function readSpreadsheet(file) {
  const name = (file.name || '').toLowerCase();
  const buf = new Uint8Array(await file.arrayBuffer());
  if (name.endsWith('.csv') || name.endsWith('.txt')) return parseCsv(new TextDecoder().decode(buf));
  if (buf[0] === 0x50 && buf[1] === 0x4b) return readXlsx(buf);
  if (name.endsWith('.xls')) throw new Error('This is an older .xls file. In QuickBooks, export the report as Excel (.xlsx) or CSV instead.');
  return parseCsv(new TextDecoder().decode(buf));
}

// ---------- zip ----------
async function unzip(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('This file isn’t a readable Excel workbook.');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const fname = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nlen));
    entries.set(fname, { method, csize, local });
    p += 46 + nlen + xlen + clen;
  }
  const read = async (fname) => {
    const e = entries.get(fname); if (!e) return null;
    const nlen = dv.getUint16(e.local + 26, true), xlen = dv.getUint16(e.local + 28, true);
    const data = buf.subarray(e.local + 30 + nlen + xlen, e.local + 30 + nlen + xlen + e.csize);
    if (e.method === 0) return new TextDecoder().decode(data);
    if (e.method !== 8) throw new Error('This workbook uses an unsupported compression.');
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(stream).text();
  };
  return { read, names: [...entries.keys()] };
}

// ---------- xlsx ----------
const unescapeXml = (s) => s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e) => {
  const map = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
  if (map[e.toLowerCase()]) return map[e.toLowerCase()];
  return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
});
const textOf = (xml) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unescapeXml(m[1])).join('');
const colIndex = (ref) => { let n = 0; for (const ch of ref.replace(/\d+/g, '')) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };

async function readXlsx(buf) {
  const zip = await unzip(buf);
  const wb = await zip.read('xl/workbook.xml');
  if (!wb) throw new Error('This file isn’t a readable Excel workbook.');
  // First sheet in the workbook, via its relationship id.
  const firstSheet = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(wb) || /<sheet\b[^>]*\bid="([^"]+)"/.exec(wb);
  let sheetPath = 'xl/worksheets/sheet1.xml';
  const rels = await zip.read('xl/_rels/workbook.xml.rels');
  if (firstSheet && rels) {
    const rel = new RegExp(`<Relationship\\b[^>]*Id="${firstSheet[1]}"[^>]*>`).exec(rels);
    const target = rel && /Target="([^"]+)"/.exec(rel[0]);
    if (target) sheetPath = target[1].startsWith('/') ? target[1].slice(1) : 'xl/' + target[1].replace(/^\.\//, '');
  }
  const sst = await zip.read('xl/sharedStrings.xml');
  const shared = sst ? [...sst.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1])) : [];
  const sheet = await zip.read(sheetPath);
  if (!sheet) throw new Error('Couldn’t find a worksheet in this file.');
  const rows = [];
  for (const rm of sheet.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const r = Number(/\br="(\d+)"/.exec(rm[1])?.[1] || rows.length + 1) - 1;
    const row = [];
    for (const cm of rm[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1]; const body = cm[2] || '';
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const c = ref ? colIndex(ref) : row.length;
      const t = /\bt="([^"]+)"/.exec(attrs)?.[1];
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let val = null;
      if (t === 's') val = v !== undefined ? shared[Number(v)] ?? null : null;
      else if (t === 'inlineStr') val = textOf(body);
      else if (t === 'str') val = v !== undefined ? unescapeXml(v) : null;
      else if (t === 'b') val = v === '1';
      else if (t === 'e') val = null;
      else if (v !== undefined) val = Number(v);
      row[c] = val;
    }
    for (let i = 0; i < row.length; i++) if (row[i] === undefined) row[i] = null;
    rows[r] = row;
  }
  for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
  return rows;
}

// ---------- csv ----------
export function parseCsv(text) {
  const rows = []; let row = []; let cur = ''; let q = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.map((r) => r.map((v) => {
    const s = v.trim(); if (s === '') return null;
    const num = s.replace(/[$,]/g, '').replace(/^\((.*)\)$/, '-$1');
    return /^-?\d+(\.\d+)?$/.test(num) ? Number(num) : s;
  }));
}

// ---------- writing ----------
// A small .xlsx writer for downloads: one or more sheets of rows. A cell is a
// string, a number, null, or { date: 'YYYY-MM-DD' } (shown as a date in Excel).
// The first `headRows` rows of a sheet are bold and stay put when scrolling.
// sheets: [{ name, rows, headRows = 1, widths: [chars per column], freezeCols = 0 }]
const xmlEsc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const colName = (i) => { let s = ''; for (i += 1; i; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s; return s; };
const excelDate = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86400000 + 25569;

function sheetXml({ rows, headRows = 1, widths = [], freezeCols = 0 }) {
  const cells = rows.map((row, r) => `<row r="${r + 1}">${(row || []).map((v, c) => {
    const ref = `${colName(c)}${r + 1}`; const bold = r < headRows;
    if (v === null || v === undefined || v === '') return bold ? `<c r="${ref}" s="1"/>` : '';
    if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${bold ? ' s="1"' : ' s="3"'}><v>${v}</v></c>`;
    if (v && typeof v === 'object' && v.date) return `<c r="${ref}" s="2"><v>${excelDate(v.date)}</v></c>`;
    return `<c r="${ref}" t="inlineStr"${bold ? ' s="1"' : ''}><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`;
  }).join('')}</row>`).join('');
  const split = [freezeCols ? `xSplit="${freezeCols}"` : '', headRows ? `ySplit="${headRows}"` : ''].filter(Boolean).join(' ');
  const pane = split ? `<sheetViews><sheetView workbookViewId="0"><pane ${split} topLeftCell="${colName(freezeCols)}${headRows + 1}" activePane="${headRows && freezeCols ? 'bottomRight' : headRows ? 'bottomLeft' : 'topRight'}" state="frozen"/></sheetView></sheetViews>` : '';
  const cols = widths.length ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${pane}${cols}<sheetData>${cells}</sheetData></worksheet>`;
}

let crcTable;
function crc32(bytes) {
  if (!crcTable) crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  let c = 0xffffffff; for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0;
}
// A zip with every file stored (not compressed): simple, and Excel reads it.
function zipStore(files) {
  const enc = new TextEncoder(); const parts = []; const central = []; let offset = 0;
  for (const [name, text] of files) {
    const data = enc.encode(text); const nm = enc.encode(name); const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true); local.setUint16(8, 0, true);
    local.setUint32(14, crc, true); local.setUint32(18, data.length, true); local.setUint32(22, data.length, true); local.setUint16(26, nm.length, true);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true); cen.setUint16(8, 0x0800, true);
    cen.setUint32(16, crc, true); cen.setUint32(20, data.length, true); cen.setUint32(24, data.length, true); cen.setUint16(28, nm.length, true); cen.setUint32(42, offset, true);
    parts.push(new Uint8Array(local.buffer), nm, data); central.push(new Uint8Array(cen.buffer), nm);
    offset += 30 + nm.length + data.length;
  }
  const size = central.reduce((t, p) => t + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, size, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

export function xlsxBlob(sheets) {
  const ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
  const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const names = sheets.map((s, i) => xmlEsc(String(s.name || `Sheet${i + 1}`).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31)));
  return zipStore([
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook ${ns} xmlns:r="${rel}"><sheets>${names.map((n, i) => `<sheet name="${n}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${rel}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="${rel}/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet ${ns}><numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.##;-#,##0.##;0"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment wrapText="1" vertical="bottom"/></xf><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`],
    ...sheets.map((s, i) => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)]),
  ]);
}

export function downloadXlsx(filename, sheets) {
  const url = URL.createObjectURL(xlsxBlob(sheets));
  const a = document.createElement('a'); a.href = url; a.download = filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`;
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
