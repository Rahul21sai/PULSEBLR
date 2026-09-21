/**
 * Repair hand-added events that were stored with a FABRICATED category and are therefore invisible.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS. `/add-event` used to substitute `category: ['Meetup']` when the user picked
 * nothing — in the browser at `app/add-event/page.tsx`, and again server-side in
 * `lib/events/manual-input.ts`. `'Meetup'` is deliberately excluded from `TECH_FLAG_CATEGORIES`, so
 * `POST /api/events` correctly derived `isTechEvent: false` from it, and the home feed — which is
 * unconditionally `techOnly` — correctly hid the row. Every layer behaved; the input was a lie.
 *
 * Measured on the live corpus 2026-09-20: 12 of 12 hand-added events owned by a real user were
 * stored `category: ["Meetup"]`, `isTechEvent: false`, `connectionScore: 20`, and **0 of the 5
 * future-dated ones matched the feed** through the app's own `buildEventFilter`.
 *
 * THE CODE FIX ONLY HELPS FUTURE ROWS. That is the whole reason this script is not optional: the
 * create path now refuses to invent a category, and `PATCH /api/admin/submissions` re-derives the
 * flag on approve — but neither touches a row already written, and 10 of the 12 have already been
 * approved (`visibility` absent), so no future approval will ever repair them. Without this, the fix
 * ships, the owner reopens the home page, still sees none of the events he complained about, and
 * reasonably concludes the fix failed.
 *
 * ── THREE DECISIONS WORTH ARGUING WITH ───────────────────────────────────────────────────────
 *
 * 1. IT SELECTS ON THE FABRICATION FINGERPRINT, not on `isTechEvent: false`. The predicate is
 *    `source: 'manual'` AND `category` exactly `['Meetup']`. Selecting every non-tech manual row
 *    would sweep in events somebody deliberately filed as non-tech, which is a legitimate state.
 *
 * 2. IT ONLY REWRITES A CATEGORY IT CAN JUSTIFY FROM THE TEXT, via the same `keywordTagging()` floor
 *    the create path now uses. When the floor finds no TECH topic the row is REPORTED AND LEFT
 *    ALONE — never nudged to `isTechEvent: true` while its category still says `Meetup`. That
 *    combination is precisely the category/flag disagreement `diag-tech-consistency.ts` exists to
 *    report, and `retag-events.ts --inconsistent` would then select those rows and undo this.
 *    Measured expectation: ~10 of 12 repair, ~2 decline and need a human to pick a category.
 *
 * 3. IT ALWAYS RECOMPUTES `connectionScore`, even for a row it declines to re-categorise. 20 is the
 *    schema default at `lib/models/Event.ts`, never a computed value on this path — and
 *    `connectionScore()` itself opens `let score = 20 // baseline`, which is why a stored 20 looked
 *    computed. The default sort is `connections`, so an unscored row ranks below ~190 of 249
 *    upcoming tech events: fixing the flag alone makes an event reachable and still unfindable.
 *
 * `findOne` + assign + `.save()` per document, never `updateMany`: `Event`'s `pre('validate')` hook
 * derives `clusterKey`/`dedupHash` and self-heals a legacy row, and document middleware does not run
 * on an update. Slower and correct.
 *
 *   npx tsx scripts/backfill-manual-event-tech-flag.ts            # DRY — names every row, writes nothing
 *   npx tsx scripts/backfill-manual-event-tech-flag.ts --apply
 *
 * DESTRUCTIVE with `--apply` (it rewrites `category`), dry by default. Exits 0 either way; exits
 * non-zero only if a write throws.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */

import './load-env';

import mongoose from 'mongoose';

import { connectionScore } from '@/lib/events/connection-score';
import { isTechFromCategories } from '@/lib/event-types';
import { keywordTagging } from '@/lib/llm/tagger';
import Event from '@/lib/models/Event';
import connectDB from '@/lib/mongodb';

