#!/usr/bin/env tsx
/**
 * The Meetup geo guard cannot reject anything. This measures what got in.
 *
 * `lib/scrapers/adapters/meetup.ts` filters group-ICS events with:
 *
 *     if (isBengaluru({ text: event.description }) === false) continue;
 *
 * and comments it "Reject an event that positively names another city". It does not do that.
 * Reading `isBengaluru` (lib/scrapers/core/geo.ts), the only branch that returns `false` from a
 * text signal is `if (namesOther) return false` — and it sits INSIDE `if (location)`, where
 * `location = [venue, address].join(', ')`. The Meetup adapter's own file header documents that
 * "ICS emits no LOCATION", so venue and address are always absent here. With only `text` set the
 * function can return `true` or `null`, never `false`, so the `=== false` comparison is never
 * satisfied and every event passes.
 *
 * This matters because Meetup is by far the largest source (881 of ~1210 upcoming) and because
 * group ICS feeds are NOT city-scoped: the Meetup keyword fan-out discovers groups by topic, and
 * a group discovered in a Bengaluru search can run its events anywhere. `lfdt-coimbatore` is
 * already in the seed list as a known example.
 *
 * The fix is one line — pass the fields the guard needs, or make the guard reject on text — but
 * the size of the problem decides how urgent that is, so measure before changing.
 *
 * Read-only.
 *
 * Run: npx tsx scripts/diag-meetup-geo-leak.ts
 */
import './load-env';
import connectDB from '../lib/mongodb';
import Event from '../lib/models/Event';
import { isBengaluru } from '../lib/scrapers/core/geo';
import mongoose from 'mongoose';

/** Cities that are definitively NOT Bengaluru, as they appear in real event copy. */
const OTHER_CITIES = [
  'Chennai', 'Coimbatore', 'Kochi', 'Cochin', 'Trivandrum', 'Thiruvananthapuram',
  'Mumbai', 'Pune', 'Nagpur', 'Ahmedabad', 'Surat', 'Vadodara', 'Jaipur', 'Indore',
  'Bhopal', 'Lucknow', 'Kanpur', 'Prayagraj', 'Guwahati', 'Kolkata', 'Bhubaneswar',
  'Hyderabad', 'Vijayawada', 'Visakhapatnam', 'Delhi', 'Gurgaon', 'Gurugram', 'Noida',
  'Chandigarh', 'Dehradun', 'Jammu', 'Goa', 'Nashik',
  'San Francisco', 'Los Angeles', 'New York', 'Seattle', 'Austin', 'London', 'Berlin',
  'Singapore', 'Dubai', 'Tokyo', 'Sydney', 'Toronto', 'Amsterdam', 'Paris',
];

async function main() {
  await connectDB();

  console.log('════ 1. Prove the guard is dead, with the real function ════\n');
  const cases: Array<[string, string]> = [
    ['names Chennai only', 'Join us in Chennai for a hands-on workshop.'],
    ['names San Francisco only', 'Meetup at our San Francisco office.'],
    ['names Bengaluru', 'Our Bengaluru chapter meets at Indiranagar.'],
    ['names nothing', 'A talk about distributed systems.'],
  ];
  for (const [label, text] of cases) {
    const asMeetupCallsIt = isBengaluru({ text });
    const ifVenueWerePassed = isBengaluru({ venue: text });
    console.log(
      `  ${label.padEnd(26)} isBengaluru({text}) = ${String(asMeetupCallsIt).padEnd(5)}  ` +
        `rejected by "=== false"? ${asMeetupCallsIt === false ? 'YES' : 'no'}   ` +
        `[{venue} would give ${String(ifVenueWerePassed)}]`
    );
  }
  console.log('\n  → the guard as written can never reject. Passing the same string as `venue`');
  console.log('    (or `address`) makes the OTHER_STATE_HINTS branch reachable.');

  console.log('\n════ 2. What actually got into the corpus ════\n');
  const now = new Date();
  const rows = await Event.find(
    {
      source: 'meetup',
      $or: [{ startDateTime: { $gte: now } }, { endDateTime: { $gte: now } }],
    },
    { title: 1, description: 1, venue: 1, address: 1, city: 1, area: 1, isTechEvent: 1, organizer: 1, format: 1 }
  ).lean();

  console.log(`  ${rows.length} upcoming Meetup events\n`);

  const offenders: Array<{ city: string; row: (typeof rows)[number] }> = [];
  for (const r of rows) {
    const haystack = `${r.title ?? ''} ${r.venue ?? ''} ${r.address ?? ''}`;
    // Only judge on TITLE/VENUE/ADDRESS, never the description: a Bengaluru event may легitimately
    // mention another city in its body ("lessons from our Chennai rollout").
    const hit = OTHER_CITIES.find(c => new RegExp(`\\b${c}\\b`, 'i').test(haystack));
    if (!hit) continue;
    // A string naming BOTH is ambiguous (a highway, a tour) — leave it out of the count.
    if (/\b(bengaluru|bangalore|blr)\b/i.test(haystack)) continue;
    offenders.push({ city: hit, row: r });
  }

  const inTechFeed = offenders.filter(o => o.row.isTechEvent);
  const online = offenders.filter(o => o.row.format === 'online');

  console.log(`  name another city in title/venue/address, and NOT Bengaluru: ${offenders.length}`);
  console.log(`    of those, in the default tech feed: ${inTechFeed.length}`);
  console.log(`    of those, online (arguably fine — you can attend from here): ${online.length}`);
  console.log(`    of those, IN-PERSON elsewhere (indefensible): ${offenders.filter(o => o.row.format !== 'online').length}`);

  const byCity = new Map<string, number>();
  for (const o of offenders) byCity.set(o.city, (byCity.get(o.city) ?? 0) + 1);
  if (byCity.size) {
    console.log('\n  by city:');
    for (const [c, n] of [...byCity.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(n).padStart(3)}  ${c}`);
    }
  }

  console.log('\n  ── the in-person ones, which a Bengaluru user cannot attend ──');
  for (const o of offenders.filter(x => x.row.format !== 'online').slice(0, 25)) {
    console.log(
      `    ${o.city.padEnd(16)} tech=${String(o.row.isTechEvent).padEnd(5)} ${String(o.row.title).slice(0, 46).padEnd(46)} area=${String(o.row.area ?? '—').slice(0, 14)}`
    );
  }

  console.log('\n  ── a sample of the online ones, for the judgement call ──');
  for (const o of online.slice(0, 8)) {
    console.log(`    ${o.city.padEnd(16)} ${String(o.row.title).slice(0, 54)}`);
  }

  console.log('\nFIX: pass the fields the guard needs. In meetup.ts the ICS row has no venue, so');
  console.log('either give isBengaluru the title as `venue` (it is the only location-ish string');
  console.log('available) or add a text-level OTHER_STATE_HINTS rejection to geo.ts. Prefer the');
  console.log('latter ONLY if it cannot reject a Bengaluru event that merely mentions elsewhere —');
  console.log('the enrichment pass fills real venues later, so the cheap correct move is to let');
  console.log('enrichment decide and re-check geo AFTER it, not before.');

  await mongoose.disconnect();
}

main().catch(async e => {
  console.error(e);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
