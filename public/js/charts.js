// Small SVG charts, so the site has no chart library to load.
const NS = 'http://www.w3.org/2000/svg';
function s(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) el.setAttribute(k, v);
  for (const k of kids) if (k !== null && k !== undefined) el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return el;
}
function niceMax(v) { if (v <= 0) return 1; const p = 10 ** Math.floor(Math.log10(v)); const m = v / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p; }
const short = (v) => { const a = Math.abs(v); return a >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : a >= 1e3 ? (v / 1e3).toFixed(a >= 1e4 ? 0 : 1) + 'k' : String(Math.round(v)); };

// Vertical bars (one or two series per label), with an optional line on its own 0-100% scale.
export function barChart({ labels, series, line, money = true, height = 260, title, width = 640 }) {
  const W = width, H = height, L = 48, R = line ? 40 : 12, T = 14, B = 26;
  const max = niceMax(Math.max(0, ...series.flatMap((x) => x.values)));
  const pw = W - L - R, ph = H - T - B, band = pw / Math.max(1, labels.length), bw = Math.min(28, (band * 0.7) / series.length);
  const y = (v) => T + ph - (Math.max(0, v) / max) * ph;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': title || 'Chart' });
  const axis = s('g', { class: 'axis' });
  for (let i = 0; i <= 4; i++) { const v = (max / 4) * i; axis.append(s('line', { x1: L, x2: W - R, y1: y(v), y2: y(v) }), s('text', { x: L - 6, y: y(v) + 4, 'text-anchor': 'end' }, (money ? '$' : '') + short(v))); }
  svg.append(axis);
  labels.forEach((lab, i) => {
    const cx = L + band * i + band / 2;
    series.forEach((ser, j) => {
      const v = ser.values[i] || 0; const x = cx - (bw * series.length) / 2 + j * bw;
      svg.append(s('rect', { x, y: y(v), width: bw - 2, height: Math.max(0, T + ph - y(v)), class: ser.cls, rx: 2 }, s('title', {}, `${lab} ${ser.name}: ${money ? '$' : ''}${Math.round(v).toLocaleString()}`)));
    });
    svg.append(s('text', { x: cx, y: H - 8, 'text-anchor': 'middle' }, lab));
  });
  if (line) {
    const ly = (p) => T + ph - Math.max(0, Math.min(1, p)) * ph;
    const pts = labels.map((_, i) => [L + band * i + band / 2, ly(line.values[i] || 0)]).filter((_, i) => line.show ? line.show[i] : true);
    if (pts.length) svg.append(s('polyline', { points: pts.map((p) => p.join(',')).join(' '), class: 'line' }));
    labels.forEach((_, i) => { if (line.show && !line.show[i]) return; const cx = L + band * i + band / 2; const v = line.values[i] || 0;
      svg.append(s('circle', { cx, cy: ly(v), r: 3.5, class: 'dot' }), s('text', { x: cx, y: ly(v) - 8, 'text-anchor': 'middle', class: 'val' }, Math.round(v * 100) + '%')); });
    for (let i = 0; i <= 4; i++) svg.append(s('text', { x: W - R + 6, y: ly(i / 4) + 4 }, i * 25 + '%'));
  }
  return svg;
}

// Horizontal bars for ranked lists (sales by product or customer).
export function hbarChart({ rows, money = true, title, width = 640 }) {
  const W = width, rowH = 26, L = Math.min(210, Math.round(W * 0.4)), R = 56, T = 6;
  const H = T * 2 + rows.length * rowH;
  const max = Math.max(1, ...rows.map((r) => r[1]));
  const svg = s('svg', { viewBox: `0 0 ${W} ${Math.max(H, 40)}`, role: 'img', 'aria-label': title || 'Chart' });
  rows.forEach(([label, v], i) => {
    const yy = T + i * rowH; const w = (Math.max(0, v) / max) * (W - L - R);
    const maxChars = Math.floor((L - 10) / 6.4); const name = label.length > maxChars ? label.slice(0, maxChars - 1) + '…' : label;
    svg.append(s('text', { x: L - 8, y: yy + 17, 'text-anchor': 'end' }, name, s('title', {}, label)),
      s('rect', { x: L, y: yy + 5, width: w, height: rowH - 10, rx: 2, class: 'bar-a' }),
      s('text', { x: L + w + 6, y: yy + 17, class: 'val' }, (money ? '$' : '') + short(v)));
  });
  return svg;
}
