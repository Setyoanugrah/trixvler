const DEFAULT_TIMEOUT = 60000;
const MAX_CONCURRENT = 2;

let active = 0;
const waiters = [];

function acquire() {
  if (active < MAX_CONCURRENT) { active++; return Promise.resolve(); }
  return new Promise((resolve) => waiters.push(resolve)).then(() => { active++; });
}

function release() {
  active = Math.max(0, active - 1);
  const next = waiters.shift();
  if (next) next();
}

function parseProxy(p) {
  if (!p) return undefined;
  if (typeof p === 'object') return p;
  try {
    const u = new URL(p);
    return {
      server: `${u.protocol}//${u.host}`,
      username: u.username || undefined,
      password: u.password || undefined,
    };
  } catch {
    return { server: p };
  }
}

async function getToken(page) {
  try {
    return await page.evaluate(() => {
      const el = document.querySelector('[name="cf-turnstile-response"]');
      if (el && el.value) return el.value;
      try {
        if (window.turnstile) {
          const r = window.turnstile.getResponse();
          if (r) return r;
        }
      } catch {}
      return null;
    });
  } catch {
    return null;
  }
}

async function tryClick(page) {
  const frames = page.frames().filter((f) => f.url().includes('challenges.cloudflare.com'));
  for (const f of frames) {
    for (const sel of ['input[type="checkbox"]', 'label', '.cb-c', '#challenge-stage', 'body']) {
      try {
        const el = await f.$(sel);
        if (el) { await el.click({ timeout: 1500 }); return true; }
      } catch {}
    }
  }
  try {
    const w = await page.$('.cf-turnstile, [data-sitekey]');
    if (w) { await w.click({ timeout: 1500 }); return true; }
  } catch {}
  return false;
}

async function injectWidget(page, sitekey, action, cdata) {
  const has = await page.evaluate(() =>
    !!document.querySelector('[name="cf-turnstile-response"], .cf-turnstile, [data-sitekey]')
  ).catch(() => false);
  if (has) return;
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const attrs = [`data-sitekey="${esc(sitekey)}"`];
  if (action) attrs.push(`data-action="${esc(action)}"`);
  if (cdata) attrs.push(`data-cdata="${esc(cdata)}"`);
  const html = `<!doctype html><html><head><meta charset="utf-8"></head><body>` +
    `<div class="cf-turnstile" ${attrs.join(' ')}></div>` +
    `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>` +
    `</body></html>`;
  await page.setContent(html, { waitUntil: 'domcontentloaded' }).catch(() => {});
}

async function diagnostics(page) {
  const info = await page.evaluate(() => ({
    title: document.title,
    url: location.href,
    widgets: document.querySelectorAll('.cf-turnstile, [data-sitekey]').length,
    hasResponse: !!document.querySelector('[name="cf-turnstile-response"]'),
    hasTurnstile: typeof window.turnstile !== 'undefined',
  })).catch(() => ({}));
  const frames = page.frames().map((f) => f.url()).filter(Boolean);
  let screenshot = null;
  try { screenshot = (await page.screenshot({ type: 'png' })).toString('base64'); } catch {}
  return { ...info, frames, screenshot };
}

export async function solveTurnstile(opts = {}) {
  const {
    url,
    sitekey,
    action,
    cdata,
    proxy,
    cookies,
    debug = false,
    headless = process.env.TURNSTILE_HEADED !== '1',
    timeoutMs = DEFAULT_TIMEOUT,
  } = opts;
  if (!url) throw new Error('missing-url');

  const { chromium } = await import('patchright');
  await acquire();
  const t0 = Date.now();
  let browser;
  try {
    browser = await chromium.launch({
      headless,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
      proxy: parseProxy(proxy),
    });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      locale: 'en-US',
      timezoneId: 'America/New_York',
    });
    if (Array.isArray(cookies) && cookies.length) {
      try { await context.addCookies(cookies); } catch {}
    }
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.min(timeoutMs, 45000) });

    if (sitekey) await injectWidget(page, sitekey, action, cdata);

    const deadline = Date.now() + timeoutMs;
    let token = null;
    let clicks = 0;
    while (Date.now() < deadline) {
      token = await getToken(page);
      if (token) break;
      if (clicks < 3) { await tryClick(page); clicks++; }
      await page.waitForTimeout(1000);
    }
    if (!token) {
      if (debug) return { token: null, error: 'turnstile-timeout', elapsedMs: Date.now() - t0, ...(await diagnostics(page)) };
      throw new Error('turnstile-timeout (kemungkinan butuh interaksi / proxy residential)');
    }
    if (debug) return { token, elapsedMs: Date.now() - t0, sitekey: sitekey || null, url, ...(await diagnostics(page)) };
    return { token, elapsedMs: Date.now() - t0, sitekey: sitekey || null, url };
  } finally {
    try { await browser?.close(); } catch {}
    release();
  }
}
