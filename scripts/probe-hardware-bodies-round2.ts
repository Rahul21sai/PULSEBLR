#!/usr/bin/env tsx
/**
 * Round 2 on the professional bodies. Round 1's headline was "none viable", and that headline
 * was too quick on three of them.
 *
 * What round 1 actually found:
 *   · IEEE Bangalore `/wp-json/tribe/events/v1/events` returned **200 with a 212-byte body**.
 *     IESA's same route returned 404. A 200 means The Events Calendar plugin IS INSTALLED and
 *     answering — 212 bytes is an empty result set, not a missing endpoint. An empty set can
 *     mean "no upcoming events right now", which is a completely different conclusion from
 *     "no mechanism exists", and only one of those is permanent.
 *   · IISc redirects /events/ to /news-events/events/ and serves 291 KB containing hardware
 *     vocabulary. It is the institution running Bengaluru's semiconductor and electron-device
 *     research seminars. WordPress sites expose custom post types over wp-json even when the
 *     rendered page has no JSON-LD.
 *   · IIIT-B, same shape, 93 KB.
 *
 * So this round asks the follow-up questions instead of the opening ones: read the empty
 * body, ask the plugin for PAST events to prove the collection is populated, enumerate the
 * custom post types, and look for RSS — which every WordPress install has whether or not
 * anyone remembered to add schema.org markup.
 *
 * Read-only. No DB writes.
 *
 * Run: npx tsx scripts/probe-hardware-bodies-round2.ts
 */
import './load-env';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

async function get(url: string) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Accept: 'application/json, application/rss+xml, text/xml, text/html;q=0.8, */*;q=0.5',
        'Accept-Language': 'en-IN,en;q=0.9',
      },
      signal: AbortSignal.timeout(25000),
      redirect: 'follow',
    });
    return { status: res.status, type: (res.headers.get('content-type') || '').split(';')[0], text: await res.text() };
  } catch (err) {
    return { status: 0, type: '', text: '', error: err instanceof Error ? err.message : String(err) };
  }
}

const line = (label: string, r: { status: number; type: string; text: string }) =>
  `   ${String(r.status).padEnd(4)} ${r.type.padEnd(20)} ${String(r.text.length).padStart(8)}B  ${label}`;

