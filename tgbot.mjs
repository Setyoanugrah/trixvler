import fs from 'node:fs';
import { solve } from './trixvler.mjs';

const TOKEN = process.env.TG_BOT_TOKEN || '';
const API = `https://api.telegram.org/bot${TOKEN}`;
const APINEX_KEY = process.env.APINEX_KEY || '';
const DUMP = '/tmp/tgbot';
fs.mkdirSync(DUMP, { recursive: true });

let offset = 0;

async function tg(method, body) {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  return res.json();
}

async function reply(chatId, text) {
  await tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML' });
}

async function downloadFile(fileId, dest) {
  const f = await tg('getFile', { file_id: fileId });
  if (!f?.result?.file_path) throw new Error('getFile failed');
  const url = `https://api.telegram.org/file/bot${TOKEN}/${f.result.file_path}`;
  const res = await fetch(url);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  return buf;
}

async function handleUpdate(u) {
  const msg = u.message || u.edited_message;
  if (!msg) return;
  const chatId = msg.chat?.id;
  if (!chatId) return;

  // photo (largest size) or image document
  let fileId = null;
  if (Array.isArray(msg.photo) && msg.photo.length) {
    fileId = msg.photo[msg.photo.length - 1].file_id;
  } else if (msg.document && /^image\/(png|jpeg)/.test(msg.document.mime_type || '')) {
    fileId = msg.document.file_id;
  }

  if (!fileId) {
    if (msg.text === '/start') {
      await reply(chatId, '<b>IconCaptcha AI Solver</b>\nKirim PNG/JPG challenge (photo atau file).\nMode: <b>AI only</b> (local CV di-skip).\nBalasan: JSON + index tile yang harus dipilih.');
    } else {
      await reply(chatId, 'Kirim gambar challenge (photo atau file PNG/JPG).');
    }
    return;
  }

  const t0 = Date.now();
  const statusMsg = await tg('sendMessage', { chat_id: chatId, text: '⏳ AI solving...' });
  try {
    const buf = await downloadFile(fileId, `${DUMP}/${msg.message_id}.png`);
    // FORCE AI: mode 'ai' skips local answer, only aiFallback result is used
    const out = await solve(buf, { mode: 'ai', apiKey: APINEX_KEY, useAI: true });
    const ms = Date.now() - t0;

    if (out.source !== 'ai') {
      // model failed validation or returned nothing - no local fallback allowed
      const reason = out.aiFailReason || 'no-valid-ai-answer';
      await tg('editMessageText', {
        chat_id: chatId, message_id: statusMsg?.result?.message_id,
        text: `❌ <b>AI failed</b> (${reason})\nCoba kirim ulang gambar yang lebih jelas.`,
        parse_mode: 'HTML',
      });
      return;
    }

    const lines = [
      '✅ <b>AI SOLVER RESULT</b>',
      '',
      `<b>index:</b> ${out.index == null ? 'null (tie/ambiguous)' : out.index}`,
      `<b>counts:</b> ${JSON.stringify(out.counts || [])}`,
      `<b>groups:</b> ${JSON.stringify(out.groups || [])}`,
      `<b>confidence:</b> ${out.confidence ?? '-'}`,
      `<b>agree:</b> ${out.agree === true ? '✓ model-consistent' : out.agree === false ? '⚠ counts-overridden' : '-'}`,
      `<b>tie:</b> ${out.tie ? 'yes' : 'no'}`,
      `<b>time:</b> ${ms}ms`,
    ];
    if (Array.isArray(out.tiles) && out.tiles.length) {
      lines.push(`<b>types:</b> ${JSON.stringify(out.tiles).slice(0, 200)}`);
    }
    await tg('editMessageText', {
      chat_id: chatId, message_id: statusMsg?.result?.message_id,
      text: lines.join('\n'), parse_mode: 'HTML',
    });
  } catch (e) {
    await tg('editMessageText', {
      chat_id: chatId, message_id: statusMsg?.result?.message_id,
      text: `❌ Error: ${String(e.message || e).slice(0, 200)}`,
    }).catch(() => {});
  }
}

async function loop() {
  for (;;) {
    try {
      const r = await tg('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] });
      if (r?.ok && Array.isArray(r.result)) {
        for (const u of r.result) {
          offset = u.update_id + 1;
          await handleUpdate(u).catch((e) => console.error('handle err', e.message));
        }
      } else {
        await new Promise((r2) => setTimeout(r2, 3000));
      }
    } catch (e) {
      console.error('poll err', e.message);
      await new Promise((r2) => setTimeout(r2, 5000));
    }
  }
}

console.log('tg iconcaptcha AI bot polling...');
loop();
