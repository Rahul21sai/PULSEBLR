#!/usr/bin/env tsx
/**
 * READ-ONLY probe: do INDIA'S OWN ticketing / conference platforms expose
 * machine-readable Bengaluru tech events IN THE HTTP RESPONSE ITSELF?
 *
 * Context: company event microsites were already probed and rejected
 * (probe-event-microsites.ts, probe-microsites-round2.ts). scripts/probe-india-platforms.ts
 * took a first pass at Indian platforms with ONE url per platform; this goes deeper —
 * multiple plausible JSON endpoints per platform, real __NEXT_DATA__ / __NUXT__ /
 * embedded-JSON parsing (not just "the string is present"), sitemap probes, and a
 * follow-up pass that fetches actual EVENT DETAIL pages, because a client-rendered
 * listing page plus JSON-LD-bearing detail pages is still viable via universal.ts.
 *
 * A 200 that returns an empty JS shell is NOT viable and is reported as a zero.
 *
 * Writes nothing. Run: npx tsx scripts/probe-india-ticketing.ts
 */
import './load-env';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const TIMEOUT = 20000;
const CONCURRENCY = 4;
const BLR = /bengaluru|bangalore/i;

interface Candidate {
  platform: string;
  name: string;
  url: string;
  post?: unknown;
  headers?: Record<string, string>;
}

// ── Phase 1 candidates ──────────────────────────────────────────────────────
const CANDIDATES: Candidate[] = [
  // ── Konfhub ──
  { platform: 'konfhub', name: 'home', url: 'https://konfhub.com/' },
  { platform: 'konfhub', name: 'explore page', url: 'https://konfhub.com/explore' },
  { platform: 'konfhub', name: 'explore?city=Bangalore', url: 'https://konfhub.com/explore?city=Bangalore' },
  { platform: 'konfhub', name: 'api /event/list', url: 'https://api.konfhub.com/event/list' },
  { platform: 'konfhub', name: 'api /events', url: 'https://api.konfhub.com/events' },
  { platform: 'konfhub', name: 'api /event/all', url: 'https://api.konfhub.com/event/all' },
  { platform: 'konfhub', name: 'api /explore', url: 'https://api.konfhub.com/explore' },
  { platform: 'konfhub', name: 'api /event/explore', url: 'https://api.konfhub.com/event/explore' },
  { platform: 'konfhub', name: 'api v2 /events/list', url: 'https://api.konfhub.com/v2/events/list' },
  { platform: 'konfhub', name: 'next api /events', url: 'https://konfhub.com/api/events' },
  { platform: 'konfhub', name: 'sitemap.xml', url: 'https://konfhub.com/sitemap.xml' },
  { platform: 'konfhub', name: 'robots.txt', url: 'https://konfhub.com/robots.txt' },

  // ── Townscript ──
  { platform: 'townscript', name: 'in/bangalore', url: 'https://www.townscript.com/in/bangalore' },
  { platform: 'townscript', name: 'in/bangalore/technology', url: 'https://www.townscript.com/in/bangalore/technology' },
  { platform: 'townscript', name: 'browse/bangalore', url: 'https://www.townscript.com/browse/bangalore' },
  { platform: 'townscript', name: 'api v1 event/search', url: 'https://www.townscript.com/api/v1/event/search?city=Bangalore' },
  { platform: 'townscript', name: 'api v2 discover', url: 'https://www.townscript.com/api/v2/discover/events?city=bangalore' },
  { platform: 'townscript', name: 'ts-api search', url: 'https://api.townscript.com/api/v1/event/search?city=Bangalore' },
  { platform: 'townscript', name: 'discover api (search-city)', url: 'https://www.townscript.com/discover/api/search?city=bangalore&category=technology' },
  { platform: 'townscript', name: 'sitemap.xml', url: 'https://www.townscript.com/sitemap.xml' },
  { platform: 'townscript', name: 'robots.txt', url: 'https://www.townscript.com/robots.txt' },

  // ── HasGeek / Funnel ──
  { platform: 'hasgeek', name: 'home', url: 'https://hasgeek.com/' },
  { platform: 'hasgeek', name: 'home Accept:json', url: 'https://hasgeek.com/', headers: { Accept: 'application/json' } },
  { platform: 'hasgeek', name: 'api/1/events', url: 'https://hasgeek.com/api/1/events' },
  { platform: 'hasgeek', name: 'api/1/project/all', url: 'https://hasgeek.com/api/1/project/all' },
  { platform: 'hasgeek', name: 'api/1/events.ics', url: 'https://hasgeek.com/api/1/events.ics' },
  { platform: 'hasgeek', name: 'search?q=bangalore', url: 'https://hasgeek.com/search?q=bangalore&type=project' },
  { platform: 'hasgeek', name: 'sitemap.xml', url: 'https://hasgeek.com/sitemap.xml' },
  { platform: 'hasgeek', name: 'robots.txt', url: 'https://hasgeek.com/robots.txt' },
  { platform: 'hasgeek', name: 'json feed guess', url: 'https://hasgeek.com/json' },

  // ── Commudle ──
  { platform: 'commudle', name: 'all-events page', url: 'https://www.commudle.com/all-events' },
  { platform: 'commudle', name: 'api v2 events', url: 'https://api.commudle.com/api/v2/events' },
  { platform: 'commudle', name: 'api v2 all_events', url: 'https://api.commudle.com/api/v2/all_events?page=1&count=30' },
  { platform: 'commudle', name: 'api v2 events/upcoming', url: 'https://api.commudle.com/api/v2/events/upcoming?page=1&count=30' },
  { platform: 'commudle', name: 'api v2 home/upcoming_events', url: 'https://api.commudle.com/api/v2/home/upcoming_events' },
  { platform: 'commudle', name: 'api v2 search?q=bangalore', url: 'https://api.commudle.com/api/v2/search?q=bangalore' },
  { platform: 'commudle', name: 'api v1 events', url: 'https://api.commudle.com/api/v1/events' },
  { platform: 'commudle', name: 'sitemap.xml', url: 'https://www.commudle.com/sitemap.xml' },

  // ── Kommunity ──
  { platform: 'kommunity', name: 'home', url: 'https://kommunity.com/' },
  { platform: 'kommunity', name: 'explore?city=bangalore', url: 'https://kommunity.com/explore?city=bangalore' },
  { platform: 'kommunity', name: 'events search', url: 'https://kommunity.com/events?city=bangalore' },
  { platform: 'kommunity', name: 'api events', url: 'https://kommunity.com/api/events?city=bangalore' },
  { platform: 'kommunity', name: 'gateway api', url: 'https://api.kommunity.com/api/v1/events?city=bangalore' },
  { platform: 'kommunity', name: 'sitemap.xml', url: 'https://kommunity.com/sitemap.xml' },
  { platform: 'kommunity', name: 'robots.txt', url: 'https://kommunity.com/robots.txt' },

  // ── 10times ──
  { platform: '10times', name: 'bangalore technology', url: 'https://10times.com/bangalore-in/technology' },
  { platform: '10times', name: 'bangalore all', url: 'https://10times.com/bangalore-in' },
  { platform: '10times', name: 'ajax loadmore', url: 'https://10times.com/ajax?for=eventList&city=bangalore&page=1' },
  { platform: '10times', name: 'api events', url: 'https://10times.com/api/events?city=bangalore' },
  { platform: '10times', name: 'sitemap.xml', url: 'https://10times.com/sitemap.xml' },
  { platform: '10times', name: 'robots.txt', url: 'https://10times.com/robots.txt' },

  // ── Eventshigh ──
  { platform: 'eventshigh', name: 'bangalore', url: 'https://eventshigh.com/bangalore' },
  { platform: 'eventshigh', name: 'bangalore/tech', url: 'https://eventshigh.com/bangalore/tech' },
  { platform: 'eventshigh', name: 'api events', url: 'https://eventshigh.com/api/events?city=bangalore' },
  { platform: 'eventshigh', name: 'api v1 city feed', url: 'https://api.eventshigh.com/v1/events?city=bangalore' },
  { platform: 'eventshigh', name: 'sitemap.xml', url: 'https://eventshigh.com/sitemap.xml' },
  { platform: 'eventshigh', name: 'robots.txt', url: 'https://eventshigh.com/robots.txt' },
];

