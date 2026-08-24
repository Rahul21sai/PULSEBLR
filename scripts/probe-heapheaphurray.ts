#!/usr/bin/env tsx
/**
 * Recon on events.heapheaphurray.com — a competitor/reference India events site.
 *
 * TWO separate questions, and they must not be conflated:
 *
 *   1. PRODUCT: what does it do that PulseBLR does not, and is any of it worth copying?
 *      Answering this needs the rendered information architecture — filters, sort options,
 *      what each card shows, how an event page is laid out, what it asks of the user.
 *
 *   2. SOURCE: is it scrapable, and would it add Bengaluru events we do not already have?
 *      Answered by the same bar every other source in this project had to clear — event
 *      objects with a title AND a date must be present IN A RESPONSE (JSON-LD,
 *      __NEXT_DATA__, an RSC payload, or a JSON endpoint). A 200 that needs a browser is
 *      not a source.
 *
 * Starts from robots.txt rather than guessing paths, because that mistake has been made in
 * this repo before: District was written off after two guessed URLs 404'd, and starting from
 * robots.txt later found a 6,316-URL events sitemap in one request.
 *
 * robots.txt is also read as POLICY, not just as a map. This project already refuses to fetch
 * linkedin.com on those grounds. If this site disallows crawling, that is the answer to
 * question 2 regardless of what is technically reachable, and question 1 is unaffected —
 * looking at a public page to learn from its design is not crawling it for data.
 *
 * Read-only. No writes, no auth, no account creation.
 *
 * Run: npx tsx scripts/probe-heapheaphurray.ts
 */
import './load-env';

const HOST = 'https://events.heapheaphurray.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

interface Fetched {
  status: number;
  type: string;
  bytes: number;
  text: string;
  location?: string;
  server?: string;
  error?: string;
}

