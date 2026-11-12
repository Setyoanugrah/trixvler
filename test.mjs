import { PNG } from 'pngjs';
import { solve } from './trixvler.mjs';

const W = 320, H = 50;

function setPx(png, x, y, v = 40) {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
  const i = (y * png.width + x) * 4;
  png.data[i] = v; png.data[i + 1] = v; png.data[i + 2] = v; png.data[i + 3] = 255;
}

function inShape(type, x, y) {
  if (type === 'square') {
    const m = Math.max(Math.abs(x), Math.abs(y));
    return m > 0.55 && m < 0.9;
  }
  if (type === 'triangle') {
    return y > -0.7 && y < 0.8 && Math.abs(x) < (y + 0.7) * 0.5;
  }
  if (type === 'plus') {
    return (Math.abs(x) < 0.18 && Math.abs(y) < 0.85) || (Math.abs(y) < 0.18 && Math.abs(x) < 0.85);
  }
  return false;
}

function drawIcon(png, cx, cy, r, type, rot, flip) {
  const a = (-rot * Math.PI) / 180;
  const ca = Math.cos(a), sa = Math.sin(a);
  for (let py = Math.floor(cy - r); py <= cy + r; py++) {
    for (let px = Math.floor(cx - r); px <= cx + r; px++) {
      let x = (px - cx) / r, y = (py - cy) / r;
      if (flip) x = -x;
      const rx = x * ca - y * sa;
      const ry = x * sa + y * ca;
      if (inShape(type, rx, ry)) setPx(png, px, py);
    }
  }
}

function makeChallenge(types, seed = 1, transparent = false) {
  const png = new PNG({ width: W, height: H });
  for (let i = 0; i < png.data.length; i += 4) {
    if (transparent) {
      png.data[i] = 0; png.data[i + 1] = 0; png.data[i + 2] = 0; png.data[i + 3] = 0;
    } else {
      png.data[i] = 255; png.data[i + 1] = 255; png.data[i + 2] = 255; png.data[i + 3] = 255;
    }
  }
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      if (x % 40 === 0 || y === 0 || y === H - 1) setPx(png, x, y, 229);
    }
  }
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < types.length; i++) {
    const rot = [0, 90, 180, 270][Math.floor(rnd() * 4)];
    const flip = rnd() > 0.5;
    drawIcon(png, i * 40 + 20, 25, 17, types[i], rot, flip);
  }
  return png;
}

const cases = [
  { types: ['square', 'triangle', 'plus', 'square', 'triangle', 'plus', 'square', 'triangle'], least: ['plus'] },
  { types: ['plus', 'plus', 'square', 'triangle', 'square', 'plus', 'triangle', 'plus'], tie: true },
  { types: ['triangle', 'square', 'square', 'plus', 'plus', 'plus', 'square', 'triangle'], least: ['triangle'] },
  { types: ['plus', 'triangle', 'square', 'plus', 'triangle', 'square', 'plus', 'triangle'], least: ['square'], transparent: true },
];

let pass = 0;
for (let c = 0; c < cases.length; c++) {
  const png = makeChallenge(cases[c].types, c + 7, !!cases[c].transparent);
  const buf = PNG.sync.write(png);
  const out = await solve(buf, { useAI: false });
  if (cases[c].tie) {
    const ok = out.tie === true && out.index === null;
    console.log(`case ${c}: ${ok ? 'PASS' : 'FAIL'} (tie expected) counts=${JSON.stringify(out.counts)}`);
    if (ok) pass++;
    continue;
  }
  const leastType = cases[c].least[0];
  const expected = cases[c].types.map((t, i) => (t === leastType ? i : -1)).filter((i) => i >= 0);
  const ok = !out.tie && expected.includes(out.index);
  console.log(`case ${c}: ${ok ? 'PASS' : 'FAIL'} counts=${JSON.stringify(out.counts)} index=${out.index} expected=${JSON.stringify(expected)}`);
  if (ok) pass++;
}
console.log(`${pass}/${cases.length} passed`);
process.exit(pass === cases.length ? 0 : 1);
