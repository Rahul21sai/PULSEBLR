#!/usr/bin/env tsx
/**
 * Recompute `Contact.companies` and `Contact.isTargetCompany` from stored fields.
 *
 * WHY THIS EXISTS FROM DAY ONE. Both fields are DERIVED, and this repo has already been bitten
 * by a derived field with no backfill: `Event.isTargetCompany` and `Event.recruiterMentioned`
 * are written once at normalize time and never recomputed, so their values silently reflect
 * whatever the code said on the day each row was written. `Event.companies` and
 * `Event.connectionScore` avoided that by having `backfill-companies.ts` and
 * `backfill-connection-score.ts`. This is the contacts equivalent.
 *
 * Run it after:
 *   - editing `lib/companies/registry.ts`
 *   - changing the matching rules in `lib/companies/resolve.ts`
 *   - a user editing their target-company list
 *
 * It calls exactly the same `deriveContactMeta()` the write path uses, so the two cannot drift.
 *
 * DRY BY DEFAULT. Pass `--apply` to write.
 *
 *   npx tsx scripts/backfill-contact-companies.ts
 *   npx tsx scripts/backfill-contact-companies.ts --apply
 */
import './load-env';
import mongoose from 'mongoose';
import connectDB from '../lib/mongodb';
import Contact from '../lib/models/Contact';
import { deriveContactMeta, getTargetCompanies } from '../lib/contacts/service';

const APPLY = process.argv.includes('--apply');

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((value, index) => value === sortedB[index]);
}

async function main() {
  await connectDB();

  const contacts = await Contact.find({}).lean();
  console.log(`${APPLY ? 'BACKFILLING' : 'DRY RUN — no writes'} · ${contacts.length} contacts\n`);

  const targetsByUser = new Map<string, string[]>();
  let changed = 0;
  const examples: string[] = [];

  for (const contact of contacts) {
    if (!targetsByUser.has(contact.userId)) {
      targetsByUser.set(contact.userId, await getTargetCompanies(contact.userId));
    }
    const targets = targetsByUser.get(contact.userId)!;

    const next = deriveContactMeta(
      {
        company: contact.company ?? null,
        role: contact.role ?? null,
        headline: contact.headline ?? null,
        tags: contact.tags ?? null,
      },
      targets
    );

    const companiesChanged = !sameSet(contact.companies ?? [], next.companies);
    const targetChanged = Boolean(contact.isTargetCompany) !== next.isTargetCompany;
    if (!companiesChanged && !targetChanged) continue;

    changed++;
    if (examples.length < 15) {
      examples.push(
        `${contact.name} (${contact.company ?? 'no company'}): ` +
          `[${(contact.companies ?? []).join(', ')}] -> [${next.companies.join(', ')}]` +
          (targetChanged ? `  target ${contact.isTargetCompany} -> ${next.isTargetCompany}` : '')
      );
    }

    if (APPLY) {
      // A plain field update is correct here: `contactKey` does not depend on these fields, so
      // there is nothing for the document hook to recompute.
      await Contact.updateOne(
        { _id: contact._id },
        { $set: { companies: next.companies, isTargetCompany: next.isTargetCompany } }
      );
    }
  }

  console.log(`${changed} contact${changed === 1 ? '' : 's'} ${APPLY ? 'updated' : 'would change'}`);
  if (examples.length) {
    console.log('\nexamples:');
    for (const example of examples) console.log(`  - ${example}`);
  }
  if (!APPLY && changed) console.log('\nRe-run with --apply to write.');

  await mongoose.connection.close();
  process.exit(0);
}

main().catch(async error => {
  console.error(error);
  await mongoose.connection.close().catch(() => {});
  process.exit(1);
});
