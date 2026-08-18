#!/usr/bin/env tsx
/**
 * Probe the platforms named in the user's curated "events I actually attended" list.
 *
 * WHY THIS LIST IS DIFFERENT from the earlier platform surveys: every entry here is a
 * community the user personally registered with over 12 months, so each one demonstrably
 * runs real Bengaluru tech events. That makes it a far better seed than guessing slugs
 * (0 of 35 guessed Meetup slugs existed) or guessing tenant hosts (5 of 36).
 *
 * The discipline is unchanged: nothing gets added to an adapter without evidence here.
 * A 200 that returns a client-rendered shell is NOT viable.
 *
 * Read-only. No DB writes.
 *
 * Run: npx tsx scripts/probe-attended-sources.ts
 */
import './load-env';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

const BLR = /bengaluru|bangalore/i;

interface Candidate {
  name: string;
  url: string;
  /** What we hope to find, for the report. */
  hope: string;
}

const CANDIDATES: Candidate[] = [
  // ── FOSS United — the single most important one. IndiaFOSS is the flagship Indian
  //    open-source conference and the user has a ticket. Frappe-based, so there may be
  //    a /api/method or /api/resource endpoint.
  { name: 'FOSS United — IndiaFOSS 2026', url: 'https://fossunited.org/c/indiafoss/2026', hope: 'JSON-LD or embedded data' },
  { name: 'FOSS United — events index', url: 'https://fossunited.org/events', hope: 'event list' },
  { name: 'FOSS United — Bangalore chapter', url: 'https://fossunited.org/c/bangalore', hope: 'chapter events' },
  { name: 'FOSS United — Frappe API (Event)', url: 'https://fossunited.org/api/resource/FOSS%20Event?limit_page_length=100', hope: 'Frappe REST' },
  { name: 'FOSS United — Frappe API (Meetup)', url: 'https://fossunited.org/api/resource/FOSS%20Meetup?limit_page_length=100', hope: 'Frappe REST' },

  // ── Global AI Community — ran AgentCon Bengaluru. Strong Bevy candidate.
  { name: 'Global AI Community (Bevy?)', url: 'https://globalai.community/api/search/event/?q=bangalore', hope: 'Bevy JSON' },
  { name: 'Global AI Community — chapters', url: 'https://globalai.community/chapters/', hope: 'chapter list' },

  // ── GDG Cloud Bengaluru specifically. The Bevy adapter already queries
  //    gdg.community.dev, but the audit measured only 1 Bengaluru event from it, which
  //    is implausible for an active chapter — so test the chapter endpoint directly.
  { name: 'GDG Cloud Bengaluru (chapter API)', url: 'https://gdg.community.dev/api/event/?chapter=gdg-cloud-bengaluru', hope: 'chapter events' },
  { name: 'GDG Bevy search q=bengaluru', url: 'https://gdg.community.dev/api/search/event/?q=bengaluru', hope: 'more than 1 hit' },

  // ── Atlassian Community (Khoros-based, ran the Bangalore Learning Camp)
  { name: 'Atlassian Community events', url: 'https://community.atlassian.com/forums/Events/ct-p/events', hope: 'JSON-LD' },

  // ── Indian hackathon platforms. hack2skill accounts for ~8 of the user's
  //    registrations, so it is the highest-frequency organiser in the whole list.
  { name: 'Hack2skill', url: 'https://hack2skill.com/', hope: 'embedded JSON' },
  { name: 'Hack2skill — explore', url: 'https://hack2skill.com/explore-hackathons', hope: 'listing' },
  { name: 'HackCulture', url: 'https://hackculture.in/', hope: 'listing' },
  { name: 'DevAarambh', url: 'https://devaarambh.com/', hope: 'listing' },
  { name: 'AI Camp', url: 'https://aicamp.ai/', hope: 'listing' },
  { name: 'lablab.ai', url: 'https://lablab.ai/event', hope: 'listing' },

  // ── Community platforms
  { name: 'nas.io — The Hub Bengaluru', url: 'https://nas.io/thehubbengaluru', hope: 'embedded JSON' },
  { name: 'nas.io API', url: 'https://api.nas.io/nas-io/v1/communities/thehubbengaluru', hope: 'JSON API' },

  // ── Conference organisers
  { name: 'Apidays India', url: 'https://www.apidays.co/india', hope: 'JSON-LD' },
  { name: 'FOST (joinfost.io)', url: 'https://joinfost.io/', hope: 'listing' },
];

interface Result {
  name: string;
  url: string;
  status: number | string;
  type: string;
  bytes: number;
  jsonld: number;
  ldTitles: string[];
  jsonRows: number;
  jsonTitles: string[];
  blrMentions: number;
  spa: boolean;
  apiHints: string[];
  note: string;
}

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
      const walk = (node: unknown): void => {
        if (Array.isArray(node)) return node.forEach(walk);
        if (!node || typeof node !== 'object') return;
        const obj = node as Record<string, unknown>;
        const t = obj['@type'];
        const types = Array.isArray(t) ? t : [t];
        if (types.some(x => typeof x === 'string' && /event/i.test(x))) {
          count++;
          if (typeof obj.name === 'string') titles.push(obj.name.slice(0, 56));
        }
        Object.values(obj).forEach(walk);
      };
      walk(JSON.parse(body));
    } catch {
      /* malformed ld+json is common */
    }
  }
  return { count, titles };
}

