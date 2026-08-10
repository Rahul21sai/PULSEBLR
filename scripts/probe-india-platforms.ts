#!/usr/bin/env tsx
/**
 * Do INDIA'S OWN event platforms expose machine-readable Bengaluru tech events?
 *
 * This is the open question left after two dead ends were proven:
 *   - company event microsites (aws-experience.com) are client-rendered shells
 *     (probe-event-microsites.ts, probe-microsites-round2.ts), and
 *   - 19 of 20 corporate marketing pages in COMPANY_EVENT_PAGES yield nothing.
 *
 * Indian platforms were never probed, and they are where a lot of Bengaluru tech
 * and company events actually get listed — Konfhub and Hasgeek in particular host
 * conferences that never appear on Meetup or Luma.
 *
 * Read-only. Reports, for each candidate: HTTP status, content-type, body size, and
 * whether real event objects are present IN THE RESPONSE rather than rendered later
 * by JavaScript. A 200 that returns an empty JS shell is NOT viable.
 *
 * Run: npx tsx scripts/probe-india-platforms.ts
 */
import './load-env';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

interface Candidate {
  name: string;
  url: string;
  /** Optional JSON body to POST instead of GET. */
  post?: unknown;
}

const CANDIDATES: Candidate[] = [
  // ── Indian tech-conference / community ticketing ──
  { name: 'Konfhub listing', url: 'https://konfhub.com/explore' },
  { name: 'Konfhub API', url: 'https://api.konfhub.com/event/list' },
  { name: 'Konfhub search API', url: 'https://api.konfhub.com/v1/events?city=Bangalore' },
  { name: 'Hasgeek home', url: 'https://hasgeek.com/' },
  { name: 'Hasgeek JSON', url: 'https://hasgeek.com/api/1/events' },
  { name: 'Commudle events', url: 'https://www.commudle.com/events' },
  { name: 'Commudle API', url: 'https://api.commudle.com/api/v2/events' },
  { name: 'Townscript Bangalore', url: 'https://www.townscript.com/in/bangalore/technology' },
  { name: 'Kommunity BLR', url: 'https://kommunity.com/explore?city=bangalore' },
  { name: '10times Bangalore tech', url: 'https://10times.com/bangalore-in/technology' },
  { name: 'Eventshigh Bangalore', url: 'https://eventshigh.com/bangalore' },

  // ── Consumer platforms (breadth beyond tech) ──
  { name: 'District (Zomato)', url: 'https://www.district.in/bengaluru' },
  { name: 'District API', url: 'https://api.district.in/rest/v1/events?city=bengaluru' },
  { name: 'Insider.in', url: 'https://insider.in/bengaluru' },
  { name: 'BookMyShow events', url: 'https://in.bookmyshow.com/explore/events-bengaluru' },

  // ── Developer / hackathon ──
  { name: 'Devpost hackathons', url: 'https://devpost.com/api/hackathons?search=india' },
  { name: 'Commudle Bangalore', url: 'https://www.commudle.com/communities' },
  { name: 'MS Reactor', url: 'https://developer.microsoft.com/en-us/reactor/' },
];

const BLR = /bengaluru|bangalore/i;

interface Result {
  name: string;
  url: string;
  status: number | string;
  type: string;
  bytes: number;
  jsonld: number;
  nextData: boolean;
  apiHints: string[];
  blrHits: number;
  eventish: boolean;
  samples: string[];
  note?: string;
}

/** Pull titles out of JSON-LD Event nodes, which is what the repo's adapters use. */
function jsonLdEvents(html: string): { count: number; titles: string[] } {
  const blocks = html.match(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  );
  if (!blocks) return { count: 0, titles: [] };
  const titles: string[] = [];
  let count = 0;
  for (const block of blocks) {
    const body = block.replace(/^[\s\S]*?>/, '').replace(/<\/script>$/i, '');
    try {
      const parsed = JSON.parse(body);
      const walk = (node: unknown): void => {
        if (Array.isArray(node)) return node.forEach(walk);
        if (!node || typeof node !== 'object') return;
        const obj = node as Record<string, unknown>;
        const type = obj['@type'];
        const types = Array.isArray(type) ? type : [type];
        if (types.some(t => typeof t === 'string' && /event/i.test(t))) {
          count++;
          if (typeof obj.name === 'string') titles.push(obj.name.slice(0, 58));
        }
        for (const v of Object.values(obj)) walk(v);
      };
      walk(parsed);
    } catch {
      // Malformed JSON-LD is common; skip it.
    }
  }
  return { count, titles };
}

