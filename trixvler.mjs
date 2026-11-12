import { PNG } from 'pngjs';
import fs from 'node:fs';

const G = 16;
const CELL_W = 40;
const CELL_H = 50;
const THRESH = 0.12;

const lum = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
const inkAt = (d, i) => {
  const a = d[i + 3];
  if (a === 0) return 0;
  return (a / 255) * Math.max(0, 255 - lum(d, i));
};

export function detectSeparators(png) {
  const W = png.width, H = png.height, d = png.data;
  const isLine = new Array(W).fill(false);
  for (let x = 0; x < W; x++) {
    let g = 0;
    for (let y = 0; y < H; y++) {
      const i = (y * W + x) * 4;
      if (d[i + 3] < 10) continue;
      const l = lum(d, i);
      if (l > 195 && l < 248) g++;
    }
    isLine[x] = g > H * 0.8;
  }
  const runs = [];
  let s = -1;
  for (let x = 0; x <= W; x++) {
    const on = x < W && isLine[x];
    if (on && s < 0) s = x;
    if (!on && s >= 0) { runs.push((s + x - 1) / 2); s = -1; }
  }
  const internal = runs.filter((cx) => cx > 2 && cx < W - 3);
  return internal.length + 1;
}

export function inferN(png) {
  const sep = detectSeparators(png);
  if (sep >= 5 && sep <= 8) return sep;
  const r = Math.round((png.width / png.height) * (CELL_H / CELL_W));
  if (r >= 5 && r <= 8) return r;
  return 8;
}

const rot90 = (d) => {
  const o = new Float32Array(G * G);
  for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) o[y * G + x] = d[(G - 1 - x) * G + y];
  return o;
};
const flipH = (d) => {
  const o = new Float32Array(G * G);
  for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) o[y * G + x] = d[y * G + (G - 1 - x)];
  return o;
};
const variants = (d) => {
  const out = [];
  let cur = d;
  for (let r = 0; r < 4; r++) { out.push(cur, flipH(cur)); cur = rot90(cur); }
  return out;
};
const dist = (a, b) => {
  let best = Infinity;
  for (const v of b) {
    let s = 0;
    for (let k = 0; k < a.length; k++) s += Math.abs(a[k] - v[k]);
    s /= a.length;
    if (s < best) best = s;
  }
  return best;
};

function descriptor(png, x0, x1) {
  const W = png.width, H = png.height, d = png.data;
  let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
  for (let y = 0; y < H; y++) {
    for (let x = x0; x < x1; x++) {
      if (inkAt(d, (y * W + x) * 4) > 90) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) { minX = x0; maxX = x1 - 1; minY = 0; maxY = H - 1; }
  const side = Math.max(maxX - minX + 1, maxY - minY + 1);
  const sx = (minX + maxX) / 2 - side / 2;
  const sy = (minY + maxY) / 2 - side / 2;
  const out = new Float32Array(G * G);
  for (let gy = 0; gy < G; gy++) {
    for (let gx = 0; gx < G; gx++) {
      const ax = sx + (gx / G) * side, bx = sx + ((gx + 1) / G) * side;
      const ay = sy + (gy / G) * side, by = sy + ((gy + 1) / G) * side;
      let sum = 0, cnt = 0;
      for (let yy = Math.floor(ay); yy < Math.ceil(by); yy++) {
        if (yy < 0 || yy >= H) continue;
        for (let xx = Math.floor(ax); xx < Math.ceil(bx); xx++) {
          if (xx < 0 || xx >= W) continue;
          sum += inkAt(d, (yy * W + xx) * 4);
          cnt++;
        }
      }
      out[gy * G + gx] = cnt ? sum / cnt : 0;
    }
  }
  let mx = 1e-6;
  for (let k = 0; k < out.length; k++) if (out[k] > mx) mx = out[k];
  for (let k = 0; k < out.length; k++) out[k] /= mx;
  return out;
}

export function analyze(png, opts = {}) {
  const n = opts.n || inferN(png);
  const cellW = png.width / n;
  const descs = [];
  for (let i = 0; i < n; i++) {
    descs.push(descriptor(png, Math.floor(i * cellW), Math.floor((i + 1) * cellW)));
  }
  const vs = descs.map(variants);
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (a) => (parent[a] === a ? a : (parent[a] = find(parent[a])));
  const union = (a, b) => { parent[find(a)] = find(b); };
  const thresh = opts.threshold ?? THRESH;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (dist(descs[i], vs[j]) < thresh) union(i, j);
    }
  }
  const map = {};
  for (let i = 0; i < n; i++) (map[find(i)] ||= []).push(i);
  const groups = Object.values(map).map((m) => ({ members: m, count: m.length }));
  groups.sort((a, b) => a.count - b.count);
  const tie = groups.length > 1 && groups[0].count === groups[1].count;
  const min = groups[0].count;
  const second = groups.length > 1 ? groups[1].count : min;
  return {
    n,
    groups: groups.map((g) => g.members),
    counts: groups.map((g) => g.count),
    index: tie ? null : groups[0].members[0],
    candidates: groups[0].members,
    tie,
    confidence: second > min ? 1 : 0,
  };
}