async function main() {
  // ────────────────────────────────────────────────────────────────────────────
  console.log('══ 1. IEEE Bangalore — is The Events Calendar populated? ══\n');

  const tribeBase = 'https://ieeebangalore.org/wp-json/tribe/events/v1';
  const empty = await get(`${tribeBase}/events?per_page=20`);
  console.log(line('events?per_page=20', empty));
  console.log(`   body: ${empty.text.slice(0, 400)}`);

  // The decisive question: does the collection hold anything at all? If PAST events come back,
  // the mechanism works and the source is simply quiet — an adapter would start producing the
  // moment they publish. If even the past is empty, nobody uses the plugin.
  for (const q of [
    'events?per_page=20&start_date=2020-01-01',
    'events?per_page=20&start_date=2020-01-01&end_date=2026-12-31',
    'events/?per_page=20&status=publish&start_date=2024-01-01',
    'events?per_page=5&page=1&order=desc&orderby=start_date&start_date=2023-01-01',
  ]) {
    const r = await get(`${tribeBase}/${q}`);
    let total = '?';
    let names: string[] = [];
    try {
      const j = JSON.parse(r.text) as { total?: number; events?: Array<{ title?: string; start_date?: string }> };
      total = String(j.total ?? '?');
      names = (j.events || []).slice(0, 4).map(e => `${String(e.title).slice(0, 44)} @ ${e.start_date ?? '?'}`);
    } catch {
      /* not json */
    }
    console.log(line(`${q.slice(0, 58)}  total=${total}`, r));
    for (const n of names) console.log(`        ${n}`);
  }

  // ────────────────────────────────────────────────────────────────────────────
  console.log('\n\n══ 2. WordPress custom post types + RSS, for all three institutions ══');

  const sites = [
    { label: 'IEEE Bangalore', base: 'https://ieeebangalore.org' },
    { label: 'IISc', base: 'https://www.iisc.ac.in' },
    { label: 'IIIT-B', base: 'https://www.iiitb.ac.in' },
  ];

  for (const site of sites) {
    console.log(`\n── ${site.label} (${site.base})`);

    // Enumerate post types. This is how you find an events CPT without guessing its name.
    const types = await get(`${site.base}/wp-json/wp/v2/types`);
    console.log(line('wp-json/wp/v2/types', types));
    let eventish: string[] = [];
    if (types.status === 200) {
      try {
        const j = JSON.parse(types.text) as Record<string, { name?: string; rest_base?: string }>;
        const keys = Object.keys(j);
        console.log(`        ${keys.length} type(s): ${keys.slice(0, 22).join(', ')}`);
        eventish = keys
          .filter(k => /event|seminar|talk|lecture|webinar|conference|workshop|colloqui/i.test(k))
          .map(k => j[k]?.rest_base || k);
      } catch {
        /* ignore */
      }
    }
    if (eventish.length === 0) {
      // Try the conventional names anyway — a site can restrict /types while exposing the CPT.
      eventish = ['event', 'events', 'tribe_events', 'seminars', 'seminar'];
      console.log('        no event-ish type listed; trying conventional rest_bases');
    } else {
      console.log(`        event-ish rest_base(s): ${eventish.join(', ')}`);
    }

    for (const base of eventish.slice(0, 6)) {
      const r = await get(`${site.base}/wp-json/wp/v2/${base}?per_page=5`);
      let count = 0;
      const sample: string[] = [];
      if (r.status === 200) {
        try {
          const j = JSON.parse(r.text);
          if (Array.isArray(j)) {
            count = j.length;
            for (const item of j.slice(0, 3)) {
              const o = item as Record<string, unknown>;
              const title = (o.title as { rendered?: string } | undefined)?.rendered ?? o.title;
              // A post's `date` is when it was PUBLISHED, not when the event happens. Look for
              // an event-date field in meta/acf, otherwise say so plainly.
              const meta = JSON.stringify(o.meta ?? o.acf ?? {}).slice(0, 90);
              sample.push(`${String(title).slice(0, 46)} | published ${String(o.date).slice(0, 10)} | meta ${meta}`);
            }
          }
        } catch {
          /* ignore */
        }
      }
      console.log(line(`wp/v2/${base}  items=${count}`, r));
      for (const s of sample) console.log(`        ${s}`);
    }

    // RSS: universal on WordPress, and the ICS/RSS path is already a first-class mechanism in
    // universal.ts, so a working feed needs no new parser.
    for (const path of ['/feed/', '/events/feed/', '/news-events/events/feed/', '/?feed=rss2&post_type=tribe_events']) {
      const r = await get(`${site.base}${path}`);
      const items = (r.text.match(/<item>/g) || []).length;
      const isRss = /<rss|<feed/i.test(r.text.slice(0, 400));
      console.log(line(`${path}  items=${items}${isRss ? ' (RSS)' : ''}`, r));
      if (isRss && items > 0) {
        const titles = [...r.text.matchAll(/<title>(?:<!\[CDATA\[)?([^<\]]{4,80})/g)].slice(1, 4).map(m => m[1]);
        for (const t of titles) console.log(`        ${t}`);
      }
    }

    // The Events Calendar also publishes ICS per page — a standard, not a selector.
    const ics = await get(`${site.base}/events/?ical=1`);
    const vevents = (ics.text.match(/BEGIN:VEVENT/g) || []).length;
    console.log(line(`/events/?ical=1  VEVENT=${vevents}`, ics));
  }

  console.log('\n\nVERDICT: a populated tribe/events collection, an events CPT carrying a real event');
  console.log('date, or an RSS/ICS feed with future items each make an adapter possible. A 200 with');
  console.log('an empty array means the mechanism exists but nobody publishes through it — worth');
  console.log('recording, not worth an adapter.');
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
