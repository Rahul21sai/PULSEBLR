#!/usr/bin/env tsx
/**
 * Round 4: the two events that matter, and WHY we miss them.
 *
 * Round 3 reduced the whole competitive question to two rows. Of the 20 events
 * events.heapheaphurray.com shows, 4 are already in our corpus and 16 are not — but 14 of those
 * 16 are Mumbai, Noida, Jammu, Visakhapatnam, Ahmedabad, Agra, Surat, Delhi, Kochi, Hyderabad
 * and Kukas, i.e. correctly out of scope for a Bengaluru product. Exactly TWO are Bengaluru
 * events we do not have:
 *
 *     JumpStart Bharat: Bengaluru        https://lu.ma/9ozcbva9
 *     Founders Running Club :: Bengaluru https://lu.ma/jlg6hl9y
 *
 * "They have two we don't" is not a finding until it explains itself. Both are Luma, and
 * PulseBLR scrapes Luma two ways — the public city discover feed, and every host calendar ever
 * discovered. So there are only a few possible causes, and they have different fixes:
 *
 *   a. the event IS on a calendar we know, and something in our pipeline dropped it
 *      (geo gate, tech filter, plausibility window, a cap)
 *   b. the event is on a calendar we have never discovered → seed it, and coverage compounds
 *      from then on, because discovered calendars persist
 *   c. the event is not in Bengaluru at all despite the label → they are wrong, not us
 *
 * This fetches each event's own Luma page, extracts the hosting calendar, and checks that
 * calendar against our `Source` collection. Read-only.
 *
 * Run: npx tsx scripts/probe-hhh-round4.ts
 */
import './load-env';
import connectDB from '../lib/mongodb';
import Event from '../lib/models/Event';
import Source from '../lib/models/Source';
import mongoose from 'mongoose';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

const TARGETS = [
  { name: 'JumpStart Bharat: Bengaluru', url: 'https://lu.ma/9ozcbva9' },
  { name: 'Founders Running Club :: Bengaluru', url: 'https://lu.ma/jlg6hl9y' },
  // Two we DO have, as controls — whatever explains a miss must not also be true of these.
  { name: 'n8n Bangalore: Founders & Builders Mixer', url: 'https://lu.ma/n8n-ad2z' },
  { name: 'AIBoomi Expert Hours with Shekhar Kirani', url: 'https://lu.ma/ExpertHoursShekhar' },
];

async function get(url: string) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html', 'Accept-Language': 'en-IN,en;q=0.9' },
      signal: AbortSignal.timeout(25000),
      redirect: 'follow',
    });
    return { status: res.status, text: await res.text() };
  } catch (err) {
    return { status: 0, text: '', error: err instanceof Error ? err.message : String(err) };
  }
}

