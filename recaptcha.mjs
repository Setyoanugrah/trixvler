import http from 'node:http';
import { chromium } from 'patchright';

const APINEX_URL = 'https://api.apinex.bond/v1/chat/completions';
export const DEMO_SITEKEY = '6Le-wvkSAAAAAPBMRTvw0Q4Muexq9bi0DJwx_mJ-';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (a, b) => a + Math.random() * (b - a);

function challengeHtml(sitekey) {
  return `<!doctype html><html><head><title>t</title>
<script src="https://www.google.com/recaptcha/api.js" async defer></script>
</head><body style="background:#fff;margin:20px">
<div class="g-recaptcha" data-sitekey="${sitekey}"></div>
</body></html>`;
}

function parseJsonLoose(txt) {
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

async function arVision({ imageB64, prompt, key, model, timeoutMs = 120000 }) {
  const body = JSON.stringify({
    model,
    temperature: 0,
    max_tokens: 500,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,' + imageB64 } },
      ],
    }],
  });
  const res = await fetch(APINEX_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`apinex-http-${res.status}: ${(await res.text()).slice(0, 180)}`);
  const rawBody = await res.text();
  let j;
  try { j = JSON.parse(rawBody); } catch { throw new Error('apinex-non-json: ' + rawBody.slice(0, 150)); }
  return (j?.choices?.[0]?.message?.content || '').trim();
}

const VISION_PROMPT = [
  'You are looking at a screenshot of a visual verification challenge area (reCAPTCHA-style).',
  'The task is usually one of:',
  '- a grid of tiles: "select all squares/images containing <object>", possibly across multiple rounds',
  '- a single image: "click the center of the <object>"',
  '',
  'Return ONLY JSON, no prose:',
  '{"clicks":[{"x":N,"y":N}]}',
  'where each x,y is a click position normalized 0-1000 relative to this image (0,0 = top-left, 1000,1000 = bottom-right).',
  'For grid tasks include EVERY tile that matches the requested object (click the center of each matching tile).',
  'For single-image tasks return exactly one click at the center of the requested object.',
  'If nothing in the image matches, return {"clicks":[]}.',
].join('\n');

async function findImageLoc(challenge) {
  for (const sel of ['.rc-imageselect-target', '.rc-dynamic-image-wrapper', '.rc-image-tile-target']) {
    const loc = challenge.locator(sel).first();
    try {
      if (await loc.isVisible()) return loc;
    } catch {}
  }
  return challenge.locator('body');
}

async function clickAt(challenge, loc, nx, ny) {
  const box = await loc.boundingBox();
  if (!box) return;
  const px = Math.max(2, Math.min(box.width - 2, Math.round((nx / 1000) * box.width)));
  const py = Math.max(2, Math.min(box.height - 2, Math.round((ny / 1000) * box.height)));
  // raw mouse events at page level: no actionability/stability wait (tiles animate)
  const frameEl = await challenge.frameElement();
  const fb = await frameEl.boundingBox();
  await challenge.page().mouse.move(fb.x + box.x + px, fb.y + box.y + py, { steps: 5 });
  await challenge.page().mouse.down();
  await sleep(rnd(30, 80));
  await challenge.page().mouse.up();
  await sleep(rnd(150, 450));
}

async function anchorChecked(anchor) {
  try {
    return (await anchor.locator('#recaptcha-anchor[aria-checked="true"]').count()) > 0;
  } catch {
    return false;
  }
}

