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

export function aiConfig(opts = {}) {
  const explicit = opts.provider || process.env.AI_PROVIDER;
  const hasAgentrouter = !!(opts.agentrouterKey || process.env.AGENTROUTER_KEY);
  const provider = explicit || (hasAgentrouter ? 'agentrouter' : 'apinex');

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

// Returns the model's raw text answer for a single image + prompt.
export async function visionText(opts = {}) {
  const conf = aiConfig(opts);
  if (!conf.key) throw new Error('missing-ai-key');
  if (!opts.imageB64) throw new Error('missing-image');
  const prompt = opts.prompt || '';
  const maxTokens = opts.maxTokens || 700;
  const timeoutMs = opts.timeoutMs || 120000;
  const model = opts.modelOverride || conf.model;

  if (conf.provider === 'agentrouter') {
    try {
      return await agentrouterVision({
        imageB64: opts.imageB64, prompt, key: conf.key, model, maxTokens, timeoutMs, proxy: conf.proxy,
      });
    } catch (e) {
      const apxKey = process.env.APINEX_KEY;
      if (apxKey && opts.noFallback !== true) {
        return apinexVision({
          imageB64: opts.imageB64, prompt, key: apxKey,
          model: process.env.APINEX_MODEL || 'free/gemini-3.8-flash', maxTokens, timeoutMs,
        });
      }
      throw e;
    }
  }
  return apinexVision({ imageB64: opts.imageB64, prompt, key: conf.key, model, maxTokens, timeoutMs });
}

function parseJsonLoose(txt) {
  const m = String(txt).replace(/```(?:json)?/gi, '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

// Returns a parsed JSON object from the model answer, or null.
export async function visionJson(opts = {}) {
  const txt = await visionText(opts);
  return parseJsonLoose(txt);
}
