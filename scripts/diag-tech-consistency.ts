#!/usr/bin/env tsx
/**
 * Do the app's TWO definitions of "tech" agree?
 *
 * There are two, and they are filtered on independently:
 *   · `isTechEvent` — a boolean the LLM sets directly. `techOnly=true` maps to exactly this
 *     (lib/events/query.ts: `filter.isTechEvent = true`), and the feed defaults to it.
 *   · `category` ∩ TECH_CATEGORY_NAMES — the nine tech topics the filter rail renders as a
 *     group labelled "Tech topic".
 *
 * The keyword floor derives one from the other (`isTechEvent = chosen.some(c => TECH.has(c))`),
 * so they cannot disagree there. The LLM sets both independently, so they can — and a District
 * row surfaced it: "NoCode by Yashraj" stored `[Web/Mobile, Arts/Culture]` with
 * isTechEvent=false.
 *
 * WHY THE DIRECTION MATTERS:
 *   A. tech category, isTechEvent=false → the event is HIDDEN from the default feed despite
 *      being on a tech topic. This is recall loss on the product's core purpose, and it is
 *      invisible: the facet counts are computed through the same filter, so the rail agrees
 *      with the list and nothing looks wrong.
 *   B. no tech category, isTechEvent=true → shown in the tech feed with no tech topic. This is
 *      the precision direction, and it is what a user would notice and complain about.
 *
 * A handful either way is judgement. Hundreds means one of the two signals should be derived
 * from the other rather than asked for twice.
 *
 * Read-only.
 *
 * Run: npx tsx scripts/diag-tech-consistency.ts
 */
import './load-env';
import connectDB from '../lib/mongodb';
import Event from '../lib/models/Event';
import { TECH_CATEGORY_NAMES } from '../lib/event-types';
import mongoose from 'mongoose';

async function main() {
  await connectDB();
  const now = new Date();
  const TECH = [...TECH_CATEGORY_NAMES];

  const upcoming = { startDateTime: { $gte: now } };

  const total = await Event.countDocuments(upcoming);
  const flagTech = await Event.countDocuments({ ...upcoming, isTechEvent: true });
  const catTech = await Event.countDocuments({ ...upcoming, category: { $in: TECH } });
  const both = await Event.countDocuments({ ...upcoming, isTechEvent: true, category: { $in: TECH } });

  const onlyFlag = await Event.find(
    { ...upcoming, isTechEvent: true, category: { $nin: TECH } },
    { title: 1, category: 1, source: 1 }
  ).lean();
  const onlyCat = await Event.find(
    { ...upcoming, isTechEvent: { $ne: true }, category: { $in: TECH } },
    { title: 1, category: 1, source: 1 }
  ).lean();

  console.log(`upcoming events            ${total}`);
  console.log(`isTechEvent = true         ${flagTech}   ← what the default feed shows`);
  console.log(`has a tech category        ${catTech}   ← what the "Tech topic" rail counts`);
  console.log(`both agree                 ${both}`);
  console.log('');
  console.log(`A. tech category, flag FALSE  ${onlyCat.length}   ← hidden from the default feed`);
  console.log(`B. flag TRUE, no tech category ${onlyFlag.length}   ← in the tech feed, no tech topic`);

  const disagree = onlyCat.length + onlyFlag.length;
  console.log(`\ndisagreement: ${disagree} of ${total} upcoming (${((disagree / (total || 1)) * 100).toFixed(1)}%)`);

  console.log('\n── A. tech topic but hidden from the default feed (recall loss)');
  for (const e of onlyCat.slice(0, 25)) {
    console.log(`  ${String(e.source).padEnd(11)} ${String(e.title).slice(0, 54).padEnd(54)} [${(e.category || []).join(', ')}]`);
  }
  if (onlyCat.length > 25) console.log(`  … ${onlyCat.length - 25} more`);

  console.log('\n── B. in the tech feed with no tech topic (precision risk)');
  for (const e of onlyFlag.slice(0, 25)) {
    console.log(`  ${String(e.source).padEnd(11)} ${String(e.title).slice(0, 54).padEnd(54)} [${(e.category || []).join(', ')}]`);
  }
  if (onlyFlag.length > 25) console.log(`  … ${onlyFlag.length - 25} more`);

  // Which categories dominate direction B tells you whether the flag is picking up a real
  // signal the topic list cannot express (a "Hackathon" with no topic is genuinely tech) or
  // is simply wrong.
  const bCats = new Map<string, number>();
  for (const e of onlyFlag) for (const c of e.category || []) bCats.set(c, (bCats.get(c) ?? 0) + 1);
  if (bCats.size > 0) {
    console.log('\n  categories carried by direction B:');
    for (const [c, n] of [...bCats.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(n).padStart(4)}  ${c}`);
    }
    console.log('    (Hackathon / Conference / Workshop / Career-Hiring / Startup-Founders are');
    console.log('     GATHERING types, not topics — a hackathon with no topic is legitimately tech,');
    console.log('     so direction B is expected to be non-zero and is not automatically a defect.)');
  }

  await mongoose.disconnect();
}

main().catch(async e => {
  console.error(e);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
