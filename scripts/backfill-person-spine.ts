#!/usr/bin/env tsx
/**
 * Backfill the people spine: give every existing `Contact` a `Person`, and every capture one `met`
 * `Interaction`.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * RUN `migrate-connections-to-contacts.ts --apply` FIRST, AND THE ORDER IS NOT NEGOTIABLE.
 *
 * People still trapped in the deprecated `TrackerEntry.connections[]` are not `Contact` rows yet, so
 * this script cannot see them. Run this first and they never get a `Person` — they arrive later, as
 * contacts with no person, on a page that has already cut over to listing persons. They would simply
 * be absent from `/people`, with nothing on screen to say so.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * IDEMPOTENT, three times over, which is what makes re-running safe after an interrupted pass:
 *
 *   1. A contact that already has a `personId` is skipped outright.
 *   2. `resolvePerson()` attaches to whoever already holds the `contactKey` rather than creating.
 *   3. The partial unique index on `{ userId, contactId }` filtered to `kind: 'met'` refuses a second
 *      `met` row, and `recordInteraction()` returns the existing one instead of throwing.
 *
 * DRY BY DEFAULT — repo convention, and load-bearing here for a reason the other backfills do not
 * have: `resolvePerson()` WRITES (it creates persons and appends keys), so a dry run cannot call it.
 * The projection below is computed from the same `contactKey` grouping the resolver would use, and it
 * is a projection rather than a rehearsal. Say so, rather than implying it simulated the run.
 *
 *   npx tsx scripts/backfill-person-spine.ts
 *   npx tsx scripts/backfill-person-spine.ts --apply
 *   npx tsx scripts/backfill-person-spine.ts --apply --limit 50
 */
import './load-env';
import mongoose from 'mongoose';
import connectDB from '../lib/mongodb';
import Contact from '../lib/models/Contact';
import Folder from '../lib/models/Folder';
import Person from '../lib/models/Person';
import Interaction from '../lib/models/Interaction';
import { resolvePerson, recordInteraction, recomputePerson } from '../lib/people/service';
import { normalizeName } from '../lib/scan/contact-key';

const APPLY = process.argv.includes('--apply');
const LIMIT = (() => {
  const arg = process.argv.find(a => a.startsWith('--limit='));
  if (arg) return Number(arg.split('=')[1]) || 0;
  const index = process.argv.indexOf('--limit');
  return index > -1 ? Number(process.argv[index + 1]) || 0 : 0;
})();

async function main() {
  await connectDB();

  /**
   * OLDEST FIRST. `derivePersonFields()` is per-field newest-wins, so the order the rows are
   * processed in does not change the final derived values — but it does change which encounter seeds
   * a brand-new `Person`, and seeding from the oldest then recomputing forward is the order the live
   * write path would have produced. A backfill that leaves rows in a state the live path could not
   * have created is a backfill whose output nobody can reason about later.
   */
  const contacts = await Contact.find({})
    .sort({ scannedAt: 1 })
    .limit(LIMIT || 0)
    .select('userId folderId contactKey personId name company role headline linkedinSlug email scannedAt');

  const unattached = contacts.filter(c => !c.personId);

  console.log(
    `${APPLY ? 'BACKFILLING' : 'DRY RUN — no writes'} · ${contacts.length} contacts ` +
      `(${contacts.length - unattached.length} already attached, ${unattached.length} to do)` +
      (LIMIT ? `  [--limit ${LIMIT}]` : '') +
      '\n'
  );

  // Folder → eventId, in one read. `folder.eventId` is what puts an event on the `met` interaction,
  // and it is the whole reason "who did I meet here" becomes answerable.
  const folderIds = [...new Set(contacts.map(c => String(c.folderId)))];
  const folders = await Folder.find({ _id: { $in: folderIds } }).select('eventId').lean();
  const eventByFolder = new Map(folders.map(f => [String(f._id), f.eventId ?? null]));

  await reportSplits(unattached);

  if (!APPLY) {
    await projectDryRun(unattached);
    await mongoose.connection.close();
    process.exit(0);
  }

  let personsCreated = 0;
  let attached = 0;
  let interactions = 0;
  let collisions = 0;
  let failed = 0;
  const touched = new Set<string>();
  const problems: string[] = [];

  for (const contact of unattached) {
    try {
      const { person, created, suggestion } = await resolvePerson(contact.userId, contact);
      if (created) personsCreated++;
      if (suggestion) {
        collisions++;
        problems.push(
          `collision: "${contact.name}" (${contact.contactKey}) → suggests ${suggestion.displayName}`
        );
      }

      contact.personId = person._id as mongoose.Types.ObjectId;
      await contact.save();
      attached++;

      /**
       * `recompute: false` on EVERY row, then one recompute per person at the end. Recomputing per
       * interaction would re-read that person's whole contact set once per capture — quadratic in the
       * number of times you have met somebody, for a value that is only correct after the last row.
       */
      await recordInteraction(
        contact.userId,
        {
          personId: person._id as mongoose.Types.ObjectId,
          kind: 'met',
          // The SCAN time. A backfilled interaction that claimed to have happened now would make
          // `lastInteractionAt` say every person was contacted the day the migration ran.
          at: contact.scannedAt ?? contact.get('createdAt') ?? new Date(),
          eventId: eventByFolder.get(String(contact.folderId)) ?? null,
          contactId: contact._id as mongoose.Types.ObjectId,
        },
        { recompute: false }
      );
      interactions++;
      touched.add(`${contact.userId}::${String(person._id)}`);
    } catch (err) {
      // One bad row must not abandon the pass — the script is idempotent, so the right behaviour is
      // to carry on and let a re-run pick up whatever failed.
      failed++;
      problems.push(`FAILED "${contact.name}" (${String(contact._id)}): ${(err as Error).message}`);
    }
  }

  let recomputed = 0;
  for (const composite of touched) {
    const [userId, personId] = composite.split('::');
    if (await recomputePerson(userId, personId)) recomputed++;
  }

  console.log(`persons created      ${personsCreated}`);
  console.log(`contacts attached    ${attached}`);
  console.log(`met interactions     ${interactions}`);
  console.log(`persons recomputed   ${recomputed}`);
  console.log(`key collisions       ${collisions}   (suggestions only — nothing was merged)`);
  console.log(`failed rows          ${failed}`);

  if (problems.length) {
    console.log('\nnotes:');
    for (const problem of problems.slice(0, 25)) console.log(`  - ${problem}`);
    if (problems.length > 25) console.log(`  … and ${problems.length - 25} more`);
  }

  console.log('\nNow run: npx tsx scripts/diag-people-spine.ts');

  await mongoose.connection.close();
  process.exit(failed ? 1 : 0);
}

