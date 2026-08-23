#!/usr/bin/env tsx
/**
 * Where did an AMBIGUOUS company name come from, on an event that plainly is not that company's?
 *
 * The scorecard found `Docker` attributed to "Meetup new people/seekers of SriVidya Tradition",
 * hosted by "srividya personal spiritua". Docker is marked `strength: 'ambiguous'` in the
 * registry, which per its own contract means it may be matched ONLY against the organiser field —
 * a bare mention there really does mean the company is hosting. Neither the organiser nor the
 * venue contains "docker", so either the contract is being violated or something else is matching.
 *
 * This matters more than one row: `strength` is described in CLAUDE.md as THE load-bearing field
 * in company attribution, because a naive substring match reported Intel 37 times (matching
 * *intel*ligence), CRED 31 (*cred*entials) and SAP 157. If the ambiguous path can leak, those all
 * come back.
 *
 * Prints every field of the offending document and re-runs the resolver on it field by field, so
 * the leak is located rather than guessed at.
 *
 * Read-only.
 *
 * Run: npx tsx scripts/diag-company-leak.ts [company]
 */
import './load-env';
import connectDB from '../lib/mongodb';
import Event from '../lib/models/Event';
import { COMPANIES } from '../lib/companies/registry';
import mongoose from 'mongoose';

const TARGET = process.argv[2] ?? 'Docker';

async function main() {
  await connectDB();
  const now = new Date();

  const entry = COMPANIES.find(c => c.name.toLowerCase() === TARGET.toLowerCase());
  console.log(`registry: ${entry ? `${entry.name} · strength=${entry.strength} · aliases=${(entry.aliases || []).join(', ') || 'none'}` : 'NOT IN REGISTRY'}\n`);

  const rows = await Event.find(
    {
      companies: TARGET,
      $or: [{ startDateTime: { $gte: now } }, { endDateTime: { $gte: now } }],
    },
    { title: 1, description: 1, organizer: 1, venue: 1, address: 1, tags: 1, companies: 1, source: 1 }
  ).lean();

  console.log(`${rows.length} upcoming event(s) attributed to "${TARGET}"\n`);

  const needle = new RegExp(`\\b${TARGET.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  const loose = new RegExp(TARGET.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

  for (const e of rows) {
    const fields: Array<[string, string]> = [
      ['title', String(e.title ?? '')],
      ['organizer', String(e.organizer ?? '')],
      ['venue', String(e.venue ?? '')],
      ['address', String(e.address ?? '')],
      ['tags', (e.tags || []).join(' ')],
      ['description', String(e.description ?? '')],
    ];

    const hitFields = fields.filter(([, v]) => loose.test(v)).map(([k]) => k);
    const wordFields = fields.filter(([, v]) => needle.test(v)).map(([k]) => k);

    // An attribution is only justified when the WORD appears in organizer or venue.
    const justified = wordFields.some(f => f === 'organizer' || f === 'venue');
    console.log(`${justified ? 'ok   ' : 'LEAK '} ${String(e.title).slice(0, 62)}`);
    console.log(`       source ${e.source}   companies: [${(e.companies || []).join(', ')}]`);
    console.log(`       "${TARGET}" as a WORD in:      ${wordFields.join(', ') || 'NOWHERE'}`);
    console.log(`       "${TARGET}" as a SUBSTRING in: ${hitFields.join(', ') || 'NOWHERE'}`);

    if (!justified) {
      for (const [k, v] of fields) {
        if (!loose.test(v)) continue;
        const idx = v.search(loose);
        const around = v.slice(Math.max(0, idx - 60), idx + 60).replace(/\s+/g, ' ');
        console.log(`       ${k}: …${around}…`);
      }
      if (hitFields.length === 0) {
        console.log('       NOT PRESENT IN ANY FIELD — the attribution is stale. Event.companies is');
        console.log('       DERIVED data: it was written when the text differed (before enrichment');
        console.log('       replaced a description, or before the registry changed) and nothing');
        console.log('       recomputes it on update. Fix: npx tsx scripts/backfill-companies.ts');
      }
    }
    console.log('');
  }

  await mongoose.disconnect();
}

main().catch(async e => {
  console.error(e);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
