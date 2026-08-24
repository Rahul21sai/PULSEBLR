#!/usr/bin/env tsx
/**
 * Delete stored events that are not in Bengaluru.
 *
 * The pipeline gates on geo AFTER enrichment (pipeline.ts step 5c), which stops new ones
 * arriving. It cannot remove what is already stored, because it filters the incoming batch and
 * never looks at the collection — so anything that got in before the gate existed stays in the
 * feed until something deletes it. It does not age out either: rejecting a re-sighting stops
 * `lastSeenAt` refreshing, so each stored off-city row is now FROZEN — a later scrape can no
 * longer correct or cancel it — and `pruneStale()` only removes it a week after its own start
 * date. They drain AFTER being shown, which is why this is worth running rather than waiting out.
 *
 * ── WHY THIS SELECTS ON `offCityReason` ───────────────────────────────────────────────────────
 *
 * It used to condemn a row on `isBengaluru(...) === false`, which is a different question from
 * the one stage 5c asks, and the difference is not small. `isBengaluru` reads `city` for a
 * POSITIVE match only (`if (input.city && BLR_NAME.test(input.city)) return true`), then builds
 * its `location` string from **venue + address alone** — `city` is not in it — and only
 * `if (namesOther) return false` can condemn. So `isBengaluru` can never reject on `city` at all:
 * `city: 'Los Angeles'`, `city: 'San Francisco'` and even `city: 'Chennai'` all return `null`,
 * which this script correctly keeps. `OTHER_STATE_HINTS` is other-STATE only on top of that, so
 * `city: 'Mysuru'` falls through both lists — a Karnataka city that is not Bengaluru matches no
 * hint and no Bengaluru pattern. Measured against live Atlas 2026-08-24, same corpus, same moment:
 *
 *                                     all stored   upcoming   in the default tech feed
 *     isBengaluru(...) === false           21          14                3
 *     offCityReason(...)                   39          29               10
 *
 * — so 15 upcoming rows and 7 tech-flagged rows were invisible to it. Compare the UPCOMING
 * figures: the old headline `will delete: 21` counted 7 already-past events, which makes the gap
 * look half its real size. The rows in it are the ones that motivated the work: `KONG API + AI
 * Summit 2026` (city=Los Angeles) and `FounderX Silicon Valley` (city=San Francisco) are foreign,
 * `Ronda Central Park` (New York) likewise, and the Bali / Pisa / Andalusia cycling trips. KONG is
 * the expensive one: it scores 100 and ranks SECOND in upcoming-tech by `connectionScore`, which
 * is now the feed's DEFAULT sort — so the app was recommending a Los Angeles conference on page one.
 *
 * The switch only ever deletes MORE, never differently. Measured the same day, the set of rows
 * `isBengaluru(...) === false` condemns that `offCityReason` would spare is EMPTY, so this is a
 * strict superset of the old behaviour rather than a trade. Selecting on the gate's own predicate
 * is also what keeps the two in step — a cleanup that mirrors the rule it enforces eventually
 * enforces the mirror, which is the drift recorded in pipeline.ts's DEFAULTS.
 *
 * ── WHY ONLINE EVENTS ARE JUDGED TOO ──────────────────────────────────────────────────────────
 *
 * This script used to skip `format === 'online' || onlineLink` BEFORE any geo judgement, on the
 * reasoning that a Bengaluru user can attend an online event hosted anywhere. That is right for a
 * venue-less event with no city signal and wrong for a city-scoped EDITION, and it was the second
 * half of the defect: swapping the predicate alone left four tech-flagged `Chennai - Build Your
 * First AI Agent` rows in the default feed, because they are `format: 'online'` with
 * `city`/`venue`/`address` all empty and Chennai named in the TITLE only.
 *
 * That judging them on title is safe is not an opinion — the series is a natural controlled
 * experiment. All 9 upcoming rows are `format: 'online'`, `onlineLink` set, `city`/`venue`/
 * `address` empty and `isTechEvent: true`, differing only by one word of title:
 *
 *     KEEP                    Bengaluru - Build Your First AI Agent…   ×4
 *     KEEP                    Build Your First AI Agent…               ×1   (unprefixed → unknown)
 *     REJECT Chennai (title)  Chennai - Build Your First AI Agent…     ×4
 *
 * So the title rule is NECESSARY — nothing else in these documents distinguishes a Chennai edition
 * from a Bengaluru one — and SAFE, because the Bengaluru-evidence veto spares all four siblings
 * and the unprefixed row passes as unknown. Verified twice independently. `--keep-online` restores
 * the old exemption, and those rows are then named in a REPORTED, NOT DELETED section rather than
 * silently skipped.
 *
 * ── WHAT THE JUDGEMENT WILL NOT DO ────────────────────────────────────────────────────────────
 *
 *   · never the description. A Bengaluru event may legitimately say "lessons from our Chennai
 *     rollout", and deleting on that basis would be the tagger's `\bpm\b` over-matching mistake
 *     with a DELETE attached. `offCityReason` accepts a description and deliberately never matches
 *     it; tests/off-city.test.ts pins that.
 *   · never on absence. Any evidence FOR Bengaluru is an unconditional veto, so a row is condemned
 *     only on a positive signal of somewhere else. Requiring a positive Bengaluru match instead
 *     would delete most of the corpus — 42% of upcoming events have no usable city at all.
 *   · never a row a user has TRACKED (`TrackerEntry`) or built a FOLDER for (`Folder`). Both are
 *     deliberate human actions and outrank a geo heuristic; a folder means they scanned people at
 *     that event, which is the strongest signal in the app that it mattered.
 *
 * DO NOT copy `cleanup-duplicate-clusters.ts`'s referrer handling in here. It looks like a sibling
 * and is not: that script REPOINTS `TrackerEntry` and `Folder.eventId` because a surviving twin
 * exists to repoint TO. An off-city delete has no twin, so repointing is unavailable and a dangling
 * soft ref is the correct outcome, not a bug to engineer around — `Folder.eventId` is deliberately
 * soft and `pruneStale()` leaves dangling refs on every scrape. What this script does instead is
 * SPARE the referenced row, which needs no twin. (Related sharp edge, pre-existing and not fixed
 * here: `getPendingFollowUps` 500s on a dangling ref by reading `entry.eventId.title` unguarded.)
 *
 * The audit line names the field from `verdict.field` directly. The previous version re-derived it
 * with `isBengaluru({ city }) !== true`, where `null` qualifies — so a row condemned on its ADDRESS
 * printed as `city="…"`, reversing the apparent cause and misleading a review of exactly this
 * question. Do not reintroduce a second derivation of something the verdict already carries.
 *
 * DESTRUCTIVE. Dry by default; pass --apply to delete. Prints every candidate with the field that
 * condemned it, because a delete you cannot audit is worse than a stale row. Run
 * scripts/diag-offcity.ts first: it replays this same predicate and names all the rejects AND all
 * the spares, which is where a wrong delete shows up.
 *
 * Run: npx tsx scripts/cleanup-non-bengaluru.ts                     (dry)
 *      npx tsx scripts/cleanup-non-bengaluru.ts --keep-online       (dry, exempt online)
 *      npx tsx scripts/cleanup-non-bengaluru.ts --apply
 */
