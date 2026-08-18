#!/usr/bin/env tsx
/**
 * Round 3: characterise the two endpoints round 2 found.
 *
 *  1. hack2skill /api/v1/innovator/public/event/list returned 200 + 62KB of JSON.
 *     Establish the full field shape, how many events there are, how many are
 *     Bengaluru, and how many are upcoming — the three numbers that decide whether an
 *     adapter is worth writing.
 *
 *  2. fossunited.org whitelisted methods returned 417, not 403. In Frappe, 417 means
 *     the method EXISTS and is callable but the arguments failed validation, whereas
 *     403 means blocked. So dump the 417 bodies: Frappe echoes the missing argument
 *     names, which tells us how to call it.
 *
 * Read-only, no DB.
 *
 * Run: npx tsx scripts/probe-attended-round3.ts
 */
import './load-env';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

const BLR = /bengaluru|bangalore/gi;

async function get(url: string) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json', 'Accept-Language': 'en-IN,en;q=0.9' },
    signal: AbortSignal.timeout(25000),
    redirect: 'follow',
  });
  const text = await res.text();
  return { status: res.status, type: (res.headers.get('content-type') || '').split(';')[0], text };
}

/** Recursively collect every object that has a title-ish key. */
function collectEvents(node: unknown, out: Record<string, unknown>[] = [], depth = 0): Record<string, unknown>[] {
  if (depth > 7 || !node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const c of node) collectEvents(c, out, depth + 1);
    return out;
  }
  const obj = node as Record<string, unknown>;
  if (typeof obj.title === 'string' && ('eventUrl' in obj || 'mode' in obj || 'tags' in obj || 'startDate' in obj)) {
    out.push(obj);
  }
  for (const v of Object.values(obj)) collectEvents(v, out, depth + 1);
  return out;
}

async function hack2skill() {
  console.log('══════ HACK2SKILL /event/list ══════');
  const r = await get('https://hack2skill.com/api/v1/innovator/public/event/list');
  console.log(`status=${r.status} type=${r.type} bytes=${r.text.length}`);
  const body = JSON.parse(r.text) as { data?: Record<string, unknown> };
  const data = body.data || {};
  console.log('top-level data keys:', Object.keys(data).join(', '));
  for (const [k, v] of Object.entries(data)) {
    if (Array.isArray(v)) console.log(`   ${k}: ${v.length} row(s)`);
  }

  const events = collectEvents(data);
  console.log(`\ncollected ${events.length} event-shaped object(s)`);
  if (events.length === 0) return;

  console.log('\nfield inventory (keys present across all rows):');
  const keys = new Map<string, number>();
  for (const e of events) for (const k of Object.keys(e)) keys.set(k, (keys.get(k) || 0) + 1);
  for (const [k, n] of [...keys.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`   ${String(n).padStart(3)}/${events.length}  ${k}`);
  }

  console.log('\nfull first row:');
  console.log(JSON.stringify(events[0], null, 2).slice(0, 1600));

  // The decisive numbers.
  const now = Date.now();
  let blr = 0;
  let upcoming = 0;
  let bothCount = 0;
  const samples: string[] = [];
  for (const e of events) {
    const blob = JSON.stringify(e);
    const isBlr = BLR.test(blob);
    BLR.lastIndex = 0;
    // Dates appear under several possible keys; try them all.
    const candidates = ['startDate', 'endDate', 'eventStartDate', 'startsAt', 'date', 'regEndDate'];
    let ts = 0;
    for (const c of candidates) {
      const v = e[c];
      if (typeof v === 'string' || typeof v === 'number') {
        const t = new Date(v).getTime();
        if (Number.isFinite(t) && t > 0) { ts = Math.max(ts, t); }
      }
    }
    const isUpcoming = ts > now;
    if (isBlr) blr++;
    if (isUpcoming) upcoming++;
    if (isBlr && isUpcoming) {
      bothCount++;
      samples.push(`${new Date(ts).toISOString().slice(0, 10)}  ${String(e.title).slice(0, 54)}`);
    }
  }
  console.log(`\nBengaluru-mentioning: ${blr}/${events.length}`);
  console.log(`upcoming (any date field in the future): ${upcoming}/${events.length}`);
  console.log(`BOTH Bengaluru AND upcoming: ${bothCount}`);
  for (const s of samples.slice(0, 10)) console.log(`   ${s}`);
}

async function fossUnited() {
  console.log('\n\n══════ FOSS UNITED — reading the 417 bodies ══════');
  const methods = [
    'https://fossunited.org/api/method/fossunited.api.event.get_events',
    'https://fossunited.org/api/method/fossunited.fossunited.utils.get_events',
  ];
  for (const url of methods) {
    const r = await get(url);
    console.log(`\n${r.status}  ${url.split('/api/method/')[1]}`);
    // Frappe puts the useful part in the exception message / _server_messages.
    try {
      const parsed = JSON.parse(r.text) as Record<string, unknown>;
      for (const k of ['exception', 'exc_type', '_server_messages', 'message']) {
        if (parsed[k]) console.log(`   ${k}: ${String(parsed[k]).replace(/\s+/g, ' ').slice(0, 300)}`);
      }
      if (Array.isArray(parsed.exc)) console.log(`   exc: ${String(parsed.exc[0]).slice(0, 200)}`);
    } catch {
      console.log('   (non-JSON) ' + r.text.replace(/\s+/g, ' ').slice(0, 250));
    }
  }

  // The site is a Frappe *portal*; its pages are server-rendered, so the reliable
  // route is the sitemap plus per-page HTML rather than an API.
  console.log('\n-- sitemap / discovery surface --');
  for (const url of [
    'https://fossunited.org/sitemap.xml',
    'https://fossunited.org/events/timeline',
  ]) {
    try {
      const r = await get(url);
      console.log(`  ${r.status} ${r.type} ${r.text.length}B  ${url}`);
      if (url.endsWith('.xml') && r.status === 200) {
        const locs = [...r.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
        console.log(`     ${locs.length} URL(s) in sitemap`);
        const evt = locs.filter(l => /\/(events|c)\//.test(l));
        console.log(`     ${evt.length} event/chapter URL(s); samples:`);
        for (const l of evt.slice(0, 12)) console.log(`       ${l}`);
      }
      if (url.includes('timeline') && r.status === 200) {
        const titles = [...r.text.matchAll(/<h[23][^>]*>\s*([^<]{6,70})\s*</g)].map(m => m[1].trim());
        console.log(`     ${titles.length} heading(s); samples: ${titles.slice(0, 8).join(' | ').slice(0, 240)}`);
        console.log(`     Bengaluru mentions: ${(r.text.match(BLR) || []).length}`);
      }
    } catch (err) {
      console.log(`  ERR ${url}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

async function main() {
  await hack2skill();
  await fossUnited();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
