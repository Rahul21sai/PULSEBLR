#!/usr/bin/env tsx
/**
 * The tech-feed false positives, with enough context to see WHY each was flagged.
 *
 * A precision figure of 99% sounded fine and was misleading about the experience: the default
 * feed sorts soonest-first, so five wrong events out of 347 can occupy the top of the page. The
 * first screen of `/api/events?techOnly=true` was "The Fun Boardgames", "Sunday Sports & Dinner
 * meet" and "Sunday Jamming". A count is not a ranking, and the user sees the ranking.
 *
 * So this prints each false positive with its organiser and the head of its description, because
 * the interesting question is not how many there are but which SIGNAL fooled the classifier —
 * a tech-themed Meetup group hosting a social event will have technical copy attached to a
 * boardgame night, and that is a different fix from a bad regex.
 *
 * Read-only.
 *
 * Run: npx tsx scripts/diag-tech-fp.ts
 */
import './load-env';
import connectDB from '../lib/mongodb';
import Event from '../lib/models/Event';
import mongoose from 'mongoose';

/** Activities that are unambiguously not software or hardware engineering. */
const NON_TECH =
  /\b(standup comedy|open mic|comedy show|concert|live music|jamming|karaoke|dj night|trek|hike|marathon|10k run|yoga|meditation|sound bath|zumba|potluck|speed dating|singles|marriage|astrolog|tarot|reiki|book club|poetry|painting|pottery|terrarium|wine tasting|brunch|food festival|flea market|amusement park|board ?game|boardgaming|tabletop|cake|baking|sports|cricket|football|badminton|dinner meet)\b/i;

async function main() {
  await connectDB();
  const now = new Date();

  const flagged = await Event.find(
    {
      isTechEvent: true,
      $or: [{ startDateTime: { $gte: now } }, { endDateTime: { $gte: now } }],
    },
    { title: 1, description: 1, organizer: 1, category: 1, source: 1, connectionScore: 1, startDateTime: 1 }
  )
    .sort({ startDateTime: 1 })
    .lean();

  const fps = flagged.filter(e => NON_TECH.test(String(e.title)));

  console.log(`${flagged.length} upcoming events flagged isTechEvent`);
  console.log(`${fps.length} have an unambiguously non-tech title → precision ${Math.round(((flagged.length - fps.length) / flagged.length) * 100)}%\n`);

  // The number that actually matters: how many of them land on the first page.
  const firstPage = flagged.slice(0, 20);
  const fpOnFirstPage = firstPage.filter(e => NON_TECH.test(String(e.title)));
  console.log(`ON THE FIRST 20 (what a user sees): ${fpOnFirstPage.length} of 20 are false positives`);
  console.log(`  → ${Math.round((fpOnFirstPage.length / 20) * 100)}% of the visible feed, versus ${Math.round((fps.length / flagged.length) * 100)}% of the corpus\n`);

  for (const e of fps) {
    const day = new Date(e.startDateTime as unknown as string).toISOString().slice(0, 10);
    const rank = flagged.findIndex(x => String(x._id) === String(e._id)) + 1;
    console.log(`── #${rank} in the feed · ${day} · ${e.source}`);
    console.log(`   ${String(e.title).slice(0, 74)}`);
    console.log(`   categories: [${(e.category || []).join(', ')}]   score ${e.connectionScore ?? '-'}`);
    console.log(`   organiser:  ${String(e.organizer ?? '—').slice(0, 62)}`);
    console.log(`   description head: ${String(e.description ?? '').replace(/\s+/g, ' ').slice(0, 190)}`);
    console.log('');
  }

  console.log('WHAT THE FIRST RUN OF THIS SCRIPT ACTUALLY SHOWED — it disproved the guess this');
  console.log('note used to make. The expectation was that a tech-themed Meetup group hosting a');
  console.log('social night attaches technical copy to a boardgame event. The descriptions said');
  console.log('otherwise: "cricket sesh followed by dinner", "SUNDAY MUSIC JAMMING", "read a good');
  console.log('book" — no technical text anywhere — yet the categories were AI/ML, Data/Analytics,');
  console.log('Cloud/DevOps and Cybersecurity. Those came from OTHER EVENTS IN THE SAME BATCH.');
  console.log('');
  console.log('And they survived because ingestion UNIONS categories, so a bad tag can never be');
  console.log('removed by re-scraping — only retag-events.ts / retag-category.ts replace. Nor could');
  console.log('`--inconsistent` find them: a boardgame night tagged [Web/Mobile] with');
  console.log('isTechEvent=true is self-CONSISTENT and wrong. Content-based selection is the only');
  console.log('thing that finds an agreed-upon error. Fix: retag-category.ts --match=<title regex>.');
  console.log('');
  console.log('Read the remaining entries before acting: this detector has its own false positives.');
  console.log('"Vibes In, Latency Out: A Voice AI Open Mic" is a real Voice AI event whose title');
  console.log('contains "open mic", and [AI/ML] is the correct tag for it.');

  await mongoose.disconnect();
}

main().catch(async e => {
  console.error(e);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
