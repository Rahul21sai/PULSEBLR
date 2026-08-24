#!/usr/bin/env tsx
/**
 * Delete stored events that are not in Bengaluru.
 *
 * The pipeline now gates on geo AFTER enrichment (pipeline.ts step 5c), which stops new ones
 * arriving. It cannot remove what is already stored, because it filters the incoming batch and
 * never looks at the collection — so the events that got in while `meetup.ts`'s guard was dead
 * code stay in the feed forever unless something deletes them. Measured before this ran: 23 of
 * 886 upcoming Meetup events named another city without naming Bengaluru, 19 in-person, 9 in the
 * default tech feed (scripts/diag-meetup-geo-leak.ts).
 *
 * The judgement is deliberately narrow, and only ever on STRONG signals:
 *
 *   · coordinates, `city`, `venue`, `address` — never the description. A Bengaluru event may
 *     legitimately say "lessons from our Chennai rollout", and deleting on that basis would be
 *     the tagger's `\bpm\b` over-matching mistake with a DELETE attached.
 *   · online events are never deleted on location. They have no venue, and a Bengaluru user can
 *     attend an online event hosted anywhere.
 *   · `null` (nothing to judge on) is KEPT. Absence of evidence is not evidence.
 *
 * DESTRUCTIVE. Dry by default; pass --apply to delete. Prints every candidate with the field that
 * condemned it, because a delete you cannot audit is worse than a stale row.
 *
 * Also repoints nothing: unlike cleanup-duplicate-clusters.ts there is no surviving twin to point
 * at. A TrackerEntry or Folder referencing a deleted event becomes a dangling ref, which the
 * codebase already treats as normal — pruneStale() creates them on every scrape.
 *
 * Run: npx tsx scripts/cleanup-non-bengaluru.ts          (dry)
 *      npx tsx scripts/cleanup-non-bengaluru.ts --apply
 */
import './load-env';
import connectDB from '../lib/mongodb';
import Event from '../lib/models/Event';
import TrackerEntry from '../lib/models/TrackerEntry';
import { isBengaluru } from '../lib/scrapers/core/geo';
import mongoose from 'mongoose';

const APPLY = process.argv.includes('--apply');

async function main() {
  await connectDB();

  const rows = await Event.find(
    {},
    {
      title: 1, venue: 1, address: 1, city: 1, area: 1, lat: 1, lng: 1,
      format: 1, onlineLink: 1, source: 1, isTechEvent: 1, startDateTime: 1,
    }
  ).lean();

  console.log(`${rows.length} stored events${APPLY ? '' : '  (DRY RUN — nothing will be deleted)'}\n`);

  const doomed: Array<{ row: (typeof rows)[number]; why: string }> = [];

  for (const r of rows) {
    // Online is attendable from anywhere. Never delete on location.
    if (r.format === 'online' || r.onlineLink) continue;

    const verdict = isBengaluru({
      lat: r.lat as number | undefined,
      lng: r.lng as number | undefined,
      city: r.city as string | undefined,
      venue: r.venue as string | undefined,
      address: r.address as string | undefined,
    });
    if (verdict !== false) continue;

    // Name the field responsible, so each delete is auditable rather than trusted.
    const why =
      typeof r.lat === 'number' && typeof r.lng === 'number' && (r.lat !== 0 || r.lng !== 0)
        ? `coordinates ${r.lat},${r.lng}`
        : r.city && isBengaluru({ city: String(r.city) }) !== true
          ? `city="${r.city}"`
          : r.venue && isBengaluru({ venue: String(r.venue) }) === false
            ? `venue="${String(r.venue).slice(0, 44)}"`
            : `address="${String(r.address ?? '').slice(0, 44)}"`;

    doomed.push({ row: r, why });
  }

  const upcoming = doomed.filter(
    d => new Date(d.row.startDateTime as unknown as string).getTime() >= Date.now()
  );
  const inTechFeed = upcoming.filter(d => d.row.isTechEvent);

  console.log(`  outside Bengaluru on strong signals: ${doomed.length}`);
  console.log(`    of those, still upcoming:          ${upcoming.length}`);
  console.log(`    of those, in the default tech feed: ${inTechFeed.length}\n`);

  const bySource = new Map<string, number>();
  for (const d of doomed) bySource.set(String(d.row.source), (bySource.get(String(d.row.source)) ?? 0) + 1);
  console.log('  by source:');
  for (const [s, n] of [...bySource.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(4)}  ${s}`);
  }

  console.log('\n  every candidate, with the field that condemned it:');
  for (const d of doomed) {
    const day = new Date(d.row.startDateTime as unknown as string).toISOString().slice(0, 10);
    console.log(
      `    ${day}  ${String(d.row.source).padEnd(11)} tech=${String(d.row.isTechEvent).padEnd(5)} ${String(d.row.title).slice(0, 44).padEnd(44)}`
    );
    console.log(`                ${d.why}`);
  }

  // Anything a user has TRACKED is a deliberate human action and outranks our classifier.
  const ids = doomed.map(d => d.row._id);
  const tracked = ids.length
    ? await TrackerEntry.find({ eventId: { $in: ids } }, { eventId: 1, userId: 1 }).lean()
    : [];
  const trackedIds = new Set(tracked.map(t => String(t.eventId)));
  if (trackedIds.size > 0) {
    console.log(`\n  ${trackedIds.size} of these are TRACKED by a user and will be KEPT.`);
    console.log('  A person deciding to attend an event outranks a geo heuristic, and deleting it');
    console.log('  would break their tracker row for no benefit.');
  }

  const toDelete = doomed.filter(d => !trackedIds.has(String(d.row._id)));
  console.log(`\n  will delete: ${toDelete.length}`);

  if (!APPLY) {
    console.log('\n  DRY RUN. Re-run with --apply to delete.');
    await mongoose.disconnect();
    return;
  }

  const result = await Event.deleteMany({ _id: { $in: toDelete.map(d => d.row._id) } });
  console.log(`\n  deleted ${result.deletedCount ?? 0} event(s).`);
  console.log('  Re-run scripts/diag-meetup-geo-leak.ts to confirm, and diag-scorecard.ts to see');
  console.log('  the effect on the feed.');

  await mongoose.disconnect();
}

main().catch(async e => {
  console.error(e);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