async function probe(c: Candidate): Promise<Result> {
  const base: Result = {
    name: c.name, url: c.url, status: '---', type: '', bytes: 0,
    jsonld: 0, nextData: false, apiHints: [], blrHits: 0, eventish: false, samples: [],
  };
  try {
    const res = await fetch(c.url, {
      method: c.post ? 'POST' : 'GET',
      headers: {
        'User-Agent': UA,
        Accept: c.url.includes('api') ? 'application/json' : 'text/html,application/json',
        'Accept-Language': 'en-IN,en;q=0.9',
        ...(c.post ? { 'Content-Type': 'application/json' } : {}),
      },
      body: c.post ? JSON.stringify(c.post) : undefined,
      signal: AbortSignal.timeout(20000),
      redirect: 'follow',
    });

    base.status = res.status;
    base.type = (res.headers.get('content-type') || '').split(';')[0];
    const text = await res.text();
    base.bytes = text.length;
    base.blrHits = (text.match(BLR) || []).length;

    if (base.type.includes('json')) {
      try {
        const data = JSON.parse(text);
        // Find the first array of objects that look like events.
        const findRows = (node: unknown, depth = 0): Record<string, unknown>[] | null => {
          if (depth > 5 || !node || typeof node !== 'object') return null;
          if (Array.isArray(node)) {
            const objs = node.filter(x => x && typeof x === 'object') as Record<string, unknown>[];
            if (objs.length && objs.some(o => 'title' in o || 'name' in o || 'event_name' in o)) return objs;
            return null;
          }
          for (const v of Object.values(node as Record<string, unknown>)) {
            const hit = findRows(v, depth + 1);
            if (hit) return hit;
          }
          return null;
        };
        const rows = findRows(data);
        if (rows && rows.length) {
          base.eventish = true;
          base.samples = rows
            .slice(0, 4)
            .map(r => String(r.title || r.name || r.event_name || '?').slice(0, 58));
          base.note = `${rows.length} row(s) in JSON`;
        } else {
          base.note = 'JSON but no event-shaped rows';
        }
      } catch {
        base.note = 'invalid JSON';
      }
      return base;
    }

    // HTML path: is the data in the markup, or does it need a browser?
    const ld = jsonLdEvents(text);
    base.jsonld = ld.count;
    base.samples = ld.titles.slice(0, 4);
    base.nextData = /__NEXT_DATA__|__NUXT__|__remixContext/.test(text);
    base.eventish = ld.count > 0;

    // Any API endpoints referenced in the page are the real prize.
    const hints = new Set<string>();
    for (const m of text.matchAll(/["'](https?:\/\/[a-z0-9.-]*api[a-z0-9.-]*\/[^"'\s]{4,70})["']/gi)) {
      hints.add(m[1].slice(0, 70));
    }
    for (const m of text.matchAll(/["'](\/api\/[a-z0-9/_-]{3,50})["']/gi)) hints.add(m[1]);
    base.apiHints = [...hints].slice(0, 4);

    if (!base.eventish) {
      base.note = base.bytes < 60000 && base.nextData
        ? 'JS shell with embedded state — needs __NEXT_DATA__ parsing'
        : base.bytes < 20000
          ? 'tiny shell, no data in HTML'
          : 'HTML with no JSON-LD Event nodes';
    }
    return base;
  } catch (err) {
    base.note = (err instanceof Error ? err.message : String(err)).slice(0, 50);
    return base;
  }
}

async function main() {
  console.log(`Probing ${CANDIDATES.length} Indian event platforms…\n`);

  const results: Result[] = [];
  const CONCURRENCY = 5;
  let cursor = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (cursor < CANDIDATES.length) results.push(await probe(CANDIDATES[cursor++]));
    })
  );

  const viable = results.filter(r => r.eventish).sort((a, b) => b.blrHits - a.blrHits);
  const maybe = results.filter(r => !r.eventish && r.status === 200);
  const dead = results.filter(r => !r.eventish && r.status !== 200);

  console.log(`══ VIABLE — structured events in the response (${viable.length}) ══`);
  for (const r of viable) {
    console.log(`  ${r.name}  [${r.status} ${r.type} ${(r.bytes / 1024).toFixed(0)}KB]`);
    console.log(`     jsonld=${r.jsonld} blrMentions=${r.blrHits}  ${r.note || ''}`);
    for (const s of r.samples) console.log(`       · ${s}`);
  }

  console.log(`\n══ 200 BUT NO DATA IN RESPONSE (${maybe.length}) ══`);
  for (const r of maybe) {
    console.log(`  ${r.name}  [${(r.bytes / 1024).toFixed(0)}KB] ${r.note}`);
    console.log(`     blrMentions=${r.blrHits} nextData=${r.nextData}`);
    if (r.apiHints.length) console.log(`     api hints: ${r.apiHints.join('  ')}`);
  }

  console.log(`\n══ UNREACHABLE / ERROR (${dead.length}) ══`);
  for (const r of dead) console.log(`  ${String(r.status).padStart(4)} ${r.name}  ${r.note || ''}`);

  console.log(
    `\nVERDICT: ${viable.length} viable, ${maybe.length} need __NEXT_DATA__/API work, ${dead.length} dead.`
  );
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
