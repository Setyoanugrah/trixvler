import http from 'node:http';
import { solve } from './trixvler.mjs';

const PORT = Number(process.env.PORT || 8080);
const KEY = process.env.TRIXVLER_KEY || '';

const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > 8 * 1024 * 1024) { reject(new Error('too-large')); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});

const send = (res, code, obj) => {
  const b = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) });
  res.end(b);
};

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true });
  if (req.method !== 'POST' || req.url !== '/solve') return send(res, 404, { error: 'not-found' });

  if (KEY) {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : req.headers['x-api-key'];
    if (token !== KEY) return send(res, 401, { error: 'unauthorized' });
  }

  try {
    const body = await readBody(req);
    const j = JSON.parse(body.toString('utf8'));
    const img = (j.image || '').replace(/^data:image\/\w+;base64,/, '');
    if (!img) return send(res, 400, { error: 'missing-image' });
    const buf = Buffer.from(img, 'base64');
    const out = await solve(buf, { apiKey: process.env.APINEX_KEY, model: process.env.APINEX_MODEL, n: j.n, threshold: j.threshold });
    return send(res, 200, out);
  } catch (e) {
    return send(res, 400, { error: e.message });
  }
});

server.listen(PORT, () => console.log(`trixvler listening :${PORT}`));
