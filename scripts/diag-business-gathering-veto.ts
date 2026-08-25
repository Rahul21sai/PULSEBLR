/**
 * What does the business-gathering veto actually do to the LIVE corpus?
 *
 * `looksLikeBusinessGathering()` decides, from the TITLE alone, that an event is a sales gathering
 * rather than an engineering one, and turns `isTechEvent` off. That is a delete from the default
 * feed, because the feed defaults to `techOnly` — so a false positive here does not mis-file an
 * event, it makes it invisible.
 *
 * Synthetic titles in `tests/business-gathering-veto.test.ts` pin the intent. This measures the
 * consequence, which is a different question: a regex can pass every test I thought to write and
 * still match something a real organiser typed. So this prints BOTH SIDES BY NAME —
 *
 *   REMOVED  currently in the tech feed, and the veto takes it out. Judge each one by eye.
 *   NEAR MISS titles containing a veto word that are SPARED, which is where an over-widened
 *            alternative would show up next time someone edits the pattern.
 *
 * Read-only. Writes nothing, changes nothing — run `retag-category.ts --match=<regex>` to apply a
 * decision, or re-scrape, since the veto only takes effect at tagging time.
 *
 *   npx tsx scripts/diag-business-gathering-veto.ts
 */
import './load-env';
import mongoose from 'mongoose';
import connectDB from '../lib/mongodb';
import Event from '../lib/models/Event';
import { looksLikeBusinessGathering } from '../lib/llm/tagger';
import { buildSort } from '../lib/events/query';

/** Words that appear inside the veto pattern, used to find near misses worth eyeballing. */
const VETO_VOCABULARY =
  /\b(referral|pitch|gtm|go[-\s]?to[-\s]?market|employer|recruiter|mlm|network marketing|sales)\b/i;

function truncate(value: string | null | undefined, max: number): string {
  const text = (value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

async function main() {
  await connectDB();
  const now = new Date();

  const upcoming = await Event.find({ startDateTime: { $gte: now } })
    .select('title source category isTechEvent connectionScore organizer startDateTime')
    .lean();

  const techFeed = upcoming.filter(e => e.isTechEvent);

  /*
   * Rank the removals the way the FEED ranks them, not by date. `connectionScore` is the default
   * sort, so a leak sitting at #2 is a completely different problem from one at #279 — a
   * diagnostic that names rows without ranking them under-reports severity. Same reasoning as
   * diag-offcity.ts.
   *
   * `buildSort` returns a MONGO sort document, not a JS comparator, so it is read as the spec for
   * the comparator below rather than passed to `.sort()` directly — that mistake silently ranks
   * nothing. Asserted against the real value so this cannot drift if the default sort changes.
   */
  const feedSort = buildSort('connections', false);
  const expected = JSON.stringify({ connectionScore: -1, startDateTime: 1 });
  if (JSON.stringify(feedSort) !== expected) {
    console.log(
      `  NOTE: buildSort('connections') is now ${JSON.stringify(feedSort)}, not ${expected}.\n` +
        '        The comparator below no longer mirrors the feed — update it.'
    );
  }
  const ranked = [...techFeed].sort(
    (a, b) =>
      (b.connectionScore ?? 0) - (a.connectionScore ?? 0) ||
      new Date(a.startDateTime).getTime() - new Date(b.startDateTime).getTime()
  );
  const rankOf = new Map(ranked.map((e, i) => [String(e._id), i + 1]));

  const removed = techFeed.filter(e => looksLikeBusinessGathering(e.title));
  const nearMisses = upcoming.filter(
    e => !looksLikeBusinessGathering(e.title) && VETO_VOCABULARY.test(e.title || '')
  );

  console.log(`\nupcoming events            ${upcoming.length}`);
  console.log(`currently isTechEvent      ${techFeed.length}`);
  console.log(`the veto REMOVES           ${removed.length}`);
  console.log(
    `  → tech feed becomes      ${techFeed.length - removed.length}` +
      `  (${((removed.length / Math.max(techFeed.length, 1)) * 100).toFixed(1)}% removed)`
  );

  console.log('\n── REMOVED from the tech feed. Judge every one of these by eye.\n');
  if (removed.length === 0) {
    console.log('  (none — either already retagged, or the corpus has no such events right now)');
  }
  for (const e of removed.sort(
    (a, b) => (rankOf.get(String(a._id)) ?? 0) - (rankOf.get(String(b._id)) ?? 0)
  )) {
    const rank = rankOf.get(String(e._id));
    console.log(
      `  feed#${String(rank).padStart(4)} score ${String(e.connectionScore ?? 0).padStart(3)}  ` +
        `${(e.source || '').padEnd(11)} ${truncate(e.title, 62)}`
    );
    console.log(`               [${(e.category || []).join(', ')}]  host: ${truncate(e.organizer, 40)}`);
  }

  /*
   * The half that catches an over-widened pattern. These titles contain a word the veto knows
   * about and are deliberately SPARED — "Pitch your API to 100 developers", a proptech hackathon,
   * a candidate-side hiring fair. If a future edit starts vetoing one of these, it shows up here
   * as a row moving from this list to the one above.
   */
  console.log('\n── NEAR MISSES: contain a veto word, deliberately SPARED.\n');
  if (nearMisses.length === 0) console.log('  (none)');
  for (const e of nearMisses.slice(0, 40)) {
    const flag = e.isTechEvent ? 'tech ' : '  -  ';
    console.log(`  ${flag} ${(e.source || '').padEnd(11)} ${truncate(e.title, 66)}`);
  }
  if (nearMisses.length > 40) console.log(`  … and ${nearMisses.length - 40} more`);

  console.log(
    '\nThe veto applies at TAGGING time, so stored rows keep their current flag until they are\n' +
      're-tagged or re-scraped. Nothing here has been changed.\n'
  );

  await mongoose.disconnect();
}

main().catch(async err => {
  console.error(err);
  await mongoose.disconnect();
  process.exit(1);
});
