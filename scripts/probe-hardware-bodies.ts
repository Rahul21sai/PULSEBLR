#!/usr/bin/env tsx
/**
 * Hardware, attempt N: stop asking the general event platforms and go to the PROFESSIONAL
 * BODIES.
 *
 * Everything measured so far says hardware is a SUPPLY problem, not a filter problem — 1 of
 * 788 stored events carries hardware vocabulary, proven four ways (diag-hardware-gap.ts,
 * diag-tech-recall.ts, probe-hardware-meetup.ts, probe-hardware-sources.ts). But every one of
 * those probes asked a general-purpose consumer platform (Meetup, Luma, Eventbrite) where
 * embedded and silicon people simply do not organise.
 *
 * Where they DO organise is the professional societies, and those have their own event
 * systems that predate the modern platforms:
 *
 *   · IEEE vTools Events — the system every IEEE section/chapter worldwide files events in.
 *     Bangalore Section is one of IEEE's largest, with Solid-State Circuits, Electron
 *     Devices, Embedded Systems, Signal Processing and Computer Society chapters. vTools has
 *     historically exposed a public REST surface, which is the specific thing to establish.
 *   · IEEE Bangalore Section's own site.
 *   · IESA — India Electronics & Semiconductor Association, the industry body for the exact
 *     sector the feed is missing.
 *   · Hackster.io — maker/embedded events, and it is a Next.js/Rails app that has published
 *     structured event data.
 *   · VLSI System Design / VSD — runs chip-design workshops out of Bengaluru.
 *   · IISc and IIIT-B seminar feeds — where the semiconductor research talks are.
 *
 * The bar is the same as every other source in this project: event objects with a title and a
 * date must be present IN A RESPONSE. A 200 that needs a browser is not a source.
 *
 * Read-only. No DB writes.
 *
 * Run: npx tsx scripts/probe-hardware-bodies.ts
 */
import './load-env';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

interface Probe {
  label: string;
  url: string;
  accept?: 'json' | 'html' | 'xml';
}

const TARGETS: Probe[] = [
  // ── IEEE vTools: the highest-value lead. Several surfaces have existed over the years.
  { label: 'vTools events (public search page)', url: 'https://events.vtools.ieee.org/events/index', accept: 'html' },
  { label: 'vTools RST list API', url: 'https://events.vtools.ieee.org/RST/events/list?limit=20', accept: 'json' },
  { label: 'vTools events.json', url: 'https://events.vtools.ieee.org/events.json?limit=20', accept: 'json' },
  { label: 'vTools upcoming (region 10)', url: 'https://events.vtools.ieee.org/events/index?region=10', accept: 'html' },
  { label: 'vTools ICS all', url: 'https://events.vtools.ieee.org/events/calendar.ics', accept: 'xml' },
  // IEEE's newer front end.
  { label: 'IEEE events search (meetings)', url: 'https://ieeemeetings.ieee.org/', accept: 'html' },

  // ── IEEE Bangalore Section itself.
  { label: 'IEEE Bangalore Section', url: 'https://ieeebangalore.org/', accept: 'html' },
  { label: 'IEEE Bangalore events page', url: 'https://ieeebangalore.org/events/', accept: 'html' },
  { label: 'IEEE Bangalore WP REST events', url: 'https://ieeebangalore.org/wp-json/wp/v2/pages?per_page=5', accept: 'json' },
  { label: 'IEEE Bangalore tribe_events', url: 'https://ieeebangalore.org/wp-json/tribe/events/v1/events?per_page=20', accept: 'json' },

  // ── Semiconductor / electronics industry bodies.
  { label: 'IESA', url: 'https://www.iesaonline.org/events', accept: 'html' },
  { label: 'IESA WP tribe_events', url: 'https://www.iesaonline.org/wp-json/tribe/events/v1/events?per_page=20', accept: 'json' },
  { label: 'SEMI India', url: 'https://www.semi.org/en/connect/events', accept: 'html' },

  // ── Makers / embedded.
  { label: 'Hackster events', url: 'https://www.hackster.io/events', accept: 'html' },
  { label: 'Hackster events JSON', url: 'https://www.hackster.io/events.json', accept: 'json' },

  // ── Chip design training that runs out of Bengaluru.
  { label: 'VLSI System Design', url: 'https://www.vlsisystemdesign.com/', accept: 'html' },

  // ── Research seminar feeds.
  { label: 'IISc events', url: 'https://iisc.ac.in/events/', accept: 'html' },
  { label: 'IISc WP tribe_events', url: 'https://iisc.ac.in/wp-json/tribe/events/v1/events?per_page=20', accept: 'json' },
  { label: 'IIIT-B events', url: 'https://www.iiitb.ac.in/events', accept: 'html' },
];

