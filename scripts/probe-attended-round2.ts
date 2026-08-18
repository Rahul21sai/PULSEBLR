#!/usr/bin/env tsx
/**
 * Round 2 on the two highest-value leads from probe-attended-sources.ts.
 *
 *  1. FOSS UNITED — the flagship Indian open-source community (IndiaFOSS, plus city
 *     chapters). Round 1 got HTML with no JSON-LD and 403 on the generic Frappe REST
 *     path, but Frappe exposes several other entry points and its pages usually embed
 *     server state. This is the top priority: the audit scored open-source coverage at
 *     22%, and FOSS United is the single biggest gap in it.
 *
 *  2. HACK2SKILL — organiser of ~8 of the user's registrations, more than any other.
 *     Round 1 found a public API namespace referenced in its homepage bundle:
 *     /api/v1/innovator/public/banner/list. If a public listing endpoint exists in the
 *     same namespace, that is a clean adapter.
 *
 * Read-only, no DB.
 *
 * Run: npx tsx scripts/probe-attended-round2.ts
 */
import './load-env';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

async function get(url: string, asJson = true) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Accept: asJson ? 'application/json' : 'text/html',
        'Accept-Language': 'en-IN,en;q=0.9',
      },
      signal: AbortSignal.timeout(20000),
      redirect: 'follow',
    });
    const text = await res.text();
    return {
      status: res.status,
      type: (res.headers.get('content-type') || '').split(';')[0],
      bytes: text.length,
      text,
    };
  } catch (err) {
    return { status: 0, type: '', bytes: 0, text: '', error: err instanceof Error ? err.message : String(err) };
  }
}

function short(s: string, n = 150) {
  return s.replace(/\s+/g, ' ').slice(0, n);
}

async function fossUnited() {
  console.log('\n══════ FOSS UNITED ══════');

  // Frappe's documented read paths. get_list is the one that is usually public on
  // community sites, because the website itself calls it.
  const endpoints = [
    'https://fossunited.org/api/method/frappe.client.get_list?doctype=FOSS%20Event&fields=["name","event_name","event_start_date","city","event_type"]&limit_page_length=100',
    'https://fossunited.org/api/method/frappe.client.get_list?doctype=FOSS%20Meetup&limit_page_length=100',
    'https://fossunited.org/api/resource/FOSS Event?fields=["name"]&limit_page_length=20',
    'https://fossunited.org/api/method/fossunited.api.event.get_events',
    'https://fossunited.org/api/method/fossunited.fossunited.utils.get_events',
    'https://fossunited.org/events.json',
    'https://fossunited.org/api/method/frappe.client.get_count?doctype=FOSS%20Event',
  ];
  for (const url of endpoints) {
    const r = await get(url);
    const label = url.replace('https://fossunited.org', '').slice(0, 74);
    console.log(`  ${String(r.status).padStart(4)} ${r.type.padEnd(17)} ${String(r.bytes).padStart(7)}B  ${label}`);
    if (r.status === 200 && r.bytes > 2) console.log(`        ${short(r.text, 220)}`);
  }

  // Does the events page embed its data server-side?
  console.log('\n  -- HTML inspection of /events --');
  const page = await get('https://fossunited.org/events', false);
  console.log(`  status=${page.status} type=${page.type} bytes=${page.bytes}`);
  if (page.text) {
    const t = page.text;
    // Frappe/Vue apps often ship boot state or a JSON island.
    for (const [label, re] of [
      ['frappe.boot', /frappe\.boot\s*=/],
      ['window.__', /window\.__[A-Z_]+\s*=/],
      ['script type=application/json', /<script[^>]+type=["']application\/json["']/i],
      ['data-page attr (Inertia)', /data-page=/],
      ['__NEXT_DATA__', /__NEXT_DATA__/],
      ['event_start_date field', /event_start_date/],
      ['IndiaFOSS mention', /IndiaFOSS/i],
    ] as Array<[string, RegExp]>) {
      console.log(`    ${re.test(t) ? 'YES' : ' no'}  ${label}`);
    }
    // Pull any /c/<chapter> or /events/<slug> links — that is the discovery surface.
    const links = new Set<string>();
    for (const m of t.matchAll(/href=["'](\/(?:c|events)\/[a-z0-9/_-]{2,60})["']/gi)) links.add(m[1]);
    console.log(`    internal event/chapter links: ${links.size}`);
    for (const l of [...links].slice(0, 14)) console.log(`       ${l}`);
  }
}

async function hack2skill() {
  console.log('\n══════ HACK2SKILL ══════');
  const base = 'https://hack2skill.com/api/v1/innovator/public';
  const paths = [
    '/banner/list',
    '/hackathon/list',
    '/challenge/list',
    '/event/list',
    '/opportunity/list',
    '/hackathon/all',
    '/hackathons',
    '/explore/list',
    '/listing/list',
  ];
  for (const p of paths) {
    const r = await get(base + p);
    console.log(`  ${String(r.status).padStart(4)} ${r.type.padEnd(17)} ${String(r.bytes).padStart(7)}B  ${p}`);
    if (r.status === 200 && r.bytes > 2) console.log(`        ${short(r.text, 260)}`);
  }

  // Also try the other host the bundle referenced.
  for (const url of [
    'https://api.hack2skill.com/api/v1/innovator/public/hackathon/list',
    'https://hack2skill.com/api/v1/public/hackathon/list',
  ]) {
    const r = await get(url);
    console.log(`  ${String(r.status).padStart(4)} ${r.type.padEnd(17)} ${String(r.bytes).padStart(7)}B  ${url.slice(8, 70)}`);
    if (r.status === 200 && r.bytes > 2) console.log(`        ${short(r.text, 220)}`);
  }
}

async function main() {
  await fossUnited();
  await hack2skill();
  console.log('\nDone. Anything returning 200 with JSON rows above is adapter-ready.');
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
