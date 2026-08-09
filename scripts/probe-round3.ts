#!/usr/bin/env tsx
/**
 * READ-ONLY recon, round 3 — verify the AUTO-DISCOVERY mechanisms.
 *
 * The insight from round 2: hand-maintaining a list of company event pages does
 * not scale and most company sites carry no structured data. But almost every
 * Bengaluru company/community event is *hosted* on Luma or Meetup. So instead of
 * scraping company websites we discover their HOST CALENDARS:
 *
 *   Luma   : city discover feed → each entry names its `calendar` → fetch that
 *            calendar's own feed for ALL its upcoming events (not just the few
 *            the city page surfaces).
 *   Meetup : city find pages → harvest group slugs → per-group ICS feed.
 *
 * This round proves those two endpoints exist and returns their shapes.
 * Run: npx tsx scripts/probe-round3.ts
 */
import './load-env';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function get(url: string) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'text/html,application/json;q=0.9,*/*;q=0.8' },
    redirect: 'follow',
    signal: AbortSignal.timeout(25000),
  });
  return { status: res.status, text: await res.text() };
}

const PLACE = 'discplace-G0tGUVYwl7T17Sb'; // Bengaluru, verified in round 2

/** Only the fields this probe reads out of Luma's discover payload. */
interface ProbeEntry {
  calendar?: { api_id?: string; name?: string; slug?: string };
  ticket_info?: unknown;
  hosts?: unknown[];
  guest_count?: number;
  event?: { coordinate?: unknown; geo_address_info?: unknown };
}