async function main() {
  await connectDB();

  const knownCalendars = await Source.find({ kind: 'luma-calendar' }, { handle: 1, name: 1, lastEventCount: 1 }).lean();
  const knownHandles = new Set(knownCalendars.map(c => String(c.handle)));
  console.log(`we know ${knownCalendars.length} Luma calendar(s)\n`);

  for (const t of TARGETS) {
    console.log(`════ ${t.name}`);
    console.log(`     ${t.url}`);

    const page = await get(t.url);
    if (page.status !== 200) {
      console.log(`     ${page.status} — could not fetch${'error' in page && page.error ? `: ${page.error}` : ''}\n`);
      continue;
    }

    // Luma event pages carry JSON-LD plus an RSC/embedded payload naming the calendar.
    const jsonLd: Array<Record<string, unknown>> = [];
    for (const b of page.text.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
      try {
        const parsed = JSON.parse(b[1]);
        (Array.isArray(parsed) ? parsed : [parsed]).forEach(x => jsonLd.push(x as Record<string, unknown>));
      } catch { /* ignore */ }
    }
    const ev = jsonLd.find(n => /Event$/i.test(String(n['@type'] ?? '')));

    const loc = ev?.location as Record<string, unknown> | undefined;
    const addr = loc?.address as Record<string, unknown> | string | undefined;
    const cityFromLd =
      typeof addr === 'string' ? addr : String((addr?.addressLocality as string) ?? '');
    console.log(`     JSON-LD: name=${String(ev?.name ?? '—').slice(0, 44)}`);
    console.log(`              start=${String(ev?.startDate ?? '—')}  city=${cityFromLd || '—'}`);
    console.log(`              venue=${String(loc?.name ?? '—').slice(0, 50)}`);
    console.log(`              mode=${String(ev?.eventAttendanceMode ?? '—').replace(/.*\//, '')}`);

    // Which calendar hosts it? Luma embeds calendar api_id / slug in the payload.
    const calSlugs = new Set<string>();
    for (const m of page.text.matchAll(/"calendar"\s*:\s*\{[^}]*?"slug"\s*:\s*"([a-z0-9-]+)"/gi)) calSlugs.add(m[1]);
    for (const m of page.text.matchAll(/"calendar_api_id"\s*:\s*"(cal-[A-Za-z0-9]+)"/g)) calSlugs.add(m[1]);
    for (const m of page.text.matchAll(/"api_id"\s*:\s*"(cal-[A-Za-z0-9]+)"/g)) calSlugs.add(m[1]);
    const hostNames = new Set<string>();
    for (const m of page.text.matchAll(/"name"\s*:\s*"([^"]{3,50})"\s*,\s*"[^"]*"\s*:\s*"[^"]*"\s*,?\s*"?(?:avatar_url|instagram)/gi)) {
      hostNames.add(m[1]);
    }

    console.log(`     calendar id/slug candidates: ${[...calSlugs].join(', ') || 'none found in payload'}`);
    const knownHit = [...calSlugs].filter(s => knownHandles.has(s));
    console.log(`     of those, ALREADY KNOWN to us: ${knownHit.join(', ') || 'NONE'}`);

    // Is it in our corpus under any identity?
    const slug = t.url.split('/').pop()!;
    const inCorpus = await Event.findOne(
      {
        $or: [
          { sourceUrl: new RegExp(slug, 'i') },
          { applyLink: new RegExp(slug, 'i') },
          { title: new RegExp(t.name.replace(/[.*+?^${}()|[\]\\:]/g, '\\$&').slice(0, 24), 'i') },
        ],
      },
      { title: 1, source: 1, city: 1, isTechEvent: 1, startDateTime: 1 }
    ).lean();
    console.log(
      `     in OUR corpus: ${inCorpus ? `YES — "${String(inCorpus.title).slice(0, 40)}" [${inCorpus.source}] tech=${inCorpus.isTechEvent}` : 'NO'}`
    );

    // Verdict per the three causes in the header.
    const isBlr = /bengaluru|bangalore/i.test(`${cityFromLd} ${String(loc?.name ?? '')} ${String(ev?.name ?? '')}`);
    if (inCorpus) console.log('     → already covered; nothing to do.');
    else if (!isBlr) console.log('     → NOT actually Bengaluru on its own page. Their label is wrong, not our coverage.');
    else if (knownHit.length > 0) console.log('     → on a calendar WE ALREADY SCRAPE, so our pipeline dropped it. Investigate the filters.');
    else console.log('     → on a calendar we have NEVER discovered. Seeding it fixes this and compounds.');

    console.log('');
  }

  console.log('════ Our Luma calendar coverage, for context ════\n');
  const productive = knownCalendars.filter(c => (c.lastEventCount ?? 0) > 0).length;
  console.log(`  known ${knownCalendars.length}, of which produced events last run: ${productive}`);
  console.log('  Adding a calendar is a one-line seed entry and it persists, so a single miss found');
  console.log('  this way is worth acting on — discovery only ever grows.');

  await mongoose.disconnect();
}

main().catch(async e => {
  console.error(e);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
