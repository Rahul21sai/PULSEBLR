#!/usr/bin/env tsx
/**
 * Final gate before anything from the attended-events list is added to an adapter.
 *
 * A candidate only earns a seed entry if it returns REAL UPCOMING EVENTS right now,
 * using the exact mechanism the production adapter will use:
 *   - Luma calendars  -> api.lu.ma/calendar/get-items?period=future  (as luma.ts does)
 *   - Meetup groups   -> meetup.com/<slug>/events/ical/               (as meetup.ts does)
 *
 * This is the discipline that has kept the source list honest: guessing produced 0/35
 * on Meetup slugs and 5/36 on Bevy hosts, so nothing is taken on faith.
 *
 * Also checks whether FOSS United offers an ICS or RSS feed, which would let the
 * existing universal.ts adapter consume it with no new scraping code.
 *
 * Read-only. No DB writes.
 *
 * Run: npx tsx scripts/verify-attended-seeds.ts
 */
import './load-env';
import { rawEventsFromIcs } from '../lib/scrapers/core/ics';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const API = 'https://api.lu.ma';

async function get(url: string, accept = 'application/json') {
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

// ── Luma ────────────────────────────────────────────────────────────────────
/** Named handles from the user's list, plus the calendars harvested from their events. */
const LUMA_HANDLES = ['claudecommunity', 'aihouse', 'agenticsummit', 'n8n-ad2z', 'bengalurutechweek'];
const HARVESTED_CALENDARS: Array<[string, string]> = [
  ['cal-rKZGvZjZWgFjKWW', 'host of n8n Bangalore mixer'],
  ['cal-l0CgIJ0Hhef7fcT', 'host of Bengaluru Tech Week'],
  ['cal-b1CEtpI9GuyP8KM', 'host of Sela x Google Cloud'],
  ['cal-Qjb1m8xxo3a7QNB', 'host of kipi.ai DataTALKS'],
];

/** Pull cal-XXXX ids out of a public luma.com page. */
async function calendarsFromHandle(handle: string): Promise<string[]> {
  const r = await get(`https://luma.com/${handle}`, 'text/html');
  if (r.status !== 200) return [];
  const ids = new Set<string>();
  for (const m of r.text.matchAll(/"(cal-[A-Za-z0-9]{8,})"/g)) ids.add(m[1]);
  return [...ids];
}

async function countLumaEvents(calId: string) {
  const url =
    `${API}/calendar/get-items?calendar_api_id=${encodeURIComponent(calId)}` +
    `&period=future&pagination_limit=50`;
  const r = await get(url);
  if (r.status !== 200) return { ok: false, n: 0, samples: [] as string[], status: r.status };
  try {
    const d = JSON.parse(r.text) as { entries?: Array<{ event?: { name?: string; start_at?: string; geo_address_info?: { city_state?: string } } }> };
    const entries = d.entries || [];
    const samples = entries.slice(0, 4).map(e => {
      const ev = e.event || {};
      return `${String(ev.start_at || '').slice(0, 10)}  ${String(ev.name || '?').slice(0, 46)}  ${ev.geo_address_info?.city_state || ''}`;
    });
    return { ok: true, n: entries.length, samples, status: 200 };
  } catch {
    return { ok: false, n: 0, samples: [], status: 200 };
  }
}

async function luma() {
  console.log('══════ LUMA CALENDARS ══════');
  const resolved = new Map<string, string>();
  for (const [id, why] of HARVESTED_CALENDARS) resolved.set(id, why);

  console.log('\n  resolving named handles to calendar ids:');
  for (const h of LUMA_HANDLES) {
    const ids = await calendarsFromHandle(h);
    console.log(`     luma.com/${h.padEnd(20)} → ${ids.length ? ids.join(', ') : 'NONE'}`);
    for (const id of ids) if (!resolved.has(id)) resolved.set(id, `from luma.com/${h}`);
  }

  console.log(`\n  verifying ${resolved.size} calendar(s) for UPCOMING events:`);
  const keep: string[] = [];
  for (const [id, why] of resolved) {
    const res = await countLumaEvents(id);
    const verdict = res.n > 0 ? 'KEEP' : res.ok ? 'empty' : `HTTP ${res.status}`;
    console.log(`     ${verdict.padEnd(9)} ${id}  (${why})  upcoming=${res.n}`);
    for (const s of res.samples) console.log(`            ${s}`);
    if (res.n > 0) keep.push(id);
  }
  console.log(`\n  => ${keep.length} calendar(s) worth seeding:`);
  for (const id of keep) console.log(`     '${id}',`);
  return keep;
}

// ── Meetup ──────────────────────────────────────────────────────────────────
/**
 * Slugs harvested by searching for the community NAMES in the user's list. Most
 * search hits are noise (Meetup search is fuzzy relevance, not a filter), so each is
 * tested here rather than trusted.
 */
const MEETUP_CANDIDATES = [
  'apache-pinot-bengaluru-by-startree',
  'apache-iceberg-meetups-india',
  'presto-bangalore',
  'ai-xchange',
  'global-platform-engineers-network-gpen',
  'lead-with-tech-meetup-group',
  'cloud-computing-circle',
  'startups-entrepreneurs-network-senex-by-cedat',
  'bangalore-seapreneurs-community',
  'hsrmeetups',
  'whfl-bangalore',
  'echai-bangalore',
  'technexus-community',
  'bangalore-apache-kafka',
];

async function meetup() {
  console.log('\n\n══════ MEETUP GROUPS (ICS) ══════');
  const keep: Array<[string, number]> = [];
  for (const slug of MEETUP_CANDIDATES) {
    const r = await get(`https://www.meetup.com/${slug}/events/ical/`, 'text/calendar');
    if (r.status !== 200) {
      console.log(`     HTTP ${String(r.status).padEnd(4)} ${slug}`);
      continue;
    }
    let events: ReturnType<typeof rawEventsFromIcs> = [];
    try {
      events = rawEventsFromIcs(r.text, { source: 'meetup', fallbackUrl: `https://www.meetup.com/${slug}/`, organizer: slug });
    } catch { /* malformed ics */ }
    const future = events.filter(e => e.startDateTime.getTime() > Date.now());
    const verdict = future.length > 0 ? 'KEEP' : 'empty';
    console.log(`     ${verdict.padEnd(9)} ${slug.padEnd(46)} upcoming=${future.length}`);
    for (const e of future.slice(0, 3)) {
      console.log(`            ${e.startDateTime.toISOString().slice(0, 10)}  ${e.title.slice(0, 52)}`);
    }
    if (future.length > 0) keep.push([slug, future.length]);
  }
  console.log(`\n  => ${keep.length} group(s) worth seeding:`);
  for (const [s] of keep) console.log(`     '${s}',`);
  return keep;
}

// ── FOSS United: is there a feed the existing universal adapter could eat? ──
async function fossFeeds() {
  console.log('\n\n══════ FOSS UNITED — feed hunt ══════');
  const urls = [
    'https://fossunited.org/events.ics',
    'https://fossunited.org/c/bengaluru.ics',
    'https://fossunited.org/rss.xml',
    'https://fossunited.org/feed',
    'https://fossunited.org/blog/rss.xml',
    'https://fossunited.org/api/method/frappe.website.doctype.website_settings.website_settings.get_website_settings',
  ];
  for (const u of urls) {
    const r = await get(u, 'text/calendar, application/rss+xml, application/xml, */*');
    const isFeed = /calendar|rss|xml/.test(r.type) && r.status === 200;
    console.log(`     ${String(r.status).padStart(4)} ${r.type.padEnd(24)} ${String(r.text.length).padStart(7)}B  ${isFeed ? 'FEED?' : ''}  ${u.replace('https://fossunited.org', '')}`);
  }
  console.log('     (no ICS/RSS => FOSS United would need HTML selector scraping, which');
  console.log('      universal.ts deliberately refuses. Report, do not add.)');
}

async function main() {
  await luma();
  await meetup();
  await fossFeeds();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
