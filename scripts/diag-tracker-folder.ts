/**
 * Why did confirming an event not produce a folder?
 *
 * Read-only. Walks the whole chain for one event — Event → TrackerEntry → Folder — and prints what
 * exists at each boundary, because "no folder appeared" has at least four different causes that look
 * identical from the outside:
 *
 *   1. The tracker entry never reached a folder-creating status.
 *   2. `entry.eventId` did not populate, so `ensureFolderForEvent` got an object with no `_id` —
 *      and `Folder.findOne({ userId, eventId: undefined })` strips the undefined key in Mongoose,
 *      matching the user's FIRST folder instead and reporting `outcome: 'linked'`. No folder is
 *      created and nothing errors.
 *   3. The folder WAS created and the screen being looked at does not list folders.
 *   4. `Folder.create` threw for a reason other than the name clash the catch handles.
 *
 * Usage: npx tsx scripts/diag-tracker-folder.ts [title-substring]
 */
import './load-env';
import connectDB from '../lib/mongodb';
import mongoose from 'mongoose';
import Event from '../lib/models/Event';
import TrackerEntry from '../lib/models/TrackerEntry';
import Folder from '../lib/models/Folder';
import { FOLDER_ON_TRACKER_STATUS } from '../lib/contacts/service';

const NEEDLE = process.argv[2] || 'beyond';

async function main() {
  await connectDB();

  console.log(`\nSearching events matching /${NEEDLE}/i\n${'─'.repeat(90)}`);

  const events = await Event.find({ title: { $regex: NEEDLE, $options: 'i' } })
    .select('title startDateTime venue area createdByUserId visibility source')
    .lean();

  if (!events.length) {
    console.log('No event matches. The tracker entry cannot exist without one.');
    return;
  }

  for (const e of events) {
    const owner = e.createdByUserId ?? null;
    console.log(`\nEVENT  ${e.title}`);
    console.log(`  _id            ${String(e._id)}`);
    console.log(`  startDateTime  ${e.startDateTime ? new Date(e.startDateTime).toISOString() : '(none)'}`);
    console.log(`  source         ${e.source}`);
    console.log(`  hand-entered   ${owner ? `yes (${owner})` : 'no — scraped'}`);
    console.log(`  visibility     ${e.visibility ?? '(absent = public)'}`);

    const entries = await TrackerEntry.find({ eventId: e._id })
      .select('userId status createdAt updatedAt')
      .lean();

    if (!entries.length) {
      console.log('  TRACKER        no entry for this event — nothing would create a folder');
      continue;
    }

    for (const t of entries) {
      const triggers = (FOLDER_ON_TRACKER_STATUS as readonly string[]).includes(t.status);
      console.log(`  TRACKER        status=${t.status}  triggersFolder=${triggers}  user=${t.userId}`);

      const byEvent = await Folder.findOne({ userId: t.userId, eventId: e._id })
        .select('name eventId eventDate createdAt')
        .lean();
      console.log(
        `  FOLDER(byEventId) ${byEvent ? `FOUND "${byEvent.name}" (${String(byEvent._id)})` : 'NONE'}`
      );

      // The smoking gun for cause 2: if a folder with a NULL eventId exists, then a call made with
      // an undefined event id would have matched it and returned 'linked'.
      // `$exists: false` OR null, expressed without putting `undefined` in an `$in` — the typed
      // ObjectId path rejects that, and Mongo would treat it as a null match anyway.
      const nullLinked = await Folder.find({
        userId: t.userId,
        $or: [{ eventId: { $exists: false } }, { eventId: null }],
      })
        .select('name createdAt')
        .lean();
      console.log(
        `  FOLDERS with eventId unset for this user: ${nullLinked.length}` +
          (nullLinked.length ? ` → ${nullLinked.map(f => `"${f.name}"`).join(', ')}` : '')
      );

      const all = await Folder.find({ userId: t.userId })
        .select('name eventId eventDate contactCount')
        .sort({ createdAt: 1 })
        .lean();
      console.log(`  ALL FOLDERS for this user (${all.length}):`);
      for (const f of all) {
        const contacts = await mongoose.connection
          .db!.collection('contacts')
          .countDocuments({ folderId: f._id });
        console.log(
          `    · "${f.name}"  eventId=${f.eventId ? String(f.eventId) : 'NULL'}  contacts=${contacts}`
        );
      }
    }
  }

  console.log(`\n${'─'.repeat(90)}`);
  console.log(
    'READ THIS AS: a folder found by eventId means creation worked and the UI is the problem.\n' +
      'A missing folder plus "FOLDERS with eventId unset" > 0 means the undefined-id match fired.'
  );
}

main()
  .catch(err => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => process.exit());
