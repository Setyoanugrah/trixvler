import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { solve } from './trixvler.mjs';
import { solveTurnstile } from './turnstile.mjs';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const KEY = process.env.TRIXVLER_KEY || '';
const DASH = path.join(__dir, 'public', 'index.html');

const stats = { total: 0, local: 0, ai: 0, tie: 0, msSum: 0, turnstile: 0 };

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

const send = (res, code, obj, type = 'application/json') => {
  const b = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(code, { 'content-type': type, 'content-length': Buffer.byteLength(b) });
  res.end(b);
};

const authorized = (req) => {
  if (!KEY) return true;
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : req.headers['x-api-key'];
  return token === KEY;
};

const server = http.createServer(async (req, res) => {
  const url = (req.url || '/').split('?')[0];

  if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    try {
      return send(res, 200, fs.readFileSync(DASH, 'utf8'), 'text/html; charset=utf-8');
    } catch {
      return send(res, 500, { error: 'dashboard-missing' });
    }
  }

  if (req.method === 'GET' && url === '/health') return send(res, 200, { ok: true });

  if (req.method === 'GET' && url === '/stats') {
    return send(res, 200, {
      total: stats.total,
      local: stats.local,
      ai: stats.ai,
      tie: stats.tie,
      turnstile: stats.turnstile,
      avgMs: stats.total ? Math.round(stats.msSum / stats.total) : 0,
    });
  }

  if (req.method === 'GET' && url === '/turnstile-test') {
    const q = new URL(req.url || '/', 'http://x');
    const sk = (q.searchParams.get('sitekey') || '1x00000000000000000000AA').replace(/[^\w-]/g, '');
    const html = `<!doctype html><meta charset="utf-8"><title>turnstile-test</title>
<div class="cf-turnstile" data-sitekey="${sk}"></div>
<pre id="t">waiting...</pre>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
<script>setInterval(function(){var e=document.querySelector('[name="cf-turnstile-response"]');document.getElementById('t').textContent=e&&e.value?('TOKEN '+e.value):'waiting...';},400);</script>`;
    return send(res, 200, html, 'text/html; charset=utf-8');
  }

  if (req.method === 'POST' && url === '/turnstile') {
    if (!authorized(req)) return send(res, 401, { error: 'unauthorized' });
    try {
      const j = JSON.parse((await readBody(req)).toString('utf8'));
      if (!j.url) return send(res, 400, { error: 'missing-url' });
      const out = await solveTurnstile({
        url: j.url,
        sitekey: j.sitekey,
        action: j.action,
        cdata: j.cdata,
        proxy: j.proxy,
        cookies: j.cookies,
        debug: !!j.debug,
        timeoutMs: Math.max(5000, Math.min(Number(j.timeout || 60) * 1000, 180000)),
      });
      stats.turnstile++;
      return send(res, 200, out);
    } catch (e) {
      return send(res, 400, { error: e.message });
    }
  }

  if (req.method !== 'POST' || url !== '/solve') return send(res, 404, { error: 'not-found' });

  if (!authorized(req)) return send(res, 401, { error: 'unauthorized' });

  const t0 = Date.now();
  try {
    const body = await readBody(req);
    const j = JSON.parse(body.toString('utf8'));
    const img = (j.image || '').replace(/^data:image\/\w+;base64,/, '');
    if (!img) return send(res, 400, { error: 'missing-image' });
    const buf = Buffer.from(img, 'base64');
    const out = await solve(buf, {
      apiKey: process.env.APINEX_KEY,
      model: process.env.APINEX_MODEL,
      n: j.n,
      threshold: j.threshold,
      mode: j.mode || 'auto',
    });
    stats.total++;
    stats[out.source] = (stats[out.source] || 0) + 1;
    if (out.tie) stats.tie++;
    stats.msSum += Date.now() - t0;
    return send(res, 200, out);
  } catch (e) {
    return send(res, 400, { error: e.message });
  }
});

server.listen(PORT, () => console.log(`trixvler listening :${PORT}`));
