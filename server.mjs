import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { solve } from './trixvler.mjs';
import { solveRecaptcha } from './recaptcha.mjs';
import { solveTurnstile } from './turnstile.mjs';

process.on('uncaughtException', (e) => {
  if (e && (e.code === 'EPIPE' || e.code === 'ECONNRESET')) return;
  console.error('uncaught', e);
});

const __dir = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const KEY = process.env.TRIXVLER_KEY || '';
const DASH = path.join(__dir, 'public', 'index.html');

const stats = { total: 0, local: 0, ai: 0, tie: 0, rcTotal: 0, rcOk: 0, tsTotal: 0, tsOk: 0, msSum: 0 };

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
  req.socket?.on('error', () => {});
  res.on('error', () => {});
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
    avgMs: stats.total ? Math.round(stats.msSum / stats.total) : 0,
    rcTotal: stats.rcTotal,
    rcOk: stats.rcOk,
    tsTotal: stats.tsTotal,
    tsOk: stats.tsOk,
   });
  }

  if (req.method === 'POST' && url === '/turnstile') {
   if (!authorized(req)) return send(res, 401, { error: 'unauthorized' });
   const t0 = Date.now();
   try {
    const body = await readBody(req);
    const j = JSON.parse(body.toString('utf8'));
    if (!j.pageurl || !j.sitekey) return send(res, 400, { error: 'missing-pageurl-or-sitekey' });
    const out = await solveTurnstile({
     pageurl: j.pageurl,
     sitekey: j.sitekey,
     proxy: j.proxy || process.env.TURNSTILE_PROXY || 'socks5://100.64.8.24:1095',
     action: j.action,
     cdata: j.cdata,
     timeout: j.timeout,
    });
    stats.tsTotal++;
    if (out.ok) stats.tsOk++;
    stats.msSum += Date.now() - t0;
    return send(res, 200, out);
   } catch (e) {
    stats.tsTotal++;
    return send(res, 502, { ok: false, error: e.message, ms: Date.now() - t0 });
   }
  }

  if (req.method === 'POST' && url === '/recaptcha') {
   if (!authorized(req)) return send(res, 401, { error: 'unauthorized' });
   const t0 = Date.now();
   try {
    const body = await readBody(req);
    const j = JSON.parse(body.toString('utf8'));
    const out = await solveRecaptcha({
     sitekey: j.sitekey,
     pageurl: j.pageurl,
     maxRounds: j.maxRounds,
     maxPasses: j.maxPasses,
     models: j.models,
     provider: j.provider,
     agentrouterKey: j.agentrouterKey,
     agentrouterModel: j.agentrouterModel,
     numesKey: j.numesKey,
     numesModel: j.numesModel,
     });
    stats.rcTotal++;
    if (out.ok) stats.rcOk++;
    stats.msSum += Date.now() - t0;
    return send(res, 200, out);
   } catch (e) {
    stats.rcTotal++;
    return send(res, 502, { ok: false, error: e.message, ms: Date.now() - t0 });
   }
  }

  if (req.method === 'POST' && (url === '/vision' || url === '/solve-puzzle')) {
   if (!authorized(req)) return send(res, 401, { error: 'unauthorized' });
   const t0 = Date.now();
   try {
    const body = await readBody(req);
    const j = JSON.parse(body.toString('utf8'));
    if (!j.image) return send(res, 400, { error: 'missing-image' });
    const { execFile } = await import('node:child_process');
    const input = JSON.stringify({ image: j.image.replace(/^data:image\/\w+;base64,/, ''), ref: (j.ref || '').replace(/^data:image\/\w+;base64,/, ''), prompt: j.prompt || '' });
    const out = await new Promise((resolve, reject) => {
      const p = execFile('python3', [path.join(__dir, 'vision_cv.py')], { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        try { resolve(JSON.parse(stdout)); } catch { reject(new Error('bad-vision-output: ' + stdout.slice(0, 120))); }
      });
      p.stdin.write(input); p.stdin.end();
    });
    return send(res, 200, { ...out, ms: Date.now() - t0 });
   } catch (e) {
    return send(res, 502, { ok: false, error: e.message, ms: Date.now() - t0 });
   }
  }

  if (req.method === 'POST' && url === '/vision-ai') {
   if (!authorized(req)) return send(res, 401, { error: 'unauthorized' });
   const t0 = Date.now();
   try {
    const body = await readBody(req);
    const j = JSON.parse(body.toString('utf8'));
    if (!j.image) return send(res, 400, { error: 'missing-image' });
    const { execFile } = await import('node:child_process');
    const input = JSON.stringify({ image: (j.image || '').replace(/^data:image\/\w+;base64,/, ''),
      ref: (j.ref || '').replace(/^data:image\/\w+;base64,/, ''), prompt: j.prompt || '' });
    const out = await new Promise((resolve, reject) => {
      const p = execFile('python3', [path.join(__dir, 'vision_ai.py')], { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        try { resolve(JSON.parse(stdout)); } catch { reject(new Error('bad-output: ' + stdout.slice(0, 120))); }
      });
      p.stdin.write(input); p.stdin.end();
    });
    return send(res, 200, { ...out, ms: Date.now() - t0 });
   } catch (e) {
    return send(res, 502, { ok: false, error: e.message, ms: Date.now() - t0 });
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
      agentrouterKey: process.env.AGENTROUTER_KEY,
      agentrouterModel: process.env.AGENTROUTER_MODEL,
      numesKey: process.env.NUMES_KEY,
      numesModel: process.env.NUMES_MODEL,
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