import './load-env';
import connectDB from '../lib/mongodb';
import Event from '../lib/models/Event';
import TrackerEntry from '../lib/models/TrackerEntry';
import Folder from '../lib/models/Folder';
import { offCityReason, type OffCityVerdict } from '../lib/scrapers/core/geo';
import mongoose from 'mongoose';

const APPLY = process.argv.includes('--apply');
const KEEP_ONLINE = process.argv.includes('--keep-online');

type Row = {
  _id: mongoose.Types.ObjectId;
  title?: string;
  venue?: string;
  address?: string;
  city?: string;
  lat?: number;
  lng?: number;
  format?: string;
  onlineLink?: string;
  source?: string;
  isTechEvent?: boolean;
  startDateTime?: Date;
};

/** The rule --keep-online restores. `hybrid` with a join link counts, and is printed. */
const isOnline = (r: Row): boolean => r.format === 'online' || Boolean(r.onlineLink);

const isUpcoming = (r: Row): boolean => new Date(r.startDateTime as unknown as string).getTime() >= Date.now();

/** IST, matching diag-offcity.ts, so the two outputs can be read side by side. */
const ist = (d?: Date): string =>
  d ? new Date(new Date(d).getTime() + 5.5 * 3600_000).toISOString().slice(0, 10) : '??????????';

/** Name the field responsible AND the text in it, taken from the verdict, never re-derived. */
function reason(row: Row, verdict: OffCityVerdict): string {
  const value =
    verdict.field === 'city' ? row.city
    : verdict.field === 'venue' ? row.venue
    : verdict.field === 'address' ? row.address
    : row.title;
  return `${verdict.city} — ${verdict.field}="${String(value ?? '').slice(0, 44)}"`;
}

/** total / upcoming / in the default tech feed — the three numbers any decision here needs. */
const tally = (rows: Row[]): string =>
  `${rows.length} total, ${rows.filter(isUpcoming).length} upcoming, ` +
  `${rows.filter(r => isUpcoming(r) && r.isTechEvent).length} in the default tech feed`;

function print(entry: { row: Row; why: string }, extra = '') {
  console.log(
    `    ${ist(entry.row.startDateTime)}  ${isUpcoming(entry.row) ? 'UPCOMING' : 'past    '}  ` +
      `${String(entry.row.source).padEnd(11)} tech=${String(Boolean(entry.row.isTechEvent)).padEnd(5)} ` +
      `${extra}${String(entry.row.title).slice(0, 44)}`
  );
  console.log(`                ${entry.why}`);
}