async function get(p: Probe) {
  const accept =
    p.accept === 'json'
      ? 'application/json, text/plain;q=0.9, */*;q=0.8'
      : p.accept === 'xml'
        ? 'application/xml,text/calendar,text/plain'
        : 'text/html,application/xhtml+xml,*/*;q=0.8';
  try {
    const res = await fetch(p.url, {
      headers: { 'User-Agent': UA, Accept: accept, 'Accept-Language': 'en-IN,en;q=0.9' },
      signal: AbortSignal.timeout(20000),
      redirect: 'follow',
    });
    return {
      status: res.status,
      finalUrl: res.url,
      type: (res.headers.get('content-type') || '').split(';')[0],
      text: await res.text(),
    };
  } catch (err) {
    return { status: 0, finalUrl: '', type: '', text: '', error: err instanceof Error ? err.message : String(err) };
  }
}

function jsonLdEventCount(html: string): number {
  let n = 0;
  for (const block of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const walk = (node: unknown): void => {
        if (Array.isArray(node)) return node.forEach(walk);
        if (!node || typeof node !== 'object') return;
        const o = node as Record<string, unknown>;
        const t = o['@type'];
        if ((Array.isArray(t) ? t : [t]).some(x => typeof x === 'string' && /Event$/i.test(x))) n++;
        Object.values(o).forEach(walk);
      };
      walk(JSON.parse(block[1]));
    } catch {
      /* ignore */
    }
  }
  return n;
}

/** Count plausible event objects in an arbitrary JSON payload: something with a title AND a date. */
function jsonEventCount(text: string): { count: number; sample: string[] } {
  const sample: string[] = [];
  let count = 0;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { count: 0, sample };
  }
  const TITLE = ['title', 'name', 'event_name', 'summary'];
  const DATE = ['start_time', 'startDate', 'start_date', 'start', 'date', 'begins_at', 'utc_start'];
  const stack: unknown[] = [parsed];
  const seen = new Set<unknown>();
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    if (Array.isArray(node)) { stack.push(...node); continue; }
    const o = node as Record<string, unknown>;
    const titleKey = TITLE.find(k => typeof o[k] === 'string' && (o[k] as string).length > 3);
    const dateKey = DATE.find(k => o[k] !== undefined && o[k] !== null && o[k] !== '');
    if (titleKey && dateKey) {
      count++;
      if (sample.length < 3) sample.push(`${String(o[titleKey]).slice(0, 52)} @ ${String(o[dateKey]).slice(0, 26)}`);
    }
    stack.push(...Object.values(o));
  }
  return { count, sample };
}

async function main() {
  const viable: string[] = [];

  for (const p of TARGETS) {
    const r = await get(p);
    const redirected = r.finalUrl && r.finalUrl !== p.url ? ` → ${r.finalUrl.slice(0, 58)}` : '';
    console.log(`\n── ${p.label}`);
    console.log(`   ${r.status} ${r.type.padEnd(22)} ${String(r.text.length).padStart(8)}B  ${p.url.slice(0, 62)}${redirected}`);
    if ('error' in r && r.error) { console.log(`   error: ${r.error}`); continue; }
    if (r.status !== 200 || r.text.length === 0) continue;

    const ld = jsonLdEventCount(r.text);
    const js = jsonEventCount(r.text);
    const ics = (r.text.match(/BEGIN:VEVENT/g) || []).length;
    const blr = /bengaluru|bangalore/i.test(r.text);
    const hw = /\b(embedded|vlsi|fpga|semiconductor|silicon|rtl|verilog|asic|pcb|robotics|iot|electron devices|solid[- ]state)\b/i.test(r.text);

    console.log(`   JSON-LD Events ${String(ld).padStart(4)}   JSON event objs ${String(js.count).padStart(4)}   VEVENT ${String(ics).padStart(3)}   Bengaluru ${blr ? 'Y' : 'n'}   hardware vocab ${hw ? 'Y' : 'n'}`);
    for (const s of js.sample) console.log(`      ${s}`);

    if (ld > 0 || js.count > 0 || ics > 0) {
      viable.push(`${p.label} — ${ld} JSON-LD / ${js.count} JSON / ${ics} VEVENT${blr ? ' · mentions Bengaluru' : ''}`);
    }

    // For a WordPress site that answered, the events plugin may live at a different route.
    if (/wp-json/.test(p.url) && r.status === 200 && js.count === 0) {
      console.log('   (WP REST answered but held no event objects — plugin route differs)');
    }
  }

  console.log('\n\n══ VIABLE ══');
  if (viable.length === 0) console.log('  none — hardware supply is confirmed capped at the professional bodies too');
  for (const v of viable) console.log(`  · ${v}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
