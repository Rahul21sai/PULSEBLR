#!/usr/bin/env tsx
/**
 * Round 2 on District: follow the events sitemap it declares, and see whether an event page
 * carries parseable data.
 *
 * Round 1 found two things the first probe had missed entirely by guessing URLs:
 *   · robots.txt declares https://www.district.in/events/search-sitemap/sitemap-events.xml
 *   · pages ship an RSC stream (self.__next_f), which is where an App Router app puts its
 *     server data — so "client-rendered" is not automatically "unreachable"
 *
 * District absorbed Paytm Insider and is the largest consumer-events surface in India, which
 * makes it the biggest remaining pool for "every Bengaluru event". Worth one careful look.
 *
 * Read-only.
 *
 * Run: npx tsx scripts/probe-district-round2.ts
 */
import './load-env';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

async function get(url: string, accept = 'text/html') {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: accept, 'Accept-Language': 'en-IN,en;q=0.9' },
      signal: AbortSignal.timeout(25000),
      redirect: 'follow',
    });
    return { status: res.status, type: (res.headers.get('content-type') || '').split(';')[0], text: await res.text() };
  } catch (err) {
    return { status: 0, type: '', text: '', error: err instanceof Error ? err.message : String(err) };
  }
}

function jsonLdNodes(html: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const block of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const walk = (node: unknown): void => {
        if (Array.isArray(node)) return node.forEach(walk);
        if (!node || typeof node !== 'object') return;
        out.push(node as Record<string, unknown>);
        Object.values(node as Record<string, unknown>).forEach(walk);
      };
      walk(JSON.parse(block[1]));
    } catch {
      /* ignore */
    }
  }
  return out;
}

async function main() {
  console.log('══ The events sitemap ══\n');
  const sm = await get('https://www.district.in/events/search-sitemap/sitemap-events.xml', 'application/xml');
  console.log(`  ${sm.status} ${sm.type} ${sm.text.length}B`);

  // Sitemap indexes nest; collect both direct <loc>s and child sitemaps.
  const locs = [...sm.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
  const childMaps = locs.filter(l => l.endsWith('.xml'));
  let eventUrls = locs.filter(l => !l.endsWith('.xml'));

  console.log(`  ${locs.length} <loc>: ${childMaps.length} child sitemap(s), ${eventUrls.length} direct URL(s)`);

  if (childMaps.length > 0 && eventUrls.length === 0) {
    console.log(`\n  following the first child sitemap: ${childMaps[0]}`);
    const child = await get(childMaps[0], 'application/xml');
    eventUrls = [...child.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]).filter(l => !l.endsWith('.xml'));
    console.log(`  ${child.status}, ${eventUrls.length} URL(s)`);
  }

  const blr = eventUrls.filter(u => /bengaluru|bangalore/i.test(u));
  console.log(`\n  total event URLs: ${eventUrls.length}`);
  console.log(`  Bengaluru in the URL: ${blr.length}`);
  for (const u of (blr.length ? blr : eventUrls).slice(0, 8)) console.log(`     ${u.slice(0, 100)}`);

  // Now the decisive question: is an event page parseable?
  const sample = (blr.length ? blr : eventUrls).slice(0, 3);
  console.log(`\n══ ${sample.length} event page(s) — is the data in the response? ══`);

  for (const url of sample) {
    const page = await get(url);
    console.log(`\n  ${page.status} ${page.text.length}B  ${url.slice(0, 88)}`);

    const nodes = jsonLdNodes(page.text);
    const eventNodes = nodes.filter(n => {
      const t = n['@type'];
      return (Array.isArray(t) ? t : [t]).some(x => typeof x === 'string' && /event/i.test(x));
    });
    console.log(`     JSON-LD nodes: ${nodes.length} (Event-typed: ${eventNodes.length})`);
    if (eventNodes[0]) {
      const e = eventNodes[0];
      console.log(`        name      ${String(e.name ?? '-').slice(0, 66)}`);
      console.log(`        startDate ${String(e.startDate ?? '-')}`);
      console.log(`        location  ${JSON.stringify(e.location ?? '-').slice(0, 80)}`);
    }

    for (const [label, re] of [
      ['RSC stream (self.__next_f)', /self\.__next_f/],
      ['og:title', /property=["']og:title["']/i],
      ['ISO date in response', /\b20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}/],
      ['Bengaluru mentioned', /bengaluru|bangalore/i],
    ] as Array<[string, RegExp]>) {
      console.log(`     ${label.padEnd(28)} ${re.test(page.text) ? 'YES' : 'no'}`);
    }

    const og = page.text.match(/property=["']og:title["'][^>]*content=["']([^"']+)["']/i)
      ?? page.text.match(/content=["']([^"']+)["'][^>]*property=["']og:title["']/i);
    if (og) console.log(`     og:title = ${og[1].slice(0, 70)}`);
  }

  console.log('\nVERDICT: a JSON-LD Event with name + startDate on each page makes District an');
  console.log('adapter with no browser needed — sitemap for discovery, JSON-LD for extraction,');
  console.log('exactly the shape universal.ts already handles.');
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
