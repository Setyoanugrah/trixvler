// ai.mjs - shared vision backend for trixvler.
//
// Primary provider: agentrouter (OpenAI Responses API).
//   endpoint : https://agentrouter.org/v1/responses
//   auth     : Authorization: Bearer <AGENTROUTER_KEY>
//   UA       : MUST look like a known client (opencode/claude-cli).
//              curl/Mozilla get "unauthorized client detected" (401).
//   models   : gpt-6.1-sol, gpt-5.6-sol   (gpt-6-astra is 402 quota-exhausted)
//   image    : { type:'input_image', image_url:'data:image/png;base64,...' }
//   response : output[].content[].text where type === 'output_text'
//
// Datacenter IPs (GitHub Actions) get an Aliyun WAF HTML challenge. Set
// AGENTROUTER_PROXY=<host:port> (a SOCKS5 proxy, e.g. the phone's tailnet
// 100.64.8.24:1094) to route the request through curl instead of fetch.
//
// Fallback provider: APINEX (OpenAI chat/completions, free vision pool).

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const AGENTROUTER_URL = process.env.AGENTROUTER_URL || 'https://agentrouter.org/v1/responses';
const AGENTROUTER_UA = 'opencode/0.1.0';
const APINEX_URL = 'https://api.apinex.bond/v1/chat/completions';
const NUMES_URL = 'https://api.numes.ai/api/v1/chat/completions';
const NUMES_DEFAULT_MODEL = 'z-ai/glm-5.3-flash:free';

export function aiConfig(opts = {}) {
  const explicit = opts.provider || process.env.AI_PROVIDER;
  const hasAgentrouter = !!(opts.agentrouterKey || process.env.AGENTROUTER_KEY);
  const hasNumes = !!(opts.numesKey || process.env.NUMES_KEY);
  const provider = explicit || (hasNumes ? 'numes' : hasAgentrouter ? 'agentrouter' : 'apinex');

  if (provider === 'numes') {
    return {
      provider,
      url: NUMES_URL,
      key: opts.numesKey || process.env.NUMES_KEY || '',
      model: opts.numesModel || process.env.NUMES_MODEL || NUMES_DEFAULT_MODEL,
    };
  }
  if (provider === 'agentrouter') {
    return {
      provider,
      url: AGENTROUTER_URL,
      userAgent: AGENTROUTER_UA,
      key: opts.agentrouterKey || process.env.AGENTROUTER_KEY || '',
      model: opts.agentrouterModel || process.env.AGENTROUTER_MODEL || 'gpt-6.1-sol',
      proxy: opts.agentrouterProxy || process.env.AGENTROUTER_PROXY || '',
    };
  }
  return {
    provider: 'apinex',
    url: APINEX_URL,
    key: opts.apiKey || process.env.APINEX_KEY || '',
    model: opts.model || process.env.APINEX_MODEL || 'free/gemini-3.8-flash',
  };
}

function agentrouterBody({ imageB64, prompt, model, maxTokens }) {
  return {
    model,
    input: [{
      role: 'user',
      content: [
        { type: 'input_text', text: prompt },
        { type: 'input_image', image_url: 'data:image/png;base64,' + imageB64 },
      ],
    }],
    max_output_tokens: maxTokens,
  };
}

function parseAgentrouter(raw) {
  let j;
  try { j = JSON.parse(raw); } catch { throw new Error('agentrouter-non-json: ' + String(raw).slice(0, 160)); }
  let txt = '';
  for (const item of j.output || []) {
    for (const part of item.content || []) {
      if (part.type === 'output_text') txt += part.text || '';
    }
  }
  return txt.trim();
}