export async function solveRecaptcha(opts = {}) {
  const sitekey = opts.sitekey;
  if (!sitekey) throw new Error('missing-sitekey');
  const key = opts.apiKey || process.env.APINEX_KEY;
  if (!key) throw new Error('missing-apinex-key');
  const model = opts.model || process.env.APINEX_MODEL || 'free/gemini-3.8-flash';
  const maxRounds = Math.min(Number(opts.maxRounds) || 8, 15);
  const t0 = Date.now();
  const log = [];

  let host = null;
  if (opts.pageurl) {
    try { host = new URL(opts.pageurl).hostname; } catch { throw new Error('bad-pageurl'); }
  }

  // local widget server; with host-mapping the widget believes it runs on the target domain
  const widget = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(challengeHtml(sitekey));
  });
  await new Promise((r) => widget.listen(0, '127.0.0.1', r));
  const wport = widget.address().port;

  const browser = await chromium.launch({
    headless: false, // under xvfb on the runner; patchright works best headed
    args: host
      ? [`--host-resolver-rules=MAP ${host} 127.0.0.1:${wport}`, '--no-sandbox']
      : ['--no-sandbox'],
  });

  try {
    const ctx = await browser.newContext({
      viewport: { width: 480, height: 760 },
      locale: 'en-US',
      timezoneId: 'America/New_York',
    });
    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${wport}/`, { waitUntil: 'load', timeout: 30000 });

    // wait for the anchor iframe
    let anchor = null;
    for (let i = 0; i < 40 && !anchor; i++) {
      anchor = page.frames().find((f) => f.url().includes('api2/anchor'));
      if (!anchor) await sleep(500);
    }
    if (!anchor) throw new Error('anchor-iframe-timeout');
    await anchor.waitForSelector('#recaptcha-anchor', { timeout: 20000 });
    log.push('anchor-ready');

    await anchor.locator('#recaptcha-anchor').click({ delay: rnd(40, 120) });

    // wait: either solved instantly or a challenge frame shows up
    let challenge = null;
    let solved = false;
    for (let i = 0; i < 30; i++) {
      if (await anchorChecked(anchor)) { solved = true; break; }
      challenge = page.frames().find((f) => f.url().includes('api2/bframe'));
      if (challenge) break;
      await sleep(500);
    }
    log.push(solved ? 'no-challenge' : 'challenge-shown');

    let rounds = 0;
    if (!solved && challenge) {
      for (let round = 1; round <= maxRounds; round++) {
        rounds = round;
        const imgLoc = await findImageLoc(challenge);
        try { await imgLoc.waitFor({ state: 'visible', timeout: 15000 }); } catch {}
        await sleep(rnd(600, 1400));

        // unusual-traffic block check
        const bodyTxt = await challenge.locator('body').innerText().catch(() => '');
        if (/unusual traffic/i.test(bodyTxt)) throw new Error('blocked-unusual-traffic');

        const shot = await imgLoc.screenshot({ type: 'png' });
        const raw = await arVision({
          imageB64: shot.toString('base64'),
          prompt: VISION_PROMPT,
          key, model,
        });
        const parsed = parseJsonLoose(raw) || { clicks: [] };
        const clicks = Array.isArray(parsed.clicks)
          ? parsed.clicks.filter((c) => Number.isFinite(c?.x) && Number.isFinite(c?.y)).slice(0, 20)
          : [];
        log.push(`r${round}:clicks=${clicks.length}`);

        for (const c of clicks) await clickAt(challenge, imgLoc, c.x, c.y);
        await sleep(rnd(700, 1500));

        // no matching tile -> SKIP; otherwise VERIFY
        if (clicks.length === 0) {
          const skip = challenge.locator('.rc-imageselect-button-skip, button:has-text("SKIP")').first();
          if (await skip.isVisible().catch(() => false)) await skip.click({ delay: rnd(30, 90) });
          else await challenge.locator('.rc-imageselect-verify-button, button:has-text("VERIFY")').first().click({ delay: rnd(30, 90) }).catch(() => {});
        } else {
          await challenge.locator('.rc-imageselect-verify-button, button:has-text("VERIFY")').first().click({ delay: rnd(30, 90) }).catch(() => {});
        }

        // wait for outcome: solved / next round / block
        let advanced = false;
        for (let i = 0; i < 24; i++) {
          if (await anchorChecked(anchor)) { solved = true; break; }
          const bodyTxt2 = await challenge.locator('body').innerText().catch(() => '');
          if (/unusual traffic/i.test(bodyTxt2)) throw new Error('blocked-unusual-traffic');
          await sleep(500);
        }
        if (solved) break;
        advanced = true;
        await sleep(rnd(800, 1600));
      }
      if (!solved) throw new Error('challenge-not-solved rounds=' + rounds + ' log=' + log.join('|'));
    }
    if (!solved) throw new Error('challenge-timeout');

    // token
    let token = '';
    for (let i = 0; i < 20 && !token; i++) {
      token = await page.evaluate(() => document.querySelector('#g-recaptcha-response')?.value || '').catch(() => '');
      if (!token) await sleep(500);
    }
    if (!token) throw new Error('token-empty log=' + log.join('|'));

    return { ok: true, token, sitekey, rounds, ms: Date.now() - t0, log, source: 'vision' };
  } finally {
    await browser.close().catch(() => {});
    widget.close();
  }
}

const isMain = process.argv[1] && import.meta.url === 'file://' + process.argv[1];
if (isMain) {
  if (process.argv[2] === '--selftest') {
    // smoke test: module loads, exports exist, no browser needed
    if (typeof solveRecaptcha !== 'function') { console.error('selftest FAIL'); process.exit(1); }
    if (typeof DEMO_SITEKEY !== 'string') { console.error('selftest FAIL'); process.exit(1); }
    console.log('selftest OK (recaptcha.mjs loads, exports intact)');
    process.exit(0);
  }
  const sitekey = process.argv[2] || DEMO_SITEKEY;
  const out = await solveRecaptcha({ sitekey, pageurl: process.argv[3] });
  console.log(JSON.stringify(out, null, 2));
}
