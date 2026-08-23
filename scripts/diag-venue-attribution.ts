#!/usr/bin/env tsx
/**
 * Does matching a company against the VENUE add real attributions, or just noise?
 *
 * resolveCompanies now scores a distinctive company name found in the venue field at 70,
 * on the reasoning that a company lending its office to an event is involved in it. That
 * is a recall improvement bought with some precision risk, so it has to be measured rather
 * than assumed — the registry's whole design exists because a naive match once reported
 * "Intel" 37 times by matching *intel*ligence.
 *
 * Prints every attribution the venue rule ADDS, so each one can be judged by eye. A rule
 * that adds 40 attributions of which 30 are wrong is worse than no rule.
 *
 * Read-only.
 *
 * Run: npx tsx scripts/diag-venue-attribution.ts
 */
import './load-env';
import mongoose from 'mongoose';
import connectDB from '../lib/mongodb';
import Event from '../lib/models/Event';
import { resolveCompanies } from '../lib/companies/resolve';

async function main() {
  await connectDB();
  const now = new Date();

  const events = await Event.find({ startDateTime: { $gte: now } })
    .select('title organizer venue tags description isTechEvent')
    .lean();

  console.log(`Comparing attribution with and without the venue rule across ${events.length} upcoming events\n`);

  let withoutCount = 0;
  let withCount = 0;
  const added: Array<{ company: string; venue: string; title: string; organizer: string }> = [];

  for (const e of events) {
    const base = {
      organizer: e.organizer,
      title: e.title,
      description: e.description,
      tags: e.tags,
    };
    // Same call, minus the venue — the difference is exactly what the rule contributes.
    const without = resolveCompanies(base);
    const withVenue = resolveCompanies({ ...base, venue: e.venue });

    if (without.length > 0) withoutCount++;
    if (withVenue.length > 0) withCount++;

    for (const name of withVenue) {
      if (without.includes(name)) continue;
      added.push({
        company: name,
        venue: (e.venue || '').slice(0, 40),
        title: (e.title || '').slice(0, 46),
        organizer: (e.organizer || '?').slice(0, 26),
      });
    }
  }

  console.log(`attributed WITHOUT venue rule: ${withoutCount}`);
  console.log(`attributed WITH venue rule:    ${withCount}`);
  console.log(`net events gained:             ${withCount - withoutCount}`);
  console.log(`individual attributions added: ${added.length}\n`);

  console.log('Every attribution the venue rule adds — judge these by eye:\n');
  const byCompany = new Map<string, typeof added>();
  for (const a of added) {
    if (!byCompany.has(a.company)) byCompany.set(a.company, []);
    byCompany.get(a.company)!.push(a);
  }
  for (const [company, list] of [...byCompany.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`${company} (${list.length}):`);
    for (const a of list.slice(0, 6)) {
      console.log(`   venue="${a.venue}"`);
      console.log(`      ${a.title}   [host: ${a.organizer}]`);
    }
  }

  console.log('\nJUDGEMENT: an office name in the venue field should mean that company is');
  console.log('involved. Anything above that looks like a coincidence — a mall, a hotel, a');
  console.log('coworking space that merely shares a word with a registry entry — means the');
  console.log('rule is too loose and that name should be marked ambiguous.');

  await mongoose.disconnect();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
