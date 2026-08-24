#!/usr/bin/env tsx
/**
 * Round 2 on events.heapheaphurray.com: get the actual data and the actual IA.
 *
 * Round 1 established the shape: Next.js App Router on Vercel, RSC stream, robots.txt says
 * `Allow: /`, and 20 JSON-LD Event nodes sit on the homepage with real ISO dates. Its <title>
 * is "Tech Events in India — Conferences, Meetups, Workshops & Hackathons", which makes it a
 * direct competitor to PulseBLR's stated purpose rather than a general city-events site.
 *
 * This round answers what actually matters for both questions:
 *
 *   PRODUCT — what fields does each event carry, what filters exist (the meta description
 *   claims city + technology), how is an event page laid out, and what does it do that
 *   PulseBLR does not?
 *
 *   SOURCE — how many events total, how many in Bengaluru, and is the full set reachable or
 *   only the first page? A homepage carrying 20 is not the same as a corpus of 20.
 *
 * Also checks whether ANYTHING is gated behind login, because the user offered an account and
 * the honest answer may be that no account is needed.
 *
 * Read-only. No auth, no account creation, no writes.
 *
 * Run: npx tsx scripts/probe-hhh-round2.ts
 */
import './load-env';

const HOST = 'https://events.heapheaphurray.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

async function get(url: string, accept = 'text/html') {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: accept, 'Accept-Language': 'en-IN,en;q=0.9' },
      signal: AbortSignal.timeout(30000),
      redirect: 'follow',
    });
    const text = await res.text();
    return { status: res.status, type: (res.headers.get('content-type') || '').split(';')[0], text, url: res.url };
  } catch (err) {
    return { status: 0, type: '', text: '', url, error: err instanceof Error ? err.message : String(err) };
  }
}

function allJsonLd(html: string): unknown[] {
  const out: unknown[] = [];
  for (const b of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { out.push(JSON.parse(b[1])); } catch { /* ignore */ }
  }
  return out;
}

function eventNodes(html: string): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  const stack = [...allJsonLd(html)];
  const seen = new Set<unknown>();
  while (stack.length) {
    const n = stack.pop();
    if (!n || typeof n !== 'object' || seen.has(n)) continue;
    seen.add(n);
    if (Array.isArray(n)) { stack.push(...n); continue; }
    const o = n as Record<string, unknown>;
    const t = o['@type'];
    if ((Array.isArray(t) ? t : [t]).some(x => typeof x === 'string' && /Event$/i.test(x))) found.push(o);
    stack.push(...Object.values(o));
  }
  return found;
}