/** What the run would do, projected from the contact keys — NOT a rehearsal. See the header. */
async function projectDryRun(unattached: Array<{ userId: string; contactKey?: string | null }>) {
  const byKey = new Map<string, number>();
  let keyless = 0;
  for (const contact of unattached) {
    if (!contact.contactKey) {
      keyless++;
      continue;
    }
    const composite = `${contact.userId}::${contact.contactKey}`;
    byKey.set(composite, (byKey.get(composite) ?? 0) + 1);
  }

  // How many of those keys a live Person already holds — those attach rather than create.
  let existing = 0;
  for (const composite of byKey.keys()) {
    const [userId, key] = composite.split('::');
    if (await Person.exists({ userId, contactKeys: key })) existing++;
  }

  const alreadyMet = await Interaction.countDocuments({ kind: 'met' });

  console.log(`distinct contact keys      ${byKey.size}`);
  console.log(`  keys a Person already holds  ${existing}   → would ATTACH`);
  console.log(`  keys nobody holds            ${byKey.size - existing}   → would CREATE a Person`);
  console.log(
    `keyless contacts           ${keyless}   → one Person each; unfindable later, see resolvePerson`
  );
  console.log(`met interactions today     ${alreadyMet}`);
  console.log(`\nRe-run with --apply to write.`);
}

/**
 * THE ONE THING A DRY RUN SHOULD WARN ABOUT, because it is the thing the operator cannot see coming.
 *
 * The backfill attaches strictly on an EXACT `contactKey` match. So the same human captured twice —
 * once by name (`nm:asha rao`) and once from a LinkedIn QR (`li:asha-rao-123`) — becomes TWO persons,
 * because at backfill time neither contact has a `personId` to link them and the keys do not overlap.
 *
 * That is the DELIBERATELY SAFE direction and must not be "improved" into name-based joining. The
 * asymmetry: two persons for one human is untidy and one merge fixes it, while one person for two
 * humans interleaves their notes and follow-ups and is the single failure this design cannot make
 * cheap to undo. Two people called Rahul at one event is exactly the case `contactKey` was introduced
 * to stop collapsing.
 *
 * So this reports, and does not act.
 */
async function reportSplits(
  unattached: Array<{ userId: string; name?: string | null; contactKey?: string | null }>
) {
  const keysByName = new Map<string, Set<string>>();
  for (const contact of unattached) {
    const name = normalizeName(contact.name);
    if (!name || !contact.contactKey) continue;
    const composite = `${contact.userId}::${name}`;
    if (!keysByName.has(composite)) keysByName.set(composite, new Set());
    keysByName.get(composite)!.add(contact.contactKey);
  }

  const split = [...keysByName.entries()].filter(([, keys]) => keys.size > 1);
  if (!split.length) return;

  console.log(
    `${split.length} name${split.length === 1 ? '' : 's'} carry more than one contactKey and will ` +
      `become separate persons (a merge suggestion, not an error — see reportSplits):`
  );
  for (const [composite, keys] of split.slice(0, 10)) {
    console.log(`  - ${composite.split('::')[1]}: ${[...keys].join(' , ')}`);
  }
  if (split.length > 10) console.log(`  … and ${split.length - 10} more`);
  console.log('');
}

main().catch(async error => {
  console.error(error);
  await mongoose.connection.close().catch(() => {});
  process.exit(1);
});
