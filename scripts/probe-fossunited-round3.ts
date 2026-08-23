#!/usr/bin/env tsx
/**
 * Third look at FOSS United, because the first two asked the wrong question.
 *
 * FOSS United runs the Bengaluru open-source scene — IndiaFOSS plus a monthly city meetup —
 * and open source is one of the dimensions still short. It was rejected earlier on the
 * grounds that the Frappe REST API is 403, the whitelisted methods do not exist (417 "No
 * module named"), /events.ics is a 404, and rss.xml turns out to be a BLOG feed.
 *
 * All true, and all beside the point: those checks only asked "is there an API or a feed?".
 * The chapter page itself returns 200 with 417 KB of SERVER-RENDERED HTML containing ISO
 * dates, "Bengaluru", and the word venue. Frappe portals render lists server-side, so the
 * data may well be in the markup in a stable, parseable shape — which is a different
 * question from whether it is offered as JSON.
 *
 * This looks at the actual structure before concluding anything.
 *
 * Read-only.
 *
 * Run: npx tsx scripts/probe-fossunited-round3.ts
 */
import './load-env';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

async function get(url: string, accept = 'text/html') {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: accept },
    signal: AbortSignal.timeout(25000),
    redirect: 'follow',
  });
  return { status: res.status, type: (res.headers.get('content-type') || '').split(';')[0], text: await res.text() };
}

function show(label: string, value: unknown) {
  console.log(`  ${label.padEnd(30)} ${String(value)}`);
}

async function main() {
  console.log('══ /c/bengaluru — what is actually in the markup? ══\n');
  const page = await get('https://fossunited.org/c/bengaluru');
  show('status / bytes', `${page.status} / ${page.text.length}`);

  const t = page.text;

  // 1. Is there embedded server state? Frappe apps often ship boot data or a JSON island.
  console.log('\n  embedded state:');
  for (const [label, re] of [
    ['frappe.boot assignment', /frappe\.boot\s*=\s*\{/],
    ['window.__ state', /window\.__[A-Za-z_]+\s*=\s*\{/],
    ['<script type=application/json>', /<script[^>]+type=["']application\/json["'][^>]*>/i],
    ['data-page / Inertia', /data-page=["']\{/],
    ['hx- attributes (htmx)', /hx-(get|post|target)=/],
  ] as Array<[string, RegExp]>) {
    show(label, re.test(t) ? 'YES' : 'no');
  }

  // 2. If frappe.boot exists, what is in it?
  const boot = t.match(/frappe\.boot\s*=\s*(\{[\s\S]{0,400})/);
  if (boot) console.log(`\n  frappe.boot starts: ${boot[1].replace(/\s+/g, ' ').slice(0, 220)}`);

  // 3. Event links on the page — the discovery surface regardless of parseability.
  const eventLinks = [...new Set([...t.matchAll(/href=["'](\/c\/bengaluru\/[a-z0-9][a-z0-9/_-]{2,60})["']/gi)].map(m => m[1]))];
  console.log(`\n  /c/bengaluru/* links: ${eventLinks.length}`);
  for (const l of eventLinks.slice(0, 12)) console.log(`     ${l}`);

  // 4. Dates in the markup, and whether any are upcoming.
  const isoDates = [...new Set([...t.matchAll(/\b(20\d{2}-\d{2}-\d{2})\b/g)].map(m => m[1]))].sort();
  const now = Date.now();
  const future = isoDates.filter(d => Date.parse(d) > now);
  console.log(`\n  ISO dates in markup: ${isoDates.length} (${future.length} in the future)`);
  if (isoDates.length) console.log(`     ${isoDates.slice(-8).join(', ')}`);

  // 5. Are dates attached to elements in a stable way, or loose in prose?
  console.log('\n  date carriers:');
  for (const [label, re] of [
    ['<time datetime=…>', /<time[^>]+datetime=/i],
    ['data-date attribute', /data-[a-z-]*date[a-z-]*=/i],
    ['itemprop=startDate', /itemprop=["']startDate["']/i],
  ] as Array<[string, RegExp]>) {
    show(label, re.test(t) ? 'YES' : 'no');
  }

  // 6. One event page — richer than the index, and where JSON-LD would live if anywhere.
  if (eventLinks.length > 0) {
    const target = `https://fossunited.org${eventLinks[0]}`;
    console.log(`\n══ one event page: ${eventLinks[0]} ══\n`);
    const ev = await get(target);
    show('status / bytes', `${ev.status} / ${ev.text.length}`);
    for (const [label, re] of [
      ['JSON-LD Event', /"@type"\s*:\s*"[^"]*Event/i],
      ['<time datetime=…>', /<time[^>]+datetime=/i],
      ['og:title', /property=["']og:title["']/i],
      ['og:description', /property=["']og:description["']/i],
      ['ISO date present', /\b20\d{2}-\d{2}-\d{2}\b/],
    ] as Array<[string, RegExp]>) {
      show(label, re.test(ev.text) ? 'YES' : 'no');
    }
    const og = ev.text.match(/property=["']og:title["'][^>]*content=["']([^"']+)["']/i)
      ?? ev.text.match(/content=["']([^"']+)["'][^>]*property=["']og:title["']/i);
    if (og) console.log(`\n  og:title = ${og[1].slice(0, 90)}`);
    const evDates = [...new Set([...ev.text.matchAll(/\b(20\d{2}-\d{2}-\d{2})\b/g)].map(m => m[1]))].sort();
    console.log(`  dates on the event page: ${evDates.join(', ').slice(0, 120)}`);
  }

  console.log('\nVERDICT depends on the above: og: tags plus a <time datetime> would make this');
  console.log('parseable by universal.ts-style extraction. Loose dates in prose would not, and');
  console.log('would mean selector scraping — which universal.ts refuses on purpose.');
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
