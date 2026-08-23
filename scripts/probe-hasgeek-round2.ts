#!/usr/bin/env tsx
/**
 * Round 2: is there an ACCOUNT-level feed on HasGeek?
 *
 * The search endpoint returns 336 Bengaluru projects but only 3 upcoming — it is mostly
 * an archive. That is too little to justify an adapter on its own.
 *
 * The Luma adapter solved the same shape of problem by harvesting HOST CALENDARS from the
 * city feed and then scraping each host's own feed, which multiplied coverage (The Product
 * Folks appeared once in the city feed but had 18 events on its own calendar). If HasGeek
 * accounts expose their upcoming projects the same way, then Rust Bangalore, The Fifth
 * Elephant, Rootconf, Bengaluru Systems Meetup and friends become durable sources that
 * keep producing rather than a one-off archive read.
 *
 * Read-only.
 *
 * Run: npx tsx scripts/probe-hasgeek-round2.ts
 */
import './load-env';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

/** Accounts harvested from the search results, highest-value first. */
const ACCOUNTS = [
  'fifthelephant',
  'rootconf',
  'rustbangalore',
  'jsfoo',
  'fpindia',
  'blrsystems',
  'vizchitra',
  'anthillinside',
];

async function tryUrl(url: string, accept: string) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: accept },
      signal: AbortSignal.timeout(20000),
      redirect: 'follow',
    });
    const text = await res.text();
    return {
      status: res.status,
      type: (res.headers.get('content-type') || '').split(';')[0],
      bytes: text.length,
      text,
    };
  } catch (err) {
    return { status: 0, type: '', bytes: 0, text: '', error: err instanceof Error ? err.message : String(err) };
  }
}

/** Count future-dated ISO timestamps anywhere in a payload — a cheap "has upcoming" test. */
function futureDates(text: string): string[] {
  const now = Date.now();
  const out = new Set<string>();
  for (const m of text.matchAll(/"(20\d{2}-\d{2}-\d{2})T\d{2}:\d{2}/g)) {
    const t = Date.parse(m[1]);
    if (Number.isFinite(t) && t > now) out.add(m[1]);
  }
  return [...out].sort();
}

async function main() {
  console.log('══ Account pages as JSON ══\n');
  for (const acc of ACCOUNTS) {
    const r = await tryUrl(`https://hasgeek.com/${acc}`, 'application/json');
    let shape = '';
    if (r.type.includes('json')) {
      try {
        const d = JSON.parse(r.text) as Record<string, unknown>;
        shape = Object.keys(d).slice(0, 8).join(',');
      } catch {
        shape = 'unparseable';
      }
    }
    const fut = futureDates(r.text);
    console.log(
      `  ${String(r.status).padStart(3)} ${r.type.padEnd(17)} ${String(r.bytes).padStart(7)}B  ` +
        `${acc.padEnd(16)} futureDates=${fut.length} ${shape ? `keys=[${shape}]` : ''}`
    );
    if (fut.length) console.log(`        next: ${fut.slice(0, 4).join(', ')}`);
  }

  console.log('\n══ Does search support an upcoming-only filter? ══\n');
  for (const variant of [
    'https://hasgeek.com/search?q=bangalore&type=project&state=upcoming',
    'https://hasgeek.com/search?q=meetup&type=project',
    'https://hasgeek.com/search?q=bengaluru&type=project',
    'https://hasgeek.com/api/1/board/projects',
    'https://hasgeek.com/?upcoming=1',
  ]) {
    const r = await tryUrl(variant, 'application/json');
    const fut = futureDates(r.text);
    console.log(
      `  ${String(r.status).padStart(3)} ${r.type.padEnd(17)} ${String(r.bytes).padStart(7)}B  futureDates=${String(fut.length).padStart(3)}  ${variant.replace('https://hasgeek.com', '')}`
    );
  }

  console.log('\n══ The site root: does it list what is on now? ══\n');
  const root = await tryUrl('https://hasgeek.com/', 'application/json');
  console.log(`  ${root.status} ${root.type} ${root.bytes}B  futureDates=${futureDates(root.text).length}`);
  if (root.type.includes('json')) {
    try {
      const d = JSON.parse(root.text) as Record<string, unknown>;
      console.log('  keys:', Object.keys(d).join(', '));
      for (const [k, v] of Object.entries(d)) {
        if (Array.isArray(v)) console.log(`    ${k}: ${v.length} row(s)`);
      }
    } catch {
      console.log('  (unparseable)');
    }
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