const APPLY = process.argv.includes('--apply');

void (async () => {
  await connectDB();

  /**
   * `category: ['Meetup']` as an EXACT array match, not `$in`. A row genuinely tagged
   * `['Meetup', 'Community/Social']` by the tagger carries real signal and is not this bug.
   */
  const rows = await Event.find({ source: 'manual', category: ['Meetup'] }).sort({ createdAt: 1 });

  console.log(`\n${rows.length} hand-added row(s) carrying the fabricated category\n`);
  if (!rows.length) {
    console.log('Nothing to repair.');
    await mongoose.connection.close();
    return;
  }

  let repaired = 0;
  let declined = 0;
  let rescored = 0;
  let failures = 0;

  for (const event of rows) {
    const title = String(event.get('title') ?? '');
    const description = String(event.get('description') ?? '');

    const floor = keywordTagging({
      title,
      description,
      venue: event.get('venue') ?? undefined,
      onlineLink: event.get('onlineLink') ?? undefined,
    });
    // The floor has its OWN `['Meetup']` fallback (`lib/llm/tagger.ts`), so "found a tech topic" is
    // the only test that distinguishes a real reading from the same fabrication one layer down.
    const usable = isTechFromCategories(floor.categories);

    const nextCategory = usable ? floor.categories : (event.get('category') as string[]);
    const nextScore = connectionScore({
      format: event.get('format'),
      hasFood: event.get('hasFood'),
      category: nextCategory,
      organizer: event.get('organizer'),
      title,
      isFree: event.get('isFree'),
      price: event.get('price'),
      attendeeCount: event.get('attendeeCount'),
      capacity: event.get('capacity'),
    });
    const scoreBefore = Number(event.get('connectionScore') ?? 0);
    const start = event.get('startDateTime') as Date | undefined;
    const when = start ? start.toISOString().slice(0, 10) : '????-??-??';
    const past = start ? start.getTime() < Date.now() : false;

    console.log(`  "${title.slice(0, 52)}"`);
    console.log(`     starts ${when}${past ? ' (past)' : ''}  visibility=${String(event.get('visibility') ?? '(public)')}`);
    if (usable) {
      console.log(`     REPAIR  category ["Meetup"] -> [${floor.categories.join(', ')}]   isTechEvent false -> true`);
    } else {
      const seen = floor.categories.filter(c => c !== 'Meetup');
      console.log(
        `     DECLINE category left as-is — the floor found ${seen.length ? `only [${seen.join(', ')}]` : 'no topic'}, ` +
          'so a human must pick one. Set it in /admin.'
      );
    }
    if (nextScore !== scoreBefore) {
      console.log(`     SCORE   connectionScore ${scoreBefore} -> ${nextScore}`);
    }

    if (!APPLY) {
      if (usable) repaired++; else declined++;
      if (nextScore !== scoreBefore) rescored++;
      continue;
    }

    try {
      if (usable) {
        event.set('category', floor.categories);
        event.set('isTechEvent', true);
        // The floor's own confidence, so `diag-recent-writes.ts` keyword fingerprinting stays honest
        // about how this row was classified.
        event.set('tagConfidence', floor.confidence);
        repaired++;
      } else {
        declined++;
      }
      if (nextScore !== scoreBefore) {
        event.set('connectionScore', nextScore);
        rescored++;
      }
      if (event.isModified()) await event.save();
    } catch (err) {
      failures++;
      console.log(`     FAILED  ${(err as Error).message}`);
    }
  }

  console.log(
    `\n${repaired} repairable, ${declined} need a human category, ${rescored} need rescoring` +
      (failures ? `, ${failures} FAILED` : '')
  );
  console.log(
    APPLY
      ? 'Applied. Re-open the home page — the repaired rows are now in the default feed.'
      : 'DRY RUN — re-run with --apply to write.'
  );

  await mongoose.connection.close();
  process.exit(failures ? 1 : 0);
})();
