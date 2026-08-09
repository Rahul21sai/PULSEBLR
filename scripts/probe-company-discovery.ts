#!/usr/bin/env tsx
/**
 * READ-ONLY recon: which mechanisms let us go from a COMPANY NAME to its events?
 *
 * The goal is "every Bengaluru company that runs events is listed". Round-2 recon
 * already established that company marketing pages are a dead end (no structured
 * data). So the question is which platform lets us look a company UP:
 *
 *   A. Luma slug page      luma.com/<handle> → __NEXT_DATA__ → calendar api_id
 *   B. Luma co-host graph  an event page names hosts + their calendars
 *   C. Meetup keyword      /find/?keywords=<company>&location=in--Bengaluru
 *   D. Eventbrite organizer /o/<slug> and city search by company name
 *
 * Run: npx tsx scripts/probe-company-discovery.ts
 */
import './load-env';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function get(url: string): Promise<{ status: number; text: string }> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/json;q=0.9,*/*;q=0.8' },
      redirect: 'follow',
      signal: AbortSignal.timeout(20000),
    });
    return { status: res.status, text: await res.text() };
  } catch (err) {
    return { status: 0, text: err instanceof Error ? err.message : String(err) };
  }
}

/** Pull every Luma calendar api_id + name pair out of any JSON blob. */
function harvestCalendars(text: string): Array<{ apiId: string; name: string }> {
  const found = new Map<string, string>();
  // Calendar objects always carry api_id starting "cal-" near a "name".
  for (const m of text.matchAll(/"api_id"\s*:\s*"(cal-[A-Za-z0-9]+)"/g)) {
    found.set(m[1], '');
  }
  // Associate names by scanning a small window around each id.
  for (const id of found.keys()) {
    const at = text.indexOf(`"${id}"`);
    if (at === -1) continue;
    const window = text.slice(Math.max(0, at - 400), at + 400);
    const name = window.match(/"name"\s*:\s*"([^"]{2,60})"/);
    if (name) found.set(id, name[1]);
  }
  return [...found.entries()].map(([apiId, name]) => ({ apiId, name }));
}

const COMPANIES = [
  'Google', 'Microsoft', 'Amazon', 'Flipkart', 'Swiggy', 'Razorpay', 'CRED',
  'Zerodha', 'Postman', 'Hasura', 'BrowserStack', 'Freshworks', 'Sarvam AI',
  'Atlassian', 'Nvidia', 'ThoughtWorks', 'Zomato', 'PhonePe', 'Meesho', 'Groww',
];

const LUMA_SLUGS = [
  'razorpay', 'razorpayrize', 'theproductfolks', 'tpf', 'lyzr', 'sarvam',
  'buildclubblr', 'aitinkerers', 'papers-we-love-bangalore', 'basecamp',
  'foundersstartuphouse', 'blr', 'bengaluru',
];

async function main() {
  // ── A. Luma slug pages ────────────────────────────────────────────────────
  console.log('\n══ A. Luma slug page → calendar api_id ══════════════════════════');
  for (const slug of LUMA_SLUGS) {
    const r = await get(`https://luma.com/${slug}`);
    const cals = r.status === 200 ? harvestCalendars(r.text) : [];
    const nextData = r.text.includes('__NEXT_DATA__');
    console.log(
      `  ${r.status === 200 ? 'OK ' : '-- '} [${r.status}] ${slug.padEnd(26)} nextData=${nextData} calendars=${cals.length}` +
        (cals[0] ? `  first=${cals[0].apiId} "${cals[0].name.slice(0, 28)}"` : '')
    );
  }

  // ── B. Luma co-host graph from ONE event page ─────────────────────────────
  console.log('\n══ B. Luma event page → co-host calendars ═══════════════════════');
  const place = await get('https://api.lu.ma/discover/get-place?slug=bengaluru');
  let placeId = '';
  try {
    placeId = JSON.parse(place.text)?.place?.api_id || '';
  } catch { /* ignore */ }
  const feed = await get(
    `https://api.lu.ma/discover/get-paginated-events?discover_place_api_id=${placeId}&pagination_limit=6`
  );
  let slugs: string[] = [];
  try {
    slugs = (JSON.parse(feed.text).entries || [])
      .map((e: { event?: { url?: string } }) => e.event?.url)
      .filter(Boolean);
  } catch { /* ignore */ }
  console.log(`  sampled event slugs: ${slugs.join(', ')}`);

  const allFromEvents = new Map<string, string>();
  for (const slug of slugs.slice(0, 5)) {
    const r = await get(`https://luma.com/${slug}`);
    const cals = r.status === 200 ? harvestCalendars(r.text) : [];
    for (const c of cals) allFromEvents.set(c.apiId, c.name);
    console.log(`  [${r.status}] /${slug.padEnd(12)} calendars on page=${cals.length}`);
  }
  console.log(`  → ${allFromEvents.size} distinct calendars from 5 event pages`);
  for (const [id, name] of [...allFromEvents].slice(0, 10)) {
    console.log(`      ${id}  ${name.slice(0, 40)}`);
  }

  // ── C. Meetup keyword search by company name ──────────────────────────────
  console.log('\n══ C. Meetup search by company name ═════════════════════════════');
  for (const company of COMPANIES.slice(0, 12)) {
    const r = await get(
      `https://www.meetup.com/find/?keywords=${encodeURIComponent(company)}&location=in--Bengaluru&source=EVENTS`
    );
    let events = 0;
    for (const m of r.text.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
      try {
        events += (JSON.stringify(JSON.parse(m[1].trim())).match(/"@type"\s*:\s*"[A-Za-z]*Event"/g) || []).length;
      } catch { /* ignore */ }
    }
    const groups = new Set(
      [...r.text.matchAll(/meetup\.com\\?\/([a-zA-Z0-9-]{3,60})\\?\/events\\?\/\d{6,}/g)].map(m => m[1])
    );
    console.log(`  [${r.status}] ${company.padEnd(14)} jsonldEvents=${String(events).padStart(3)} groups=${groups.size}`);
  }

  // ── D. Eventbrite organizer / company search ──────────────────────────────
  console.log('\n══ D. Eventbrite search by company name ═════════════════════════');
  for (const company of COMPANIES.slice(0, 8)) {
    const url = `https://www.eventbrite.com/d/india--bengaluru/${encodeURIComponent(company.toLowerCase().replace(/\s+/g, '-'))}/`;
    const r = await get(url);
    let events = 0;
    for (const m of r.text.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
      try {
        events += (JSON.stringify(JSON.parse(m[1].trim())).match(/"@type"\s*:\s*"[A-Za-z]*Event"/g) || []).length;
      } catch { /* ignore */ }
    }
    console.log(`  [${r.status}] ${company.padEnd(14)} jsonldEvents=${events}`);
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