export async function aiFallback(b64, opts = {}) {
  const key = opts.apiKey || process.env.APINEX_KEY;
  if (!key) return null;
  const model = opts.model || process.env.APINEX_MODEL || 'free/gemini-3.8-flash';
  const n = opts.n || 8;
  const text = [
    `The image is a horizontal strip of ${n} icons. Tile 0 is the leftmost, tile ${n - 1} is the rightmost.`,
    'Some tiles show the SAME base icon rotated by 0/90/180/270 degrees and/or mirrored; treat those as ONE type.',
    '',
    'Do this, in order:',
    '1) Describe each tile base icon in 1-3 words (ignore rotation and mirroring).',
    '2) Group tiles that share the same base icon.',
    '3) Count the tiles in every group.',
    '4) Identify the group(s) with the smallest count.',
    '',
    'Return ONLY JSON, no prose:',
    '{"tiles":["desc0","desc1"],"groups":[[0,3]],"counts":[2],"least":[indices in the smallest group]}',
  ].join('\n');
  const body = {
    model,
    temperature: 0,
    max_tokens: 700,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,' + b64 } },
      ],
    }],
  };
  try {
    const res = await fetch('https://api.apinex.bond/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await res.json();
    const txt = j?.choices?.[0]?.message?.content || '';
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const p = JSON.parse(m[0]);
    const g = Array.isArray(p.groups) ? p.groups : [];
    let least = Array.isArray(p.least) ? p.least.filter((x) => typeof x === 'number') : [];
    if (!least.length && g.length) {
      let best = g[0];
      for (const x of g) if (Array.isArray(x) && x.length < best.length) best = x;
      least = best;
    }
    const idx = least[0];
    if (typeof idx !== 'number') return null;
    return { index: idx, groups: g, tiles: p.tiles, source: 'ai' };
  } catch {
    return null;
  }
}

export async function solve(buffer, opts = {}) {
  const png = PNG.sync.read(buffer);
  const local = analyze(png, opts);
  const mode = opts.mode || 'auto';
  if (mode === 'local') return { ...local, source: 'local' };
  const needAI = mode === 'ai' || local.tie;
  if (!needAI) return { ...local, source: 'local' };
  const b64 = Buffer.from(buffer).toString('base64');
  const ai = await aiFallback(b64, { ...opts, n: local.n });
  if (ai) return { ...local, ...ai, localIndex: local.index, source: 'ai' };
  return { ...local, source: 'local', aiFailed: true };
}

const isMain = process.argv[1] && import.meta.url === 'file://' + process.argv[1];
if (isMain) {
  const arg = process.argv[2];
  if (!arg) {
    console.error('usage: trixvler <file.png | ->');
    process.exit(1);
  }
  const buf = arg === '-'
    ? Buffer.concat(await new Promise((r) => { const c = []; process.stdin.on('data', (x) => c.push(x)); process.stdin.on('end', () => r(c)); }))
    : fs.readFileSync(arg);
  const out = await solve(buf);
  console.log(JSON.stringify(out));
}
