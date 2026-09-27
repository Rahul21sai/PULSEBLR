#!/usr/bin/env tsx
/**
 * Collapse NEAR-TWIN events: pairs the exact `clusterKey` cannot see but `isNearTwin()` can.
 *
 * `scripts/cleanup-duplicate-clusters.ts` groups on an identical `clusterKey`. The live GIDS pair
 * (scripts/diag-gids-dupe.ts) has two different keys — one title carries "2027", and the
 * date-only developers.events copy sits one IST day from the company page's — so that script
 * reports it clean while the feed shows two cards. This one groups by the SAME predicate ingest
 * now uses (`lib/scrapers/core/event-match.ts`), imported, not mirrored.
 *
 * ORDER MATTERS: run this only AFTER the ingest change is on `main`. The daily cron runs the
 * default branch; a loser deleted while `main` still lacks the near-twin fallback is simply
 * re-created by the next scrape, since its own dedupHash / sourceEventId no longer match anything.
 *
 * Merge rule is `cleanup-duplicate-clusters.ts`'s exactly — most complete survives, gap-fill only,
 * never blank a field, repoint TrackerEntry and Folder.eventId — plus one addition from ingest: a
 * date-only survivor adopts a precise loser's time when both are on the SAME IST day
 * (`preciseTimingUpgrade`). A pair whose days DISAGREE is reported as a day conflict and the
 * survivor's day is kept; which day is true is not something a script can know.
 *
 * Hand-entered events are excluded at selection AND refused by the predicate.
 *
 * DESTRUCTIVE. Dry by default; pass --apply to write.
 *
 * Run: npx tsx --tsconfig tsconfig.json scripts/cleanup-near-twins.ts [--apply]
 */
import './load-env';
import mongoose from 'mongoose';
import connectDB from '../lib/mongodb';
import Event from '../lib/models/Event';
import TrackerEntry from '../lib/models/TrackerEntry';
import Folder from '../lib/models/Folder';
import { istDayGap, isNearTwin, preciseTimingUpgrade } from '../lib/scrapers/core/event-match';

const APPLY = process.argv.includes('--apply');
const MAX_CATEGORIES = 3;
const SCRAPED_ONLY = { createdByUserId: { $exists: false } } as const;

type Doc = Record<string, unknown> & {
  _id: mongoose.Types.ObjectId;
  title: string;
  startDateTime: Date;
  endDateTime?: Date;
  source?: string;
  city?: string;
};

/** Identical to cleanup-duplicate-clusters.ts — what a user sees on the card. */
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

const ist = (d?: Date) =>
  d ? new Date(d).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false }) : '-';