async function get(url: string, accept = 'text/html'): Promise<Fetched> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: accept, 'Accept-Language': 'en-IN,en;q=0.9' },
      signal: AbortSignal.timeout(25000),
      redirect: 'follow',
    });
    const text = await res.text();
    return {
      status: res.status,
      type: (res.headers.get('content-type') || '').split(';')[0],
      bytes: text.length,
      text,
      location: res.url !== url ? res.url : undefined,
      server: [res.headers.get('server'), res.headers.get('x-powered-by')].filter(Boolean).join(' / '),
    };
  } catch (err) {
    return { status: 0, type: '', bytes: 0, text: '', error: err instanceof Error ? err.message : String(err) };
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

function eventNodes(html: string) {
  return jsonLdNodes(html).filter(n => {
    const t = n['@type'];
    return (Array.isArray(t) ? t : [t]).some(x => typeof x === 'string' && /Event$/i.test(x));
  });
}

async function main() {
  console.log('════ 1. robots.txt — the map AND the policy ════\n');
  const robots = await get(`${HOST}/robots.txt`, 'text/plain');
  console.log(`  ${robots.status} ${robots.type} ${robots.bytes}B`);
  if (robots.status === 200) {
    console.log('  ─── verbatim ───');
    for (const line of robots.text.split('\n').slice(0, 40)) console.log(`  | ${line}`);
    const sitemaps = [...robots.text.matchAll(/Sitemap:\s*(\S+)/gi)].map(m => m[1]);
    console.log(`\n  sitemaps declared: ${sitemaps.length ? sitemaps.join(', ') : 'NONE'}`);
    const blanketDisallow = /User-agent:\s*\*[\s\S]*?Disallow:\s*\/\s*$/im.test(robots.text);
    console.log(`  blanket Disallow: / for * ? ${blanketDisallow ? 'YES — do not crawl' : 'no'}`);
  }

  console.log('\n════ 2. What does the root serve? ════\n');
  const root = await get(`${HOST}/`);
  console.log(`  ${root.status} ${root.type} ${root.bytes}B  server=${root.server || '?'}`);
  if (root.location) console.log(`  → ${root.location}`);
  if (root.error) console.log(`  error: ${root.error}`);

  const html = root.text;
  const signals: Array<[string, RegExp]> = [
    ['__NEXT_DATA__ (Next pages router)', /__NEXT_DATA__/],
    ['self.__next_f (Next app router RSC)', /self\.__next_f/],
    ['Nuxt / __NUXT__', /__NUXT__/],
    ['Remix', /__remixContext/],
    ['Vite/React SPA shell', /<div id="root">\s*<\/div>/],
    ['Wix', /wix(static|apps)/i],
    ['Squarespace', /squarespace/i],
    ['Webflow', /webflow/i],
    ['WordPress', /wp-(content|json|includes)/i],
    ['Shopify', /cdn\.shopify/i],
    ['Bubble', /bubble\.io|bubbleapps/i],
    ['Framer', /framerusercontent/i],
    ['Luma embed', /lu\.ma|luma/i],
    ['Airtable', /airtable/i],
    ['Notion', /notion/i],
    ['Google Sheets/Forms', /docs\.google\.com|forms\.gle/i],
    ['Supabase', /supabase/i],
    ['Firebase', /firebase(io|app)/i],
    ['JSON-LD present', /application\/ld\+json/i],
    ['login / signup wording', /\b(sign in|sign up|log ?in|register|create account)\b/i],
    ['Bengaluru mentioned', /bengaluru|bangalore/i],
  ];
  console.log('\n  platform + content signals:');
  for (const [label, re] of signals) {
    console.log(`    ${label.padEnd(38)} ${re.test(html) ? 'YES' : 'no'}`);
  }

  const ld = eventNodes(html);
  console.log(`\n  JSON-LD Event nodes on root: ${ld.length}`);
  for (const e of ld.slice(0, 5)) {
    console.log(`     ${String(e.name ?? '?').slice(0, 58)}  @ ${String(e.startDate ?? '?')}`);
  }

  const title = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1];
  const desc = html.match(/name=["']description["'][^>]*content=["']([^"']+)["']/i)?.[1];
  console.log(`\n  <title>       ${title?.slice(0, 90) ?? '—'}`);
  console.log(`  description   ${desc?.slice(0, 140) ?? '—'}`);

  console.log('\n════ 3. Internal paths the markup itself links to ════\n');
  const paths = new Set<string>();
  for (const m of html.matchAll(/href=["'](\/[a-z0-9][a-z0-9/_?=&.-]{0,70})["']/gi)) paths.add(m[1]);
  for (const m of html.matchAll(new RegExp(`href=["']${HOST}(/[a-z0-9][a-z0-9/_?=&.-]{0,70})["']`, 'gi'))) {
    paths.add(m[1]);
  }
  console.log(`  ${paths.size} distinct internal path(s):`);
  for (const p of [...paths].sort().slice(0, 40)) console.log(`     ${p}`);

  console.log('\n════ 4. API / data endpoints referenced in the bundle ════\n');
  const apis = new Set<string>();
  for (const m of html.matchAll(/["'](https?:\/\/[a-z0-9.-]*(?:api|gw|gateway|bff|graphql|supabase|airtable)[a-z0-9.-]*\/[^"'\s]{0,70})["']/gi)) {
    apis.add(m[1].slice(0, 100));
  }
  for (const m of html.matchAll(/["'](\/(?:api|graphql|_next\/data)\/[a-z0-9/_.?=&-]{2,70})["']/gi)) apis.add(m[1]);
  console.log(`  ${apis.size} candidate endpoint(s):`);
  for (const a of [...apis].slice(0, 20)) console.log(`     ${a}`);

  console.log('\n════ 5. Conventional discovery surfaces ════\n');
  for (const path of [
    '/sitemap.xml',
    '/sitemap_index.xml',
    '/sitemap-events.xml',
    '/feed',
    '/rss',
    '/rss.xml',
    '/feed.xml',
    '/atom.xml',
    '/events.json',
    '/api/events',
    '/api/event',
    '/wp-json/wp/v2/types',
    '/.well-known/security.txt',
  ]) {
    const r = await get(`${HOST}${path}`, 'application/xml,application/json,text/plain,*/*;q=0.8');
    const locs = (r.text.match(/<loc>/g) || []).length;
    const items = (r.text.match(/<item>|<entry>/g) || []).length;
    let jsonEventish = 0;
    if (/json/.test(r.type)) {
      try {
        const parsed = JSON.parse(r.text);
        const stack: unknown[] = [parsed];
        const seen = new Set<unknown>();
        while (stack.length) {
          const n = stack.pop();
          if (!n || typeof n !== 'object' || seen.has(n)) continue;
          seen.add(n);
          if (Array.isArray(n)) { stack.push(...n); continue; }
          const o = n as Record<string, unknown>;
          const hasTitle = ['title', 'name', 'event_name'].some(k => typeof o[k] === 'string');
          const hasDate = ['start', 'startDate', 'start_date', 'start_time', 'date'].some(k => o[k]);
          if (hasTitle && hasDate) jsonEventish++;
          stack.push(...Object.values(o));
        }
      } catch { /* not json */ }
    }
    const flags = [
      locs ? `${locs} <loc>` : '',
      items ? `${items} item` : '',
      jsonEventish ? `${jsonEventish} json-event` : '',
    ].filter(Boolean).join(' ');
    console.log(`  ${String(r.status).padEnd(4)} ${r.type.padEnd(24)} ${String(r.bytes).padStart(8)}B  ${path}${flags ? `   ${flags}` : ''}`);
  }

  console.log('\n\nVERDICT NOTES');
  console.log('  · Product lessons do not depend on any of the above — a rendered page can be read');
  console.log('    for its design without being a data source.');
  console.log('  · As a SOURCE it is only viable if event objects with a title AND a date appear in');
  console.log('    a response, AND robots.txt permits it. Both, not either.');
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
