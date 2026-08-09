#!/usr/bin/env tsx
/**
 * Diagnose the LLM provider chain: which providers are configured, whether their
 * credentials work, and how long a real tagging batch takes.
 *
 * Run: npx tsx scripts/check-llm.ts
 */
import './load-env';

const UA = 'PulseBLR/1.0';

interface Provider {
  name: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}

const PROVIDERS: Provider[] = [
  {
    name: 'IBM ICA',
    baseUrl: process.env.ICA_BASE_URL,
    model: process.env.ICA_MODEL,
    apiKey: process.env.ICA_API_KEY,
  },
  {
    name: 'NVIDIA NIM',
    baseUrl: process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1',
    model: process.env.NVIDIA_MODEL || 'meta/llama-3.1-8b-instruct',
    apiKey: process.env.NVIDIA_API_KEY,
  },
];

function mask(key?: string): string {
  if (!key) return '(unset)';
  if (key.length < 12) return '(too short?)';
  return `${key.slice(0, 6)}…${key.slice(-4)} (${key.length} chars)`;
}

async function probeModels(p: Provider): Promise<void> {
  if (!p.baseUrl || !p.apiKey) return;
  const url = `${p.baseUrl.replace(/\/+$/, '')}/models`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${p.apiKey}`, 'User-Agent': UA },
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    if (res.ok) {
      try {
        const json = JSON.parse(text);
        const ids = (json.data || []).map((m: { id?: string }) => m.id).filter(Boolean);
        console.log(`   GET /models  → ${res.status}, ${ids.length} model(s)`);
        const match = ids.find((id: string) => id === p.model);
        console.log(
          `   configured model "${p.model}" ${match ? 'IS' : 'is NOT'} in the list` +
            (!match && ids.length > 0 ? `; e.g. ${ids.slice(0, 4).join(', ')}` : '')
        );
      } catch {
        console.log(`   GET /models  → ${res.status}, non-JSON body`);
      }
    } else {
      console.log(`   GET /models  → ${res.status}: ${text.slice(0, 160)}`);
    }
  } catch (err) {
    console.log(`   GET /models  → ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function probeChat(p: Provider): Promise<void> {
  if (!p.baseUrl || !p.apiKey || !p.model) return;
  const url = `${p.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${p.apiKey}`,
        'Content-Type': 'application/json',
        'User-Agent': UA,
      },
      body: JSON.stringify({
        model: p.model,
        messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
        max_tokens: 10,
        temperature: 1,
      }),
      signal: AbortSignal.timeout(60000),
    });
    const text = await res.text();
    const ms = Date.now() - started;
    if (res.ok) {
      let reply = '';
      try {
        reply = JSON.parse(text).choices?.[0]?.message?.content ?? '';
      } catch { /* ignore */ }
      console.log(`   POST /chat/completions → ${res.status} in ${ms}ms, reply=${JSON.stringify(reply.trim().slice(0, 40))}`);
    } else {
      console.log(`   POST /chat/completions → ${res.status} in ${ms}ms: ${text.slice(0, 220)}`);
    }
  } catch (err) {
    console.log(
      `   POST /chat/completions → FAILED after ${Date.now() - started}ms: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

async function main() {
  console.log('\nLLM provider diagnostics\n');

  for (const p of PROVIDERS) {
    const configured = Boolean(p.apiKey && p.baseUrl && p.model);
    console.log(`── ${p.name} ${configured ? '' : '(incomplete config — skipped by the tagger)'}`);
    console.log(`   base  ${p.baseUrl || '(unset)'}`);
    console.log(`   model ${p.model || '(unset)'}`);
    console.log(`   key   ${mask(p.apiKey)}`);
    if (configured) {
      await probeModels(p);
      await probeChat(p);
    }
    console.log('');
  }

  console.log(`── Anthropic\n   key   ${mask(process.env.ANTHROPIC_API_KEY)}\n`);

  // Real end-to-end check through the actual tagger.
  const { tagEvents } = await import('../lib/llm/tagger');
  const started = Date.now();
  const results = await tagEvents([
    {
      title: 'Bangalore Kubernetes Meetup #42',
      description: 'Deep dive into cluster autoscaling and eBPF observability. Pizza after the talks.',
      venue: 'Ecospace, Outer Ring Road',
    },
    {
      title: 'Fred again.. live in Bengaluru',
      description: 'An electronic music night at Phoenix Marketcity.',
      venue: 'Phoenix Marketcity, Whitefield',
    },
  ]);
  console.log(`Tagger end-to-end: ${Date.now() - started}ms`);
  for (const r of results) {
    console.log(
      `   categories=${r.categories.join('|')} format=${r.format} food=${r.hasFood} tech=${r.isTechEvent} conf=${r.confidence}`
    );
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
