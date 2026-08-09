#!/usr/bin/env tsx
/**
 * Find a NVIDIA NIM model that actually answers quickly with the configured key.
 *
 * Context: the key is valid (GET /models returns 200 with 100 models) but the
 * configured model never returns within 60 s. This script times a real completion
 * against several candidates so NVIDIA_MODEL can be set to something that works
 * rather than guessed at.
 *
 * Run: npx tsx scripts/check-nvidia-models.ts
 */
import './load-env';

const KEY = process.env.NVIDIA_API_KEY;
const BASE = (process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1').replace(/\/+$/, '');

const CANDIDATES = [
  process.env.NVIDIA_MODEL || 'z-ai/glm-5.2',
  'meta/llama-3.1-8b-instruct',
  'meta/llama-3.3-70b-instruct',
  'mistralai/mistral-7b-instruct-v0.3',
  'microsoft/phi-3-mini-4k-instruct',
  'qwen/qwen2.5-7b-instruct',
  'nvidia/llama-3.1-nemotron-70b-instruct',
];

async function timeModel(model: string, timeoutMs: number): Promise<string> {
  const started = Date.now();
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: 'Reply with compact JSON only.' },
          { role: 'user', content: 'Return exactly: [{"ok":true}]' },
        ],
        max_tokens: 40,
        temperature: 1,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    const ms = Date.now() - started;
    if (!res.ok) return `HTTP ${res.status} in ${ms}ms — ${text.slice(0, 110)}`;
    let reply = '';
    try {
      reply = JSON.parse(text).choices?.[0]?.message?.content ?? '';
    } catch { /* ignore */ }
    return `OK in ${ms}ms — ${JSON.stringify(reply.trim().slice(0, 60))}`;
  } catch (err) {
    return `FAILED after ${Date.now() - started}ms — ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function main() {
  if (!KEY) {
    console.log('NVIDIA_API_KEY is not set.');
    return;
  }
  console.log(`\nTiming ${CANDIDATES.length} candidate models against ${BASE}\n`);

  const available = new Set<string>();
  try {
    const res = await fetch(`${BASE}/models`, { headers: { Authorization: `Bearer ${KEY}` } });
    if (res.ok) {
      const json = await res.json();
      for (const m of json.data || []) if (m?.id) available.add(m.id);
    }
  } catch { /* ignore */ }

  for (const model of [...new Set(CANDIDATES)]) {
    const listed = available.size === 0 ? '?' : available.has(model) ? 'listed' : 'NOT listed';
    // 25 s ceiling: anything slower than this is unusable for batch tagging anyway.
    const outcome = await timeModel(model, 25000);
    const mark = outcome.startsWith('OK') ? 'ok  ' : 'fail';
    console.log(`[${mark}] ${model.padEnd(42)} (${listed}) ${outcome}`);
  }

  console.log('\nSet the fastest working model as NVIDIA_MODEL in .env.local\n');
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