async function main() {
  // ── 1. Luma discover: cursor pagination + harvest host calendars ──────────
  console.log('\n── LUMA discover: cursor pagination ────────────────────────────');
  const calendars = new Map<string, string>(); // api_id → name
  let cursor: string | null = null;
  let total = 0;
  for (let page = 0; page < 6; page++) {
    const url =
      `https://api.lu.ma/discover/get-paginated-events?discover_place_api_id=${PLACE}&pagination_limit=100` +
      (cursor ? `&pagination_cursor=${encodeURIComponent(cursor)}` : '');
    const r = await get(url);
    if (r.status !== 200) {
      console.log(`   ❌ page ${page} → HTTP ${r.status}`);
      break;
    }
    const j = JSON.parse(r.text);
        const entries: ProbeEntry[] = j.entries || [];
    total += entries.length;
    console.log(
      `   ✅ page ${page}: entries=${entries.length} has_more=${j.has_more} cursor=${String(j.next_cursor).slice(0, 24)}…`
    );
    for (const e of entries) {
      const cal = e.calendar;
      if (cal?.api_id) calendars.set(cal.api_id, cal.name || cal.slug || cal.api_id);
    }
    if (page === 0 && entries[0]) {
      console.log(`      calendar node keys: ${Object.keys(entries[0].calendar || {}).join(',')}`);
      console.log(`      ticket_info: ${JSON.stringify(entries[0].ticket_info)}`);
      console.log(`      hosts[0]: ${JSON.stringify(entries[0].hosts?.[0])?.slice(0, 200)}`);
      console.log(`      guest_count=${entries[0].guest_count} coordinate=${JSON.stringify(entries[0].event?.coordinate)}`);
      console.log(`      geo_address_info=${JSON.stringify(entries[0].event?.geo_address_info)?.slice(0, 300)}`);
    }
    cursor = j.next_cursor || null;
    if (!j.has_more || !cursor) break;
  }
  console.log(`   → ${total} events, ${calendars.size} distinct host calendars discovered`);
  const calList = [...calendars.entries()].slice(0, 25);
  for (const [id, name] of calList.slice(0, 12)) console.log(`      · ${id}  ${name}`);

  // ── 2. Luma calendar feed for a discovered host ───────────────────────────
  console.log('\n── LUMA calendar/get-items for discovered hosts ────────────────');
  for (const [calId, name] of calList.slice(0, 4)) {
    for (const variant of [
      `https://api.lu.ma/calendar/get-items?calendar_api_id=${calId}&period=future&pagination_limit=50`,
      `https://api.lu.ma/calendar/get-items?calendar_api_id=${calId}&pagination_limit=50`,
    ]) {
      const r = await get(variant);
      let info = r.text.slice(0, 120).replace(/\s+/g, ' ');
      try {
        const j = JSON.parse(r.text);
        const entries = j.entries || [];
        info = `entries=${entries.length} has_more=${j.has_more}`;
        if (entries[0]) info += ` firstKeys=${Object.keys(entries[0]).join(',')}`;
      } catch { /* ignore */ }
      console.log(`   ${r.status === 200 ? '✅' : '❌'} [${r.status}] ${name.slice(0, 26).padEnd(26)} ${variant.includes('period') ? 'period=future' : 'no-period  '} ${info}`);
      if (r.status === 200) break;
    }
  }

  // ── 3. Meetup: harvest group slugs from city find pages ──────────────────
  console.log('\n── MEETUP group-slug harvesting from find pages ────────────────');
  const groups = new Set<string>();
  const keywords = ['technology', 'ai', 'startup', 'developer', 'data', 'cloud', 'design', 'career', 'product', 'web3'];
  for (const kw of keywords) {
    const r = await get(
      `https://www.meetup.com/find/?keywords=${encodeURIComponent(kw)}&location=in--Bengaluru&source=EVENTS`
    );
    if (r.status !== 200) continue;
    const before = groups.size;
    // Event URLs look like https://www.meetup.com/<group-slug>/events/<id>/
    for (const m of r.text.matchAll(/meetup\.com\\?\/([a-zA-Z0-9-]{3,60})\\?\/events\\?\/(\d{8,})/g)) {
      groups.add(m[1]);
    }
    console.log(`   ✅ ${kw.padEnd(12)} +${groups.size - before} groups (running total ${groups.size})`);
  }
  console.log(`   → ${groups.size} distinct Meetup groups discovered`);
  console.log(`      ${[...groups].slice(0, 30).join(', ')}`);

  // ── 4. Verify ICS works for a sample of discovered groups ────────────────
  console.log('\n── MEETUP per-group ICS spot-check ─────────────────────────────');
  for (const slug of [...groups].slice(0, 6)) {
    try {
      const r = await get(`https://www.meetup.com/${slug}/events/ical/`);
      const n = (r.text.match(/BEGIN:VEVENT/g) || []).length;
      console.log(`   ${r.status === 200 ? '✅' : '❌'} [${r.status}] ${slug.padEnd(38)} vevents=${n}`);
    } catch (e) {
      console.log(`   ❌ ${slug} ${String(e).slice(0, 60)}`);
    }
  }

  // ── 5. Unstop: where is the start date? ──────────────────────────────────
  console.log('\n── UNSTOP record shape (locating dates) ────────────────────────');
  const r = await get(
    'https://unstop.com/api/public/opportunity/search-result?opportunity=hackathons&per_page=10&page=1'
  );
  try {
    const j = JSON.parse(r.text);
    const list = j.data?.data || [];
    console.log(`   items=${list.length}`);
    if (list[0]) {
      const it = list[0];
      console.log(`   title=${it.title}`);
      console.log(`   regn_open=${it.regn_open} end_date=${it.end_date} status=${it.status}`);
      console.log(`   region=${JSON.stringify(it.region)} locations=${JSON.stringify(it.locations)?.slice(0, 200)}`);
      console.log(`   festival=${JSON.stringify(it.festival)?.slice(0, 160)}`);
      const dateKeys = Object.entries(it).filter(([k]) => /date|time|start|end/i.test(k));
      console.log(`   date-ish keys: ${dateKeys.map(([k, v]) => `${k}=${JSON.stringify(v)?.slice(0, 40)}`).join(' | ')}`);
      console.log(`   opportunity_config keys: ${Object.keys(it.opportunity_config || {}).join(',')}`);
      console.log(`   filters sample: ${JSON.stringify(it.filters)?.slice(0, 250)}`);
    }
  } catch (e) {
    console.log(`   ❌ ${String(e).slice(0, 120)}`);
  }

  // ── 6. AllEvents: are the category pages genuinely different events? ─────
  console.log('\n── ALLEVENTS category overlap check ────────────────────────────');
  async function namesFrom(url: string): Promise<string[]> {
    const rr = await get(url);
    const names: string[] = [];
    for (const m of rr.text.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
      try {
        const p = JSON.parse(m[1].trim());
        const arr: Array<Record<string, unknown>> = Array.isArray(p) ? p : p['@graph'] || [p];
        for (const n of arr) if (String(n?.['@type']).includes('Event') && n.name) names.push(String(n.name));
      } catch { /* ignore */ }
    }
    return names;
  }
  const a = await namesFrom('https://allevents.in/bengaluru/all');
  const b = await namesFrom('https://allevents.in/bengaluru/technology');
  const c = await namesFrom('https://allevents.in/bengaluru/music');
  const overlapAB = a.filter(n => b.includes(n)).length;
  const overlapAC = a.filter(n => c.includes(n)).length;
  console.log(`   all=${a.length} tech=${b.length} music=${c.length} | overlap all∩tech=${overlapAB} all∩music=${overlapAC}`);
  console.log(`   union of three = ${new Set([...a, ...b, ...c]).size}`);
  console.log(`   tech sample: ${b.slice(0, 5).join(' | ')}`);
}

main().catch(e => {
  console.error('❌', e);
  process.exit(1);
});
