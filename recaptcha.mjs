import http from 'node:http';
import fs from 'node:fs';
import { chromium } from 'patchright';

import { PNG } from 'pngjs';
import { visionJson, aiConfig } from './ai.mjs';

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

function visionPrompt(instruction, cols, rows) {
  const n = cols * rows;
  return [
    'You are analyzing a screenshot of a reCAPTCHA image challenge.',
    `The challenge asks: "${instruction || 'select all images matching the requested category'}".`,
    `The image is a ${cols}x${rows} grid of ${n} photo tiles, indexed 0-${n - 1} row-major (0 = top-left, across each row).`,
    'Tiles may look distorted (posterized/noisy) on purpose - judge the content anyway.',
    'A tile matches if ANY part of the requested object is visible in it - including PARTIAL objects at tile edges (a few stripes of a crosswalk, a wheel of a car, a corner of a sign).',
    'CRITICAL: Google deliberately puts partial/edge-fragment views of the object in edge tiles - look closely at every tile boundary for fragments of the pattern/texture associated with the object.',
    'Do NOT select tiles that are ambiguous, blurred, mostly background, or where you only suspect the object might be.',
    'Do NOT select tiles showing only background: grass, sky, road, water, walls, fences.',
    'Ignore tiles already marked with a blue/white checkmark overlay.',
    '',
    'Return ONLY JSON, exactly:',
    `{"tiles":[${Array(n).fill('true|false').join(',')}]}  -> e.g. {"tiles":[true,false,false,true,false,false,false,false,true]}`,
    `The array MUST have exactly ${n} boolean entries, entry i = whether tile i should be selected.`,
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
      const ok = await challenge.locator('.rc-image-tile-wrapper img').evaluateAll(
        (els) => els.length > 0 && els.every((e) => e.complete && e.naturalWidth > 10));
      if (ok) return true;
    } catch {}
  }
  return false;
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
      if (after.length && after.some((v, i) => v !== before[i])) return true;
    }
  } catch {}
  return false;
}

async function rawClickFrame(page, challenge, loc) {
  const b = await loc.boundingBox().catch(() => null);
  if (!b) return false;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 4 });
  await page.mouse.down();
  await sleep(rnd(30, 70));
  await page.mouse.up();
  return true;
}

