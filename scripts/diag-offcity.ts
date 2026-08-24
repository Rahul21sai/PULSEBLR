#!/usr/bin/env tsx
/**
 * Which events in the corpus are not in Bengaluru?
 *
 * PulseBLR's scope is one city. The scraper deliberately ingests the whole of it — concerts,
 * treks, book clubs — because one broad pass is cheaper than many narrow ones and the
 * classifier sorts it out. That argument covers the wrong TOPIC. It does not cover the wrong
 * CITY: a Chennai event is not noise a filter can rescue, it is out of scope in a way no
 * category or `techOnly` toggle expresses, and it appears in the default feed alongside the
 * real ones.
 *
 * Found while grouping upcoming events by `city`: alongside 349 Bengaluru / 272 Bangalore there
 * sat Chennai, Mumbai, Hyderabad, Coimbatore, Bali, New York, San Francisco, Pisa. Worse, six
 * upcoming events flagged `isTechEvent` name another city in their own TITLE — "Chennai - Build
 * Your First AI Agent", "Anthropic - Code - Coffee : Coimbatore Edition" — so they are in the
 * DEFAULT tech feed, which is the one surface every user sees.
 *
 * Every row is named rather than counted. An aggregate cannot tell you whether "6 off-city
 * events" means six Chennai meetups or six false positives about to be deleted, and the
 * decision this script informs — reject at ingest — is irreversible per event.
 *
 * WHY `city` CANNOT BE THE FILTER, which is the other thing this prints: 522 of the upcoming
 * events have no city at all, the home city's spelling spans six casings, and six more values
 * are Bengaluru SUBURBS in no gazetteer (Hebbagodi, Madavara, Doddathoguru …). Section 1 shows
 * that distribution so the shape of the problem is visible before anyone proposes
 * `city === 'Bengaluru'`, which would delete most of the corpus.
 *
 * Section 4 replays the real ingest gate (`offCityReason`, exercised by tests/off-city.test.ts)
 * over the stored corpus, including the rows it SPARES. Both halves matter: the gate is one
 * loose regex away from deleting real events, and this is where that shows up.
 *
 * EVERY TECH ROW ALSO CARRIES ITS POSITION IN THE DEFAULT FEED, and that is not decoration.
 * A count of leaked rows says nothing about how many a user sees. The default sort is now
 * `connections`, which rewards in-person-with-a-venue and penalises online hard, so the leak
 * is wildly non-uniform in visibility: measured 2026-08-24, `KONG API + AI Summit 2026` (Los
 * Angeles) scores a flat 100 and sits at #2 in the entire tech feed, while the four
 * `Chennai - Build Your First AI Agent` rows that prompted this whole gate score 15 and sit at
 * #279-#301, where nobody will ever scroll. So the rows that were REPORTED are the least
 * visible ones, and a partial cleanup should be triaged by rank rather than by complaint. A
 * diagnostic that names rows without ranking them under-reports severity, which is the general
 * form of the mistake this section exists to stop.
 *
 * This script imports the gate AND the feed's sort rather than reimplementing either, for the
 * reason recorded in pipeline.ts's DEFAULTS: a diagnostic that mirrors the value it checks
 * eventually checks the mirror.
 *
 * Read-only. No writes, no network.
 *
 * Run: npx tsx scripts/diag-offcity.ts
 */
import './load-env';
import connectDB from '../lib/mongodb';
import Event from '../lib/models/Event';
import { namesOtherCity, offCityReason, isBengaluru } from '../lib/scrapers/core/geo';
import { buildSort } from '../lib/events/query';
import mongoose from 'mongoose';

/**
 * Home-city recognition is asked of the REAL gate rather than a copy of its regex, so this
 * cannot drift from what production believes. Only the state bucket is local, and it is a
 * display bucket rather than a decision: `KA` stays case-sensitive for the reason geo.ts
 * records — the two-letter form only means Karnataka as a state code.
 */
const isHome = (value: string): boolean => isBengaluru({ city: value }) === true;
const namesHomeState = (value: string): boolean => /karnataka/i.test(value) || /\bKA\b/.test(value);

type Row = {
  _id: mongoose.Types.ObjectId;
  title?: string;
  city?: string;
  venue?: string;
  address?: string;
  lat?: number;
  lng?: number;
  source?: string;
  isTechEvent?: boolean;
  connectionScore?: number;
  startDateTime?: Date;
};

const ist = (d?: Date): string =>
  d ? new Date(d.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10) : '??????????';

const cut = (s: unknown, n: number): string => String(s ?? '—').slice(0, n).padEnd(n);

