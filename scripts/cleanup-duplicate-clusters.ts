#!/usr/bin/env tsx
/**
 * Collapse documents that share a clusterKey into one card.
 *
 * WHY THIS IS NEEDED AT ALL. Ingestion dedups on the way in, so duplicates should be
 * impossible. These exist because 26 documents were written by OLD scraper code (the
 * daily GitHub Actions cron runs the default branch, which predates clusterKey) and
 * therefore had no cluster key to match on. scripts/migrate-events.ts has since
 * backfilled their keys, which makes the duplicates *detectable* but does not merge
 * them: ingestion only merges an incoming sighting into ONE existing document, so the
 * second copy would sit in the feed forever.
 *
 * MERGE RULE, identical in spirit to ingestion's mergeInto: a merge may only FILL
 * GAPS on the survivor or improve a value. It never blanks a field. Categories and
 * seenInSources are unioned; the highest attendee count and the richest description
 * win.
 *
 * SURVIVOR CHOICE: the most complete document, scored on the fields a user sees. Ties
 * break toward the oldest document, so stable ids survive and any tracker entry
 * pointing at it keeps working.
 *
 * DESTRUCTIVE. Dry by default; pass --apply to delete.
 *
 * Usage:
 *   npx tsx scripts/cleanup-duplicate-clusters.ts            report only
 *   npx tsx scripts/cleanup-duplicate-clusters.ts --apply    merge and delete
 */
import './load-env';
import mongoose from 'mongoose';
import connectDB from '../lib/mongodb';
import Event from '../lib/models/Event';
import TrackerEntry from '../lib/models/TrackerEntry';

const APPLY = process.argv.includes('--apply');
const MAX_CATEGORIES = 3;

type Doc = Record<string, unknown> & { _id: mongoose.Types.ObjectId };

/** How much does a user actually see on this card? Higher survives. */
function completeness(d: Doc): number {
  let score = 0;
  if (d.imageUrl) score += 6;
  if (d.venue) score += 5;
  if (d.lat !== undefined && d.lat !== null) score += 3;
  if (typeof d.description === 'string' && d.description.length > 120) score += 4;
  if (d.organizer) score += 2;
  if (typeof d.attendeeCount === 'number' && d.attendeeCount > 0) score += 2;
  if (Array.isArray(d.category)) score += Math.min(3, d.category.length);
  if (Array.isArray(d.companies) && d.companies.length > 0) score += 2;
  if (typeof d.connectionScore === 'number') score += 1;
  if (d.endDateTime) score += 1;
  return score;
}