async function main() {
  console.log('════ 1. The sitemap (round 1 saw only ONE <loc>) ════\n');
  const sm = await get(`${HOST}/sitemap.xml`, 'application/xml');
  console.log(`  ${sm.status} ${sm.text.length}B`);
  console.log('  ─── verbatim ───');
  for (const line of sm.text.split('\n').slice(0, 20)) console.log(`  | ${line.slice(0, 140)}`);
  console.log('\n  → a single-URL sitemap means SEO relies on the homepage alone. Every event is');
  console.log('    rendered there rather than getting its own indexable page, OR event pages exist');
  console.log('    but are not declared. Section 4 settles which.');

  console.log('\n════ 2. Every JSON-LD event on the homepage, with full field coverage ════\n');
  const root = await get(`${HOST}/`);
  const events = eventNodes(root.text);
  console.log(`  ${events.length} Event node(s)\n`);

  const FIELDS = [
    'name', 'startDate', 'endDate', 'url', 'description', 'image', 'location',
    'organizer', 'offers', 'performer', 'eventAttendanceMode', 'eventStatus',
    'maximumAttendeeCapacity', 'keywords', 'inLanguage', 'isAccessibleForFree',
  ];
  const coverage = new Map<string, number>();
  for (const e of events) for (const f of FIELDS) if (e[f] !== undefined && e[f] !== null && e[f] !== '') {
    coverage.set(f, (coverage.get(f) ?? 0) + 1);
  }
  console.log('  field coverage:');
  for (const f of FIELDS) {
    const n = coverage.get(f) ?? 0;
    console.log(`    ${f.padEnd(26)} ${String(n).padStart(3)}/${events.length}  ${n ? `${Math.round((n / events.length) * 100)}%` : '—'}`);
  }

  console.log('\n  every event (name · start · city · host · price · url):');
  for (const e of events) {
    const loc = e.location as Record<string, unknown> | undefined;
    const addr = loc?.address as Record<string, unknown> | string | undefined;
    const city =
      typeof addr === 'string' ? addr
        : (addr?.addressLocality as string | undefined) ?? (loc?.name as string | undefined) ?? '—';
    const org = (e.organizer as Record<string, unknown> | undefined)?.name ?? e.organizer ?? '—';
    const offers = e.offers as Record<string, unknown> | undefined;
    const price = offers ? String(offers.price ?? offers.lowPrice ?? (offers.isAccessibleForFree ? 'free' : '?')) : '—';
    console.log(`    ${String(e.startDate ?? '?').slice(0, 10)}  ${String(e.name ?? '?').slice(0, 46).padEnd(46)} ${String(city).slice(0, 16).padEnd(16)} ${String(org).slice(0, 20).padEnd(20)} ${String(price).slice(0, 8)}`);
    if (e.url) console.log(`              ${String(e.url).slice(0, 100)}`);
  }

  const blr = events.filter(e => JSON.stringify(e).match(/bengaluru|bangalore/i));
  console.log(`\n  Bengaluru/Bangalore events among them: ${blr.length}/${events.length}`);

  console.log('\n════ 3. Where do the events POINT? (aggregator or first-party?) ════\n');
  const hosts = new Map<string, number>();
  for (const e of events) {
    const u = String(e.url ?? '');
    const m = u.match(/^https?:\/\/([^/]+)/);
    if (m) hosts.set(m[1], (hosts.get(m[1]) ?? 0) + 1);
  }
  for (const [h, n] of [...hosts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(3)}  ${h}`);
  }
  console.log('\n  → if these point OFF-SITE, it is an aggregator like PulseBLR and its upstreams');
  console.log('    are the interesting part. If on-site, it hosts its own listings.');

  console.log('\n════ 4. Is anything gated, and do event pages exist? ════\n');
  // Derive candidate on-site paths from the RSC payload rather than guessing.
  const rscPaths = new Set<string>();
  for (const m of root.text.matchAll(/\\?"\/(?:events?|e|city|tech|tag|conference|meetup|hackathon)\\?\/[a-z0-9/_-]{2,60}/gi)) {
    rscPaths.add(m[0].replace(/\\"/g, '').replace(/^"/, ''));
  }
  for (const m of root.text.matchAll(/"(\/[a-z0-9][a-z0-9/_-]{2,50})"/gi)) {
    const p = m[1];
    if (/^\/(events?|city|cities|tech|tags?|about|submit|add|api)/i.test(p)) rscPaths.add(p);
  }
  console.log(`  ${rscPaths.size} candidate on-site path(s) from the RSC payload:`);
  for (const p of [...rscPaths].slice(0, 25)) console.log(`     ${p}`);

  for (const path of ['/about', '/submit', '/add-event', '/events', '/cities', '/bengaluru', '/city/bengaluru', '/login', '/signup']) {
    const r = await get(`${HOST}${path}`);
    const gated = /\b(sign in|sign up|log ?in|create account|unauthorized)\b/i.test(r.text.slice(0, 6000));
    console.log(`  ${String(r.status).padEnd(4)} ${String(r.text.length).padStart(7)}B  ${path.padEnd(18)} ${gated ? 'mentions auth' : ''}`);
  }

  console.log('\n════ 5. Filters and sort — the meta description claims city + technology ════\n');
  const text = root.text;
  const uiSignals: Array<[string, RegExp]> = [
    ['city filter', /\b(city|cities)\b/i],
    ['technology/tag filter', /\b(technolog(y|ies)|tags?|topics?)\b/i],
    ['event-type filter', /\b(conference|meetup|workshop|hackathon)s?\b/i],
    ['online/offline filter', /\b(online|offline|in[- ]person|virtual|hybrid)\b/i],
    ['free/paid filter', /\b(free|paid|price)\b/i],
    ['date/when filter', /\b(this week|this month|upcoming|today|tomorrow|weekend)\b/i],
    ['search box', /\b(search|placeholder=)/i],
    ['sort control', /\b(sort|order by|newest|soonest)\b/i],
    ['CFP / call for papers', /\b(cfp|call for (papers|proposals|speakers))\b/i],
    ['speakers listed', /\bspeakers?\b/i],
    ['attendee count', /\b(attendees?|going|registered|rsvp)\b/i],
    ['newsletter / subscribe', /\b(newsletter|subscribe|weekly digest)\b/i],
    ['submit your event', /\b(submit|add) (an? )?event\b/i],
    ['calendar / ics export', /\b(add to calendar|\.ics|google calendar)\b/i],
    ['bookmark / save', /\b(bookmark|save|favourite|favorite|wishlist)\b/i],
  ];
  for (const [label, re] of uiSignals) {
    console.log(`    ${label.padEnd(28)} ${re.test(text) ? 'YES' : 'no'}`);
  }

  // Names of cities and tags actually present, which is the real taxonomy.
  const cities = new Set<string>();
  for (const m of text.matchAll(/\b(Bengaluru|Bangalore|Mumbai|Delhi|Gurgaon|Noida|Hyderabad|Chennai|Pune|Kolkata|Ahmedabad|Jaipur|Kochi|Indore|Chandigarh|Goa|Remote|Online)\b/gi)) {
    cities.add(m[1]);
  }
  console.log(`\n  cities named in the payload (${cities.size}): ${[...cities].join(', ')}`);

  const tags = new Set<string>();
  for (const m of text.matchAll(/\b(AI|ML|LLM|GenAI|DevOps|Cloud|Kubernetes|Web3|Blockchain|Security|Cybersecurity|Data|Frontend|Backend|Mobile|Flutter|React|Python|Rust|Go(?:lang)?|Java|DevRel|Product|Design|Startup|Hardware|Robotics|IoT|Embedded|Open ?Source)\b/g)) {
    tags.add(m[1]);
  }
  console.log(`  topic words in the payload (${tags.size}): ${[...tags].slice(0, 40).join(', ')}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
