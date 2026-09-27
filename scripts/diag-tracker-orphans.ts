#!/usr/bin/env tsx
/**
 * Tracker entries whose event is gone, and what the pruner would still destroy. READ-ONLY.
 *
 * Two questions, because they are the two halves of one defect:
 *
 *   1. HOW MUCH HISTORY IS ALREADY STRANDED. A `TrackerEntry` whose `eventId` no longer resolves
 *      (the pruner hard-deleted the event), or resolves to a row its owner may no longer see
 *      (soft-deleted, or someone else's event that went private). `app/tracker/page.tsx` used to
 *      filter both out, so each one is a status, a note and a list of people the user cannot see.
 *      Also reported: how many of them have a folder for the same event, i.e. how many the tracker
 *      can still put a name to.
 *
 *   2. WHAT THE OLD PRUNE RULE WOULD DELETE NEXT. The stale candidates right now, split by whether a
 *      tracker entry, a folder or an interaction references them. Those are the rows the reference
 *      check in `lib/scrapers/prune-selection.ts` now spares, and the ones the old
 *      `Event.deleteMany(stale)` would have taken on the next run.
 *
 * Prints counts, statuses and lengths — never the text of anybody's notes, and user ids truncated.
 *
 * Only `find`, `distinct` and `countDocuments`. No writes, no deletes.
 *
 * Run: npx tsx scripts/diag-tracker-orphans.ts
 */
import './load-env';
import mongoose from 'mongoose';
import connectDB from '../lib/mongodb';
import Event from '../lib/models/Event';
import TrackerEntry from '../lib/models/TrackerEntry';
import Folder from '../lib/models/Folder';
import Interaction from '../lib/models/Interaction';
import { canViewEvent } from '../lib/events/visibility';
import { REMINDABLE_TRACKER_STATUSES } from '../lib/notifications/reminder-policy';
import {
  PRUNE_BATCH_SIZE,
  PRUNE_REFERRERS,
  chunk,
  findReferencesByReferrer,
  partitionByReference,
  staleEventFilter,
  type PruneReferrer,
} from '../lib/scrapers/prune-selection';

type EventRow = {
  _id: unknown;
  visibility?: string | null;
  createdByUserId?: string | null;
  deletedAt?: Date | null;
  startDateTime?: Date;
};

const short = (userId: string) => `${userId.slice(0, 6)}…`;
const pct = (n: number, d: number) => (d === 0 ? '—' : `${Math.round((100 * n) / d)}%`);

