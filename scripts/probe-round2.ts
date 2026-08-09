#!/usr/bin/env tsx
/**
 * READ-ONLY recon, round 2 — drill into the sources round 1 proved viable and
 * find (a) pagination, (b) per-event detail endpoints that carry cover images /
 * full descriptions / price, (c) exact JSON shapes we must parse.
 *
 * Run: npx tsx scripts/probe-round2.ts
 */
import './load-env';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function get(url: string, init?: RequestInit): Promise<{ status: number; ct: string; text: string }> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      ...(init?.headers as Record<string, string> | undefined),
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(25000),
    ...init,
  });
  return { status: res.status, ct: res.headers.get('content-type') || '', text: await res.text() };
}

function countJsonLdEvents(html: string): number {
  let n = 0;
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      n += (JSON.stringify(JSON.parse(m[1].trim())).match(/"@type"\s*:\s*"[A-Za-z]*Event"/g) || []).length;
    } catch {
      /* ignore */
    }
  }
  return n;
}

function log(label: string, status: number, extra: string) {
  const mark = status < 400 ? '✅' : '❌';
  console.log(`${mark} [${status}] ${label.padEnd(46)} ${extra}`);
}

async function section(title: string, fn: () => Promise<void>) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 64 - title.length))}`);
  try {
    await fn();
  } catch (e) {
    console.log(`   ❌ section failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function main() {
  // ═══ LUMA ════════════════════════════════════════════════════════════════
  await section('LUMA discover API with the REAL place api_id', async () => {
    const place = await get('https://api.lu.ma/discover/get-place?slug=bengaluru');
    let placeId = '';
    try {
      placeId = JSON.parse(place.text)?.place?.api_id || '';
    } catch { /* ignore */ }
    log('get-place → api_id', place.status, placeId);

    if (placeId) {
      for (const path of [
        `https://api.lu.ma/discover/get-paginated-events?discover_place_api_id=${placeId}&pagination_limit=100`,
        `https://api.lu.ma/discover/category/get-paginated-events?discover_place_api_id=${placeId}&pagination_limit=100`,
        `https://api.lu.ma/discover/get-events?discover_place_api_id=${placeId}`,
      ]) {
        const r = await get(path);
        let info = r.text.slice(0, 140).replace(/\s+/g, ' ');
        try {
          const j = JSON.parse(r.text);
          const entries = j.entries || j.events || j.data || [];
          info = `keys=${Object.keys(j).join(',')} entries=${Array.isArray(entries) ? entries.length : '?'} hasMore=${j.has_more} cursor=${j.next_cursor}`;
          if (Array.isArray(entries) && entries[0]) {
            info += `\n        first entry keys: ${Object.keys(entries[0]).join(',')}`;
            const ev = entries[0].event || entries[0];
            if (ev && typeof ev === 'object') {
              info += `\n        event keys: ${Object.keys(ev).slice(0, 40).join(',')}`;
            }
          }
        } catch { /* ignore */ }
        log(path.split('?')[0].replace('https://api.lu.ma/', ''), r.status, info);
      }
    }
  });

  await section('LUMA single event page (cover image / description / price)', async () => {
    const city = await get('https://luma.com/bengaluru');
    const slugs = [...city.text.matchAll(/"url"\s*:\s*"([a-z0-9-]{4,20})"/g)].map(m => m[1]);
    const slug = slugs.find(s => !['bengaluru', 'blr'].includes(s));
    log('slug harvested from city page', city.status, slug || '(none)');
    if (!slug) return;

    const ev = await get(`https://luma.com/${slug}`);
    const nd = ev.text.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    log(`event page /${slug}`, ev.status, `jsonldEvents=${countJsonLdEvents(ev.text)} nextData=${!!nd}`);
    if (nd) {
      try {
        const parsed = JSON.parse(nd[1]);
        const s = JSON.stringify(parsed);
        const interesting = [
          'cover_url', 'social_image_url', 'description_mirror', 'description', 'ticket_info',
          'price', 'is_free', 'guest_count', 'geo_latitude', 'geo_longitude', 'full_address',
          'timezone', 'hosts', 'calendar',
        ].filter(k => s.includes(`"${k}"`));
        console.log(`        keys present: ${interesting.join(', ')}`);
        const cover = s.match(/"cover_url"\s*:\s*"([^"]{10,200})"/)?.[1];
        if (cover) console.log(`        cover_url sample: ${cover.slice(0, 120)}`);
      } catch { /* ignore */ }
    }
    // Public event API?
    const api = await get(`https://api.lu.ma/event/get?url=${slug}`);
    log('api.lu.ma/event/get?url=', api.status, api.text.slice(0, 160).replace(/\s+/g, ' '));
  });

  // ═══ MEETUP ══════════════════════════════════════════════════════════════
  await section('MEETUP find-page pagination + ICS per group', async () => {
    for (const page of [1, 2, 3]) {
      const r = await get(
        `https://www.meetup.com/find/?location=in--Bengaluru&source=EVENTS&page=${page}`
      );
      log(`find page=${page}`, r.status, `jsonldEvents=${countJsonLdEvents(r.text)} bytes=${r.text.length}`);
    }
    // Keyword breadth: how many distinct events do different keywords surface?
    for (const kw of ['technology', 'ai', 'startup', 'design', 'career', 'music', 'business']) {
      const r = await get(
        `https://www.meetup.com/find/?keywords=${encodeURIComponent(kw)}&location=in--Bengaluru&source=EVENTS`
      );
      log(`find keywords=${kw}`, r.status, `jsonldEvents=${countJsonLdEvents(r.text)}`);
    }
    const ics = await get('https://www.meetup.com/bangpypers/events/ical/');
    const dts = (ics.text.match(/DTSTART[^:]*:([0-9TZ]+)/g) || []).slice(0, 3);
    log('group ICS', ics.status, `vevents=${(ics.text.match(/BEGIN:VEVENT/g) || []).length} ${dts.join(' ')}`);
  });

  // ═══ ALLEVENTS ═══════════════════════════════════════════════════════════
  await section('ALLEVENTS.IN pagination + JSON-LD shape', async () => {
    for (const url of [
      'https://allevents.in/bengaluru/all',
      'https://allevents.in/bengaluru/all?page=2',
      'https://allevents.in/bengaluru/technology',
      'https://allevents.in/bengaluru/business',
      'https://allevents.in/bengaluru/workshops',
      'https://allevents.in/bengaluru/music',
      'https://allevents.in/bengaluru/startups-business',
    ]) {
      const r = await get(url);
      log(url.replace('https://allevents.in/bengaluru/', ''), r.status, `jsonldEvents=${countJsonLdEvents(r.text)}`);
    }
    // Inspect one event node's fields
    const r = await get('https://allevents.in/bengaluru/all');
    for (const m of r.text.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
      try {
        const p = JSON.parse(m[1].trim());
        const arr = Array.isArray(p) ? p : p['@graph'] || [p];
        const first = (arr as Array<Record<string, unknown>>).find(n => String(n?.['@type']).includes('Event'));
        if (first) {
          console.log(`        event node keys: ${Object.keys(first).join(',')}`);
          console.log(`        sample: ${JSON.stringify(first).slice(0, 400)}`);
          break;
        }
      } catch { /* ignore */ }
    }
  });

  // ═══ EVENTBRITE ══════════════════════════════════════════════════════════
  await section('EVENTBRITE pagination', async () => {
    for (const url of [
      'https://www.eventbrite.com/d/india--bengaluru/all-events/',
      'https://www.eventbrite.com/d/india--bengaluru/all-events/?page=2',
      'https://www.eventbrite.com/d/india--bengaluru/all-events/?page=5',
      'https://www.eventbrite.com/d/india--bengaluru/technology--events/',
      'https://www.eventbrite.com/d/india--bengaluru/business--events/',
    ]) {
      const r = await get(url);
      log(url.replace('https://www.eventbrite.com/d/india--bengaluru/', ''), r.status, `jsonldEvents=${countJsonLdEvents(r.text)}`);
    }
  });

  // ═══ BEVY / GDG ══════════════════════════════════════════════════════════
  await section('BEVY (gdg.community.dev) search API shape + pagination', async () => {
    const r = await get('https://gdg.community.dev/api/search/event/?q=bangalore');
    try {
      const j = JSON.parse(r.text);
      log('search/event?q=bangalore', r.status, `count=${j.count} results=${j.results?.length}`);
      if (j.results?.[0]) {
        console.log(`        result keys: ${Object.keys(j.results[0]).join(',')}`);
        console.log(`        sample: ${JSON.stringify(j.results[0]).slice(0, 500)}`);
      }
    } catch {
      log('search/event', r.status, r.text.slice(0, 120));
    }
    for (const url of [
      'https://gdg.community.dev/api/search/event/?q=bengaluru&page=2',
      'https://gdg.community.dev/api/event_slim/?status=Published&order_by=start_date',
      'https://gdg.community.dev/api/search/event/?result_types=upcoming_event&q=bangalore',
    ]) {
      const rr = await get(url);
      let extra = rr.text.slice(0, 120).replace(/\s+/g, ' ');
      try {
        const j = JSON.parse(rr.text);
        extra = `count=${j.count} results=${j.results?.length} next=${!!j.links?.next || !!j.next}`;
      } catch { /* ignore */ }
      log(url.replace('https://gdg.community.dev/api/', ''), rr.status, extra);
    }
  });

  // ═══ UNSTOP ══════════════════════════════════════════════════════════════
  await section('UNSTOP shape', async () => {
    const r = await get(
      'https://unstop.com/api/public/opportunity/search-result?opportunity=hackathons&per_page=30&page=1'
    );
    try {
      const j = JSON.parse(r.text);
      const list = j.data?.data || j.data || [];
      log('search-result hackathons', r.status, `items=${Array.isArray(list) ? list.length : '?'}`);
      if (Array.isArray(list) && list[0]) {
        console.log(`        item keys: ${Object.keys(list[0]).slice(0, 40).join(',')}`);
        const it = list[0] as Record<string, unknown>;
        console.log(
          `        sample: title=${it.title} start=${it.start_date} region=${JSON.stringify(it.region)} logo=${it.logoUrl2 ?? it.logoUrl}`
        );
      }
    } catch (e) {
      log('unstop parse', r.status, String(e).slice(0, 120));
    }
  });

  // ═══ HASGEEK ═════════════════════════════════════════════════════════════
  await section('HASGEEK discovery', async () => {
    for (const url of [
      'https://hasgeek.com/',
      'https://hasgeek.com/api/1/project/all',
      'https://hasgeek.com/sitemap.xml',
    ]) {
      const r = await get(url);
      log(url.replace('https://hasgeek.com', ''), r.status, `bytes=${r.text.length} jsonldEvents=${countJsonLdEvents(r.text)} ${r.text.slice(0, 80).replace(/\s+/g, ' ')}`);
    }
  });

  // ═══ COMPANY PAGES that already proved they carry JSON-LD Events ═════════
  await section('COMPANY pages — JSON-LD Event yield', async () => {
    for (const url of [
      'https://www.postman.com/events/',
      'https://www.meetup.com/postman-bengaluru/events/ical/',
      'https://luma.com/user/razorpay',
      'https://www.redhat.com/en/events',
      'https://events.gitlab.com/',
      'https://www.digitalocean.com/community/events',
      'https://www.jetbrains.com/events/',
      'https://www.docker.com/events/',
      'https://cloud.google.com/events',
      'https://www.databricks.com/events',
      'https://www.confluent.io/events/',
      'https://sessionize.com/api/v2/',
    ]) {
      try {
        const r = await get(url);
        log(url.replace(/^https?:\/\//, ''), r.status, `jsonldEvents=${countJsonLdEvents(r.text)} bytes=${r.text.length}`);
      } catch (e) {
        log(url.replace(/^https?:\/\//, ''), 599, String(e).slice(0, 80));
      }
    }
  });
}

main().catch(e => {
  console.error('❌', e);
  process.exit(1);
});