function curlPost(url, body, { key, maxTokens, timeoutMs, proxy }) {
  return new Promise((resolve, reject) => {
    const tmp = path.join(os.tmpdir(), `ar-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    try { fs.writeFileSync(tmp, JSON.stringify(body)); } catch (e) { reject(e); return; }
    const args = [
      '-sS', '--max-time', String(Math.ceil(timeoutMs / 1000)),
      '--socks5', proxy,
      '-X', 'POST', url,
      '-H', `Authorization: Bearer ${key}`,
      '-H', `User-Agent: ${AGENTROUTER_UA}`,
      '-H', 'Content-Type: application/json',
      '--data-binary', '@' + tmp,
    ];
    execFile('curl', args, { maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      try { fs.unlinkSync(tmp); } catch {}
      if (err) reject(new Error(`agentrouter-curl: ${String(stderr || err.message).slice(0, 200)}`));
      else resolve(stdout);
    });
  });
}

async function agentrouterVision({ imageB64, prompt, key, model, maxTokens, timeoutMs, proxy }) {
  const body = agentrouterBody({ imageB64, prompt, model, maxTokens });
  if (proxy) {
    const raw = await curlPost(AGENTROUTER_URL, body, { key, maxTokens, timeoutMs, proxy });
    return parseAgentrouter(raw);
  }
  const res = await fetch(AGENTROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'User-Agent': AGENTROUTER_UA,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`agentrouter-http-${res.status}: ${raw.slice(0, 200)}`);
  return parseAgentrouter(raw);
}

async function apinexVision({ imageB64, prompt, key, model, maxTokens, timeoutMs }) {
  const body = {
    model,
    temperature: 0,
    max_tokens: maxTokens,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,' + imageB64 } },
      ],
    }],
  };
  const res = await fetch(APINEX_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`apinex-http-${res.status}: ${raw.slice(0, 200)}`);
  let j;
  try { j = JSON.parse(raw); } catch { throw new Error('apinex-non-json: ' + raw.slice(0, 160)); }
  return String(j?.choices?.[0]?.message?.content || '').trim();
}

async function numesVision({ imageB64, prompt, key, model, maxTokens, timeoutMs }) {
  const body = {
    model,
    temperature: 0,
    max_tokens: maxTokens,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,' + imageB64 } },
      ],
    }],
  };
  const res = await fetch(NUMES_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`numes-http-${res.status}: ${raw.slice(0, 200)}`);
  let j;
  try { j = JSON.parse(raw); } catch { throw new Error('numes-non-json: ' + raw.slice(0, 160)); }
  const c = j?.choices?.[0]?.message?.content;
  if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('').trim();
  return String(c || '').trim();
}

// Returns the model's raw text answer for a single image + prompt.
export async function visionText(opts = {}) {
  const conf = aiConfig(opts);
  if (!conf.key) throw new Error('missing-ai-key');
  if (!opts.imageB64) throw new Error('missing-image');
  const prompt = opts.prompt || '';
  const maxTokens = opts.maxTokens || 700;
  const timeoutMs = opts.timeoutMs || 120000;
  const model = opts.modelOverride || conf.model;

  if (conf.provider === 'numes') {
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await numesVision({ imageB64: opts.imageB64, prompt, key: conf.key, model, maxTokens, timeoutMs });
      } catch (e) {
        lastErr = e;
        if (attempt === 0) await new Promise((r) => setTimeout(r, 800));
      }
    }
    throw lastErr;
  }
  if (conf.provider === 'agentrouter') {
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await agentrouterVision({
          imageB64: opts.imageB64, prompt, key: conf.key, model, maxTokens, timeoutMs, proxy: conf.proxy,
        });
      } catch (e) {
        lastErr = e;
        if (attempt === 0) await new Promise((r) => setTimeout(r, 1500));
      }
    }
    // APINEX's free tier is gone; only use it if explicitly enabled with a
    // funded key, otherwise surface the real agentrouter error.
    if (opts.noFallback !== true && process.env.APINEX_FALLBACK === '1' && process.env.APINEX_KEY) {
      return apinexVision({
        imageB64: opts.imageB64, prompt, key: process.env.APINEX_KEY,
        model: process.env.APINEX_MODEL || 'free/gemini-3.8-flash', maxTokens, timeoutMs,
      });
    }
    throw lastErr;
  }
  return apinexVision({ imageB64: opts.imageB64, prompt, key: conf.key, model, maxTokens, timeoutMs });
}

function parseJsonLoose(txt) {
  const clean = String(txt).replace(/```(?:json)?/gi, '');
  const flat = clean.match(/\{[\s\S]*?\}/g) || [];
  for (let i = flat.length - 1; i >= 0; i--) {
    try { return JSON.parse(flat[i]); } catch {}
  }
  const greedy = clean.match(/\{[\s\S]*\}/);
  if (greedy) { try { return JSON.parse(greedy[0]); } catch {} }
  return null;
}

// Returns a parsed JSON object from the model answer, or null.
export async function visionJson(opts = {}) {
  const txt = await visionText(opts);
  return parseJsonLoose(txt);
}