async function clickVerify(challenge) {
  try {
    return await challenge.evaluate(() => {
      const b = document.getElementById('recaptcha-verify-button');
      if (!b) return false;
      b.click();
      return true;
    });
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
  const conf = aiConfig(opts);
  if (!conf.key) throw new Error('missing-ai-key');
  const models = Array.isArray(opts.models) && opts.models.length
    ? opts.models
    : conf.provider === 'agentrouter'
      ? ['gpt-6.1-sol', 'gpt-5.6-sol']
      : ['free/gemini-3.8-flash', 'free/qwen-3.8-max', 'free/gpt-6-luna'];

  const challengeDeadlineMs = 150000;
  let challengeStart = Date.now();
  const maxRounds = Math.min(Number(opts.maxRounds) || 8, 15);
  const t0 = Date.now();
  const log = [];

  let host = null;
  if (opts.pageurl) {
    try { host = new URL(opts.pageurl).hostname; } catch { throw new Error('bad-pageurl'); }
  }
  // host-mapping makes the widget believe it runs on the target domain (for
  // domain-locked sitekeys). Never map google.com itself: api.js is loaded from
  // www.google.com and would be hijacked by our local widget server.
  const mapHost = !!host && !/(^|\.)google\.com$/i.test(host);

  const widget = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(challengeHtml(sitekey));
  });
  await new Promise((r) => widget.listen(0, '127.0.0.1', r));
  const wport = widget.address().port;

  const browser = await chromium.launch({
    headless: false,
    args: mapHost
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
    const navUrl = mapHost ? `http://${host}/` : `http://127.0.0.1:${wport}/`;
    await page.goto(navUrl, { waitUntil: 'load', timeout: 30000 });

    let anchor = null;
    for (let i = 0; i < 40 && !anchor; i++) {
      anchor = page.frames().find((f) => f.url().includes('api2/anchor'));
      if (!anchor) await sleep(500);
    }
    if (!anchor) throw new Error('anchor-iframe-timeout');
    await anchor.waitForSelector('#recaptcha-anchor', { timeout: 20000 });
    log.push('anchor-ready');

    await anchor.locator('#recaptcha-anchor').click({ delay: rnd(40, 120) });

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
        if (round > 1) {
          let refound = false;
          for (let w = 0; w < 40 && !refound; w++) {
            const f = page.frames().find((fr) => fr.url().includes('api2/bframe') && !fr.isDetached());
            if (f) {
              challenge = f;
              try {
                const bodyT = await f.locator('body').innerText().catch(() => '');
                if (/verification expired/i.test(bodyT)) continue;
                const tiles = await f.locator('.rc-image-tile-wrapper').count().catch(() => 0);
                if (tiles >= 4) { refound = true; break; }
              } catch {}
            }
            await sleep(500);
          }
          log.push(`r${round}:refound=${refound}`);
          if (!refound && await anchorChecked(anchor)) { solved = true; break; }
        }
        const imgLoc = await findImageLoc(challenge);
        try { await imgLoc.waitFor({ state: 'visible', timeout: 15000 }); } catch {}
        const rendered = await waitTileRender(challenge, imgLoc);
        if (!rendered) {
          const nTiles = await challenge.locator('.rc-image-tile-wrapper').count().catch(() => 0);
          const diag = await challenge.evaluate(() => {
            const imgs = [...document.querySelectorAll('.rc-image-tile-wrapper img')];
            const all = [...document.querySelectorAll('img')];
            return {
              wrappers: document.querySelectorAll('.rc-image-tile-wrapper').length,
              wrapperImgs: imgs.length,
              anyImgs: all.length,
              ready: imgs.filter((e) => e.complete && e.naturalWidth > 10).length,
              first: (all[0]?.outerHTML || '').slice(0, 140),
            };
          }).catch(() => null);
          log.push(`r${round}:not-rendered:tiles=${nTiles}:diag=${JSON.stringify(diag)}`);
          await sleep(rnd(1200, 2000));
          challengeStart = Date.now();
          continue;
        }
        await waitAllDeselected(challenge);

        const bodyTxt = await challenge.locator('body').innerText().catch(() => '');
        if (/unusual traffic/i.test(bodyTxt)) throw new Error('blocked-unusual-traffic');
        if (await isExpired(challenge) || Date.now() - challengeStart > challengeDeadlineMs) {
          const why = (await isExpired(challenge)) ? 'expired' : 'deadline';
          log.push(`r${round}:${why}`);
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

        let cols = 0, rows = 0;
        try {
          const tiles = await challenge.locator('.rc-image-tile-wrapper').count();
          if (tiles === 9) { cols = 3; rows = 3; }
          else if (tiles === 16) { cols = 4; rows = 4; }
          else if (tiles === 4) { cols = 2; rows = 2; }
        } catch {}
        const c = cols || 3, r = rows || 3;

        // dynamic grids replace each clicked tile with a fresh image; keep going
        // until a pass finds no matches, then press the verify button once.
        let innerRounds = 0;
        for (innerRounds = 1; innerRounds <= 10; innerRounds++) {
          if (Date.now() - challengeStart > challengeDeadlineMs) break;
          await waitTileRender(challenge, imgLoc);
          await waitAllDeselected(challenge);

          const instructionStrong = await challenge
            .locator('.rc-imageselect-desc-wrapper strong, .rc-imageselect-desc-no-canonical strong')
            .first().innerText().catch(() => '');
          const instructionFull = await challenge
            .locator('.rc-imageselect-desc-wrapper, .rc-imageselect-desc-no-canonical')
            .first().innerText().catch(() => '');
          const instruction = (instructionStrong || instructionFull || '').replace(/\s+/g, ' ').trim();

          const vp = page.viewportSize(); const pageW = vp.width, pageH = vp.height;
          let pageBuf = await page.screenshot({ type: 'png', animations: 'disabled' });
          let shot = pageBuf;
          try {
            const bb = await imgLoc.boundingBox();
            if (bb) {
              const gx = Math.max(0, Math.round(bb.x)), gy = Math.max(0, Math.round(bb.y));
              const gw = Math.min(pageW - gx, Math.round(bb.width)), gh = Math.min(pageH - gy, Math.round(bb.height));
              shot = await sharpCrop(pageBuf, gx, gy, gw, gh);
              if (shotIsBlank(shot)) {
                await sleep(4000);
                pageBuf = await page.screenshot({ type: 'png', animations: 'disabled' });
                shot = await sharpCrop(pageBuf, gx, gy, gw, gh);
              }
            }
          } catch {}

          const gridPrompt = visionPrompt(instruction, c, r);
          let picked = [];
          let mUsed = '';
          for (let attempt = 0; attempt < Math.min(3, models.length); attempt++) {
            const mm = models[(round - 1 + attempt) % models.length];
            try {
              const p = await visionJson({
                imageB64: shot.toString('base64'),
                prompt: gridPrompt,
                ...opts,
                modelOverride: mm,
                maxTokens: 2000,
                timeoutMs: 90000,
              });
              if (p && Array.isArray(p.tiles) && p.tiles.length === c * r) {
                mUsed = mm;
                p.tiles.forEach((v, i) => {
                  if (v === true || v === 1 || v === 'true' || v === 'yes') picked.push({ idx: i });
                });
                try {
                  fs.mkdirSync('/tmp/rcdebug', { recursive: true });
                  fs.writeFileSync(`/tmp/rcdebug/r${round}-${innerRounds}.json`, JSON.stringify({ instruction, tiles: p.tiles }));
                  fs.writeFileSync(`/tmp/rcdebug/r${round}-${innerRounds}.png`, shot);
                } catch {}
                break;
              }
            } catch {}
          }
          log.push(`r${round}.${innerRounds}:model=${mUsed || 'none'}:matched=${picked.length}/${c * r}`);

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
            break;
          }

          if (picked.length === 0) break;

          let tileBoxes = [];
          try {
            const tilesLoc = challenge.locator('.rc-image-tile-wrapper');
            const n = await tilesLoc.count();
            for (let i = 0; i < n; i++) {
              const b = await tilesLoc.nth(i).boundingBox().catch(() => null);
              if (b) tileBoxes.push(b);
            }
          } catch {}

          for (let ci = 0; ci < picked.length; ci++) {
            const b = tileBoxes[picked[ci].idx];
            if (b) {
              const pg = challenge.page();
              await pg.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 4 });
              await pg.mouse.down();
              await sleep(rnd(30, 70));
              await pg.mouse.up();
            } else {
              const ix = picked[ci].idx % c, iy = Math.floor(picked[ci].idx / c);
              await clickAt(challenge, imgLoc, ((ix + 0.5) / c) * 1000, ((iy + 0.5) / r) * 1000);
            }
            if (ci < picked.length - 1) await sleep(rnd(700, 1200));
          }

          const replaced = await waitTileReplaced(challenge);
          await sleep(rnd(600, 1200));
          if (!replaced) break;
        }

        const clicked = await clickVerify(challenge);
        if (!clicked) await rawClickFrame(page, challenge, challenge.locator('#recaptcha-verify-button').first()).catch(() => false);
        log.push(`r${round}:verify-clicked=${clicked}`);

        let solvedNow = false;
        for (let i = 0; i < 24; i++) {
          if (await anchorChecked(anchor)) { solvedNow = true; break; }
          const bt = await challenge.locator('body').innerText().catch(() => '');
          if (/unusual traffic/i.test(bt)) throw new Error('blocked-unusual-traffic');
          await sleep(500);
        }
        if (solvedNow) { solved = true; break; }
        await sleep(rnd(800, 1600));
        await waitAllDeselected(challenge);
        await waitTileRender(challenge, imgLoc);
      }
      if (!solved) throw new Error('challenge-not-solved rounds=' + rounds + ' log=' + log.join('|'));
    }
    if (!solved) throw new Error('challenge-timeout');

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
    if (typeof solveRecaptcha !== 'function') { console.error('selftest FAIL'); process.exit(1); }
    if (typeof DEMO_SITEKEY !== 'string') { console.error('selftest FAIL'); process.exit(1); }
    console.log('selftest OK (recaptcha.mjs loads, exports intact)');
    process.exit(0);
  }
  const sitekey = process.argv[2] || DEMO_SITEKEY;
  const out = await solveRecaptcha({ sitekey, pageurl: process.argv[3] });
  console.log(JSON.stringify(out, null, 2));
}
