#!/usr/bin/env tsx
/**
 * Did anything just get written, and did it get KEYWORD tags?
 *
 * Written after aborting a `--no-llm` run that should never have been started. `--no-llm` uses
 * the keyword floor, and ingestion UNIONS categories — so that run would have added
 * keyword-derived categories on top of the LLM ones already stored, and per CLAUDE.md a unioned
 * tag cannot be removed by re-scraping. The run was killed about a minute in, which should be
 * inside the scrape phase (order is scrape → enrich → tag → ingest), but "should be" is not
 * evidence.
 *
 * `keywordTagging()` returns confidence 0.6 and the LLM path returns its own value, so a recent
 * document at exactly 0.6 is the fingerprint to look for.
 *
 * Read-only.
 *
 * Run: npx tsx scripts/diag-recent-writes.ts [minutes]
 */
import './load-env';
import connectDB from '../lib/mongodb';
import Event from '../lib/models/Event';
import mongoose from 'mongoose';

const MINUTES = Number(process.argv[2] ?? 15);

async function main() {
  await connectDB();
  const since = new Date(Date.now() - MINUTES * 60_000);

  const updated = await Event.countDocuments({ updatedAt: { $gte: since } });
  const created = await Event.countDocuments({ createdAt: { $gte: since } });
  const keywordish = await Event.find(
    { updatedAt: { $gte: since }, tagConfidence: 0.6 },
    { title: 1, category: 1, tagConfidence: 1, updatedAt: 1 }
  ).lean();

  console.log(`window: last ${MINUTES} min\n`);
  console.log(`  documents created: ${created}`);
  console.log(`  documents updated: ${updated}`);
  console.log(`  updated with tagConfidence exactly 0.6 (keyword fingerprint): ${keywordish.length}`);

  for (const e of keywordish.slice(0, 15)) {
    console.log(`     ${String(e.title).slice(0, 56).padEnd(56)} [${(e.category || []).join(', ')}]`);
  }

  if (keywordish.length === 0) {
    console.log('\n  No keyword-tagged writes in this window.');
  } else {
    // Deliberately NOT called "pollution". Keyword tagging is the documented floor and its
    // output is often correct — measured on the run this script was written for, both LLM
    // providers timed out and 314 of 914 events fell back, yet only 3 documents ended up
    // stored at 0.6 and all three were sensible ("India Food Addicts in Recovery Anonymous"
    // → Community/Social). An earlier version of this script asserted "POLLUTED" on any
    // non-zero count, which would have sent someone re-tagging correct data.
    console.log('\n  Keyword-tagged writes present. JUDGE THE CATEGORIES ABOVE, do not assume they');
    console.log('  are wrong — the floor is often right. The risk to look for is a BROADER tag');
    console.log('  unioned onto a good one (a passing "sensor" adding Hardware/Robotics), because');
    console.log('  ingestion unions and only retag-* can replace.');
    console.log('  If wrong: retag-category.ts --match=<title regex>.');
  }

  await mongoose.disconnect();
  // Always 0: this reports, it does not judge. A non-zero exit would make the documented
  // keyword floor look like a failure every time a provider blips.
  process.exit(0);
}

main().catch(async e => {
  console.error(e);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
