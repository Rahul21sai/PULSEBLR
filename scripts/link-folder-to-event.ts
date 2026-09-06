/**
 * Link an existing hand-made folder to a corpus event.
 *
 * WHY THIS NEEDS A SCRIPT AT ALL. `ensureFolderForEvent()` adopts a folder only when the folder's
 * slug matches the EVENT TITLE's slug. That is deliberately strict — a fuzzy match would happily
 * attach the wrong folder, and a folder holds real contact details — but it means a folder somebody
 * named "Beyond Gen ai" by hand will never be adopted by an event titled "Beyond GenAI: Crafting the
 * Future of Customer-Facing Enterprise Applications … · Luma". Confirming the event then creates a
 * SECOND, empty folder and leaves the people in the first.
 *
 * Setting `eventId` up front makes the adopt question moot: `ensureFolderForEvent` looks up by
 * `{ userId, eventId }` FIRST, finds this folder, and returns `outcome: 'linked'` without creating
 * anything. It also finally makes `detectRepeatConnections()`'s `folder.eventId ?? folder._id`
 * branch reachable for this folder, so two folders for one event stop counting as two meetings.
 *
 * Dry by default. `--apply` to write.
 *
 *   npx tsx scripts/link-folder-to-event.ts --folder "<name>" --event <id> [--apply]
 */
import './load-env';
import connectDB from '../lib/mongodb';
import Event from '../lib/models/Event';
import Folder from '../lib/models/Folder';
import Contact from '../lib/models/Contact';

const APPLY = process.argv.includes('--apply');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  await connectDB();

  const folderName = arg('folder');
  const eventId = arg('event');
  if (!folderName || !eventId) {
    console.error('Usage: --folder "<name>" --event <eventId> [--apply]');
    process.exitCode = 1;
    return;
  }

  const folder = await Folder.findOne({ name: folderName });
  if (!folder) {
    console.error(`No folder named ${JSON.stringify(folderName)}.`);
    process.exitCode = 1;
    return;
  }

  const event = await Event.findById(eventId).select('title startDateTime venue area');
  if (!event) {
    console.error(`No event with id ${eventId}.`);
    process.exitCode = 1;
    return;
  }

  const contacts = await Contact.countDocuments({ folderId: folder._id });

  console.log(`\nFOLDER  "${folder.name}"  (${contacts} contact(s))`);
  console.log(`  owner        ${folder.userId}`);
  console.log(`  eventId now  ${folder.eventId ? String(folder.eventId) : 'NULL'}`);
  console.log(`\nEVENT   "${event.title}"`);
  console.log(`  _id          ${String(event._id)}`);
  console.log(`  starts       ${event.startDateTime?.toISOString?.() ?? String(event.startDateTime)}`);

  if (folder.eventId && String(folder.eventId) === String(event._id)) {
    console.log('\nAlready linked. Nothing to do.');
    return;
  }
  if (folder.eventId) {
    // Refuse rather than silently repoint: a folder already attached to a DIFFERENT event is not a
    // case this script should guess about.
    console.error(
      `\nRefusing: this folder is already linked to a different event (${String(folder.eventId)}).`
    );
    process.exitCode = 1;
    return;
  }

  if (!APPLY) {
    console.log('\nDRY RUN — would set eventId (and fill eventDate/venue if empty).');
    console.log('Re-run with --apply to write.');
    return;
  }

  folder.eventId = event._id;
  if (!folder.eventDate && event.startDateTime) folder.eventDate = event.startDateTime;
  if (!folder.venue) folder.venue = event.venue || event.area || undefined;
  // `.save()` so the slug-deriving `pre('validate')` hook runs, matching every other Folder write.
  await folder.save();

  console.log(`\nLinked. eventId=${String(folder.eventId)}  eventDate=${folder.eventDate?.toISOString() ?? '(unset)'}`);
  console.log('Moving that event to Confirmed will now find this folder instead of making a new one.');
}

main()
  .catch(err => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => process.exit());