/** Find the first array of event-shaped objects anywhere in a JSON document. */
function findEventRows(node: unknown, depth = 0): Record<string, unknown>[] | null {
  if (depth > 6 || !node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    const objs = node.filter(x => x && typeof x === 'object') as Record<string, unknown>[];
    const looksLikeEvents = objs.some(
      o => 'title' in o || 'name' in o || 'event_name' in o || 'event_title' in o
    );
    if (objs.length > 0 && looksLikeEvents) return objs;
    for (const child of node) {
      const hit = findEventRows(child, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  for (const v of Object.values(node as Record<string, unknown>)) {
    const hit = findEventRows(v, depth + 1);
    if (hit) return hit;
  }
  return null;
}

async function probe(c: Candidate): Promise<Result> {
  const r: Result = {
    name: c.name, url: c.url, status: '---', type: '', bytes: 0,
    jsonld: 0, ldTitles: [], jsonRows: 0, jsonTitles: [],
    blrMentions: 0, spa: false, apiHints: [], note: '',
  };
  try {
    const res = await fetch(c.url, {
      headers: {
        'User-Agent': UA,
        // Ask for JSON first: several of these hosts content-negotiate, which is
        // exactly how the HasGeek search endpoint was missed the first time.
        Accept: 'application/json, text/html;q=0.9',
        'Accept-Language': 'en-IN,en;q=0.9',
        'X-Requested-With': 'XMLHttpRequest',
      },
      signal: AbortSignal.timeout(20000),
      redirect: 'follow',
    });
    r.status = res.status;
    r.type = (res.headers.get('content-type') || '').split(';')[0];
    const text = await res.text();
    r.bytes = text.length;
    r.blrMentions = (text.match(BLR) || []).length;

    if (r.type.includes('json')) {
      try {
        const rows = findEventRows(JSON.parse(text));
        if (rows) {
          r.jsonRows = rows.length;
          r.jsonTitles = rows
            .slice(0, 5)
            .map(o => String(o.title || o.name || o.event_name || o.event_title || '?').slice(0, 56));
          r.note = 'JSON with event-shaped rows';
        } else {
          r.note = 'JSON, no event-shaped rows';
        }
      } catch {
        r.note = 'invalid JSON';
      }
      return r;
    }

    const ld = jsonLdEvents(text);
    r.jsonld = ld.count;
    r.ldTitles = ld.titles.slice(0, 5);
    r.spa = /__NEXT_DATA__|__NUXT__|window\.__INITIAL|ng-version|__remixContext/.test(text);

    const hints = new Set<string>();
    for (const m of text.matchAll(/["'](https?:\/\/[a-z0-9.-]*(?:api|frappe)[a-z0-9.-]*\/[^"'\s]{4,72})["']/gi))
      hints.add(m[1].slice(0, 72));
    for (const m of text.matchAll(/["'](\/api\/[a-z0-9/_.%-]{3,60})["']/gi)) hints.add(m[1]);
    r.apiHints = [...hints].slice(0, 5);

    if (r.jsonld === 0) {
      r.note = r.spa
        ? `SPA shell (${(r.bytes / 1024).toFixed(0)}KB) — data loaded client-side`
        : r.bytes < 20000
          ? 'tiny shell, no data'
          : 'HTML, no JSON-LD Event nodes';
    } else {
      r.note = `${r.jsonld} JSON-LD Event node(s)`;
    }
    return r;
  } catch (err) {
    r.note = (err instanceof Error ? err.message : String(err)).slice(0, 54);
    return r;
  }
}

async function main() {
  console.log(`Probing ${CANDIDATES.length} platforms from the attended-events list…\n`);

  const results: Result[] = [];
  const CONCURRENCY = 5;
  let cursor = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (cursor < CANDIDATES.length) results.push(await probe(CANDIDATES[cursor++]));
    })
  );
  // Keep the declared order so the report reads like the list.
  results.sort((a, b) => CANDIDATES.findIndex(c => c.url === a.url) - CANDIDATES.findIndex(c => c.url === b.url));

  const viable = results.filter(r => r.jsonld > 0 || r.jsonRows > 0);
  const shells = results.filter(r => r.jsonld === 0 && r.jsonRows === 0 && r.status === 200);
  const dead = results.filter(r => r.status !== 200);

  console.log(`══ VIABLE (${viable.length}) ══`);
  for (const r of viable) {
    console.log(`  ${r.name}`);
    console.log(`     ${r.status} ${r.type} ${(r.bytes / 1024).toFixed(0)}KB · blr=${r.blrMentions} · ${r.note}`);
    for (const t of [...r.ldTitles, ...r.jsonTitles]) console.log(`       · ${t}`);
  }

  console.log(`\n══ 200 BUT NO DATA IN RESPONSE (${shells.length}) ══`);
  for (const r of shells) {
    console.log(`  ${r.name} — ${r.note} · blr=${r.blrMentions}`);
    if (r.apiHints.length) console.log(`     api hints: ${r.apiHints.join('  ')}`);
  }

  console.log(`\n══ NOT 200 (${dead.length}) ══`);
  for (const r of dead) console.log(`  ${String(r.status).padStart(4)}  ${r.name}  ${r.note}`);

  console.log(`\nVERDICT: ${viable.length} viable, ${shells.length} client-rendered, ${dead.length} unreachable.`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