/**
 * Position of each tech event in the DEFAULT feed, keyed by id.
 *
 * Ordered by `buildSort('connections')` — the feed's own sort function, not a copy of it, so
 * this cannot drift when the weights or the tie-break change. The row set is upcoming + tech,
 * which is the default feed's filter; the only difference from what a user sees is the ongoing
 * window, which shifts a rank by a place or two and never changes the conclusion.
 */
let feedRank = new Map<string, number>();

/** One line per event, in the same shape everywhere so the sections can be compared by eye. */
function line(row: Row, extra = ''): string {
  const rank = feedRank.get(String(row._id));
  // Only tech rows have a position, because only they are in the default feed at all.
  const where = row.isTechEvent
    ? `feed#${String(rank ?? '?').padStart(4)} score ${String(row.connectionScore ?? '-').padStart(3)}  `
    : ' '.repeat(21);
  return (
    `  ${row.isTechEvent ? 'TECH' : '    '}  ${where}${ist(row.startDateTime)}  ` +
    `${cut(row.source, 11)} ${cut(row.title, 46)} city=${cut(row.city, 14)}${extra}`
  );
}

async function main() {
  await connectDB();
  const now = new Date();

  const rows = (await Event.find(
    { startDateTime: { $gte: now } },
    {
      title: 1, city: 1, venue: 1, address: 1, lat: 1, lng: 1,
      source: 1, isTechEvent: 1, connectionScore: 1, startDateTime: 1,
    }
  ).lean()) as unknown as Row[];

  // Rank the tech feed exactly as the API does, then index it.
  const ranked = (await Event.find({ startDateTime: { $gte: now }, isTechEvent: true }, { _id: 1 })
    .sort(buildSort('connections', false) as Record<string, 1 | -1>)
    .lean()) as unknown as Array<{ _id: mongoose.Types.ObjectId }>;
  feedRank = new Map(ranked.map((r, i) => [String(r._id), i + 1]));

  const tech = rows.filter(r => r.isTechEvent);
  console.log(`upcoming ${rows.length}  |  flagged tech ${tech.length}\n`);

  // ── 1. What is actually stored in `city` ──────────────────────────────────
  // Printed first because it is the reason the gate cannot simply require "Bengaluru".
  console.log('════ 1. Every distinct `city` value, classified ════\n');

  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.city?.trim() || '(null)', (counts.get(r.city?.trim() || '(null)') ?? 0) + 1);

  const buckets = { home: 0, state: 0, other: 0, unknown: 0, missing: 0 };
  const unrecognised: Array<[string, number]> = [];

  for (const [value, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    if (value === '(null)') {
      buckets.missing += n;
      console.log(`  ${String(n).padStart(5)}  MISSING       (null / absent)`);
      continue;
    }
    const matched = namesOtherCity(value);
    if (isHome(value)) {
      buckets.home += n;
      console.log(`  ${String(n).padStart(5)}  HOME          ${value}`);
    } else if (matched) {
      buckets.other += n;
      console.log(`  ${String(n).padStart(5)}  OTHER CITY    ${value}  → ${matched}`);
    } else if (namesHomeState(value)) {
      buckets.state += n;
      console.log(`  ${String(n).padStart(5)}  HOME STATE    ${value}`);
    } else {
      buckets.unknown += n;
      unrecognised.push([value, n]);
      console.log(`  ${String(n).padStart(5)}  UNRECOGNISED  ${value}`);
    }
  }

  console.log(
    `\n  home ${buckets.home}  |  home state ${buckets.state}  |  another city ${buckets.other}  ` +
      `|  unrecognised ${buckets.unknown}  |  missing ${buckets.missing}`
  );
  console.log(
    `  ${Math.round(((buckets.missing + buckets.unknown) / (rows.length || 1)) * 100)}% of upcoming events ` +
      `have a city that a "must equal Bengaluru" filter would delete.`
  );
  if (unrecognised.length > 0) {
    console.log(
      `\n  UNRECOGNISED is where the Bengaluru suburbs live (${unrecognised.map(([v]) => v).slice(0, 8).join(', ')}` +
        `${unrecognised.length > 8 ? ', …' : ''}). It is also where a genuinely off-city value would`
    );
    console.log('  appear before the gazetteer knew about it — so read this bucket, do not trust it.');
  }

  // ── 2. (a) `city` names another city ──────────────────────────────────────
  console.log('\n════ 2. (a) Upcoming events whose `city` is another city ════\n');

  const byCity = rows.filter(r => namesOtherCity(r.city));
  if (byCity.length === 0) console.log('  (none)');
  for (const r of byCity.sort((a, b) => String(a.city).localeCompare(String(b.city)))) {
    console.log(line(r, `  venue=${cut(r.venue, 22)}`));
  }
  console.log(
    `\n  ${byCity.length} row(s); ${byCity.filter(r => r.isTechEvent).length} of them flagged tech ` +
      `(those are in the default feed).`
  );

  // ── 3. (b) TITLE names another city, split by isTechEvent ─────────────────
  // The tech half first, because that is the half a user sees without changing any filter.
  console.log('\n════ 3. (b) Upcoming events whose TITLE names another city ════\n');

  const byTitle = rows
    .map(r => ({ row: r, named: namesOtherCity(r.title) }))
    .filter((x): x is { row: Row; named: string } => Boolean(x.named));

  for (const [label, subset] of [
    ['isTechEvent: TRUE — in the default feed today', byTitle.filter(x => x.row.isTechEvent)],
    ['isTechEvent: false — only visible with "show all events"', byTitle.filter(x => !x.row.isTechEvent)],
  ] as const) {
    console.log(`  ── ${label} — ${subset.length} row(s)\n`);
    if (subset.length === 0) console.log('     (none)');
    for (const { row, named } of subset) {
      console.log(line(row, `  title names=${named}`));
    }
    console.log('');
  }

  // ── 4. What the ingest gate would do, both halves ─────────────────────────
  console.log('════ 4. What the ingest gate does with these rows ════\n');

  const flagged = [...new Set([...byCity, ...byTitle.map(x => x.row)])];
  const rejected: Row[] = [];
  const spared: Row[] = [];
  for (const r of flagged) {
    const verdict = offCityReason({
      title: r.title,
      venue: r.venue,
      address: r.address,
      city: r.city,
      lat: r.lat,
      lng: r.lng,
    });
    (verdict ? rejected : spared).push(r);
    if (verdict) console.log(line(r, `  REJECT ${verdict.city} (${verdict.field})`));
  }

  console.log(`\n  ── SPARED: named another city somewhere, but has Bengaluru evidence — ${spared.length} row(s)\n`);
  if (spared.length === 0) console.log('     (none)');
  for (const r of spared) {
    console.log(line(r, `  venue=${cut(r.venue, 22)}`));
  }

  // The gate also runs over rows nothing above flagged, via venue/address. Count those too, so
  // the total effect is not understated.
  const allRejected = rows.filter(r =>
    offCityReason({ title: r.title, venue: r.venue, address: r.address, city: r.city, lat: r.lat, lng: r.lng })
  );

  console.log('\n  ' + '─'.repeat(72));
  console.log(`  flagged by section 2 or 3      ${flagged.length}`);
  console.log(`  of those, gate rejects         ${rejected.length}`);
  console.log(`  of those, gate spares          ${spared.length}   (read every one — a wrong reject deletes an event)`);
  console.log(`  gate rejects across ALL rows   ${allRejected.length}  (${allRejected.filter(r => r.isTechEvent).length} flagged tech)`);
  console.log(`  survivors                      ${rows.length - allRejected.length} of ${rows.length}`);

  // ── 5. Severity, not volume ───────────────────────────────────────────────
  // The number above is how many leaked. This is how many a user meets. They are different
  // questions and only this one determines what to fix first.
  const ranks = allRejected
    .filter(r => r.isTechEvent)
    .map(r => feedRank.get(String(r._id)))
    .filter((n): n is number => typeof n === 'number')
    .sort((a, b) => a - b);

  console.log('\n  ── severity in the DEFAULT feed (sort=connections) ──');
  if (ranks.length === 0) {
    console.log('  no off-city row is in the tech feed at all.');
  } else {
    console.log(`  best (worst-case) rank         #${ranks[0]}   ← the most prominent off-city row in the product`);
    console.log(`  on page 1 (top 20)             ${ranks.filter(n => n <= 20).length} of ${ranks.length}`);
    console.log(`  in the top 50                  ${ranks.filter(n => n <= 50).length} of ${ranks.length}`);
    console.log(`  ranks                          ${ranks.join(', ')}`);
    console.log('');
    console.log('  Triage by THIS, not by which rows were reported. connectionScore penalises online');
    console.log('  hard, so a wrong-city online listing sinks out of sight while a wrong-city in-person');
    console.log('  summit with a venue rises to the top — the opposite of the order complaints arrive in.');
  }
  console.log('');
  console.log('  The gate runs at INGEST, so it cannot reach anything already stored. A non-zero');
  console.log('  count above is the backlog: those rows stay in the feed until they pass, or until');
  console.log('  something deletes them. Nothing in this script deletes anything.');

  await mongoose.disconnect();
}

main().catch(async e => {
  console.error(e);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
