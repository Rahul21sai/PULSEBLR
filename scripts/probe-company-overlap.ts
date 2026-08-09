#!/usr/bin/env tsx
/**
 * READ-ONLY: are company-name searches actually company-scoped?
 *
 * Every company name queried on Meetup returned ~12 events, and three on
 * Eventbrite returned ~20 while five returned 0. A uniform count across
 * unrelated queries is the signature of a generic fallback result set — exactly
 * the trap AllEvents.in set last round, where /technology and /music returned
 * byte-identical event lists.
 *
 * So: compare the actual event TITLES between queries. If "Google" and "Swiggy"
 * return the same set, the search is worthless for company attribution and must
 * not be built on.
 *
 * Run: npx tsx scripts/probe-company-overlap.ts
 */
import './load-env';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function get(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,*/*;q=0.8' },
      redirect: 'follow',
      signal: AbortSignal.timeout(20000),
    });
    return res.ok ? await res.text() : '';
  } catch {
    return '';
  }
}

function eventTitles(html: string): string[] {
  const titles: string[] = [];
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(m[1].trim());
      const nodes: unknown[] = Array.isArray(parsed)
        ? parsed
        : (parsed as { '@graph'?: unknown[] })['@graph'] || [parsed];
      for (const node of nodes) {
        const obj = node as Record<string, unknown>;
        if (String(obj?.['@type']).includes('Event') && typeof obj.name === 'string') {
          titles.push(obj.name);
        }
      }
    } catch {
      /* ignore */
    }
  }
  return titles;
}

function jaccard(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  const intersection = [...setA].filter(x => setB.has(x)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

const COMPANIES = ['Google', 'Swiggy', 'Razorpay', 'Zerodha', 'Microsoft'];

async function main() {
  // ── Meetup ────────────────────────────────────────────────────────────────
  console.log('\n══ MEETUP: do different company keywords return different events? ══');
  const meetup: Record<string, string[]> = {};
  for (const c of COMPANIES) {
    meetup[c] = eventTitles(
      await get(
        `https://www.meetup.com/find/?keywords=${encodeURIComponent(c)}&location=in--Bengaluru&source=EVENTS`
      )
    );
    console.log(`  ${c.padEnd(12)} ${meetup[c].length} events`);
    for (const t of meetup[c].slice(0, 3)) console.log(`       · ${t.slice(0, 62)}`);
  }
  console.log('\n  pairwise title overlap (1.00 = identical sets):');
  for (let i = 0; i < COMPANIES.length; i++) {
    for (let j = i + 1; j < COMPANIES.length; j++) {
      const a = COMPANIES[i];
      const b = COMPANIES[j];
      console.log(`     ${a.padEnd(11)} vs ${b.padEnd(11)} ${jaccard(meetup[a], meetup[b]).toFixed(2)}`);
    }
  }
  const mentioning = (c: string) =>
    meetup[c].filter(t => t.toLowerCase().includes(c.toLowerCase())).length;
  console.log('\n  titles actually naming the company:');
  for (const c of COMPANIES) console.log(`     ${c.padEnd(12)} ${mentioning(c)}/${meetup[c].length}`);

  // ── Eventbrite ────────────────────────────────────────────────────────────
  console.log('\n══ EVENTBRITE: same question ════════════════════════════════════');
  const eb: Record<string, string[]> = {};
  for (const c of COMPANIES) {
    eb[c] = eventTitles(
      await get(
        `https://www.eventbrite.com/d/india--bengaluru/${encodeURIComponent(c.toLowerCase())}/`
      )
    );
    console.log(`  ${c.padEnd(12)} ${eb[c].length} events`);
    for (const t of eb[c].slice(0, 3)) console.log(`       · ${t.slice(0, 62)}`);
  }
  console.log('\n  pairwise title overlap:');
  for (let i = 0; i < COMPANIES.length; i++) {
    for (let j = i + 1; j < COMPANIES.length; j++) {
      const a = COMPANIES[i];
      const b = COMPANIES[j];
      console.log(`     ${a.padEnd(11)} vs ${b.padEnd(11)} ${jaccard(eb[a], eb[b]).toFixed(2)}`);
    }
  }

  // ── Baseline: an unrelated nonsense keyword ────────────────────────────────
  console.log('\n══ CONTROL: a nonsense keyword ══════════════════════════════════');
  const nonsense = eventTitles(
    await get(
      'https://www.meetup.com/find/?keywords=zzqqxx-not-a-company&location=in--Bengaluru&source=EVENTS'
    )
  );
  console.log(`  nonsense keyword returned ${nonsense.length} events`);
  console.log(`  overlap with "Google": ${jaccard(nonsense, meetup.Google).toFixed(2)}`);
  console.log(
    '\n  If the control matches the company queries, the search is a generic fallback\n' +
      '  and cannot be used to attribute events to companies.'
  );
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
