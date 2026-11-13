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

function visionPrompt(instruction) {
  return [
    'You are analyzing a screenshot of a reCAPTCHA image-grid challenge.',
    `The user is asked to: "${instruction || 'select all images matching the requested category'}"`,
    '',
    'The image area contains a grid of photo tiles (usually 3x3 or 4x4, sometimes one example image above the grid).',
    'Rules for selecting a tile:',
    '- Select a tile if ANY significant part of the requested object appears in it (even a wheel of a car, a sliver of a storefront sign, a partial traffic light).',
    '- IGNORE the small example image above the grid if one exists - only the grid tiles matter.',
    '- Ignore tiles already marked with a blue checkmark overlay (selected in a previous round).',
    '- When unsure whether a tile shows the object, include it. False positives are much less costly than misses.',
    '- Do NOT select tiles that show only background (grass, sky, road, water, walls) with no trace of the object.',
    '',
    'Return ONLY JSON, no prose, exactly this shape:',
    '{"clicks":[{"x":N,"y":N}]}',
    'x,y = click position normalized 0-1000 relative to THIS image (0,0 top-left, 1000,1000 bottom-right), center of each matching tile.',
    'If no tile matches, return {"clicks":[]}.',
  ].join('\n');
}

const TILE_PROMPT = (instruction, ix, iy, cols, rows) => [
  'You are looking at ONE cropped photo tile from a reCAPTCHA grid',
  `(tile at column ${ix + 1} of ${cols}, row ${iy + 1} of ${rows}; column 1 = leftmost, row 1 = topmost).`,
  `The challenge asks to select tiles containing: "${instruction || 'the requested object'}".`,
  '',
  'The tile image may be distorted (posterized, edge-enhanced, high-contrast noise) - this is intentional; look through the distortion and judge the CONTENT.',
  'Look carefully at the whole tile. Answer ONLY JSON: {"match":true} or {"match":false}.',
  'Match = any significant part of the object is visible in this tile (partial views count: e.g. a car bumper, part of a bus, a fragment of a hydrant).',
  'No match = only background/scenery (grass, road, sky, water, walls) or an unrelated object.',
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


async function waitTileRender(challenge, imgLoc, maxMs = 12000) {
  const t0 = Date.now();
  let prev = null;
  while (Date.now() - t0 < maxMs) {
    await sleep(1200);
    try {
      // all tile <img> elements must have a loaded src
      const srcs = await challenge.locator('.rc-image-tile-wrapper img').evaluateAll(
        (els) => els.map((e) => e.getAttribute('src') || ''));
      if (srcs.length && srcs.every((x) => x && x.length > 50)) {
        const cur = await pageScreenshotFast(challenge);
        if (prev && cur.equals(prev)) return true; // stable: same bytes twice in a row
        prev = cur;
      }
    } catch {}
  }
  return false;
}

async function pageScreenshotFast(challenge) {
  const page = challenge.page();
  return page.screenshot({ type: 'png', animations: 'disabled' });
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
  const models = [model, 'gpt-6.1-sol'].filter((m, i, a) => a.indexOf(m) === i);
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

        // unusual-traffic block check
        const bodyTxt = await challenge.locator('body').innerText().catch(() => '');
        if (/unusual traffic/i.test(bodyTxt)) throw new Error('blocked-unusual-traffic');

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

        // strategy: r1 = whole grid; later rounds (or when grid unknown) = per-tile voting
        let clicks = [];
        if (cols > 0 && round > 1) {
          log.push(`r${round}:mode=per-tile ${cols}x${rows}`);
          const cellW = shotW / cols, cellH = shotH / rows;
          const jobs = [];
          for (let iy = 0; iy < rows; iy++) {
            for (let ix = 0; ix < cols; ix++) {
              jobs.push({ ix, iy });
            }
          }
          // ask the model per tile, small parallel burst
          const answers = await Promise.all(jobs.map(async ({ ix, iy }) => {
            const crop = await sharpCrop(shot, Math.round(ix * cellW), Math.round(iy * cellH), Math.round(cellW), Math.round(cellH));
            const b64 = crop.toString('base64');
            const prompt = TILE_PROMPT(instruction.replace(/\s+/g, ' ').trim(), ix, iy, cols, rows);
            const votes = await Promise.all(models.map(async (m) => {
              try {
                const raw = await arVision({ imageB64: b64, prompt, key, model: m });
                const p = parseJsonLoose(raw);
                return !!(p && p.match);
              } catch { return false; }
            }));
            return { ix, iy, match: votes.some(Boolean), votes };
          }));
          clicks = answers.filter((a) => a.match)
            .map((a) => ({ x: Math.round(((a.ix + 0.5) / cols) * 1000), y: Math.round(((a.iy + 0.5) / rows) * 1000) }));
        } else {
          const raw = await arVision({
            imageB64: shot.toString('base64'),
            prompt: visionPrompt(instruction.replace(/\s+/g, ' ').trim()),
            key, model,
          });
          const parsed = parseJsonLoose(raw) || { clicks: [] };
          clicks = Array.isArray(parsed.clicks)
            ? parsed.clicks.filter((c) => Number.isFinite(c?.x) && Number.isFinite(c?.y)).slice(0, 20)
            : [];
        }
        log.push(`r${round}:clicks=${clicks.length}`);
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
