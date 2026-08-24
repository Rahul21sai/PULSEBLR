#!/usr/bin/env tsx
/**
 * Move people out of `TrackerEntry.connections[]` and into the `Contact` collection.
 *
 * WHY. The subdocument array cannot be the home for this data:
 *   - it is declared `{ _id: false }`, so a person has no stable identifier and
 *     `markFollowUpComplete()` has to match on name — silently no-opping on the second
 *     person with that name, forever;
 *   - its only write path is `PUT /api/tracker/[id]` doing `{ $set: body }` with the client
 *     sending its ENTIRE local copy of the array, so every save is a full-array replace and
 *     two concurrent additions lose one;
 *   - `TrackerEntry.eventId` is `required`, so it cannot hold anyone met at an event the
 *     scraper never saw.
 *
 * WHAT IT DOES. For each tracker entry that has connections, finds or creates a folder named
 * after its event, then creates one `Contact` per connection.
 *
 * IDEMPOTENT. Each migrated contact gets the deterministic clientId
 * `migrated:<entryId>:<index>`, and `{ userId, clientId }` is unique — so running this twice
 * creates nothing the second time. Re-run it freely.
 *
 * NON-DESTRUCTIVE. `connections[]` is left exactly as it is. `lib/helpers/phase6.ts` reads both
 * stores and tags each result with `source`, so nothing double-counts in a way that loses data
 * and nothing disappears mid-migration. Deleting the legacy array is a separate, later decision.
 *
 * DRY BY DEFAULT. Pass `--apply` to write.
 *
 *   npx tsx scripts/migrate-connections-to-contacts.ts            # report only
 *   npx tsx scripts/migrate-connections-to-contacts.ts --apply    # write
 */
import './load-env';
import mongoose from 'mongoose';
import connectDB from '../lib/mongodb';
import TrackerEntry from '../lib/models/TrackerEntry';
// Imported for its SIDE EFFECT: `.populate('eventId')` below needs the `Event` model registered
// on the connection, and Mongoose otherwise throws
// `MissingSchemaError: Schema hasn't been registered for model "Event"`. A dry run over zero
// tracker entries never reaches the populate, which is how this survived until the migration was
// tested against a real legacy fixture.
import '../lib/models/Event';
import Folder, { folderSlug } from '../lib/models/Folder';
import Contact from '../lib/models/Contact';
import { deriveContactMeta, getTargetCompanies } from '../lib/contacts/service';
import { coerceLinkedInInput } from '../lib/scan/linkedin';
import type { IConnection } from '../lib/models/TrackerEntry';

const APPLY = process.argv.includes('--apply');

async function main() {
  await connectDB();

  const entries = await TrackerEntry.find({ 'connections.0': { $exists: true } })
    .populate('eventId')
    .lean();

  console.log(
    `${APPLY ? 'MIGRATING' : 'DRY RUN — no writes'} · ${entries.length} tracker entries with people\n`
  );

  let foldersCreated = 0;
  let foldersReused = 0;
  let contactsCreated = 0;
  let contactsSkipped = 0;
  const problems: string[] = [];
  // One lookup per user, not per contact.
  const targetsByUser = new Map<string, string[]>();

  for (const entry of entries) {
    // `pruneStale()` deletes events 7 days past on every scrape, so a dangling eventId is
    // normal rather than exceptional. The folder is named from whatever we still have.
    const event = entry.eventId as unknown as
      | { _id?: mongoose.Types.ObjectId; title?: string; startDateTime?: Date; venue?: string; area?: string }
      | null;

    const name = event?.title?.trim() || `Event ${String(entry._id).slice(-6)}`;
    const userId = entry.userId;

    let folderId: mongoose.Types.ObjectId | null = null;
    try {
      const existing = await Folder.findOne({ userId, slug: folderSlug(name) });
      if (existing) {
        folderId = existing._id;
        foldersReused++;
      } else if (APPLY) {
        const created = await Folder.create({
          userId,
          name,
          eventId: event?._id,
          eventDate: event?.startDateTime,
          venue: event?.venue || event?.area || undefined,
        });
        folderId = created._id;
        foldersCreated++;
      } else {
        foldersCreated++;
      }
    } catch (error) {
      problems.push(`folder for "${name}": ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    if (!targetsByUser.has(userId)) {
      targetsByUser.set(userId, APPLY ? await getTargetCompanies(userId) : []);
    }
    const targets = targetsByUser.get(userId)!;

    const connections = entry.connections as IConnection[];
    for (let index = 0; index < connections.length; index++) {
      const connection = connections[index];
      if (!connection?.name?.trim()) {
        contactsSkipped++;
        continue;
      }

      // Deterministic, so re-running is a no-op rather than a duplicate.
      const clientId = `migrated:${String(entry._id)}:${index}`;

      if (!APPLY) {
        contactsCreated++;
        continue;
      }
      // Under --apply the folder always exists by now; the `continue` above covers the dry run,
      // and a folder failure already `continue`d the whole entry.
      if (!folderId) {
        contactsSkipped++;
        continue;
      }

      try {
        const already = await Contact.findOne({ userId, clientId }).select('_id').lean();
        if (already) {
          contactsSkipped++;
          continue;
        }

        // Canonicalise the LinkedIn value so the migrated row gets an `li:` contactKey rather
        // than a weak `nm:` one — the entire point of the new identity scheme.
        const ref = connection.linkedin ? coerceLinkedInInput(connection.linkedin) : null;
        const meta = deriveContactMeta(
          { company: connection.company, role: connection.role, headline: null, tags: null },
          targets
        );

        await Contact.create({
          userId,
          folderId,
          clientId,
          name: connection.name.trim(),
          role: connection.role,
          company: connection.company,
          linkedin: ref?.url ?? connection.linkedin,
          linkedinSlug: ref?.slug,
          note: connection.context,
          followUpAt: connection.followUpAt,
          followedUp: Boolean(connection.followedUp),
          capturedVia: 'manual',
          // These rows predate scanning, so there is no payload to preserve.
          scannedAt: entry.createdAt ?? new Date(),
          ...meta,
        });
        contactsCreated++;
      } catch (error) {
        problems.push(
          `contact "${connection.name}" in "${name}": ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
  }

  console.log(`folders:  ${foldersCreated} ${APPLY ? 'created' : 'would be created'}, ${foldersReused} reused`);
  console.log(`contacts: ${contactsCreated} ${APPLY ? 'created' : 'would be created'}, ${contactsSkipped} skipped (already migrated or unnamed)`);

  if (problems.length) {
    console.log(`\n${problems.length} problems:`);
    for (const problem of problems.slice(0, 20)) console.log(`  - ${problem}`);
    if (problems.length > 20) console.log(`  … and ${problems.length - 20} more`);
  }

  if (!APPLY) {
    console.log('\nNothing was written. Re-run with --apply to migrate.');
  } else {
    console.log('\nLegacy connections[] left untouched, as designed — phase6.ts reads both stores.');
  }

  await mongoose.connection.close();
  process.exit(problems.length ? 1 : 0);
}

main().catch(async error => {
  console.error(error);
  await mongoose.connection.close().catch(() => {});
  process.exit(1);
});
