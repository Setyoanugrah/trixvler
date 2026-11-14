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
    'Select a tile ONLY if the requested object is clearly and unambiguously visible in it. Partial views count when the object is unmistakable (a whole wheel with its arch, a bus windshield).',
    'Do NOT select tiles that are ambiguous, blurred, mostly background, or where you only suspect the object might be. Precision matters more than recall.',
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
  // loc.boundingBox() is already page-coordinates; raw mouse events, no stability wait
  await challenge.page().mouse.move(box.x + px, box.y + py, { steps: 5 });
  await challenge.page().mouse.down();
  await sleep(rnd(30, 80));
  await challenge.page().mouse.up();
  await sleep(rnd(150, 450));
}


async function waitAllDeselected(challenge, maxMs = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    try {
      const n = await challenge.locator('.rc-imageselect-tileselected, td[aria-checked="true"]').count();
      if (n === 0) return true;
    } catch {}
    await sleep(700);
  }
  return false;
}

async function shotIsBlank(buf) {
  try {
    const img = PNG.sync.read(buf);
    let white = 0, total = 0;
    for (let i = 0; i < img.data.length; i += 40) {
      total++;
      const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
      if (r > 235 && g > 235 && b > 235) white++;
    }
    return total > 0 && white / total > 0.9;
  } catch { return false; }
}

