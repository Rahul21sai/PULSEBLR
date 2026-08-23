#!/usr/bin/env tsx
/**
 * Training-institute course adverts in the tech feed.
 *
 * Spotted on the actual first page of `/api/events?techOnly=true`: "Free DevOps Demo Class in
 * Electronic City Bangalore" and "Free AI Training Demo in Electronic City". These are lead
 * generation for paid courses run by coaching centres. The tagger's prompt already excludes
 * "paid certification or course-selling sessions that merely mention a technology" — but these
 * are advertised as FREE demos, so the word "paid" lets them through.
 *
 * They matter more than their count suggests, for two reasons:
 *   · they are the single worst thing that can sit at the top of this feed. The product's whole
 *     purpose is events worth attending TO MAKE PROFESSIONAL CONNECTIONS, and a sales demo puts
 *     you in an audience being sold to — the opposite.
 *   · `connectionScore` already penalises certification/cohort/webinar/course titles hard, so if
 *     these are scoring high the penalty list has a gap, and the "Best for connections" sort is
 *     quietly wrong too.
 *
 * This measures both: how many reach the tech feed, and what connectionScore they carry.
 *
 * Read-only.
 *
 * Run: npx tsx scripts/diag-coaching-leak.ts
 */
import './load-env';
import connectDB from '../lib/mongodb';
import Event from '../lib/models/Event';
import mongoose from 'mongoose';

/**
 * Signatures of a course advert rather than an event. Each is deliberately a PHRASE, not a bare
 * word: `course`, `training` and `demo` all appear innocently in real event copy ("a crash
 * course in Rust internals"), and a bare-word list is how you tag a fifth of the corpus wrongly.
 */
const COACHING = [
  /\b(free|paid)\s+(demo|trial)\s+(class|session|lecture)/i,
  /\bdemo\s+class\b/i,
  /\b(training|coaching)\s+(institute|centre|center|academy)\b/i,
  /\bplacement\s+(assistance|guarantee|support)\b/i,
  /\b100%\s+(placement|job)\b/i,
  /\b(certification|certificate)\s+(course|program|programme|training)\b/i,
  /\bbatch\s+(starting|starts|start)\b/i,
  /\benroll\s+now\b/i,
  /\bjob\s+guarantee\b/i,
  /\b(get|become)\s+\w+\s+certified\b/i,
  /\bcrash\s+course\b/i,
  /\blive\s+project\s+training\b/i,
];

async function main() {
  await connectDB();
  const now = new Date();

  const rows = await Event.find(
    { $or: [{ startDateTime: { $gte: now } }, { endDateTime: { $gte: now } }] },
    { title: 1, description: 1, organizer: 1, category: 1, isTechEvent: 1, source: 1, connectionScore: 1 }
  ).lean();

  const hits = rows
    .map(r => {
      const text = `${r.title ?? ''} ${r.description ?? ''}`;
      const matched = COACHING.filter(re => re.test(text));
      return { row: r, matched };
    })
    .filter(x => x.matched.length > 0);

  const inTechFeed = hits.filter(x => x.row.isTechEvent);
  const highScore = inTechFeed.filter(x => (x.row.connectionScore ?? 0) >= 50);

  console.log(`upcoming events                       ${rows.length}`);
  console.log(`look like course adverts              ${hits.length}`);
  console.log(`  of those, in the tech feed          ${inTechFeed.length}   ← precision leak`);
  console.log(`  of those, connectionScore >= 50     ${highScore.length}   ← also mis-ranked`);

  console.log('\n── in the tech feed (each is a sales session presented as an event)');
  for (const { row, matched } of inTechFeed.slice(0, 30)) {
    console.log(
      `  score ${String(row.connectionScore ?? '-').padStart(3)}  ${String(row.source).padEnd(11)} ${String(row.title).slice(0, 48).padEnd(48)} [${(row.category || []).join(', ')}]`
    );
    console.log(`        matched: ${matched.map(m => String(m).slice(0, 40)).join('  ')}`);
  }
  if (inTechFeed.length > 30) console.log(`  … ${inTechFeed.length - 30} more`);

  console.log('\n── flagged as adverts but already NON-tech (correctly excluded)');
  for (const { row } of hits.filter(x => !x.row.isTechEvent).slice(0, 10)) {
    console.log(`  ${String(row.source).padEnd(11)} ${String(row.title).slice(0, 52)}`);
  }

  const byOrganizer = new Map<string, number>();
  for (const { row } of inTechFeed) {
    const key = String(row.organizer ?? 'unknown').slice(0, 40);
    byOrganizer.set(key, (byOrganizer.get(key) ?? 0) + 1);
  }
  if (byOrganizer.size > 0) {
    console.log('\n  organisers responsible (a repeat offender is worth a registry entry):');
    for (const [o, n] of [...byOrganizer.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
      console.log(`    ${String(n).padStart(3)}  ${o}`);
    }
  }

  await mongoose.disconnect();
}

main().catch(async e => {
  console.error(e);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
