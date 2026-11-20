import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'patchright';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const API_BASE = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
const API_FETCH = API_BASE + '?render=explicit';

const BOOT = ({ sitekey, action, cdata }) => {
  window.__ts = { token: null, error: null, wid: null };
  try {
    const s = document.createElement('script');
    s.type = 'text/plain';
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
    document.head.appendChild(s);
    fetch('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit')
      .then((r) => r.text())
      .then((js) => {
        (0, eval)(js);
        if (!window.turnstile || typeof window.turnstile.render !== 'function') {
          window.__ts.error = 'turnstile-global-missing';
          return;
        }
        const host = document.createElement('div');
        host.id = '__ts_host';
        host.style.cssText = 'position:fixed;top:10px;left:10px;z-index:2147483647;background:#fff;padding:8px;';
        document.body.appendChild(host);
        window.__ts.wid = window.turnstile.render(host, {
          sitekey,
          action: action || undefined,
          cdata: cdata || undefined,
          theme: 'light',
          callback: (t) => { window.__ts.token = t; },
          'error-callback': (e) => { window.__ts.error = String(e); },
          'timeout-callback': () => { window.__ts.error = 'timeout'; },
        });
        try { window.turnstile.execute(window.__ts.wid); } catch {}
      })
      .catch((e) => { window.__ts.error = String(e); });
  } catch (e) {
    window.__ts.error = String(e);
  }
};

const pageHtml = () => `<!doctype html><html><head><meta charset="utf-8"><title>ts</title>
<style>html,body{margin:0;background:#fff}#c{padding:12px}</style></head>
<body><div id="c"></div></body></html>`;

let cachedCert = null;
function certs() {
  if (cachedCert) return cachedCert;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tscert-'));
  const key = path.join(dir, 'k.pem');
  const crt = path.join(dir, 'c.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', crt, '-days', '2', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  cachedCert = { key: fs.readFileSync(key), cert: fs.readFileSync(crt) };
  return cachedCert;
}

export async function solveTurnstile(opts = {}) {
  const { pageurl, sitekey, proxy, action, cdata, timeout = 120000 } = opts;
  if (!pageurl || !sitekey) throw new Error('missing-pageurl-or-sitekey');
  let host;
  try { host = new URL(pageurl).hostname; } catch { throw new Error('bad-pageurl'); }

  const pu = proxy ? new URL(proxy) : null;
  const pstr = pu ? `SOCKS5 ${pu.hostname}:${pu.port || 1080}` : 'DIRECT';
  const pac = `function FindProxyForURL(url,host){ if(host===${JSON.stringify(host)}) return 'DIRECT'; return ${JSON.stringify(pstr)}; }`;

  const widget = https.createServer(certs(), (req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(pageHtml());
  });
  await new Promise((r) => widget.listen(0, '127.0.0.1', r));
  const wport = widget.address().port;
  const pacSrv = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/x-ns-proxy-autoconfig' });
    res.end(pac);
  });
  await new Promise((r) => pacSrv.listen(0, '127.0.0.1', r));
  const pacPort = pacSrv.address().port;

  const t0 = Date.now();
  const browser = await chromium.launch({
    headless: false,
    args: [
      `--host-resolver-rules=MAP ${host} 127.0.0.1:${wport}`,
      `--proxy-pac-url=http://127.0.0.1:${pacPort}/proxy.pac`,
      '--ignore-certificate-errors',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--lang=en-US',
    ],
  });
  try {
    const ctx = await browser.newContext({
      viewport: { width: 480, height: 640 },
      locale: 'en-US',
      timezoneId: 'Asia/Jakarta',
      ignoreHTTPSErrors: true,
      bypassCSP: true,
    });
    const page = await ctx.newPage();
    await page.goto(`https://${host}/`, { waitUntil: 'load', timeout: 30000 });
    await page.evaluate(BOOT, { sitekey, action, cdata });

    let token = null;
    let error = null;
    let clicked = false;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const st = await page.evaluate(() => ({
        token: window.__ts && window.__ts.token,
        error: window.__ts && window.__ts.error,
      })).catch(() => ({}));
      if (st.token) { token = st.token; break; }
      if (st.error) error = st.error;
      if (!clicked && Date.now() - t0 > 6000) {
        clicked = true;
        try {
          const ifr = await page.$('iframe[src*="challenges.cloudflare.com"]');
          if (ifr) {
            const b = await ifr.boundingBox();
            if (b) await page.mouse.click(b.x + 30, b.y + 32);
          }
        } catch {}
      }
      await sleep(500);
    }
    if (!token) throw new Error('no-token' + (error ? ': ' + error : ''));
    return { ok: true, token, ms: Date.now() - t0 };
  } finally {
    await browser.close();
    await new Promise((r) => widget.close(r));
    await new Promise((r) => pacSrv.close(r));
  }
}

if (process.argv[1] && process.argv[1].endsWith('turnstile.mjs')) {
  const pageurl = process.argv[2];
  const sitekey = process.argv[3];
  const proxy = process.argv[4] || process.env.TURNSTILE_PROXY || '';
  solveTurnstile({ pageurl, sitekey, proxy })
    .then((r) => console.log(JSON.stringify(r)))
    .catch((e) => { console.log(JSON.stringify({ ok: false, error: e.message })); process.exit(1); });
}
