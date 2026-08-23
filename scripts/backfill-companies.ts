#!/usr/bin/env tsx
/**
 * Resolve `companies` for every stored event.
 *
 * Run after changing lib/companies/registry.ts or resolve.ts — attribution is
 * derived data, so it can always be recomputed from the fields we already store
 * and never needs re-scraping.
 *
 * Usage:
 *   npx tsx scripts/backfill-companies.ts          apply
 *   npx tsx scripts/backfill-companies.ts --dry    report only
 */
import './load-env';
import mongoose from 'mongoose';
import connectDB from '../lib/mongodb';
import Event from '../lib/models/Event';
import { resolveCompanies } from '../lib/companies/resolve';
import { COMPANIES } from '../lib/companies/registry';

const DRY = process.argv.includes('--dry');

async function main() {
  await connectDB();

  // `venue` is in the projection because resolveCompanies now scores it — an office name
  // in that field means the company is involved. Omitting it here would make the new rule
  // silently never fire, which is the worst kind of bug: the code is right and the data
  // never reaches it.
  const events = await Event.find({}).select('title description organizer tags companies venue');
  console.log(`Resolving companies for ${events.length} event(s)${DRY ? ' (dry run)' : ''}\n`);

  let changed = 0;
  let attributed = 0;
  const tally = new Map<string, number>();

  for (const event of events) {
    const companies = resolveCompanies({
      organizer: event.organizer,
      title: event.title,
      description: event.description,
      tags: event.tags,
      venue: event.venue,
    });

    if (companies.length > 0) {
      attributed++;
      for (const name of companies) tally.set(name, (tally.get(name) || 0) + 1);
    }

    // Write the field even when the resolved value is unchanged-and-empty, so every
    // document ends up with an explicit `companies` array. Skipping those left the
    // field ABSENT on unattributed events, and queries written as `{ companies: [] }`
    // then silently missed them.
    const before = (event.companies || []).join('|');
    const fieldMissing = event.companies === undefined;
    if (before !== companies.join('|') || fieldMissing) {
      changed++;
      if (!DRY) await Event.updateOne({ _id: event._id }, { $set: { companies } });
    }
  }

  console.log(`${attributed}/${events.length} events attributed to at least one company`);
  console.log(`${changed} document(s) ${DRY ? 'would change' : 'updated'}\n`);

  const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`${ranked.length}/${COMPANIES.length} registry companies have events:`);
  for (const [name, n] of ranked) {
    console.log(`   ${String(n).padStart(4)}  ${name}`);
  }

  const absent = COMPANIES.filter(c => !tally.has(c.name)).map(c => c.name);
  console.log(`\nNo events found for ${absent.length}: ${absent.join(', ')}`);

  await mongoose.disconnect();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