async function main() {
  await connectDB();
  const now = new Date();

  /* ── 1. Stranded tracker entries ─────────────────────────────────────────────────────────── */
  const entries = await TrackerEntry.find(
    {},
    { eventId: 1, userId: 1, status: 1, notes: 1, connections: 1, createdAt: 1 }
  ).lean();

  const eventIds = [...new Set(entries.map(entry => String(entry.eventId)))];
  const events = (await Event.find(
    { _id: { $in: eventIds } },
    { visibility: 1, createdByUserId: 1, deletedAt: 1, startDateTime: 1 }
  ).lean()) as unknown as EventRow[];
  const eventById = new Map(events.map(event => [String(event._id), event]));

  // A folder for the same (user, event) is where the tracker can still find the event's NAME —
  // `ensureFolderForEvent` denormalises it — so this counts how many orphans can be named.
  const folders = await Folder.find(
    { eventId: { $in: eventIds } },
    { userId: 1, eventId: 1 }
  ).lean();
  const foldered = new Set(folders.map(f => `${f.userId}|${String(f.eventId)}`));

  const remindable = new Set<string>(REMINDABLE_TRACKER_STATUSES);
  let missing = 0;
  let hidden = 0;
  let withNotes = 0;
  let withPeople = 0;
  let people = 0;
  let nameable = 0;
  let remindableTotal = 0;
  let remindableOrphaned = 0;
  const hiddenWhy = new Map<string, number>();
  const byStatus = new Map<string, { total: number; orphaned: number }>();
  const users = new Set<string>();
  const affected = new Set<string>();
  const samples: string[] = [];

  for (const entry of entries) {
    const userId = String(entry.userId);
    users.add(userId);
    const status = String(entry.status);
    const bucket = byStatus.get(status) ?? { total: 0, orphaned: 0 };
    bucket.total += 1;
    byStatus.set(status, bucket);
    if (remindable.has(status)) remindableTotal += 1;

    const event = eventById.get(String(entry.eventId));
    let orphanReason: string | null = null;
    if (!event) {
      missing += 1;
      orphanReason = 'deleted';
    } else if (!canViewEvent(event, userId)) {
      hidden += 1;
      orphanReason = event.deletedAt ? 'soft-deleted' : `visibility=${event.visibility} (not theirs)`;
      hiddenWhy.set(orphanReason, (hiddenWhy.get(orphanReason) ?? 0) + 1);
    }
    if (!orphanReason) continue;

    bucket.orphaned += 1;
    affected.add(userId);
    if (remindable.has(status)) remindableOrphaned += 1;
    const notes = typeof entry.notes === 'string' ? entry.notes.trim().length : 0;
    const count = Array.isArray(entry.connections) ? entry.connections.length : 0;
    if (notes > 0) withNotes += 1;
    if (count > 0) withPeople += 1;
    people += count;
    const named = foldered.has(`${userId}|${String(entry.eventId)}`);
    if (named) nameable += 1;
    if (samples.length < 15) {
      samples.push(
        `    ${status.padEnd(11)} ${orphanReason.padEnd(14)} notes=${String(notes).padStart(4)} chars  ` +
          `people=${count}  folder=${named ? 'yes' : 'no '}  saved=${
            entry.createdAt ? new Date(entry.createdAt).toISOString().slice(0, 10) : '??????????'
          }  user=${short(userId)}`
      );
    }
  }

  const orphaned = missing + hidden;
  console.log('\n1. TRACKER ENTRIES WHOSE EVENT IS GONE');
  console.log(`   ${entries.length} tracker entries across ${users.size} user(s)`);
  console.log(`   ${orphaned} orphaned (${pct(orphaned, entries.length)}) across ${affected.size} user(s)`);
  console.log(`     ${missing} point at an event row that no longer exists (hard-deleted)`);
  console.log(`     ${hidden} point at a row their owner may no longer see`);
  for (const [why, n] of hiddenWhy) console.log(`       ${String(n).padStart(3)}  ${why}`);
  console.log(
    `   remindable statuses (${[...remindable].join('/')}): ${remindableOrphaned} of ${remindableTotal} orphaned`
  );
  console.log(`   of the orphans: ${withNotes} carry notes, ${withPeople} carry people (${people} people in all)`);
  console.log(`   ${nameable} of ${orphaned} can still be NAMED from the user's own folder for that event`);
  console.log('   by status (orphaned / total):');
  for (const [status, b] of [...byStatus.entries()].sort((a, c) => c[1].total - a[1].total)) {
    console.log(`     ${status.padEnd(11)} ${String(b.orphaned).padStart(3)} / ${b.total}`);
  }
  if (samples.length) {
    console.log('   sample (no note text is printed):');
    for (const line of samples) console.log(line);
  }

  /* ── 2. Other dangling references ────────────────────────────────────────────────────────── */
  const folderRefs = (await Folder.distinct('eventId', { eventId: { $ne: null } })).map(String);
  const interactionRefs = (await Interaction.distinct('eventId', { eventId: { $ne: null } })).map(String);
  const referencedAnywhere = [...new Set([...eventIds, ...folderRefs, ...interactionRefs])];
  const present = new Set(
    (await Event.find({ _id: { $in: referencedAnywhere } }, { _id: 1 }).lean()).map(e => String(e._id))
  );
  console.log('\n2. OTHER REFERRERS POINTING AT A DELETED EVENT (distinct event ids)');
  console.log(`   Folder.eventId       ${folderRefs.filter(id => !present.has(id)).length} of ${folderRefs.length}`);
  console.log(
    `   Interaction.eventId  ${interactionRefs.filter(id => !present.has(id)).length} of ${interactionRefs.length}`
  );

  /* ── 3. What the old rule would delete on the next run ──────────────────────────────────── */
  const stale = staleEventFilter(now);
  const candidates = (await Event.find(stale, { _id: 1 }).lean()).map(row => String(row._id));
  const perReferrer = new Map<PruneReferrer, Set<string>>(PRUNE_REFERRERS.map(r => [r, new Set<string>()]));
  const referenced = new Set<string>();
  for (const batch of chunk(candidates, PRUNE_BATCH_SIZE)) {
    const found = await findReferencesByReferrer(batch);
    for (const referrer of PRUNE_REFERRERS) {
      for (const id of found[referrer]) {
        perReferrer.get(referrer)?.add(String(id));
        referenced.add(String(id));
      }
    }
  }
  const { deletable, spared } = partitionByReference(candidates, referenced);

  console.log('\n3. THE PRUNER, RIGHT NOW (stale = started AND last seen > 7 days ago, scraped only)');
  console.log(`   ${candidates.length} stale candidate(s)`);
  for (const referrer of PRUNE_REFERRERS) {
    console.log(`     referenced by ${referrer.padEnd(12)} ${perReferrer.get(referrer)?.size ?? 0}`);
  }
  console.log(`   ${spared.length} now SPARED — the old rule would delete them on the next run`);
  console.log(`   ${deletable.length} still deleted, exactly as before`);

  // Scraped events a referrer protects that are NOT yet stale: every one of these would have been
  // deleted by the old rule once it went a week past, so this is the forward-looking figure.
  const protectedAhead = await Event.countDocuments({
    _id: { $in: referencedAnywhere },
    createdByUserId: { $exists: false },
    $nor: [stale],
  });
  console.log(`   ${protectedAhead} more referenced scraped event(s) not yet stale, which the old rule`);
  console.log('   would have deleted a week after each one ended');

  await mongoose.disconnect();
}

main().catch(async error => {
  console.error(error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
