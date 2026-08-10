#!/usr/bin/env tsx
/**
 * READ-ONLY recon round 2 — drill into what round 1 proved viable, and hunt the
 * XHR APIs behind the SPA shells.
 *
 * Round 1 results that shaped this:
 *   · developers.events/all-events.json → 6051 records with date/city/country. The
 *     single biggest tech-conference source found. Needs shape + India filtering.
 *   · usergroups.snowflake.com (Bevy) → works. Most other company Bevy tenants do
 *     not resolve, so the tenant list must be verified rather than guessed.
 *   · gdg.community.dev/api/event_slim → 500 records with pagination (the adapter
 *     currently only uses the search endpoint, which caps out).
 *   · aws-experience.com → 1.6-2.4KB Angular shell. The data must come from an XHR.
 *   · aws.amazon.com/events/summits → HTML with no JSON-LD.
 *
 * Run: npx tsx scripts/probe-microsites-round2.ts
 */
import './load-env';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function get(url: string, headers: Record<string, string> = {}) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json,text/html;q=0.9,*/*;q=0.8', ...headers },
      redirect: 'follow',
      signal: AbortSignal.timeout(30000),
    });
    return { status: res.status, text: await res.text(), ct: res.headers.get('content-type') || '' };
  } catch (err) {
    return { status: 0, text: err instanceof Error ? err.message : String(err), ct: '' };
  }
}

function line(mark: string, label: string, extra: string) {
  console.log(`${mark} ${label.padEnd(44)} ${extra}`);
}

async function main() {
  // ═══ 1. developers.events — the big one ══════════════════════════════════
  console.log('\n══ 1. developers.events/all-events.json ═════════════════════════');
  const de = await get('https://developers.events/all-events.json');
  if (de.status === 200) {
    try {
      const all = JSON.parse(de.text) as Array<Record<string, unknown>>;
      console.log(`   ${all.length} total events`);
      console.log(`   record keys: ${Object.keys(all[0] || {}).join(', ')}`);
      console.log(`   sample: ${JSON.stringify(all[0]).slice(0, 260)}`);

      const india = all.filter(e =>
        /india/i.test(String(e.country ?? '')) || /bengaluru|bangalore/i.test(String(e.city ?? ''))
      );
      console.log(`\n   India events: ${india.length}`);
      const blr = india.filter(e => /bengaluru|bangalore/i.test(String(e.city ?? '')));
      console.log(`   Bengaluru events: ${blr.length}`);
      for (const e of blr.slice(0, 12)) {
        console.log(`      ${JSON.stringify(e.date).slice(0, 34)}  ${String(e.name).slice(0, 42)}  city=${e.city}`);
      }
      // How are dates shaped? That determines the adapter's parsing.
      console.log(`\n   date field shapes seen: ${[...new Set(all.slice(0, 200).map(e => typeof e.date === 'object' ? Object.keys(e.date as object).join('+') : typeof e.date))].join(' | ')}`);
      // Upcoming only?
      const withDates = blr.filter(e => e.date);
      console.log(`   Bengaluru with a date: ${withDates.length}`);
    } catch (err) {
      console.log(`   parse failed: ${String(err).slice(0, 120)}`);
    }
  } else {
    console.log(`   HTTP ${de.status}`);
  }

  // ═══ 2. Bevy tenants — verify which actually exist ═══════════════════════
  console.log('\n══ 2. Bevy tenants (verify, do not guess) ═══════════════════════');
  const BEVY_HOSTS = [
    'https://gdg.community.dev',
    'https://community.cncf.io',
    'https://usergroups.snowflake.com',
    'https://community.sap.com',
    'https://events.mongodb.com',
    'https://community.datastax.com',
    'https://airbyte.community.dev',
    'https://community.temporal.io',
    'https://community.uipath.com',
    'https://developers.events',
    'https://community.aws',
    'https://community.jamf.com',
    'https://meetups.redis.io',
    'https://community.grafana.com',
    'https://commonroom.community.dev',
    'https://bevy.community.dev',
    'https://community.neo4j.com',
    'https://events.zoom.us',
  ];
  for (const host of BEVY_HOSTS) {
    const r = await get(`${host}/api/search/event/?q=bengaluru`);
    let info = `HTTP ${r.status}`;
    if (r.status === 200) {
      try {
        const j = JSON.parse(r.text);
        info = `HTTP 200  count=${j.count}  results=${j.results?.length ?? 0}`;
      } catch {
        info = `HTTP 200 but not the Bevy shape (${r.ct})`;
      }
    }
    line(r.status === 200 && r.text.startsWith('{') ? 'YES ' : ' -  ', host.replace('https://', ''), info);
  }

  // ═══ 3. GDG event_slim: pagination + city filter ═════════════════════════
  console.log('\n══ 3. GDG event_slim — can we filter by city? ═══════════════════');
  for (const q of [
    'https://gdg.community.dev/api/event_slim/?status=Published&order_by=start_date&page_size=10',
    'https://gdg.community.dev/api/event_slim/?status=Published&chapter__city=Bangalore&page_size=10',
    'https://gdg.community.dev/api/event_slim/?status=Published&search=bengaluru&page_size=10',
  ]) {
    const r = await get(q);
    let info = `HTTP ${r.status}`;
    if (r.status === 200) {
      try {
        const j = JSON.parse(r.text);
        info = `count=${j.count} results=${j.results?.length} next=${Boolean(j.next || j.links?.next)}`;
        if (j.results?.[0]) info += `  keys=${Object.keys(j.results[0]).slice(0, 8).join(',')}`;
      } catch { /* ignore */ }
    }
    line(r.status === 200 ? 'YES ' : ' -  ', q.split('?')[1].slice(0, 42), info);
  }

  // ═══ 4. AWS — find the XHR behind the SPA ════════════════════════════════
  console.log('\n══ 4. AWS event APIs ════════════════════════════════════════════');
  const AWS_CANDIDATES = [
    'https://aws-experience.com/apj/india/api/events',
    'https://aws-experience.com/api/events',
    'https://aws-experience.com/apj/india/assets/data/events.json',
    // AWS's public "directory" API powers many aws.amazon.com listings. The
    // directoryId is the unknown; try the documented naming patterns.
    'https://aws.amazon.com/api/dirs/items/search?item.directoryId=aws-event&sort_by=item.additionalFields.startDateTime&sort_order=asc&size=20',
    'https://aws.amazon.com/api/dirs/items/search?item.directoryId=events-and-webinars&size=20',
    'https://aws.amazon.com/api/dirs/items/search?item.directoryId=summits&size=20',
    'https://aws.amazon.com/api/dirs/items/search?item.directoryId=event-cards&size=20',
    'https://aws.amazon.com/api/dirs/items/search?item.directoryId=amer-summits&size=20',
  ];
  for (const url of AWS_CANDIDATES) {
    const r = await get(url);
    let info = `HTTP ${r.status} ${r.text.length}B`;
    if (r.status === 200) {
      try {
        const j = JSON.parse(r.text);
        const items = j.items ?? j.events ?? j;
        info += `  items=${Array.isArray(items) ? items.length : '?'}`;
        if (Array.isArray(items) && items[0]) {
          info += `  keys=${Object.keys(items[0].item?.additionalFields ?? items[0]).slice(0, 6).join(',')}`;
        }
      } catch { /* html */ }
    }
    line(r.status === 200 && r.ct.includes('json') ? 'YES ' : ' -  ', url.replace('https://', '').slice(0, 44), info);
  }

  // ═══ 5. Open-source India communities ════════════════════════════════════
  console.log('\n══ 5. Open-source community endpoints ═══════════════════════════');
  const OSS = [
    'https://fossunited.org/api/method/fossunited.api.event.get_events',
    'https://fossunited.org/api/resource/FOSS%20Meetup?limit_page_length=50',
    'https://fossunited.org/api/resource/FOSS Chapter?limit_page_length=50',
    'https://hasgeek.com/api/1/event/all',
    'https://hasgeek.com/json',
    'https://in.pycon.org/',
    'https://indiaosscon.org/',
    'https://events.linuxfoundation.org/wp-json/wp/v2/lf_events?per_page=50',
    'https://www.cncf.io/wp-json/wp/v2/events?per_page=50',
    'https://community.cncf.io/api/search/event/?q=india',
  ];
  for (const url of OSS) {
    const r = await get(url);
    let info = `HTTP ${r.status} ${r.text.length}B`;
    if (r.status === 200 && r.ct.includes('json')) {
      try {
        const j = JSON.parse(r.text);
        const arr = Array.isArray(j) ? j : (j.data ?? j.results ?? j.message ?? []);
        info += `  records=${Array.isArray(arr) ? arr.length : '?'}`;
        if (Array.isArray(arr) && arr[0]) info += `  keys=${Object.keys(arr[0]).slice(0, 7).join(',')}`;
      } catch { /* ignore */ }
    }
    line(r.status === 200 && r.ct.includes('json') ? 'YES ' : ' -  ', url.replace('https://', '').slice(0, 44), info);
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
