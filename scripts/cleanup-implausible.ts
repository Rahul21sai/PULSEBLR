#!/usr/bin/env tsx
/**
 * Remove implausible listings already stored: evergreen adverts with multi-year
 * ranges, events starting far in the past, and impossible dates.
 *
 * See the matching guard in lib/scrapers/pipeline.ts — this cleans up rows that
 * were ingested before it existed. Safe to re-run.
 */
import './load-env';
import mongoose from 'mongoose';
import connectDB from '../lib/mongodb';
import Event from '../lib/models/Event';

// A hand-entered event is never a candidate for automated deletion.
//
// `$exists: false` rather than `null`, because the ~1500 documents that predate ownership have no
// such key and they ARE the intended targets. The reasoning is the same in every script that
// deletes events: a maintenance job the user never ran and cannot see must not destroy something
// they typed in themselves. Typing an event in by hand is a stronger signal of intent than the
// heuristics these scripts apply — a date typo, a venue on "Mysore Road", or a genuinely far-out
// conference is theirs to fix or keep, and nothing re-creates it because there is no upstream.
const SCRAPED_ONLY = { createdByUserId: { $exists: false } } as const;


const DRY = process.argv.includes('--dry');
const DAY = 24 * 3600 * 1000;

async function main() {
  await connectDB();
  const now = Date.now();

  const all = await Event.find(SCRAPED_ONLY).select('title startDateTime endDateTime source').lean();
  const doomed: string[] = [];
  const truncateEnd: string[] = [];

  for (const e of all) {
    const start = new Date(e.startDateTime).getTime();
    if (!Number.isFinite(start)) { doomed.push(String(e._id)); continue; }

    // Keep genuinely past events for a while (the tracker references them), but a
    // start before 2020 is a data error, not history worth keeping.
    if (start < new Date('2020-01-01').getTime()) { doomed.push(String(e._id)); continue; }
    if (start > now + 550 * DAY) { doomed.push(String(e._id)); continue; }

    if (e.endDateTime) {
      const days = (new Date(e.endDateTime).getTime() - start) / DAY;
      if (days < 0 || days > 30) truncateEnd.push(String(e._id));
    }
  }

  console.log(`${all.length} events scanned`);
  console.log(`  ${doomed.length} implausible (delete)`);
  console.log(`  ${truncateEnd.length} with absurd end dates (clear endDateTime)`);

  if (doomed.length > 0) {
    const sample = await Event.find({ _id: { $in: doomed.slice(0, 8) } })
      .select('title startDateTime endDateTime source').lean();
    for (const s of sample) {
      console.log(`     - [${s.source}] ${String(s.title).slice(0, 50)} — ${new Date(s.startDateTime).toISOString().slice(0,10)} → ${s.endDateTime ? new Date(s.endDateTime).toISOString().slice(0,10) : '?'}`);
    }
  }

  if (!DRY) {
    if (doomed.length) {
      const r = await Event.deleteMany({ _id: { $in: doomed } });
      console.log(`Deleted ${r.deletedCount}`);
    }
    if (truncateEnd.length) {
      const r = await Event.updateMany({ _id: { $in: truncateEnd } }, { $unset: { endDateTime: '' } });
      console.log(`Cleared endDateTime on ${r.modifiedCount}`);
    }
  }

  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