// ── Fetch helper ────────────────────────────────────────────────────────────
interface Resp {
  status: number | string;
  type: string;
  bytes: number;
  text: string;
  err?: string;
}

async function get(c: Candidate): Promise<Resp> {
  try {
    const res = await fetch(c.url, {
      method: c.post ? 'POST' : 'GET',
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-IN,en;q=0.9',
        ...(c.post ? { 'Content-Type': 'application/json' } : {}),
        ...(c.headers || {}),
      },
      body: c.post ? JSON.stringify(c.post) : undefined,
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT),
    });
    const text = await res.text();
    return {
      status: res.status,
      type: (res.headers.get('content-type') || '').split(';')[0],
      bytes: text.length,
      text,
    };
  } catch (err) {
    return {
      status: 'ERR',
      type: '-',
      bytes: 0,
      text: '',
      err: (err instanceof Error ? err.message : String(err)).slice(0, 90),
    };
  }
}

// ── Event-shape detection ───────────────────────────────────────────────────
const TITLE_KEYS = ['title', 'name', 'event_name', 'eventName', 'displayName'];
const DATE_KEYS = [
  'start_at', 'starts_at', 'startDate', 'start_date', 'startTime', 'start_time',
  'dateTime', 'date', 'start', 'event_start_date', 'startDateTime', 'from_date',
];
const VENUE_KEYS = [
  'venue', 'location', 'address', 'city', 'place', 'venue_name', 'venueName',
  'venue_address', 'geo', 'locality',
];

interface EventRow {
  title: string;
  date: string;
  venue: string;
  path: string;
}

function firstString(o: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && v > 1_000_000) return String(v);
    if (v && typeof v === 'object') {
      const nested = v as Record<string, unknown>;
      for (const nk of ['name', 'title', 'city', 'address', 'addressLocality', 'venue_name']) {
        const nv = nested[nk];
        if (typeof nv === 'string' && nv.trim()) return nv.trim();
      }
    }
    if (Array.isArray(v) && v.length && typeof v[0] === 'number') return String(v[0]);
  }
  return '';
}

/** Walk any JSON value and collect objects that look like real events. */
function harvest(root: unknown, label: string, maxDepth = 9): EventRow[] {
  const out: EventRow[] = [];
  const seen = new Set<unknown>();
  const walk = (node: unknown, path: string, depth: number) => {
    if (depth > maxDepth || node === null || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      node.slice(0, 200).forEach((v, i) => walk(v, `${path}[${i}]`, depth + 1));
      return;
    }
    const o = node as Record<string, unknown>;
    const title = firstString(o, TITLE_KEYS);
    const date = firstString(o, DATE_KEYS);
    const venue = firstString(o, VENUE_KEYS);
    // Require a title AND a date to count it as an event object. Venue is recorded
    // separately so we can say honestly whether venue is present.
    if (title.length > 3 && date && /\d/.test(date)) {
      out.push({ title: title.slice(0, 70), date: String(date).slice(0, 30), venue: venue.slice(0, 40), path: `${label}${path}` });
    }
    for (const [k, v] of Object.entries(o)) walk(v, `${path}.${k}`, depth + 1);
  };
  walk(root, '', 0);
  return out;
}

function jsonLdRows(html: string): EventRow[] {
  const blocks = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  const rows: EventRow[] = [];
  for (const b of blocks) {
    try {
      const parsed = JSON.parse(b[1].trim());
      const walk = (n: unknown) => {
        if (Array.isArray(n)) return n.forEach(walk);
        if (!n || typeof n !== 'object') return;
        const o = n as Record<string, unknown>;
        const t = Array.isArray(o['@type']) ? o['@type'] : [o['@type']];
        if (t.some(x => typeof x === 'string' && /Event/i.test(x))) {
          rows.push({
            title: String(o.name || '').slice(0, 70),
            date: String(o.startDate || '').slice(0, 30),
            venue: firstString(o, ['location', 'address']).slice(0, 40),
            path: 'json-ld',
          });
        }
        Object.values(o).forEach(walk);
      };
      walk(parsed);
    } catch {
      /* malformed */
    }
  }
  return rows;
}

