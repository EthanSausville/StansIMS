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