async function main() {
  await connectDB();
  const now = new Date();
  const docs = (await Event.find({
    ...SCRAPED_ONLY,
    $or: [{ startDateTime: { $gte: now } }, { endDateTime: { $gte: now } }],
  }).lean()) as unknown as Doc[];

  // Union-find over every near-twin pair, so a chain of three sightings becomes one group.
  const parent = docs.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const sorted = docs.map((d, i) => ({ i, t: +new Date(d.startDateTime) })).sort((a, b) => a.t - b.t);
  const WINDOW = 2 * 86_400_000;
  for (let x = 0; x < sorted.length; x++) {
    for (let y = x + 1; y < sorted.length && sorted[y].t - sorted[x].t <= WINDOW; y++) {
      const a = docs[sorted[x].i];
      const b = docs[sorted[y].i];
      if (a.clusterKey && a.clusterKey === b.clusterKey) continue; // cleanup-duplicate-clusters' job
      if (isNearTwin(a, b)) parent[find(sorted[x].i)] = find(sorted[y].i);
    }
  }
  const groups = new Map<number, Doc[]>();
  docs.forEach((d, i) => {
    const r = find(i);
    groups.set(r, [...(groups.get(r) || []), d]);
  });
  const twins = [...groups.values()].filter(g => g.length > 1);

  console.log(`${docs.length} upcoming scraped events; ${twins.length} near-twin group(s)${APPLY ? '' : '  (dry run)'}\n`);

  let deleted = 0, trackerRelinked = 0, foldersRelinked = 0;
  for (const group of twins) {
    group.sort((a, b) => {
      const d = completeness(b) - completeness(a);
      if (d !== 0) return d;
      return new Date(String(a.createdAt || 0)).getTime() - new Date(String(b.createdAt || 0)).getTime();
    });
    const [survivor, ...losers] = group;
    console.log(`${group.length}x  ${survivor.title}`);
    console.log(`     survivor : ${survivor._id}  [${survivor.source}] ${ist(survivor.startDateTime)}  completeness=${completeness(survivor)}  key=${survivor.clusterKey}`);

    const set: Record<string, unknown> = {};
    const categories = new Set<string>((survivor.category as string[]) || []);
    const seen = new Set<string>((survivor.seenInSources as string[]) || []);
    if (survivor.source) seen.add(survivor.source);

    for (const loser of losers) {
      console.log(`     merge in : ${loser._id}  [${loser.source}] ${ist(loser.startDateTime)}  completeness=${completeness(loser)}  key=${loser.clusterKey}`);
      if (istDayGap(survivor.startDateTime, loser.startDateTime) !== 0) {
        console.log(`     DAY CONFLICT: survivor says ${ist(survivor.startDateTime)}, loser says ${ist(loser.startDateTime)} — survivor's day kept`);
      }
      const timing = preciseTimingUpgrade(survivor, loser);
      if (timing && set.startDateTime === undefined) {
        set.startDateTime = timing.startDateTime;
        if (timing.endDateTime) set.endDateTime = timing.endDateTime;
        console.log(`     time     : date-only start upgraded to ${ist(timing.startDateTime)}`);
      }

      for (const field of [
        'imageUrl', 'venue', 'address', 'area', 'city', 'organizer', 'hostAvatarUrl',
        'onlineLink', 'applyLink', 'endDateTime', 'sourceEventId', 'price', 'priceMax',
        'currency', 'capacity', 'registrationDeadline',
      ]) {
        const empty = (v: unknown) => v === undefined || v === null || v === '';
        if (empty(survivor[field]) && !empty(loser[field]) && set[field] === undefined) set[field] = loser[field];
      }
      if ((survivor.lat === undefined || survivor.lat === null) && loser.lat !== undefined && loser.lat !== null) {
        set.lat = loser.lat;
        set.lng = loser.lng;
      }
      const ld = String(loser.description || '');
      if (ld.length > String(survivor.description || '').length && ld.length > String(set.description || '').length) {
        set.description = loser.description;
      }
      const la = Number(loser.attendeeCount || 0);
      if (la > Number(survivor.attendeeCount || 0) && la > Number(set.attendeeCount || 0)) set.attendeeCount = la;
      for (const c of (loser.category as string[]) || []) categories.add(c);
      for (const s of (loser.seenInSources as string[]) || []) seen.add(s);
      if (loser.source) seen.add(loser.source);

      const refs = await TrackerEntry.find({ eventId: loser._id }).select('userId').lean();
      if (refs.length) console.log(`     tracker  : ${refs.length} entry(ies) would repoint to the survivor`);
      const folderRefs = await Folder.countDocuments({ eventId: loser._id });
      if (folderRefs) console.log(`     folders  : ${folderRefs} folder(s) would repoint to the survivor`);
      if (APPLY) {
        for (const e of refs) {
          const clash = await TrackerEntry.countDocuments({ userId: e.userId, eventId: survivor._id });
          if (clash === 0) {
            await TrackerEntry.updateOne({ userId: e.userId, eventId: loser._id }, { $set: { eventId: survivor._id } });
            trackerRelinked++;
          } else {
            console.log(`     tracker  : user ${e.userId} already tracks the survivor — left alone`);
          }
        }
        if (folderRefs) {
          const res = await Folder.updateMany({ eventId: loser._id }, { $set: { eventId: survivor._id } });
          foldersRelinked += res.modifiedCount ?? 0;
        }
      }
    }

    if (categories.size) set.category = [...categories].slice(0, MAX_CATEGORIES);
    if (seen.size) set.seenInSources = [...seen];
    console.log(`     fills    : ${Object.keys(set).join(', ') || '(none)'}\n`);

    if (APPLY) {
      await Event.updateOne({ _id: survivor._id, ...SCRAPED_ONLY }, { $set: set });
      const res = await Event.deleteMany({ _id: { $in: losers.map(l => l._id) }, ...SCRAPED_ONLY });
      deleted += res.deletedCount || 0;
    }
  }

  if (APPLY) {
    console.log(`Deleted ${deleted}; repointed ${trackerRelinked} tracker entry(ies) and ${foldersRelinked} folder(s).`);
  } else {
    console.log(`Dry run — nothing written. ${twins.length} group(s) would collapse, removing ${twins.reduce((n, g) => n + g.length - 1, 0)} document(s).`);
  }
  await mongoose.disconnect();
}

main().catch(async e => {
  console.error(e);
  await mongoose.disconnect();
  process.exit(1);
});