function extractEmbedded(html: string): { label: string; json: unknown }[] {
  const out: { label: string; json: unknown }[] = [];
  const patterns: [string, RegExp][] = [
    ['__NEXT_DATA__', /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i],
    ['__NUXT__', /window\.__NUXT__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/i],
    ['__INITIAL_STATE__', /window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/i],
    ['__APOLLO_STATE__', /window\.__APOLLO_STATE__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/i],
    ['ng-state', /<script[^>]*id=["']ng-state["'][^>]*>([\s\S]*?)<\/script>/i],
    ['serverApp-state', /<script[^>]*id=["']serverApp-state["'][^>]*>([\s\S]*?)<\/script>/i],
  ];
  for (const [label, re] of patterns) {
    const m = html.match(re);
    if (!m) continue;
    try {
      out.push({ label, json: JSON.parse(m[1].trim()) });
    } catch {
      out.push({ label: `${label}(unparseable)`, json: null });
    }
  }
  return out;
}

function apiHints(html: string): string[] {
  const hits = new Set<string>();
  for (const m of html.matchAll(/["'`](https?:\/\/[a-z0-9.-]*(?:api|gateway|graphql)[a-z0-9.-]*\/[^"'`\s]{3,80})["'`]/gi)) hits.add(m[1]);
  for (const m of html.matchAll(/["'`](\/(?:api|graphql|_next\/data)\/[a-z0-9/_.?=&-]{3,70})["'`]/gi)) hits.add(m[1]);
  return [...hits].slice(0, 8);
}

// ── Report ──────────────────────────────────────────────────────────────────
interface Finding {
  platform: string;
  name: string;
  url: string;
  status: number | string;
  type: string;
  bytes: number;
  mechanism: string;
  rows: EventRow[];
  blrRows: number;
  shells: string[];
  hints: string[];
  note: string;
}

async function probeOne(c: Candidate): Promise<Finding> {
  const r = await get(c);
  const f: Finding = {
    platform: c.platform, name: c.name, url: c.url,
    status: r.status, type: r.type, bytes: r.bytes,
    mechanism: 'none', rows: [], blrRows: 0, shells: [], hints: [],
    note: r.err || '',
  };
  if (!r.text) return f;

  const isXml = r.type.includes('xml') || r.text.trimStart().startsWith('<?xml');

  // ICS
  if (/BEGIN:VEVENT/.test(r.text)) {
    const n = (r.text.match(/BEGIN:VEVENT/g) || []).length;
    f.mechanism = `ICS(${n} VEVENT)`;
    const titles = [...r.text.matchAll(/^SUMMARY[^:]*:(.+)$/gm)].map(m => m[1].trim());
    const dates = [...r.text.matchAll(/^DTSTART[^:]*:(.+)$/gm)].map(m => m[1].trim());
    f.rows = titles.slice(0, 200).map((t, i) => ({ title: t.slice(0, 70), date: dates[i] || '', venue: '', path: 'ics' }));
  }
  // RSS / Atom
  else if (isXml && /<item>|<entry>/i.test(r.text)) {
    const items = (r.text.match(/<item>|<entry>/gi) || []).length;
    f.mechanism = `RSS/Atom(${items} items)`;
    f.rows = [...r.text.matchAll(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/gi)]
      .slice(1, 200)
      .map(m => ({ title: m[1].trim().slice(0, 70), date: '', venue: '', path: 'rss' }));
  }
  // Sitemap
  else if (isXml && /<urlset|<sitemapindex/i.test(r.text)) {
    const urls = [...r.text.matchAll(/<loc>([\s\S]*?)<\/loc>/gi)].map(m => m[1].trim());
    f.mechanism = `sitemap(${urls.length} locs)`;
    f.note = urls.slice(0, 3).join(' ');
    (f as Finding & { locs?: string[] }).locs = urls;
  }
  // JSON
  else if (r.type.includes('json') || /^[[{]/.test(r.text.trim())) {
    try {
      const parsed = JSON.parse(r.text);
      f.rows = harvest(parsed, 'json');
      f.mechanism = f.rows.length ? `JSON API(${f.rows.length} event rows)` : 'JSON (no event-shaped rows)';
      if (!f.rows.length) {
        f.note = `keys=${Array.isArray(parsed) ? `array[${parsed.length}]` : Object.keys(parsed as object).slice(0, 10).join(',')}`;
      }
    } catch {
      f.mechanism = 'invalid JSON';
      f.note = r.text.slice(0, 120).replace(/\s+/g, ' ');
    }
  }
  // Plain text (robots.txt etc.)
  else if (r.type.includes('text/plain')) {
    f.mechanism = 'text';
    const sm = [...r.text.matchAll(/Sitemap:\s*(\S+)/gi)].map(m => m[1]);
    f.note = sm.length ? `sitemaps: ${sm.slice(0, 4).join(' ')}` : r.text.slice(0, 100).replace(/\s+/g, ' ');
    (f as Finding & { locs?: string[] }).locs = sm;
  }
  // HTML
  else {
    const ld = jsonLdRows(r.text);
    const embedded = extractEmbedded(r.text);
    f.shells = embedded.map(e => e.label);
    let embRows: EventRow[] = [];
    for (const e of embedded) {
      if (e.json) embRows = embRows.concat(harvest(e.json, e.label));
    }
    f.hints = apiHints(r.text);
    if (ld.length) {
      f.rows = ld;
      f.mechanism = `JSON-LD(${ld.length} Event nodes)`;
      if (embRows.length) f.mechanism += ` + ${f.shells.join('/')}(${embRows.length})`;
    } else if (embRows.length) {
      f.rows = embRows;
      f.mechanism = `${f.shells.join('/')}(${embRows.length} event rows)`;
    } else {
      f.mechanism = 'none';
      f.note = f.shells.length
        ? `shell present (${f.shells.join(',')}) but 0 event objects inside`
        : r.bytes < 20000
          ? `tiny HTML shell, no data (${r.bytes}B)`
          : 'HTML, no JSON-LD / no embedded state with events';
    }
  }

  f.blrRows = f.rows.filter(x => BLR.test(x.title + ' ' + x.venue)).length;
  return f;
}

async function runPool<T, R>(items: T[], fn: (t: T) => Promise<R>, n = CONCURRENCY): Promise<R[]> {
  const out: R[] = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    })
  );
  return out;
}

function printFindings(findings: Finding[]) {
  let last = '';
  for (const f of findings) {
    if (f.platform !== last) {
      console.log(`\n── ${f.platform.toUpperCase()} ${'─'.repeat(Math.max(0, 58 - f.platform.length))}`);
      last = f.platform;
    }
    const good = f.rows.length > 0;
    const mark = good ? 'YES' : typeof f.status === 'number' && f.status < 400 ? ' — ' : 'ERR';
    console.log(
      `${mark} [${String(f.status).padEnd(5)}] ${f.name.padEnd(28)} ${String(f.bytes).padStart(8)}B ${(f.type || '-').padEnd(17)} ${f.mechanism}`
    );
    if (f.blrRows) console.log(`        blr-matching rows: ${f.blrRows}/${f.rows.length}`);
    for (const s of f.rows.slice(0, 4)) {
      console.log(`        · "${s.title}" | date="${s.date}" | venue="${s.venue}"`);
    }
    if (f.note) console.log(`        note: ${f.note.slice(0, 220)}`);
    if (!good && f.hints.length) console.log(`        api hints: ${f.hints.slice(0, 5).join('  ')}`);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// ROUND 2 — drill into what round 1 turned up. Run: --round2
// ════════════════════════════════════════════════════════════════════════════
async function locsOf(url: string): Promise<string[]> {
  const r = await get({ platform: '', name: '', url });
  return [...r.text.matchAll(/<loc>([\s\S]*?)<\/loc>/gi)].map(m => m[1].trim());
}

async function round2() {
  // ── 2a. HasGeek search API: shape, pagination, totals ──
  console.log(`\n=== 2a. HASGEEK /search — shape + pagination ===`);
  for (const q of [
    'https://hasgeek.com/search?q=bangalore&type=project',
    'https://hasgeek.com/search?q=bangalore&type=project&page=2',
    'https://hasgeek.com/search?q=bengaluru&type=project',
    'https://hasgeek.com/search?q=*&type=project',
    'https://hasgeek.com/search?q=kubernetes&type=project',
    'https://hasgeek.com/search?q=bangalore&type=session',
  ]) {
    const r = await get({ platform: 'hasgeek', name: q, url: q });
    let shape = '';
    let rows: EventRow[] = [];
    let counts = '';
    try {
      const j = JSON.parse(r.text) as Record<string, unknown>;
      shape = Object.keys(j).slice(0, 12).join(',');
      const res = j.results as Record<string, unknown> | undefined;
      if (res) {
        counts = Object.entries(res)
          .map(([k, v]) => {
            const o = v as Record<string, unknown>;
            return `${k}:count=${o?.count ?? '?'}/items=${Array.isArray(o?.items) ? (o.items as unknown[]).length : '?'}`;
          })
          .join(' ');
      }
      rows = harvest(j, '');
    } catch {
      shape = 'not JSON: ' + r.text.slice(0, 60).replace(/\s+/g, ' ');
    }
    console.log(`  [${r.status} ${r.type} ${r.bytes}B] ${q.replace('https://hasgeek.com/search?', '')}`);
    console.log(`     top-keys=${shape}`);
    if (counts) console.log(`     results=${counts}`);
    console.log(`     harvested rows=${rows.length}, blr=${rows.filter(x => BLR.test(x.title + x.venue)).length}`);
    for (const s of rows.slice(0, 3)) console.log(`       · "${s.title}" | ${s.date} | ${s.venue}`);
  }

  // ── 2b. HasGeek: one raw result object, verbatim keys ──
  console.log(`\n=== 2b. HASGEEK raw result object (are title/date/venue really there?) ===`);
  {
    const r = await get({ platform: '', name: '', url: 'https://hasgeek.com/search?q=bangalore&type=project' });
    try {
      const j = JSON.parse(r.text) as Record<string, unknown>;
      const items = ((j.results as Record<string, unknown>)?.project as Record<string, unknown>)?.items as unknown[];
      console.log(`  items=${Array.isArray(items) ? items.length : 'n/a'}`);
      if (Array.isArray(items) && items[0]) {
        console.log('  first item keys: ' + Object.keys(items[0] as object).join(','));
        console.log('  first item JSON: ' + JSON.stringify(items[0]).slice(0, 1400));
      }
    } catch (e) {
      console.log('  parse failed', e);
    }
  }

  // ── 2c. Townscript: real /e/ detail pages from the upcoming sitemap ──
  console.log(`\n=== 2c. TOWNSCRIPT event detail pages (/e/<slug>) ===`);
  const tsLocs = await locsOf('https://www.townscript.com/sitemap/upcoming-event-pages.xml');
  console.log(`  upcoming sitemap locs=${tsLocs.length}`);
  const tsPick = tsLocs.slice(0, 4);
  const tsFind = await runPool(
    tsPick.map(u => ({ platform: 'townscript', name: u.split('/e/')[1]?.slice(0, 30) || u, url: u })),
    probeOne,
    3
  );
  printFindings(tsFind);

  // ── 2d. Commudle: real event detail pages + the json.commudle.com host ──
  console.log(`\n=== 2d. COMMUDLE event detail pages + json.commudle.com host ===`);
  const cmLocs = await locsOf('https://json.commudle.com/sitemaps/sitemap_events.xml');
  console.log(`  event sitemap locs=${cmLocs.length}`);
  const cmFind = await runPool(
    [
      ...cmLocs.slice(0, 3).map(u => ({ platform: 'commudle', name: 'detail ' + u.split('/').pop()!.slice(0, 28), url: u })),
      { platform: 'commudle', name: 'json host: api v2 all_events', url: 'https://json.commudle.com/api/v2/all_events?page=1&count=20' },
      { platform: 'commudle', name: 'json host: root', url: 'https://json.commudle.com/' },
      { platform: 'commudle', name: 'api v2 (retry after 503)', url: 'https://api.commudle.com/api/v2/all_events?page=1&count=20' },
    ],
    probeOne,
    3
  );
  printFindings(cmFind);

  // ── 2e. Konfhub: what IS in __NEXT_DATA__, and the CDN sitemap ──
  console.log(`\n=== 2e. KONFHUB __NEXT_DATA__ contents + CDN sitemap ===`);
  for (const u of ['https://konfhub.com/events', 'https://konfhub.com/']) {
    const r = await get({ platform: '', name: '', url: u });
    const m = r.text.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
    console.log(`  ${u} [${r.status} ${r.bytes}B] __NEXT_DATA__=${m ? m[1].length + 'B' : 'ABSENT'}`);
    if (m) {
      try {
        const j = JSON.parse(m[1]) as Record<string, unknown>;
        const props = (j.props as Record<string, unknown>)?.pageProps as Record<string, unknown> | undefined;
        console.log(`     top=${Object.keys(j).join(',')}  pageProps=${props ? Object.keys(props).join(',') || '(empty object)' : 'none'}`);
        console.log(`     pageProps JSON (first 500B)=${JSON.stringify(props ?? null).slice(0, 500)}`);
      } catch (e) {
        console.log('     __NEXT_DATA__ parse failed:', String(e).slice(0, 80));
      }
    }
  }
  const khLocs = await locsOf('https://files.konfhub.com/konfhub-sitemap/81fae46e2653383477759a342e742aa5.xml');
  console.log(`  CDN sitemap locs=${khLocs.length}; samples: ${khLocs.slice(0, 4).join(' ')}`);
  if (khLocs.length) {
    const khFind = await runPool(
      khLocs.slice(0, 3).map(u => ({ platform: 'konfhub', name: 'detail ' + u.split('/').pop()!.slice(0, 28), url: u })),
      probeOne,
      3
    );
    printFindings(khFind);
  }

  // ── 2f. Eventshigh: does the host even resolve? ──
  console.log(`\n=== 2f. EVENTSHIGH reachability ===`);
  for (const u of [
    'https://eventshigh.com/',
    'https://www.eventshigh.com/',
    'http://eventshigh.com/bangalore',
    'https://eventshigh.com/bangalore/all',
  ]) {
    const r = await get({ platform: '', name: '', url: u });
    console.log(`  ${u} → ${r.status} ${r.type} ${r.bytes}B ${r.err || ''}`);
  }

  // ── 2g. 10times: is the 403 a blanket bot block? ──
  console.log(`\n=== 2g. 10TIMES 403 nature ===`);
  for (const h of [
    {},
    { Referer: 'https://10times.com/', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'same-origin', 'Upgrade-Insecure-Requests': '1' },
  ]) {
    const r = await get({ platform: '', name: '', url: 'https://10times.com/bangalore-in/technology', headers: h as Record<string, string> });
    console.log(`  headers=${Object.keys(h).length} → ${r.status} ${r.bytes}B body: ${r.text.slice(0, 200).replace(/\s+/g, ' ')}`);
  }

  // ── 2h. Kommunity: parse the __NUXT__ payload properly ──
  console.log(`\n=== 2h. KOMMUNITY __NUXT__ payload ===`);
  {
    const r = await get({ platform: '', name: '', url: 'https://kommunity.com/' });
    const m = r.text.match(/window\.__NUXT__\s*=\s*([\s\S]*?)<\/script>/i);
    console.log(`  __NUXT__ found=${!!m} raw len=${m ? m[1].length : 0}`);
    if (m) console.log(`  head: ${m[1].slice(0, 300).replace(/\s+/g, ' ')}`);
    const g = await get({ platform: '', name: '', url: 'https://api.kommunity.com/api/v1/events?city=bangalore' });
    console.log(`  gateway body: ${g.text.slice(0, 400)}`);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// ROUND 3 — quantify the two viable paths. Run: --round3
// ════════════════════════════════════════════════════════════════════════════
const TECH =
  /\b(ai|ml|llm|genai|agent|data|devops|cloud|kubernetes|k8s|docker|python|java(script)?|rust|go(lang)?|react|node|api|dev(eloper)?s?|engineer|engineering|tech|software|hardware|iot|embedded|robotic|security|cyber|blockchain|web3|hackathon|linux|open ?source|foss|sql|database|platform|frontend|backend|fullstack|sre|mlops|observability|conf(erence)?|summit|meetup|workshop|bootcamp|coding|program(ming)?|gdg|cncf|devfest)\b/i;

async function round3() {
  // ── 3a. HasGeek: exact JSON shape + how deep pagination goes ──
  console.log(`\n=== 3a. HASGEEK exact response shape ===`);
  const r = await get({ platform: '', name: '', url: 'https://hasgeek.com/search?q=bangalore&type=project' });
  let hgItems: Record<string, unknown>[] = [];
  try {
    const j = JSON.parse(r.text) as Record<string, unknown>;
    console.log('  counts =', JSON.stringify(j.counts));
    const res = j.results as Record<string, unknown>;
    console.log(
      `  results.count=${res.count} page=${res.page} pages=${res.pages} per_page=${res.per_page} has_next=${res.has_next}`
    );
    hgItems = (res.items as Record<string, unknown>[]) || [];
    console.log(`  results.items length=${hgItems.length}`);
    if (hgItems[0]) {
      console.log('  item[0] keys: ' + Object.keys(hgItems[0]).join(','));
      console.log('  item[0] JSON: ' + JSON.stringify(hgItems[0]).slice(0, 1600));
    }
  } catch (e) {
    console.log('  parse failed', e);
  }

  console.log(`\n=== 3b. HASGEEK: how many total Bengaluru projects, and how many are FUTURE? ===`);
  const now = Date.now();
  const seen = new Map<string, { title: string; start: string; venue: string; future: boolean }>();
  for (let page = 1; page <= 6; page++) {
    const rp = await get({
      platform: '', name: '',
      url: `https://hasgeek.com/search?q=bangalore&type=project&page=${page}`,
    });
    let items: Record<string, unknown>[] = [];
    let pages = 0;
    try {
      const j = JSON.parse(rp.text) as Record<string, unknown>;
      const res = j.results as Record<string, unknown>;
      pages = Number(res.pages || 0);
      items = (res.items as Record<string, unknown>[]) || [];
    } catch {
      console.log(`  page ${page}: not JSON (${rp.status} ${rp.type})`);
      break;
    }
    for (const it of items) {
      const title = String(it.title || it.name || '');
      const start = String(it.start_at || it.startDate || '');
      const venue = String(
        (it.location as string) || ((it.venue as Record<string, unknown>)?.title as string) || ''
      );
      const key = String(it.url || it.absolute_url || title);
      seen.set(key, { title, start, venue, future: start ? Date.parse(start) > now : false });
    }
    console.log(`  page ${page}: items=${items.length} pages=${pages} cumulative-unique=${seen.size}`);
    if (page >= pages) break;
  }
  const arr = [...seen.values()];
  const future = arr.filter(x => x.future);
  const futureTech = future.filter(x => TECH.test(x.title));
  console.log(`  TOTAL unique projects=${arr.length}`);
  console.log(`  with a parseable start date=${arr.filter(x => x.start).length}`);
  console.log(`  FUTURE (start > now)=${future.length}`);
  console.log(`  FUTURE and title looks tech=${futureTech.length}`);
  for (const x of future.slice(0, 12)) console.log(`    · ${x.start.slice(0, 16)} | "${x.title.slice(0, 62)}" | ${x.venue.slice(0, 40)}`);

  // ── 3c. Konfhub: sample the CDN sitemap and count Bengaluru + tech ──
  console.log(`\n=== 3c. KONFHUB: sample event detail pages, count Bengaluru + tech ===`);
  const khLocs = await locsOf('https://files.konfhub.com/konfhub-sitemap/81fae46e2653383477759a342e742aa5.xml');
  console.log(`  sitemap locs=${khLocs.length}`);
  // Sample evenly across the sitemap so we do not bias toward one era.
  const N = 30;
  const step = Math.max(1, Math.floor(khLocs.length / N));
  const sample = Array.from({ length: N }, (_, i) => khLocs[i * step]).filter(Boolean);
  const khRows = await runPool(
    sample,
    async url => {
      const rr = await get({ platform: '', name: '', url });
      const ld = jsonLdRows(rr.text);
      return { url, status: rr.status, bytes: rr.bytes, rows: ld };
    },
    3
  );
  let ldOk = 0, blr = 0, blrTech = 0, blrTechFuture = 0;
  const examples: string[] = [];
  for (const k of khRows) {
    if (!k.rows.length) {
      console.log(`  no-JSON-LD [${k.status} ${k.bytes}B] ${k.url}`);
      continue;
    }
    ldOk++;
    for (const row of k.rows) {
      const isBlr = BLR.test(row.venue + ' ' + row.title);
      const isTech = TECH.test(row.title);
      const isFuture = row.date ? Date.parse(row.date) > now : false;
      if (isBlr) blr++;
      if (isBlr && isTech) {
        blrTech++;
        if (isFuture) {
          blrTechFuture++;
          examples.push(`${row.date.slice(0, 16)} | "${row.title.slice(0, 58)}" | ${row.venue.slice(0, 34)}`);
        }
      }
      console.log(
        `  ${isBlr ? 'BLR' : '   '}${isTech ? '/TECH' : '     '}${isFuture ? '/FUT' : '    '} "${row.title.slice(0, 46)}" | ${row.date.slice(0, 16)} | ${row.venue.slice(0, 34)}`
      );
    }
  }
  console.log(`\n  sampled=${sample.length} withJsonLdEvent=${ldOk} bengaluru=${blr} bengaluru+tech=${blrTech} bengaluru+tech+future=${blrTechFuture}`);
  for (const e of examples) console.log(`    · ${e}`);
  console.log(`  → extrapolated Bengaluru-tech events across ${khLocs.length} sitemap urls ≈ ${Math.round((blrTech / sample.length) * khLocs.length)}`);

  // ── 3d. Kommunity API: is data:[] a param problem or genuinely empty? ──
  console.log(`\n=== 3d. KOMMUNITY api.kommunity.com — real API, any data? ===`);
  for (const u of [
    'https://api.kommunity.com/api/v1/events',
    'https://api.kommunity.com/api/v1/events?page=1&per_page=20',
    'https://api.kommunity.com/api/v1/communities',
    'https://api.kommunity.com/api/v1/events?search=bangalore',
    'https://api.kommunity.com/api/v1/cities',
  ]) {
    const rr = await get({ platform: '', name: '', url: u });
    let meta = '';
    try {
      const j = JSON.parse(rr.text) as Record<string, unknown>;
      const d = j.data;
      meta = `data=${Array.isArray(d) ? `array[${d.length}]` : typeof d} total=${(j.meta as Record<string, unknown>)?.total ?? '?'}`;
      if (Array.isArray(d) && d[0]) meta += ` firstKeys=${Object.keys(d[0] as object).slice(0, 10).join(',')}`;
    } catch {
      meta = 'not JSON: ' + rr.text.slice(0, 70).replace(/\s+/g, ' ');
    }
    console.log(`  [${rr.status} ${rr.bytes}B] ${u.replace('https://api.kommunity.com', '')} → ${meta}`);
  }

  // ── 3e. 10times: find a URL that is not 404 behind the CF pass, check JSON-LD ──
  console.log(`\n=== 3e. 10TIMES with navigate headers — which paths exist, any JSON-LD? ===`);
  const navHeaders = {
    Referer: 'https://10times.com/',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-origin',
    'Upgrade-Insecure-Requests': '1',
  };
  for (const u of [
    'https://10times.com/',
    'https://10times.com/bangalore-in',
    'https://10times.com/bangalore-in/technology',
    'https://10times.com/india/bangalore',
    'https://10times.com/bangalore',
    'https://10times.com/sitemap.xml',
    'https://10times.com/robots.txt',
  ]) {
    const rr = await get({ platform: '', name: '', url: u, headers: navHeaders });
    const ld = jsonLdRows(rr.text);
    const ldBlocks = (rr.text.match(/application\/ld\+json/g) || []).length;
    console.log(
      `  [${rr.status} ${rr.type} ${rr.bytes}B] ${u.replace('https://10times.com', '') || '/'} ldBlocks=${ldBlocks} ldEventNodes=${ld.length}`
    );
    for (const row of ld.slice(0, 3)) console.log(`      · "${row.title.slice(0, 52)}" | ${row.date} | ${row.venue.slice(0, 30)}`);
  }

  // ── 3f. Commudle 503: WAF or genuinely down? ──
  console.log(`\n=== 3f. COMMUDLE api 503 — WAF or down? ===`);
  for (const h of [
    {},
    { Origin: 'https://www.commudle.com', Referer: 'https://www.commudle.com/', Accept: 'application/json' },
  ]) {
    const rr = await get({
      platform: '', name: '',
      url: 'https://api.commudle.com/api/v2/all_events?page=1&count=5',
      headers: h as Record<string, string>,
    });
    console.log(`  headers=${Object.keys(h).length} → ${rr.status} ${rr.bytes}B ${rr.text.slice(0, 180).replace(/\s+/g, ' ')}`);
  }

  // ── 3g. Townscript: any per-event JSON behind the Angular shell? ──
  console.log(`\n=== 3g. TOWNSCRIPT per-event JSON attempts ===`);
  for (const u of [
    'https://www.townscript.com/api/v1/event/tech-learn-134030',
    'https://www.townscript.com/api/v2/event/details?eventCode=tech-learn-134030',
    'https://www.townscript.com/e/tech-learn-134030/data',
    'https://api.townscript.com/v1/event/tech-learn-134030',
  ]) {
    const rr = await get({ platform: '', name: '', url: u });
    console.log(`  [${rr.status} ${rr.type} ${rr.bytes}B] ${u} → ${rr.text.slice(0, 130).replace(/\s+/g, ' ')}`);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// ROUND 4 — fixes two measurement bugs in round 3:
//   (1) HasGeek dates/venues live under item.obj, not on the item itself.
//   (2) round 3 matched /bengaluru/ against a 34-char TRUNCATED venue string,
//       so "BNM Institute of Technology, 12th Main Road, … Bengaluru" scored 0.
// Run: --round4
// ════════════════════════════════════════════════════════════════════════════
async function round4() {
  const now = Date.now();

  // ── 4a. HasGeek, reading item.obj properly, all 17 pages ──
  console.log(`\n=== 4a. HASGEEK all pages, dates read from item.obj ===`);
  {
    const r0 = await get({ platform: '', name: '', url: 'https://hasgeek.com/search?q=bangalore&type=project' });
    const j0 = JSON.parse(r0.text) as Record<string, unknown>;
    const obj0 = ((j0.results as Record<string, unknown>).items as Record<string, unknown>[])[0].obj as Record<string, unknown>;
    console.log('  item.obj keys: ' + Object.keys(obj0).join(','));
    console.log('  obj.start_at=' + JSON.stringify(obj0.start_at) + ' obj.end_at=' + JSON.stringify(obj0.end_at));
    console.log('  obj.location=' + JSON.stringify(obj0.location) + ' obj.timezone=' + JSON.stringify(obj0.timezone));
    console.log('  obj.primary_venue=' + String(JSON.stringify(obj0.primary_venue ?? null)).slice(0, 400));
    console.log('  obj.datelocation=' + String(JSON.stringify(obj0.datelocation ?? null)).slice(0, 200));
    console.log('  obj.absolute_url=' + JSON.stringify(obj0.absolute_url));
  }

  const rows = new Map<string, { title: string; start: string; loc: string; host: string }>();
  let pages = 1;
  for (let page = 1; page <= 20; page++) {
    const rp = await get({ platform: '', name: '', url: `https://hasgeek.com/search?q=bangalore&type=project&page=${page}` });
    let items: Record<string, unknown>[] = [];
    try {
      const res = (JSON.parse(rp.text) as Record<string, unknown>).results as Record<string, unknown>;
      pages = Number(res.pages || 1);
      items = (res.items as Record<string, unknown>[]) || [];
    } catch {
      console.log(`  page ${page} not JSON [${rp.status} ${rp.type}] — stopping`);
      break;
    }
    if (!items.length) break;
    for (const it of items) {
      const o = (it.obj || {}) as Record<string, unknown>;
      rows.set(String(o.absolute_url || it.url || o.title), {
        title: String(o.title || it.title || ''),
        start: String(o.start_at || ''),
        loc: String(o.location || ''),
        host: String((o.account as Record<string, unknown>)?.fullname || ''),
      });
    }
    if (page >= pages) break;
  }
  const all = [...rows.values()];
  const dated = all.filter(x => x.start && !Number.isNaN(Date.parse(x.start)));
  const future = dated.filter(x => Date.parse(x.start) > now);
  const blrAll = all.filter(x => BLR.test(x.loc + ' ' + x.title));
  const futureBlr = future.filter(x => BLR.test(x.loc + ' ' + x.title) || /hybrid|online/i.test(x.loc));
  console.log(`  pages reported=${pages}  unique projects fetched=${all.length}`);
  console.log(`  with obj.start_at parseable=${dated.length}`);
  console.log(`  location mentions Bengaluru/Bangalore=${blrAll.length}`);
  console.log(`  FUTURE (start_at > now)=${future.length}`);
  console.log(`  FUTURE and Bengaluru/hybrid=${futureBlr.length}`);
  console.log(`  distinct hosts=${new Set(all.map(x => x.host)).size}: ${[...new Set(all.map(x => x.host))].slice(0, 14).join(' | ')}`);
  console.log('  --- every FUTURE project ---');
  for (const x of future.sort((a, b) => a.start.localeCompare(b.start)))
    console.log(`    · ${x.start.slice(0, 16)} | "${x.title.slice(0, 60)}" | loc="${x.loc.slice(0, 40)}" | host=${x.host.slice(0, 26)}`);

  // ── 4b. Konfhub, 60-url sample, FULL venue string, no truncation ──
  console.log(`\n=== 4b. KONFHUB 60-url sample, full venue strings ===`);
  const khLocs = await locsOf('https://files.konfhub.com/konfhub-sitemap/81fae46e2653383477759a342e742aa5.xml');
  const N = 60;
  const step = Math.max(1, Math.floor(khLocs.length / N));
  const sample = Array.from({ length: N }, (_, i) => khLocs[i * step]).filter(Boolean);
  const results = await runPool(
    sample,
    async url => {
      const rr = await get({ platform: '', name: '', url });
      // Parse JSON-LD ourselves so we keep the FULL location string.
      const blocks = [...rr.text.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
      const evs: { name: string; start: string; loc: string; desc: string }[] = [];
      for (const b of blocks) {
        try {
          const p = JSON.parse(b[1].trim());
          const walk = (n: unknown) => {
            if (Array.isArray(n)) return n.forEach(walk);
            if (!n || typeof n !== 'object') return;
            const o = n as Record<string, unknown>;
            const t = Array.isArray(o['@type']) ? o['@type'] : [o['@type']];
            if (t.some(x => typeof x === 'string' && /Event/i.test(x))) {
              evs.push({
                name: String(o.name || ''),
                start: String(o.startDate || ''),
                loc: JSON.stringify(o.location ?? ''),
                desc: String(o.description || '').slice(0, 300),
              });
            }
            Object.values(o).forEach(walk);
          };
          walk(p);
        } catch { /* skip */ }
      }
      return { url, status: rr.status, evs };
    },
    3
  );
  let withLd = 0, blr = 0, blrTech = 0;
  const hits: string[] = [];
  for (const k of results) {
    if (!k.evs.length) continue;
    withLd++;
    for (const e of k.evs) {
      const hay = `${e.name} ${e.loc} ${e.desc}`;
      const isBlr = BLR.test(hay);
      const isTech = TECH.test(`${e.name} ${e.desc}`);
      if (isBlr) blr++;
      if (isBlr && isTech) {
        blrTech++;
        hits.push(`${e.start.slice(0, 16)} | "${e.name.slice(0, 56)}" | ${e.loc.replace(/\\?"/g, '').slice(0, 90)} | ${k.url}`);
      }
    }
  }
  console.log(`  sitemap urls=${khLocs.length}  sampled=${sample.length}  withJsonLdEvent=${withLd}`);
  console.log(`  Bengaluru anywhere (name/location/description)=${blr}`);
  console.log(`  Bengaluru AND tech-looking=${blrTech}`);
  for (const h of hits) console.log(`    · ${h}`);
  console.log(`  → extrapolated across ${khLocs.length} urls: bengaluru≈${Math.round((blr / sample.length) * khLocs.length)}, bengaluru+tech≈${Math.round((blrTech / sample.length) * khLocs.length)}`);

  // ── 4c. Kommunity: what cities are the 21727 events in? ──
  console.log(`\n=== 4c. KOMMUNITY 21727 events — which cities? ===`);
  const cityCount = new Map<string, number>();
  let fetched = 0;
  for (let page = 1; page <= 5; page++) {
    const rr = await get({ platform: '', name: '', url: `https://api.kommunity.com/api/v1/events?page=${page}` });
    try {
      const j = JSON.parse(rr.text) as Record<string, unknown>;
      const d = (j.data as Record<string, unknown>[]) || [];
      if (page === 1 && d[0]) console.log('  item keys: ' + Object.keys(d[0]).join(','));
      if (page === 1 && d[0]) console.log('  item[0]: ' + JSON.stringify(d[0]).slice(0, 700));
      for (const e of d) {
        fetched++;
        const blob = JSON.stringify(e);
        const m = blob.match(/"city"\s*:\s*(?:\{[^}]*"name"\s*:\s*)?"([^"]{2,40})"/);
        const key = m ? m[1] : BLR.test(blob) ? 'BENGALURU?' : '(no city field)';
        cityCount.set(key, (cityCount.get(key) || 0) + 1);
      }
    } catch {
      console.log(`  page ${page}: not JSON`);
      break;
    }
  }
  console.log(`  fetched=${fetched} (15/page); city histogram:`);
  for (const [c, n] of [...cityCount.entries()].sort((a, b) => b[1] - a[1])) console.log(`     ${String(n).padStart(3)}  ${c}`);
  const rb = await get({ platform: '', name: '', url: 'https://api.kommunity.com/api/v1/events?page=1&city=bangalore&country=IN' });
  console.log(`  city/country filter test: ${rb.bytes}B (identical size to unfiltered ⇒ params ignored)`);
}

// ════════════════════════════════════════════════════════════════════════════
// ROUND 5 — the only question left: UPCOMING yield, not historical. Run: --round5
// ════════════════════════════════════════════════════════════════════════════
async function round5() {
  const now = Date.now();

  // ── 5a. Konfhub sitemap: is there <lastmod> to prune with? ──
  console.log(`\n=== 5a. KONFHUB sitemap structure ===`);
  const smRaw = await get({ platform: '', name: '', url: 'https://files.konfhub.com/konfhub-sitemap/81fae46e2653383477759a342e742aa5.xml' });
  console.log(`  [${smRaw.status} ${smRaw.type} ${smRaw.bytes}B]`);
  console.log(`  has <lastmod>=${/<lastmod>/i.test(smRaw.text)}  has <priority>=${/<priority>/i.test(smRaw.text)}`);
  const firstUrlEl = smRaw.text.match(/<url>[\s\S]*?<\/url>/i);
  console.log(`  first <url> element: ${firstUrlEl ? firstUrlEl[0].replace(/\s+/g, ' ').slice(0, 300) : 'none'}`);

  // ── 5b. Konfhub: of a 60-url sample, how many are UPCOMING Bengaluru tech? ──
  console.log(`\n=== 5b. KONFHUB upcoming Bengaluru tech (60-url sample) ===`);
  const locs = [...smRaw.text.matchAll(/<loc>([\s\S]*?)<\/loc>/gi)].map(m => m[1].trim());
  const step = Math.max(1, Math.floor(locs.length / 60));
  const sample = Array.from({ length: 60 }, (_, i) => locs[i * step]).filter(Boolean);
  const out = await runPool(
    sample,
    async url => {
      const rr = await get({ platform: '', name: '', url });
      const blocks = [...rr.text.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
      const evs: { name: string; start: string; loc: string; desc: string }[] = [];
      for (const b of blocks) {
        try {
          const p = JSON.parse(b[1].trim()) as Record<string, unknown>;
          const t = Array.isArray(p['@type']) ? p['@type'] : [p['@type']];
          if (t.some(x => typeof x === 'string' && /Event/i.test(x))) {
            evs.push({
              name: String(p.name || ''),
              start: String(p.startDate || ''),
              loc: JSON.stringify(p.location ?? ''),
              desc: String(p.description || '').slice(0, 400),
            });
          }
        } catch { /* skip */ }
      }
      return { url, evs };
    },
    3
  );
  let fut = 0, futBlr = 0, futBlrTech = 0;
  const rows: string[] = [];
  for (const k of out) {
    for (const e of k.evs) {
      const isFuture = e.start ? Date.parse(e.start) > now : false;
      if (!isFuture) continue;
      fut++;
      const hay = `${e.name} ${e.loc} ${e.desc}`;
      if (!BLR.test(hay)) continue;
      futBlr++;
      if (!TECH.test(`${e.name} ${e.desc}`)) continue;
      futBlrTech++;
      rows.push(`${e.start.slice(0, 16)} | "${e.name.slice(0, 56)}" | ${k.url}`);
    }
  }
  console.log(`  sampled=${sample.length} of ${locs.length}: upcoming=${fut}, upcoming+BLR=${futBlr}, upcoming+BLR+tech=${futBlrTech}`);
  for (const r of rows) console.log(`    · ${r}`);
  console.log(`  → extrapolated UPCOMING Bengaluru tech over the whole ${locs.length}-url sitemap ≈ ${Math.round((futBlrTech / sample.length) * locs.length)}`);
  console.log(`  → cost to find them: ${locs.length} detail requests per run (repo's whole Luma+Meetup pass is ~700)`);

  // ── 5c. HasGeek: does search EVER surface upcoming, or only past? ──
  console.log(`\n=== 5c. HASGEEK upcoming — search order + home page cross-check ===`);
  const p1 = await get({ platform: '', name: '', url: 'https://hasgeek.com/search?q=bangalore&type=project' });
  try {
    const items = ((JSON.parse(p1.text) as Record<string, unknown>).results as Record<string, unknown>).items as Record<string, unknown>[];
    console.log('  first 6 results in API order (is it newest-first?):');
    for (const it of items.slice(0, 6)) {
      const o = it.obj as Record<string, unknown>;
      console.log(`    ${String(o.start_at || 'null').slice(0, 16)}  "${String(o.title).slice(0, 52)}"`);
    }
  } catch { console.log('  parse failed'); }

  // Home page: extract project links, then ask the search API for each project's dates.
  const home = await get({ platform: '', name: '', url: 'https://hasgeek.com/' });
  const projLinks = [...new Set(
    [...home.text.matchAll(/href=["'](https:\/\/hasgeek\.com\/[a-z0-9][a-z0-9_-]+\/[a-z0-9][a-z0-9_-]+\/)["']/gi)].map(m => m[1])
  )];
  console.log(`  home page [${home.status} ${home.bytes}B] project-shaped links=${projLinks.length}`);
  console.log(`  samples: ${projLinks.slice(0, 6).join(' ')}`);
  // Does the home HTML carry dates at all?
  const homeDates = [...home.text.matchAll(/datetime=["']([0-9]{4}-[0-9]{2}-[0-9]{2}[^"']*)["']/gi)].map(m => m[1]);
  console.log(`  <time datetime> attrs in home HTML=${homeDates.length}; samples: ${homeDates.slice(0, 6).join(' ')}`);
  const upcomingSection = home.text.match(/upcoming/i) ? 'the word "upcoming" appears in home HTML' : 'no "upcoming" in home HTML';
  console.log(`  ${upcomingSection}`);

  // ── 5d. HasGeek: per-project ICS / calendar subscribe? ──
  console.log(`\n=== 5d. HASGEEK per-project ICS attempts ===`);
  for (const u of [
    'https://hasgeek.com/fifthelephant/the-ai-engineers-playbook-workshop/schedule/subscribe',
    'https://hasgeek.com/fifthelephant/the-ai-engineers-playbook-workshop/schedule.ics',
    'https://hasgeek.com/fifthelephant/the-ai-engineers-playbook-workshop/ical',
    'https://hasgeek.com/fifthelephant/the-ai-engineers-playbook-workshop/',
  ]) {
    const rr = await get({ platform: '', name: '', url: u });
    const vev = (rr.text.match(/BEGIN:VEVENT/g) || []).length;
    const ldn = jsonLdRows(rr.text).length;
    console.log(`  [${rr.status} ${rr.type} ${rr.bytes}B] vevents=${vev} jsonldEvents=${ldn} ${u.replace('https://hasgeek.com/fifthelephant/the-ai-engineers-playbook-workshop', '…')}`);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// ROUND 6 — fair test for Konfhub: sample the NEWEST-lastmod entries, which is
// where upcoming events must live. An even spread over the sitemap was biased
// toward stale rows. Run: --round6
// ════════════════════════════════════════════════════════════════════════════
async function round6() {
  const now = Date.now();
  const sm = await get({ platform: '', name: '', url: 'https://files.konfhub.com/konfhub-sitemap/81fae46e2653383477759a342e742aa5.xml' });
  const entries = [...sm.text.matchAll(/<url>\s*<loc>([\s\S]*?)<\/loc>\s*<lastmod>([\s\S]*?)<\/lastmod>/gi)].map(m => ({
    url: m[1].trim(),
    lastmod: m[2].trim(),
  }));
  entries.sort((a, b) => b.lastmod.localeCompare(a.lastmod));
  console.log(`=== 6. KONFHUB newest-lastmod sample ===`);
  console.log(`  entries with lastmod=${entries.length}/${(sm.text.match(/<loc>/g) || []).length}`);
  console.log(`  newest lastmod=${entries[0]?.lastmod}  oldest=${entries[entries.length - 1]?.lastmod}`);
  const buckets = new Map<string, number>();
  for (const e of entries) buckets.set(e.lastmod.slice(0, 7), (buckets.get(e.lastmod.slice(0, 7)) || 0) + 1);
  console.log('  lastmod histogram by month: ' + [...buckets.entries()].sort((a, b) => b[0].localeCompare(a[0])).slice(0, 10).map(([k, v]) => `${k}=${v}`).join(' '));

  const sample = entries.slice(0, 60);
  const out = await runPool(
    sample,
    async e => {
      const rr = await get({ platform: '', name: '', url: e.url });
      const blocks = [...rr.text.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
      let ev: { name: string; start: string; loc: string; desc: string } | null = null;
      for (const b of blocks) {
        try {
          const p = JSON.parse(b[1].trim()) as Record<string, unknown>;
          const t = Array.isArray(p['@type']) ? p['@type'] : [p['@type']];
          if (t.some(x => typeof x === 'string' && /Event/i.test(x))) {
            ev = {
              name: String(p.name || ''),
              start: String(p.startDate || ''),
              loc: JSON.stringify(p.location ?? ''),
              desc: String(p.description || '').slice(0, 400),
            };
          }
        } catch { /* skip */ }
      }
      return { ...e, ev, status: rr.status };
    },
    3
  );
  let withLd = 0, fut = 0, blr = 0, futBlr = 0, futBlrTech = 0;
  for (const k of out) {
    if (!k.ev) { console.log(`  no-JSON-LD [${k.status}] ${k.url}`); continue; }
    withLd++;
    const hay = `${k.ev.name} ${k.ev.loc} ${k.ev.desc}`;
    const isFut = k.ev.start ? Date.parse(k.ev.start) > now : false;
    const isBlr = BLR.test(hay);
    const isTech = TECH.test(`${k.ev.name} ${k.ev.desc}`);
    if (isFut) fut++;
    if (isBlr) blr++;
    if (isFut && isBlr) futBlr++;
    if (isFut && isBlr && isTech) futBlrTech++;
    console.log(
      `  ${isFut ? 'FUT' : '   '}${isBlr ? '/BLR' : '    '}${isTech ? '/TECH' : '     '} lastmod=${k.lastmod.slice(0, 10)} start=${k.ev.start.slice(0, 16)} "${k.ev.name.slice(0, 44)}" ${k.ev.loc.replace(/[\\"]/g, '').slice(0, 60)}`
    );
  }
  console.log(`\n  newest-60: withJsonLd=${withLd} upcoming=${fut} bengaluru=${blr} upcoming+BLR=${futBlr} upcoming+BLR+tech=${futBlrTech}`);
}

async function main() {
  if (process.argv.includes('--round6')) return round6();
  if (process.argv.includes('--round5')) return round5();
  if (process.argv.includes('--round2')) return round2();
  if (process.argv.includes('--round3')) return round3();
  if (process.argv.includes('--round4')) return round4();
  console.log(`\n=== PHASE 1: ${CANDIDATES.length} listing pages + JSON endpoint guesses ===`);
  const findings = await runPool(CANDIDATES, probeOne);
  findings.sort((a, b) => a.platform.localeCompare(b.platform) || a.name.localeCompare(b.name));
  printFindings(findings);

  // ── Phase 2: follow event DETAIL pages found in sitemaps / listing HTML ──
  console.log(`\n\n=== PHASE 2: event DETAIL pages (a shell listing + JSON-LD detail is still viable) ===`);
  const detail: Candidate[] = [];
  for (const f of findings) {
    const locs = (f as Finding & { locs?: string[] }).locs || [];
    // Sitemap index → pull child sitemaps that look event-related, else event urls.
    const eventish = locs.filter(u => /event|conf|\/e\/|\/[a-z0-9-]{8,}$/i.test(u));
    for (const u of eventish.slice(0, 3)) {
      detail.push({ platform: f.platform, name: `sitemap-loc ${u.split('/').slice(3).join('/').slice(0, 34)}`, url: u });
    }
  }

  // Hand-picked detail pages: known-real event URLs per platform, so we test the
  // detail-page hypothesis even where the sitemap gave us nothing.
  detail.push(
    { platform: 'hasgeek', name: 'detail: fifthelephant', url: 'https://hasgeek.com/fifthelephant/' },
    { platform: 'hasgeek', name: 'detail: rootconf', url: 'https://hasgeek.com/rootconf/' },
    { platform: 'commudle', name: 'detail: communities list', url: 'https://www.commudle.com/communities' },
    { platform: '10times', name: 'detail: search page', url: 'https://10times.com/search?kw=bangalore' },
  );

  const detailFindings = await runPool(detail, probeOne);
  detailFindings.sort((a, b) => a.platform.localeCompare(b.platform) || a.name.localeCompare(b.name));
  printFindings(detailFindings);

  // ── Summary ──
  const all = [...findings, ...detailFindings];
  console.log(`\n\n=== SUMMARY (rows require title AND a date in the response) ===`);
  const byPlatform = new Map<string, Finding[]>();
  for (const f of all) {
    if (!byPlatform.has(f.platform)) byPlatform.set(f.platform, []);
    byPlatform.get(f.platform)!.push(f);
  }
  for (const [p, fs] of [...byPlatform.entries()].sort()) {
    const best = fs.filter(f => f.rows.length).sort((a, b) => b.rows.length - a.rows.length)[0];
    const blr = fs.reduce((s, f) => s + f.blrRows, 0);
    console.log(
      best
        ? `VIABLE?  ${p.padEnd(12)} best=${best.name} → ${best.rows.length} rows via ${best.mechanism}; blr-matching rows across all probes=${blr}`
        : `DEAD     ${p.padEnd(12)} ${fs.length} probes, 0 event objects in any response`
    );
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