async function main() {
  await connectDB();
  const now = new Date();

  const groups = await Event.aggregate<{ _id: string; ids: mongoose.Types.ObjectId[]; n: number }>([
    { $match: { startDateTime: { $gte: now }, clusterKey: { $exists: true, $nin: [null, ''] } } },
    { $group: { _id: '$clusterKey', ids: { $push: '$_id' }, n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
    { $sort: { n: -1 } },
  ]);

  console.log(`${groups.length} duplicate cluster(s) among upcoming events${APPLY ? '' : '  (dry run)'}\n`);
  if (groups.length === 0) {
    await mongoose.disconnect();
    return;
  }

  let merged = 0;
  let deleted = 0;
  let trackerRelinked = 0;

  for (const g of groups) {
    const docs = (await Event.find({ _id: { $in: g.ids } }).lean()) as unknown as Doc[];
    docs.sort((a, b) => {
      const d = completeness(b) - completeness(a);
      if (d !== 0) return d;
      const at = new Date(String(a.createdAt || 0)).getTime();
      const bt = new Date(String(b.createdAt || 0)).getTime();
      return at - bt; // oldest wins ties: stable ids, tracker entries keep working
    });

    const [survivor, ...losers] = docs;
    console.log(`${docs.length}x  ${String(survivor.title).slice(0, 62)}`);
    console.log(`     key      : ${survivor.clusterKey}`);
    console.log(`     survivor : ${survivor._id}  [${survivor.source}] completeness=${completeness(survivor)}`);

    const set: Record<string, unknown> = {};
    const categories = new Set<string>(Array.isArray(survivor.category) ? (survivor.category as string[]) : []);
    const seen = new Set<string>(Array.isArray(survivor.seenInSources) ? (survivor.seenInSources as string[]) : []);
    if (survivor.source) seen.add(String(survivor.source));

    for (const loser of losers) {
      console.log(`     merge in : ${loser._id}  [${loser.source}] completeness=${completeness(loser)}`);

      // Gap-fill only. Never overwrite a value the survivor already has.
      for (const field of [
        'imageUrl', 'venue', 'address', 'area', 'city', 'organizer', 'hostAvatarUrl',
        'onlineLink', 'applyLink', 'endDateTime', 'sourceEventId', 'price', 'priceMax',
        'currency', 'capacity', 'registrationDeadline',
      ]) {
        if (
          (survivor[field] === undefined || survivor[field] === null || survivor[field] === '') &&
          loser[field] !== undefined && loser[field] !== null && loser[field] !== ''
        ) {
          set[field] = loser[field];
        }
      }
      if (survivor.lat === undefined || survivor.lat === null) {
        if (loser.lat !== undefined && loser.lat !== null) { set.lat = loser.lat; set.lng = loser.lng; }
      }
      // Longer description wins — it is what the detail page shows.
      const sd = String(survivor.description || '');
      const ld = String(loser.description || '');
      if (ld.length > sd.length && ld.length > (set.description ? String(set.description).length : 0)) {
        set.description = loser.description;
      }
      // Highest attendee count wins: it is social proof, and feeds connectionScore.
      const sa = Number(survivor.attendeeCount || 0);
      const la = Number(loser.attendeeCount || 0);
      if (la > sa && la > Number(set.attendeeCount || 0)) set.attendeeCount = la;

      for (const c of (Array.isArray(loser.category) ? (loser.category as string[]) : [])) categories.add(c);
      for (const s of (Array.isArray(loser.seenInSources) ? (loser.seenInSources as string[]) : [])) seen.add(s);
      if (loser.source) seen.add(String(loser.source));

      // A tracker entry pointing at a doomed document must be repointed, or the user
      // silently loses a tracked event and every person they logged against it.
      const refs = await TrackerEntry.countDocuments({ eventId: loser._id });
      if (refs > 0) {
        console.log(`     tracker  : ${refs} entry(ies) point at the loser — will repoint to survivor`);
        if (APPLY) {
          // The compound-unique {userId, eventId} index means a repoint can collide
          // with an entry the user already has on the survivor; skip those.
          const entries = await TrackerEntry.find({ eventId: loser._id }).select('userId').lean();
          for (const e of entries) {
            const clash = await TrackerEntry.countDocuments({ userId: e.userId, eventId: survivor._id });
            if (clash === 0) {
              await TrackerEntry.updateOne({ userId: e.userId, eventId: loser._id }, { $set: { eventId: survivor._id } });
              trackerRelinked++;
            } else {
              console.log(`     tracker  : user ${e.userId} already tracks the survivor — left alone`);
            }
          }
        }
      }
    }

    if (categories.size > 0) set.category = [...categories].slice(0, MAX_CATEGORIES);
    if (seen.size > 0) set.seenInSources = [...seen];

    const changedFields = Object.keys(set);
    console.log(`     fills    : ${changedFields.length ? changedFields.join(', ') : '(none)'}`);

    if (APPLY) {
      if (changedFields.length) await Event.updateOne({ _id: survivor._id }, { $set: set });
      const res = await Event.deleteMany({ _id: { $in: losers.map(l => l._id) } });
      deleted += res.deletedCount || 0;
      merged++;
    }
    console.log('');
  }

  if (APPLY) {
    console.log(`Merged ${merged} cluster(s); deleted ${deleted} duplicate document(s); repointed ${trackerRelinked} tracker entry(ies).`);
    const left = await Event.aggregate([
      { $match: { startDateTime: { $gte: now } } },
      { $group: { _id: '$clusterKey', n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } },
    ]);
    console.log(`Remaining duplicate clusters: ${left.length}`);
  } else {
    console.log(`Dry run — nothing written. ${groups.length} cluster(s) would collapse, removing ${groups.reduce((s, g) => s + g.n - 1, 0)} document(s).`);
    console.log('Re-run with --apply to merge.');
  }

  await mongoose.disconnect();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