async function waitTileRender(challenge, imgLoc, maxMs = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    await sleep(800);
    try {
      // pixel-level check: every tile img decoded (complete && naturalWidth > 0)
      const ok = await challenge.locator('.rc-image-tile-wrapper img').evaluateAll(
        (els) => els.length > 0 && els.every((e) => e.complete && e.naturalWidth > 10));
      if (!ok) continue;
      // tiles decoded -> ready (blankness is checked later on the CROP, never on the
      // full page: a small widget on a 480x760 page is >90% white by design)
      return true;
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


async function waitTileReplaced(challenge, maxMs = 6000) {
  try {
    const before = await challenge.locator('.rc-image-tile-wrapper img').evaluateAll(
      (els) => els.map((e) => e.getAttribute('src') || ''));
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      await sleep(500);
      const after = await challenge.locator('.rc-image-tile-wrapper img').evaluateAll(
        (els) => els.map((e) => e.getAttribute('src') || ''));
      if (after.length && after.some((v, i) => v !== before[i])) return true; // at least one tile replaced
    }
  } catch {}
  return false;
}


async function rawClickFrame(page, challenge, loc) {
  const frameEl = await challenge.frameElement();
  const fb = await frameEl.boundingBox();
  const b = await loc.boundingBox().catch(() => null);
  if (!fb || !b) return false;
  await page.mouse.move(fb.x + b.x + b.width / 2, fb.y + b.y + b.height / 2, { steps: 4 });
  await page.mouse.down();
  await sleep(rnd(30, 70));
  await page.mouse.up();
  return true;
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
  // vision-capable free-pool models; rotation = resilience against per-model throttling
  const FREE_VISION = [
    'free/gpt-6-luna',
    'free/gemini-3.8-flash',
    'free/qwen-3.8-max',
    'free/kimi-k3',
  ];
  const models = FREE_VISION.includes(model) ? ['free/gpt-6-luna', ...FREE_VISION] : [model];
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
        // after VERIFY the bframe may close and reopen with a NEW frame object;
        // poll for a live bframe whose grid actually re-rendered (up to ~20s)
        if (round > 1) {
          let refound = false;
          for (let w = 0; w < 40 && !refound; w++) {
            const f = page.frames().find((fr) => fr.url().includes('api2/bframe') && !fr.isDetached());
            if (f) {
              challenge = f;
              try {
                const bodyT = await f.locator('body').innerText().catch(() => '');
                if (/verification expired/i.test(bodyT)) continue; // dead frame - keep polling
                const tiles = await f.locator('.rc-image-tile-wrapper').count().catch(() => 0);
                if (tiles >= 4) { refound = true; break; } // real grid, not an empty container
              } catch {}
            }
            await sleep(500);
          }
          log.push(`r${round}:refound=${refound}`);
          if (!refound && await anchorChecked(anchor)) { solved = true; break; }
        }
        const imgLoc = await findImageLoc(challenge);
        try { await imgLoc.waitFor({ state: 'visible', timeout: 15000 }); } catch {}
        const rendered = await waitTileRender(challenge, imgLoc); // tiles fade in 5-7s
        if (!rendered) {
          const nTiles = await challenge.locator('.rc-image-tile-wrapper').count().catch(() => 0);
          log.push(`r${round}:not-rendered:tiles=${nTiles}`);
          await sleep(rnd(1200, 2000));
          challengeStart = Date.now();
          continue; // no grid -> never send a blank image to the vision model
        }
        await waitAllDeselected(challenge); // never judge while any tile is still checkmarked

        // unusual-traffic / expiry checks
        const bodyTxt = await challenge.locator('body').innerText().catch(() => '');
        if (/unusual traffic/i.test(bodyTxt)) throw new Error('blocked-unusual-traffic');
        if (await isExpired(challenge) || Date.now() - challengeStart > challengeDeadlineMs) {
          const why = (await isExpired(challenge)) ? 'expired' : 'deadline';
          log.push(`r${round}:${why}`);
          const reload = challenge.locator('#recaptcha-reload-button, .rc-button-reload').first();
          const clicked = await rawClickFrame(page, challenge, reload).catch(() => false);
          if (!clicked) {
            // reload button unreachable -> nuke the whole widget: uncheck + recheck the anchor
            await anchor.locator('#recaptcha-anchor').click({ delay: rnd(40, 100) }).catch(() => {});
            await sleep(1200);
            await anchor.locator('#recaptcha-anchor').click({ delay: rnd(40, 100) }).catch(() => {});
          }
          await sleep(rnd(2000, 3000));
          challengeStart = Date.now();
          continue;
        }

        // the actual task text, e.g. "Select all images with traffic lights"
        const instruction = await challenge
          .locator('.rc-imageselect-instructions .rc-imageselect-desc-wrapper, .rc-imageselect-desc-wrapper, .instructions')
          .first().innerText().catch(() => '');

        // full-page screenshot + crop; if the crop is blank, give the tiles one more
        // render window before asking the model (protects the vision budget)
        const vp = page.viewportSize(); const pageW = vp.width, pageH = vp.height;
        let pageBuf = await page.screenshot({ type: 'png', animations: 'disabled' });
        let shot = pageBuf;
        let shotW = pageW, shotH = pageH;
        try {
          const bb = await imgLoc.boundingBox();
          if (bb) {
            const gx = Math.max(0, Math.round(bb.x)), gy = Math.max(0, Math.round(bb.y));
            const gw = Math.min(pageW - gx, Math.round(bb.width)), gh = Math.min(pageH - gy, Math.round(bb.height));
            shot = await sharpCrop(pageBuf, gx, gy, gw, gh);
            shotW = gw; shotH = gh;
            if (shotIsBlank(shot)) {
              await sleep(4000);
              pageBuf = await page.screenshot({ type: 'png', animations: 'disabled' });
              shot = await sharpCrop(pageBuf, gx, gy, gw, gh);
            }
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

        // FULL-GRID JUDGE: one call, tiles array back (model needs context to identify
        // partial objects in small tiles). Click centers computed from DOM tile boxes.
        const c = cols || 3, r = rows || 3;
        const instructionShort = (instruction || '').replace(/\s+/g, ' ').replace(/Click verify.*$/i, '').replace(/If there are none.*$/i, '').trim();
        const gridPrompt = [
          `The challenge asks: "${instructionShort}".`,
          `The image is a ${c}x${r} grid of ${c * r} photo tiles, indexed 0-${c * r - 1} row-major (0 = top-left).`,
          'Tiles may look distorted (posterized/noisy) on purpose - judge the content anyway.',
          'A tile matches if ANY significant part of the requested object is in it (wheels, bumpers, fragments count).',
          'Ignore tiles already marked with a blue checkmark badge.',
          `Reply ONLY JSON: {"tiles":[${c * r} booleans, row-major]}`,
        ].join('\n');
        let picked = [];
        let mUsed = '';
        for (let attempt = 0; attempt < Math.min(3, models.length); attempt++) {
          const mm = models[(round - 1 + attempt) % models.length];
          try {
            const res = await fetch(APINEX_URL, {
              method: 'POST',
              headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ model: mm, temperature: 0, max_tokens: 300, messages: [{ role: 'user', content: [
                { type: 'text', text: gridPrompt },
                { type: 'image_url', image_url: { url: 'data:image/png;base64,' + shot.toString('base64') } } ] }] }),
              signal: AbortSignal.timeout(60000),
            });
            const t = await res.text();
            let j; try { j = JSON.parse(t); } catch { continue; }
            const p = parseJsonLoose((j?.choices?.[0]?.message?.content || '').trim());
            if (p && Array.isArray(p.tiles) && p.tiles.length === c * r) {
              mUsed = mm;
              p.tiles.forEach((v, i) => {
                if (v === true) picked.push({ idx: i });
              });
              try {
                fs.mkdirSync('/tmp/rcdebug', { recursive: true });
                fs.writeFileSync(`/tmp/rcdebug/r${round}.json`, JSON.stringify({ instruction, raw: (j?.choices?.[0]?.message?.content || '').slice(0, 300), tiles: p.tiles }));
                fs.writeFileSync(`/tmp/rcdebug/r${round}-crop.png`, shot);
              } catch {}
              break;
            }
          } catch {}
        }
        // DOM tile boxes -> click exact centers (page coords)
        let tileBoxes = [];
        try {
          const tilesLoc = challenge.locator('.rc-image-tile-wrapper');
          const n = await tilesLoc.count();
          for (let i = 0; i < n; i++) {
            const b = await tilesLoc.nth(i).boundingBox().catch(() => null);
            if (b) tileBoxes.push(b);
          }
        } catch {}
        const clicks = picked.map((p) => {
          const b = tileBoxes[p.idx];
          if (b) return { pageX: Math.round(b.x + b.width / 2), pageY: Math.round(b.y + b.height / 2) };
          const ix = p.idx % c, iy = Math.floor(p.idx / c);
          return { pageX: null, pageY: null, relX: ((ix + 0.5) / c) * 1000, relY: ((iy + 0.5) / r) * 1000 };
        });
        log.push(`r${round}:model=${mUsed || 'none'}:matched=${picked.length}/${c * r}`);

        // the challenge can expire DURING the vision calls - verify state before acting
        if (await isExpired(challenge)) {
          log.push(`r${round}:expired-mid`);
          const reload = challenge.locator('#recaptcha-reload-button, .rc-button-reload').first();
          const clicked = await rawClickFrame(page, challenge, reload).catch(() => false);
          if (!clicked) {
            await anchor.locator('#recaptcha-anchor').click({ delay: rnd(40, 100) }).catch(() => {});
            await sleep(1200);
            await anchor.locator('#recaptcha-anchor').click({ delay: rnd(40, 100) }).catch(() => {});
          }
          await sleep(rnd(2000, 3000));
          challengeStart = Date.now();
          continue;
        }
        // human-ish pacing; clicks at exact tile centers (page coords)
        for (let ci = 0; ci < clicks.length; ci++) {
          if (ci === 0) await sleep(800);
          const cc = clicks[ci];
          if (cc.pageX != null) {
            const pg = challenge.page();
            await pg.mouse.move(cc.pageX, cc.pageY, { steps: 4 });
            await pg.mouse.down();
            await sleep(rnd(30, 70));
            await pg.mouse.up();
            await sleep(150);
          } else {
            await clickAt(challenge, imgLoc, cc.relX, cc.relY);
          }
          if (ci < clicks.length - 1) await sleep(1000);
        }
        // dynamic grids replace the clicked tile with a fresh image after ~5-7s
        await waitTileReplaced(challenge);
        await sleep(rnd(700, 1500));

        // no matching tile -> SKIP; otherwise VERIFY
        if (clicks.length === 0) {
          const skip = challenge.locator('.rc-imageselect-button-skip, button:has-text("SKIP")').first();
          if (await skip.isVisible().catch(() => false)) await rawClickFrame(page, challenge, skip);
          else await rawClickFrame(page, challenge, challenge.locator('.rc-imageselect-verify-button, button:has-text("VERIFY")').first()).catch(() => {});
        } else {
          await rawClickFrame(page, challenge, challenge.locator('.rc-imageselect-verify-button, button:has-text("VERIFY")').first()).catch(() => {});
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
        await waitAllDeselected(challenge); // old checkmarks must be gone first
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
