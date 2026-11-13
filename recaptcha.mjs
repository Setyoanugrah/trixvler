import http from 'node:http';
import fs from 'node:fs';
import { chromium } from 'patchright';

import { PNG } from 'pngjs';

async function sharpCrop(buf, x, y, w, h) {
  const img = PNG.sync.read(buf);
  const cw = Math.max(1, Math.min(w, img.width - x));
  const ch = Math.max(1, Math.min(h, img.height - y));
  const out = new PNG({ width: cw, height: ch });
  for (let ry = 0; ry < ch; ry++) {
    const src = ((y + ry) * img.width + x) * 4;
    img.data.copy(out.data, ry * cw * 4, src, src + cw * 4);
  }
  return PNG.sync.write(out);
}


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

function visionPrompt(instruction, cols, rows) {
  const n = cols * rows;
  return [
    'You are analyzing a screenshot of a reCAPTCHA image challenge.',
    `The challenge instruction is: "${instruction || 'select all images matching the requested category'}"`,
    '',
    `The image is a ${cols}x${rows} grid of ${n} photo tiles, indexed 0-${n - 1} in reading order (0 = top-left, across each row).`,
    'The tiles may be distorted (posterized, edge-enhanced, noisy) on purpose - judge the CONTENT through the distortion.',
    'Select a tile if ANY significant part of the requested object appears in it - partial views count (a wheel, a bumper, a fragment of a sign).',
    'Do NOT select tiles showing only background: grass, sky, road, water, walls, fences.',
    'Do NOT select tiles already marked with a blue/white checkmark overlay.',
    '',
    'Return ONLY JSON, exactly:',
    `{"tiles":[${Array(n).fill('true|false').join(',')}]}  -> e.g. {"tiles":[true,false,false,true,false,false,false,false,true]}`,
    'The array MUST have exactly ' + n + ' boolean entries, entry i = whether tile i should be selected.',
  ].join('\n');
}

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


async function waitTileRender(challenge, imgLoc, maxMs = 7000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    await sleep(800);
    try {
      const srcs = await challenge.locator('.rc-image-tile-wrapper img').evaluateAll(
        (els) => els.map((e) => e.getAttribute('src') || ''));
      if (srcs.length && srcs.every((x) => x && x.length > 50)) return true;
    } catch {}
  }
  return false;
}

async function pageScreenshotFast(challenge) {
  const page = challenge.page();
  return page.screenshot({ type: 'png', animations: 'disabled' });
}

async function isExpired(challenge) {
  try {
    const t = await challenge.locator('body').innerText().catch(() => '') || '';
    return /verification expired/i.test(t);
  } catch { return false; }
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
  const models = [model, 'gpt-6.1-sol'].filter((m, i, a) => a.indexOf(m) === i); // pool for rotation
  const challengeDeadlineMs = 150000; // recaptcha expires in ~2-5min; stay under it
  let challengeStart = Date.now();
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
        await waitTileRender(challenge, imgLoc); // tiles fade in 5-7s; screenshot only when stable

        // unusual-traffic / expiry checks
        const bodyTxt = await challenge.locator('body').innerText().catch(() => '');
        if (/unusual traffic/i.test(bodyTxt)) throw new Error('blocked-unusual-traffic');
        if (await isExpired(challenge) || Date.now() - challengeStart > challengeDeadlineMs) {
          log.push(`r${round}:${await isExpired(challenge) ? 'expired' : 'deadline'}`);
          const reload = challenge.locator('#recaptcha-reload-button, .rc-button-reload').first();
          await reload.click({ force: true }).catch(() => {});
          await sleep(rnd(1500, 2500));
          challengeStart = Date.now();
          continue;
        }

        // the actual task text, e.g. "Select all images with traffic lights"
        const instruction = await challenge
          .locator('.rc-imageselect-instructions .rc-imageselect-desc-wrapper, .rc-imageselect-desc-wrapper, .instructions')
          .first().innerText().catch(() => '');

        // full-page screenshot + crop to the challenge image box (locator.screenshot
        // hangs on "element to be stable" because tiles keep animating)
        const vp = page.viewportSize(); const pageW = vp.width, pageH = vp.height;
        const pageBuf = await page.screenshot({ type: 'png', animations: 'disabled' });
        let shot = pageBuf;
        let shotW = pageW, shotH = pageH;
        try {
          const frameEl = await challenge.frameElement();
          const fb = await frameEl.boundingBox();
          const bb = await imgLoc.boundingBox();
          if (fb && bb) {
            const gx = Math.max(0, Math.round(fb.x + bb.x)), gy = Math.max(0, Math.round(fb.y + bb.y));
            const gw = Math.min(pageW - gx, Math.round(bb.width)), gh = Math.min(pageH - gy, Math.round(bb.height));
            shot = await sharpCrop(pageBuf, gx, gy, gw, gh);
            shotW = gw; shotH = gh;
          }
        } catch {}

        // grid detection: reCAPTCHA tiles use .rc-image-tile-wrapper inside the target
        let cols = 0, rows = 0;
        try {
          const tiles = await challenge.locator('.rc-image-tile-wrapper').count();
          if (tiles === 9) { cols = 3; rows = 3; }
          else if (tiles === 16) { cols = 4; rows = 4; }
          else if (tiles === 4) { cols = 2; rows = 2; }
        } catch {}

        // single vision call per round: whole grid, per-tile boolean array back
        let clicks = [];
        const m = models[(round - 1) % models.length];
        const c = cols || 3, r = rows || 3;
        const raw = await arVision({
          imageB64: shot.toString('base64'),
          prompt: visionPrompt(instruction.replace(/\s+/g, ' ').trim(), c, r),
          key, model: m,
        });
        const parsed = parseJsonLoose(raw) || {};
        if (Array.isArray(parsed.tiles) && parsed.tiles.length) {
          parsed.tiles.forEach((v, i) => {
            if (v === true) {
              const ix = i % c, iy = Math.floor(i / c);
              clicks.push({ x: Math.round(((ix + 0.5) / c) * 1000), y: Math.round(((iy + 0.5) / r) * 1000) });
            }
          });
        } else if (Array.isArray(parsed.clicks)) {
          clicks = parsed.clicks.filter((cc) => Number.isFinite(cc?.x) && Number.isFinite(cc?.y)).slice(0, 20);
        }
        clicks = clicks.slice(0, c * r);
        log.push(`r${round}:model=${m}:clicks=${clicks.length}`);
        try { fs.mkdirSync('/tmp/rcdebug', { recursive: true }); fs.writeFileSync(`/tmp/rcdebug/r${round}.png`, shot); } catch {}

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
        await waitTileRender(challenge, imgLoc); // next round fades in 5-7s
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
