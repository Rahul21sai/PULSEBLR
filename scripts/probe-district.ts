#!/usr/bin/env tsx
/**
 * One careful attempt at District, because the earlier one was not careful.
 *
 * District is Zomato's events platform and absorbed Paytm Insider — it is now the largest
 * consumer-events surface in India, which makes it the single biggest remaining pool for
 * "every Bengaluru event". The previous probe tried `district.in/bengaluru` (404) and
 * `api.district.in/rest/v1/events` (fetch failed) and wrote it off. Both were GUESSES, and a
 * 404 on a guessed path says nothing about the platform.
 *
 * This starts from the real homepage and follows what is actually there: the redirect it
 * serves, the city path it uses, any API host referenced in its bundle, and its sitemap.
 *
 * Read-only.
 *
 * Run: npx tsx scripts/probe-district.ts
 */
import './load-env';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

async function probe(url: string, accept = 'text/html') {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: accept, 'Accept-Language': 'en-IN,en;q=0.9' },
      signal: AbortSignal.timeout(20000),
      redirect: 'manual',
    });
    const text = res.status < 300 || res.status >= 400 ? await res.text() : '';
    return {
      status: res.status,
      location: res.headers.get('location') ?? '',
      type: (res.headers.get('content-type') || '').split(';')[0],
      bytes: text.length,
      text,
    };
  } catch (err) {
    return { status: 0, location: '', type: '', bytes: 0, text: '', error: err instanceof Error ? err.message : String(err) };
  }
}

function jsonLdEventCount(html: string): number {
  let n = 0;
  for (const block of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const walk = (node: unknown): void => {
        if (Array.isArray(node)) return node.forEach(walk);
        if (!node || typeof node !== 'object') return;
        const o = node as Record<string, unknown>;
        const t = o['@type'];
        if ((Array.isArray(t) ? t : [t]).some(x => typeof x === 'string' && /event/i.test(x))) n++;
        Object.values(o).forEach(walk);
      };
      walk(JSON.parse(block[1]));
    } catch {
      /* ignore */
    }
  }
  return n;
}

async function main() {
  console.log('══ 1. What does the root actually serve? ══\n');
  for (const url of ['https://district.in/', 'https://www.district.in/']) {
    const r = await probe(url);
    console.log(`  ${r.status} ${r.type.padEnd(12)} ${String(r.bytes).padStart(7)}B  ${url}`);
    if (r.location) console.log(`      -> redirects to ${r.location}`);
  }

  // Follow whatever the root gives us rather than assuming /bengaluru.
  const root = await probe('https://www.district.in/');
  const html = root.text;

  console.log('\n══ 2. City paths referenced in the markup ══\n');
  const cityLinks = new Set<string>();
  for (const m of html.matchAll(/href=["'](\/[a-z-]*(?:bengaluru|bangalore)[a-z0-9/_-]*)["']/gi)) {
    cityLinks.add(m[1]);
  }
  for (const m of html.matchAll(/["'](\/(?:events|movies|eventgroup|city)\/[a-z0-9/_-]{2,50})["']/gi)) {
    cityLinks.add(m[1]);
  }
  console.log(`  ${cityLinks.size} candidate path(s)`);
  for (const l of [...cityLinks].slice(0, 14)) console.log(`     ${l}`);

  console.log('\n══ 3. API hosts referenced in the bundle ══\n');
  const apis = new Set<string>();
  for (const m of html.matchAll(/["'](https?:\/\/[a-z0-9.-]*(?:api|gw|gateway|bff)[a-z0-9.-]*\/[^"'\s]{0,60})["']/gi)) {
    apis.add(m[1].slice(0, 80));
  }
  for (const m of html.matchAll(/["'](\/api\/[a-z0-9/_.-]{3,60})["']/gi)) apis.add(m[1]);
  console.log(`  ${apis.size} candidate endpoint(s)`);
  for (const a of [...apis].slice(0, 14)) console.log(`     ${a}`);

  console.log('\n══ 4. Is there event data in the HTML at all? ══\n');
  console.log(`  JSON-LD Event nodes on root: ${jsonLdEventCount(html)}`);
  for (const [label, re] of [
    ['__NEXT_DATA__', /__NEXT_DATA__/],
    ['self.__next_f (RSC stream)', /self\.__next_f/],
    ['Bengaluru mentioned', /bengaluru|bangalore/i],
  ] as Array<[string, RegExp]>) {
    console.log(`  ${label.padEnd(28)} ${re.test(html) ? 'YES' : 'no'}`);
  }

  console.log('\n══ 5. Sitemap ══\n');
  for (const url of [
    'https://www.district.in/sitemap.xml',
    'https://www.district.in/robots.txt',
  ]) {
    const r = await probe(url, 'application/xml,text/plain');
    console.log(`  ${r.status} ${r.type.padEnd(14)} ${String(r.bytes).padStart(8)}B  ${url}`);
    if (r.status === 200 && url.endsWith('robots.txt')) {
      const maps = [...r.text.matchAll(/Sitemap:\s*(\S+)/gi)].map(m => m[1]);
      console.log(`      sitemaps declared: ${maps.slice(0, 5).join(', ') || 'none'}`);
    }
    if (r.status === 200 && url.endsWith('.xml')) {
      const locs = [...r.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
      console.log(`      ${locs.length} URL(s); event-ish: ${locs.filter(l => /event/i.test(l)).length}`);
      for (const l of locs.slice(0, 6)) console.log(`         ${l.slice(0, 90)}`);
    }
  }

  console.log('\n══ 6. Try the city page the site itself links to ══\n');
  const cityPath = [...cityLinks].find(l => /bengaluru|bangalore/i.test(l)) ?? '/bengaluru';
  const city = await probe(`https://www.district.in${cityPath}`);
  console.log(`  ${city.status} ${city.type} ${city.bytes}B  ${cityPath}`);
  if (city.status === 200) {
    console.log(`  JSON-LD Event nodes: ${jsonLdEventCount(city.text)}`);
    console.log(`  __NEXT_DATA__ present: ${/__NEXT_DATA__/.test(city.text) ? 'YES' : 'no'}`);
    console.log(`  RSC stream present:   ${/self\.__next_f/.test(city.text) ? 'YES' : 'no'}`);
  }

  console.log('\nVERDICT: viable only if event objects (title + date) are in a RESPONSE — JSON-LD,');
  console.log('__NEXT_DATA__, an RSC payload, or a JSON endpoint. A 200 that needs a browser to');
  console.log('render is not a source.');
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