async function main() {
  await connectDB();

  const rows = (await Event.find(
    {},
    {
      title: 1, venue: 1, address: 1, city: 1, area: 1, lat: 1, lng: 1,
      format: 1, onlineLink: 1, source: 1, isTechEvent: 1, startDateTime: 1,
    }
  ).lean()) as unknown as Row[];

  console.log(
    `${rows.length} stored events${APPLY ? '' : '  (DRY RUN — nothing will be deleted)'}` +
      `${KEEP_ONLINE ? '  [--keep-online]' : ''}\n`
  );

  const doomed: Array<{ row: Row; why: string }> = [];
  const onlineExempt: Array<{ row: Row; why: string }> = [];

  for (const r of rows) {
    // The ingest gate's own predicate, imported rather than mirrored. Reads city → venue →
    // address → title, and never the description.
    const verdict = offCityReason({
      title: r.title,
      venue: r.venue,
      address: r.address,
      city: r.city,
      lat: r.lat,
      lng: r.lng,
    });
    if (!verdict) continue;

    const entry = { row: r, why: reason(r, verdict) };
    if (KEEP_ONLINE && isOnline(r)) onlineExempt.push(entry);
    else doomed.push(entry);
  }

  console.log(`  outside Bengaluru on strong signals: ${tally(doomed.map(d => d.row))}`);
  if (onlineExempt.length > 0) {
    console.log(`  online, exempted by --keep-online:   ${tally(onlineExempt.map(d => d.row))}`);
  }

  const bySource = new Map<string, number>();
  for (const d of doomed) bySource.set(String(d.row.source), (bySource.get(String(d.row.source)) ?? 0) + 1);
  console.log('\n  by source:');
  for (const [s, n] of [...bySource.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(4)}  ${s}`);
  }

  console.log('\n  every candidate, with the field that condemned it:');
  for (const d of doomed) print(d);

  // Named, not just counted: --keep-online is the one rule on which this and the ingest gate
  // disagree, so the rows it protects are printed rather than left to be discovered.
  if (onlineExempt.length > 0) {
    console.log('\n  ── REPORTED, NOT DELETED: online events that name another city ──');
    console.log('  --keep-online exempted these. Drop the flag to judge them on their title too;');
    console.log('  the Bengaluru-evidence veto still spares any row that names Bengaluru.\n');
    for (const d of onlineExempt) print(d, `format=${String(d.row.format)} `);
  }

  // A tracked event or a scan folder is a deliberate human action and outranks a geo heuristic.
  // These are SPARED, never repointed — there is no surviving twin to repoint to (see header).
  const ids = doomed.map(d => d.row._id);
  const [tracked, foldered] = ids.length
    ? await Promise.all([
        TrackerEntry.find({ eventId: { $in: ids } }, { eventId: 1, userId: 1 }).lean(),
        Folder.find({ eventId: { $in: ids } }, { eventId: 1, name: 1, userId: 1 }).lean(),
      ])
    : [[], []];

  const protectedIds = new Map<string, string>();
  for (const t of tracked) protectedIds.set(String(t.eventId), 'tracked');
  for (const f of foldered as Array<{ eventId?: unknown; name?: string }>) {
    const key = String(f.eventId);
    protectedIds.set(key, protectedIds.has(key) ? 'tracked + folder' : `folder "${f.name}"`);
  }

  if (protectedIds.size > 0) {
    console.log(`\n  ${protectedIds.size} of these are KEPT because a user acted on them.`);
    console.log('  A person deciding to attend — or scanning the people they met there — outranks a geo');
    console.log('  heuristic. Nothing is repointed: there is no surviving twin, so the row is spared');
    console.log('  outright. Untrack it or delete the folder and re-run to remove it.');
    for (const d of doomed.filter(x => protectedIds.has(String(x.row._id)))) {
      console.log(
        `    KEPT (${protectedIds.get(String(d.row._id))})  ${ist(d.row.startDateTime)}  ` +
          `${String(d.row.title).slice(0, 44)}`
      );
    }
  }

  const toDelete = doomed.filter(d => !protectedIds.has(String(d.row._id)));
  console.log(`\n  will delete: ${tally(toDelete.map(d => d.row))}`);

  if (!APPLY) {
    console.log('\n  DRY RUN. Re-run with --apply to delete.');
    await mongoose.disconnect();
    return;
  }

  const result = await Event.deleteMany({ _id: { $in: toDelete.map(d => d.row._id) } });
  console.log(`\n  deleted ${result.deletedCount ?? 0} event(s).`);
  console.log('  Re-run scripts/diag-offcity.ts to confirm — it replays this same predicate over the');
  console.log('  corpus and names the rows it SPARES, which is where a wrong delete would show up.');
  console.log('  Then diag-scorecard.ts for the effect on the feed.');

  await mongoose.disconnect();
}

main().catch(async e => {
  console.error(e);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
