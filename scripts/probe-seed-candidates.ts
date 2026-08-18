#!/usr/bin/env tsx
/**
 * Verify the concrete, addressable seeds in the user's attended-events list.
 *
 * Three independent jobs, all read-only:
 *
 *   1. FOSS UNITED. No usable API (whitelisted methods do not exist; Frappe REST is
 *      403), but sitemap.xml exposes ~36k URLs. Find the real EVENT page pattern among
 *      them, then test whether one of those pages carries a parseable date + venue.
 *      This matters more than anything else here: open-source coverage is the weakest
 *      dimension in the audit (22%) and FOSS United is its biggest single gap.
 *
 *   2. LUMA CALENDARS. The list names two calendar handles outright
 *      (claudecommunity, aihouse) plus six specific event URLs whose HOST calendar can
 *      be harvested. Luma host calendars are the highest-yield source in the whole app.
 *
 *   3. MEETUP GROUPS named without a slug (eChai, Apache Kafka, TechNexus, MongoDB UG).
 *      Slug guessing failed 0/35 before, so resolve them the way that works: search.
 *
 * Run: npx tsx scripts/probe-seed-candidates.ts
 */
import './load-env';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

async function get(url: string, accept = 'text/html') {
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

// ─────────────────────────── 1. FOSS United ───────────────────────────
async function fossUnited() {
  console.log('══════ 1. FOSS UNITED ══════');
  const sm = await get('https://fossunited.org/sitemap.xml', 'application/xml');
  if (sm.status !== 200) {
    console.log('  sitemap unavailable:', sm.status);
    return;
  }
  const locs = [...sm.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
  console.log(`  sitemap URLs: ${locs.length}`);

  // Classify the /c/ namespace: /c/<chapter>/<event> is the event page shape, while
  // /cfp/, /schedule/, /speakers/ and friends are sub-pages of one.
  const buckets = new Map<string, number>();
  for (const l of locs) {
    const path = l.replace('https://fossunited.org', '');
    const seg = path.split('/').filter(Boolean);
    if (seg[0] !== 'c') continue;
    const shape = seg.length === 1 ? '/c' : seg.length === 2 ? '/c/<chapter>' : `/c/<chapter>/${seg.slice(2).map(s => (/^\d{4}$/.test(s) ? '<year>' : s)).join('/')}`;
    // Collapse the deep tails so the report stays readable.
    const key = shape.split('/').slice(0, 4).join('/');
    buckets.set(key, (buckets.get(key) || 0) + 1);
  }
  console.log('  /c/ path shapes (top 12):');
  for (const [k, n] of [...buckets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`     ${String(n).padStart(5)}  ${k}`);
  }

  // Chapters are the discovery unit. Find them, and look for a Bengaluru one.
  const chapters = new Set<string>();
  for (const l of locs) {
    const m = l.match(/^https:\/\/fossunited\.org\/c\/([a-z0-9-]+)$/i);
    if (m) chapters.add(m[1]);
  }
  console.log(`\n  chapters: ${chapters.size}`);
  const blrish = [...chapters].filter(c => /b[la]|blr|bengal|bangal/i.test(c));
  console.log(`  Bengaluru-ish chapter slugs: ${blrish.join(', ') || 'none'}`);
  console.log(`  all chapters: ${[...chapters].slice(0, 40).join(', ')}`);

  // Does a real event page carry a date and venue in its HTML?
  const testPages = [
    'https://fossunited.org/c/indiafoss/2026',
    ...[...chapters].filter(c => /bangalore|bengaluru|blr/i.test(c)).slice(0, 2).map(c => `https://fossunited.org/c/${c}`),
  ];
  for (const url of testPages) {
    const p = await get(url);
    console.log(`\n  -- ${url} → ${p.status} ${p.type} ${p.text.length}B`);
    if (p.status !== 200) continue;
    const t = p.text;
    const checks: Array<[string, RegExp]> = [
      ['JSON-LD Event', /"@type"\s*:\s*"[^"]*Event/i],
      ['ISO date in HTML', /\b20\d{2}-\d{2}-\d{2}\b/],
      ['"Bengaluru"/"Bangalore"', /bengaluru|bangalore/i],
      ['venue-ish word', /\bvenue\b/i],
      ['frappe.boot', /frappe\.boot\s*=/],
    ];
    for (const [label, re] of checks) console.log(`       ${re.test(t) ? 'YES' : ' no'}  ${label}`);
    const dates = [...t.matchAll(/\b(20\d{2}-\d{2}-\d{2})\b/g)].map(m => m[1]);
    if (dates.length) console.log(`       dates found: ${[...new Set(dates)].slice(0, 6).join(', ')}`);
  }
}

// ─────────────────────────── 2. Luma ───────────────────────────
const LUMA_HANDLES = ['claudecommunity', 'aihouse', 'agenticsummit'];
const LUMA_EVENTS = ['n8n-ad2z', 'lj24vm6i', 'httx5l2u', 'ozu0f41f', 'j4sh6op7'];

async function luma() {
  console.log('\n\n══════ 2. LUMA ══════');
  console.log('  -- named calendar handles --');
  for (const h of LUMA_HANDLES) {
    const r = await get(
      `https://api.lu.ma/calendar/get?url=${encodeURIComponent(h)}`,
      'application/json'
    );
    let label = `${r.status}`;
    let extra = '';
    if (r.status === 200) {
      try {
        const d = JSON.parse(r.text) as { calendar?: { api_id?: string; name?: string; geo_city?: string } };
        const cal = d.calendar;
        if (cal?.api_id) {
          extra = `api_id=${cal.api_id}  name="${cal.name}"  city=${cal.geo_city || '?'}`;
          label = '200 CALENDAR';
        }
      } catch { /* fallthrough */ }
    }
    console.log(`     ${label.padEnd(13)} luma.com/${h}  ${extra}`);
  }

  console.log('\n  -- host calendar behind each specific event --');
  for (const slug of LUMA_EVENTS) {
    const r = await get(`https://api.lu.ma/event/get?event_api_id=${slug}`, 'application/json');
    if (r.status !== 200) {
      // The public path uses the url slug, not the api id.
      const r2 = await get(`https://api.lu.ma/url?url=${encodeURIComponent(slug)}`, 'application/json');
      console.log(`     ${r.status}/${r2.status}  luma.com/${slug}`);
      if (r2.status === 200) {
        try {
          const d = JSON.parse(r2.text) as Record<string, unknown>;
          const s = JSON.stringify(d);
          const cals = [...s.matchAll(/"(cal-[A-Za-z0-9]{8,})"/g)].map(m => m[1]);
          const names = [...s.matchAll(/"name"\s*:\s*"([^"]{3,50})"/g)].map(m => m[1]).slice(0, 3);
          console.log(`            calendars: ${[...new Set(cals)].join(', ') || 'none'}  names: ${names.join(' | ')}`);
        } catch { /* ignore */ }
      }
      continue;
    }
    try {
      const d = JSON.parse(r.text);
      const s = JSON.stringify(d);
      const cals = [...s.matchAll(/"(cal-[A-Za-z0-9]{8,})"/g)].map(m => m[1]);
      console.log(`     200  luma.com/${slug}  calendars: ${[...new Set(cals)].join(', ') || 'none'}`);
    } catch {
      console.log(`     200  luma.com/${slug}  (unparseable)`);
    }
  }
}

// ─────────────────────────── 3. Meetup ───────────────────────────
const MEETUP_QUERIES = [
  'eChai Bangalore',
  'Apache Kafka Bangalore',
  'TechNexus',
  'MongoDB Bangalore',
  'Bangalore Weekend Hangout',
];

async function meetup() {
  console.log('\n\n══════ 3. MEETUP — resolve names to real slugs ══════');
  for (const q of MEETUP_QUERIES) {
    const url = `https://www.meetup.com/find/?keywords=${encodeURIComponent(q)}&location=in--Bengaluru&source=EVENTS&sortField=DATETIME`;
    const r = await get(url);
    if (r.status !== 200) {
      console.log(`  ${r.status}  "${q}"`);
      continue;
    }
    const slugs = new Set<string>();
    for (const m of r.text.matchAll(/meetup\.com\\?\/([a-zA-Z0-9][a-zA-Z0-9-]{2,60})\\?\/events\\?\/(\d{6,})/g)) {
      const s = m[1].toLowerCase();
      if (!['find', 'topics', 'cities', 'members', 'help', 'blog', 'home'].includes(s)) slugs.add(s);
    }
    console.log(`  "${q}" → ${slugs.size} slug(s)`);
    for (const s of [...slugs].slice(0, 8)) console.log(`       ${s}`);
  }
}

async function main() {
  await fossUnited();
  await luma();
  await meetup();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
