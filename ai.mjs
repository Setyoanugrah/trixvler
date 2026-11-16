// ai.mjs - shared vision backend for trixvler.
//
// Primary provider: agentrouter (OpenAI Responses API).
//   endpoint : https://agentrouter.org/v1/responses
//   auth     : Authorization: Bearer <AGENTROUTER_KEY>
//   UA       : MUST look like a known client (opencode/claude-cli).
//              curl/Mozilla get "unauthorized client detected" (401).
//   models   : gpt-5.6-sol, gpt-6.1-sol   (gpt-6-astra is 402 quota-exhausted)
//   image    : { type:'input_image', image_url:'data:image/png;base64,...' }
//   response : output[].content[].text where type === 'output_text'
//              (reasoning models spend output tokens on reasoning - give headroom)
//
// Fallback provider: APINEX (OpenAI chat/completions, free vision pool).

const AGENTROUTER_URL = 'https://agentrouter.org/v1/responses';
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
    };
  }
  return {
    provider: 'apinex',
    url: APINEX_URL,
    key: opts.apiKey || process.env.APINEX_KEY || '',
    model: opts.model || process.env.APINEX_MODEL || 'free/gemini-3.8-flash',
  };
}

async function agentrouterVision({ imageB64, prompt, key, model, maxTokens, timeoutMs }) {
  const body = {
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
  let j;
  try { j = JSON.parse(raw); } catch { throw new Error('agentrouter-non-json: ' + raw.slice(0, 160)); }
  let txt = '';
  for (const item of j.output || []) {
    for (const part of item.content || []) {
      if (part.type === 'output_text') txt += part.text || '';
    }
  }
  return txt.trim();
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
    return agentrouterVision({ imageB64: opts.imageB64, prompt, key: conf.key, model, maxTokens, timeoutMs });
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
