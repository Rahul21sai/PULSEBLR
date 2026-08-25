/**
 * Apply the business-gathering veto to events that are ALREADY STORED.
 *
 * `looksLikeBusinessGathering()` runs at tagging time, so it only affects rows written after it
 * shipped. Everything already in the corpus keeps the flag it was given — and it cannot heal on
 * its own, because ingestion UNIONS categories and `mergeInto()` never blanks a value, so
 * re-scraping can add a tag but never remove one. Without this, the leak stays in the feed until
 * each event's own start date passes.
 *
 * WHY A BACKFILL AND NOT `retag-events.ts`. A retag asks the LLM to re-decide, which is the right
 * tool when the question is a judgement call. This is not: the veto is a deterministic function of
 * the title, so re-deciding it through a model would be slower, cost tokens, and could disagree
 * with the code that governs every future write. Same reasoning as `backfill-companies.ts` — a
 * derived value is recomputed, not re-inferred.
 *
 * IT ONLY EVER TURNS `isTechEvent` OFF. It never sets it true, so it cannot promote an event into
 * the feed, and running it twice changes nothing the second time.
 *
 * DRY BY DEFAULT. `--apply` writes.
 *
 *   npx tsx scripts/backfill-tech-veto.ts            # report only
 *   npx tsx scripts/backfill-tech-veto.ts --apply    # write
 *   npx tsx scripts/backfill-tech-veto.ts --all      # include events already in the past
 */
import './load-env';
import mongoose from 'mongoose';
import connectDB from '../lib/mongodb';
import Event from '../lib/models/Event';
import { looksLikeBusinessGathering } from '../lib/llm/tagger';

const APPLY = process.argv.includes('--apply');
const ALL = process.argv.includes('--all');

function truncate(value: string | null | undefined, max: number): string {
  const text = (value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

async function main() {
  await connectDB();

  // Upcoming only by default: a past event is not in anyone's feed, so rewriting it is churn.
  const filter: Record<string, unknown> = { isTechEvent: true };
  if (!ALL) filter.startDateTime = { $gte: new Date() };

  const candidates = await Event.find(filter)
    .select('title source category connectionScore startDateTime')
    .lean();

  const targets = candidates.filter(e => looksLikeBusinessGathering(e.title));

  console.log(`\n${APPLY ? 'APPLY' : 'DRY RUN'} — ${ALL ? 'all' : 'upcoming'} events flagged isTechEvent`);
  console.log(`  examined  ${candidates.length}`);
  console.log(`  matching the veto  ${targets.length}\n`);

  if (targets.length === 0) {
    console.log('  Nothing to do.\n');
    await mongoose.disconnect();
    return;
  }

  for (const e of targets) {
    console.log(`  ${(e.source || '').padEnd(11)} ${truncate(e.title, 64)}`);
    console.log(`              [${(e.category || []).join(', ')}]  score ${e.connectionScore ?? 0}`);
  }

  if (!APPLY) {
    console.log(`\n  ${targets.length} row(s) would have isTechEvent set to false.`);
    console.log('  Re-run with --apply to write. Read every title above first — a false positive');
    console.log('  here REMOVES a real engineering event from the default feed.\n');
    await mongoose.disconnect();
    return;
  }

  /*
   * `updateOne` per document rather than one `updateMany`, so the report can name what changed and
   * a mid-run failure leaves a knowable state. The set is single digits in practice.
   *
   * NOT `.save()`: this touches one derived boolean and needs no document middleware. The
   * `clusterKey` / `dedupHash` hooks are `pre('validate')` and would re-run for no reason.
   */
  let written = 0;
  for (const e of targets) {
    const res = await Event.updateOne({ _id: e._id }, { $set: { isTechEvent: false } });
    if (res.modifiedCount > 0) written++;
  }

  console.log(`\n  Wrote ${written} of ${targets.length}.`);
  console.log('  Re-run scripts/diag-tech-fp.ts and diag-tech-consistency.ts to confirm.\n');

  await mongoose.disconnect();
}

main().catch(async err => {
  console.error(err);
  await mongoose.disconnect();
  process.exit(1);
});
