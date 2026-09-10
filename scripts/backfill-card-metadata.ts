#!/usr/bin/env tsx
/**
 * Populate `audience`, `perks` and `tier` on stored events, and upgrade `hasFood`.
 *
 * ── DRY BY DEFAULT. `--apply` TO WRITE. ───────────────────────────────────────────
 * Deliberately the OPPOSITE default from `scripts/backfill-connection-score.ts`, which
 * writes unless you pass `--dry`. That script recomputes a single number from fields
 * that are already stored, so a wrong run is undone by running it again. This one writes
 * to three fields nothing has ever written, and `tier`/`audience`/`perks` are
 * enum-constrained, so a bad run is a wall of ValidationErrors partway through a corpus.
 * The destructive-by-default shape belongs to the older scripts; the newer ones
 * (`cleanup-non-bengaluru.ts`, `cleanup-duplicate-clusters.ts`,
 * `migrate-connections-to-contacts.ts`) are all dry-first, and this follows those.
 *
 * Usage:
 *   npx tsx scripts/backfill-card-metadata.ts                  dry run, report only
 *   npx tsx scripts/backfill-card-metadata.ts --apply          write
 *   npx tsx scripts/backfill-card-metadata.ts --limit 200
 *   npx tsx scripts/backfill-card-metadata.ts --only-missing    skip rows already carrying all three
 *   npx tsx scripts/backfill-card-metadata.ts --all            past events too
 *
 * ── WHAT THIS WRITES, AND THE ONE THING IT MUST NOT ───────────────────────────────
 * All three fields are DERIVED and freely recomputable, which is what separates them
 * from `spotlightAt` — a human chose that one and nothing may rewrite it. This script
 * never mentions `spotlightAt`, and must not learn to.
 *
 * `hasFood` is different again, and is the field to be careful with. It PREDATES `perks`
 * and two shipped things read it: the food filter in `buildEventFilter`, and
 * `connectionScore`'s `hasFood === 'yes'` bonus. So it is UPGRADE-ONLY here — the perk
 * derivation may fill an `'unknown'` and may never overwrite a stated `'yes'` or `'no'`.
 * `hasFoodFromPerks()` returns `'yes'` or `null`, and its own comment is emphatic that
 * `null` means the perks are SILENT rather than negative; an adapter that observed the
 * catering outranks a regex that did not see it mentioned.
 *
 * ── connectionScore, AND WHY IT IS RECOMPUTED NARROWLY ────────────────────────────
 * A `hasFood` upgrade is worth +8, and the default feed sort IS `connections`, so
 * filling an `'unknown'` moves rows up the page a reader actually reads. Writing perks
 * without the score would leave the feed ranked on stale numbers.
 *
 * But the score is recomputed ONLY for rows whose `hasFood` this run changed, and that
 * narrowness is the point. Measured with `scripts/diag-card-metadata.ts` on 2026-09-10:
 * 77 of 1149 upcoming rows already carry a `connectionScore` that disagrees with a fresh
 * computation, for reasons that have nothing to do with this work. Recomputing every row
 * it touches would silently absorb that pre-existing drift into this change, so the
 * report would credit a card-metadata backfill with 77 score corrections it did not
 * cause — and the next person to ask "what moved the ranking" gets the wrong answer.
 * `scripts/backfill-connection-score.ts` is the tool for that drift; this run points at
 * it and leaves it alone.
 *
 * The score comes from importing `lib/events/connection-score.ts`, never from a copy of
 * its weights. A metric that keeps its own copy of the thing it measures will eventually
 * measure the copy — `diag-scorecard.ts` did exactly that with the category patterns and
 * reported the tagger's correct refusal as a miss.
 *
 * ── WHY A BACKFILL IS NEEDED AT ALL, RATHER THAN JUST RE-SCRAPING ─────────────────
 * Two independent reasons. Ingestion MERGES rather than replaces, so a field can be
 * filled by a later sighting but never corrected by one — the same property that makes a
 * bad category unremovable by re-scraping. And `lib/scrapers/normalizer.ts` does not yet
 * copy these three fields out of the tagging result at all (see the note at the end of
 * this header), so re-scraping currently writes none of them.
 *
 * ── KNOWN GAP THIS SCRIPT CANNOT CLOSE ───────────────────────────────────────────
 * `lib/llm/tagger.ts` now returns `audience`, `perks` and `tier` on every
 * `TaggingResult`, and `lib/scrapers/normalizer.ts#assemble()` does not read them, so
 * NOTHING POPULATES THEM AT INGEST. Three lines in `assemble()` are needed —
 * `audience: tagged.audience`, `perks: tagged.perks`, `tier: tagged.tier`, plus the
 * matching fields on `NormalizedEvent` and the same upgrade-only `hasFood` rule this
 * script uses. `toTaggingInput()` should also pass `organizer`, `attendeeCount`,
 * `isFree`, `price` and `rawCategory`, which `tier` reads and which are optional on
 * `TaggingInput` precisely because it does not pass them today. Until that lands, this
 * backfill is the only writer and must be re-run after each scrape.
 */
import './load-env';
import mongoose from 'mongoose';
import connectDB from '../lib/mongodb';
import Event from '../lib/models/Event';
import { deriveCardMetadata } from '../lib/llm/tagger';
import { connectionScore } from '../lib/events/connection-score';
import { hasFoodFromPerks, AUDIENCE_NAMES, PERK_NAMES, EVENT_TIERS } from '../lib/event-types';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const ALL = argv.includes('--all');
const ONLY_MISSING = argv.includes('--only-missing');
const limitArg = argv.indexOf('--limit');
const LIMIT = limitArg >= 0 ? Math.max(0, Number(argv[limitArg + 1]) || 0) : 0;

/** Written in chunks so a long run reports progress and can be interrupted safely. */
const CHUNK = 200;

interface Row {
  _id: mongoose.Types.ObjectId;
  title?: string;
  description?: string;
  organizer?: string;
  venue?: string;
  category?: string[];
  tags?: string[];
  attendeeCount?: number;
  capacity?: number;
  isFree?: boolean;
  price?: number;
  hasFood?: string;
  format?: string;
  companies?: string[];
  connectionScore?: number;
  audience?: string[];
  perks?: string[];
  tier?: string;
}

const same = (a: string[] = [], b: string[] = []) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

async function main() {
  await connectDB();
  const now = new Date();

  const filter: Record<string, unknown> = { deletedAt: null };
  if (!ALL) {
    filter.$or = [{ startDateTime: { $gte: now } }, { endDateTime: { $gte: now } }];
  }
  if (ONLY_MISSING) {
    // "Missing" means missing ANY of the three, not all three: a row with perks and no
    // tier is exactly the row a re-run should finish. `$size: 0` rather than `$exists`
    // because the schema defaults both arrays to `[]`, so the key is always present —
    // the same reason `spotlightAt` is filtered on `$type: 'date'` and not `$exists`.
    filter.$and = [
      {
        $or: [
          { audience: { $size: 0 } },
          { perks: { $size: 0 } },
          { tier: { $exists: false } },
          { tier: null },
        ],
      },
    ];
  }

  const query = Event.find(filter, {
    title: 1,
    description: 1,
    organizer: 1,
    venue: 1,
    category: 1,
    tags: 1,
    attendeeCount: 1,
    capacity: 1,
    isFree: 1,
    price: 1,
    hasFood: 1,
    format: 1,
    companies: 1,
    connectionScore: 1,
    audience: 1,
    perks: 1,
    tier: 1,
  });
  if (LIMIT > 0) query.limit(LIMIT);
  // `.lean()` for the reason backfill-connection-score.ts documents: a hydrated document
  // fills missing paths with the schema default, so a row that has NO stored value reads
  // back as the default and an "unchanged" check skips it, leaving the field never
  // actually written. Lean shows the true stored value.
  const rows = (await query.lean()) as unknown as Row[];

  console.log(
    `\n${APPLY ? 'APPLYING to' : 'DRY RUN over'} ${rows.length} ${ALL ? 'stored' : 'upcoming'} event(s)` +
      `${ONLY_MISSING ? ', only those missing a field' : ''}${LIMIT ? `, limit ${LIMIT}` : ''}\n`
  );
  if (!APPLY) console.log('   (nothing will be written — pass --apply to write)\n');

  const updates: Array<{ id: mongoose.Types.ObjectId; set: Record<string, unknown> }> = [];
  const counts = {
    audience: 0,
    perks: 0,
    tier: 0,
    foodUpgraded: 0,
    scoreChanged: 0,
    unchanged: 0,
  };
  const dist = {
    audience: new Map<string, number>(),
    perks: new Map<string, number>(),
    tier: new Map<string, number>(),
  };
  let scoreDelta = 0;
  const foodExamples: string[] = [];
  const tierExamples: string[] = [];

  for (const row of rows) {
    const meta = deriveCardMetadata({
      title: row.title || '',
      description: row.description || '',
      venue: row.venue,
      organizer: row.organizer,
      attendeeCount: row.attendeeCount,
      isFree: row.isFree,
      price: row.price,
      categories: row.category,
      hints: row.tags,
    });

    for (const a of meta.audience) dist.audience.set(a, (dist.audience.get(a) ?? 0) + 1);
    for (const p of meta.perks) dist.perks.set(p, (dist.perks.get(p) ?? 0) + 1);
    if (meta.tier) dist.tier.set(meta.tier, (dist.tier.get(meta.tier) ?? 0) + 1);

    const set: Record<string, unknown> = {};

    if (!same(meta.audience, row.audience)) {
      set.audience = meta.audience;
      if (meta.audience.length > 0) counts.audience++;
    }
    if (!same(meta.perks, row.perks)) {
      set.perks = meta.perks;
      if (meta.perks.length > 0) counts.perks++;
    }
    /*
     * `tier` is only ever SET, never cleared. If the derivation now says nothing about a
     * row that already carries a tier, the stored value stays — it may have come from
     * the LLM on a run when a provider worked, and the keyword floor being quieter than
     * the model is not evidence that the model was wrong. Absence means "no evidence",
     * so overwriting a value with absence would be asserting the opposite.
     */
    if (meta.tier && meta.tier !== row.tier) {
      set.tier = meta.tier;
      counts.tier++;
      if (tierExamples.length < 10) {
        tierExamples.push(`${meta.tier.padEnd(9)} ${String(row.title).slice(0, 58)}`);
      }
    }

    // ── hasFood: UPGRADE ONLY. See the header. ──
    const stored = row.hasFood ?? 'unknown';
    const implied = hasFoodFromPerks(meta.perks);
    if (stored === 'unknown' && implied === 'yes') {
      set.hasFood = 'yes';
      counts.foodUpgraded++;

      // The score is recomputed HERE and only here — for rows this run actually changed
      // the food flag on. See the header for why it is not recomputed corpus-wide.
      const scoreInput = {
        format: row.format,
        attendeeCount: row.attendeeCount,
        capacity: row.capacity,
        category: row.category,
        companies: row.companies,
        organizer: row.organizer,
        title: row.title,
        isFree: row.isFree,
        price: row.price,
      };
      const before = connectionScore({ ...scoreInput, hasFood: stored });
      const after = connectionScore({ ...scoreInput, hasFood: 'yes' });
      if (after !== before) {
        set.connectionScore = after;
        counts.scoreChanged++;
        scoreDelta += after - before;
        if (foodExamples.length < 10) {
          foodExamples.push(
            `${String(before).padStart(3)} → ${String(after).padStart(3)}  ${String(row.title).slice(0, 52)}  perks=[${meta.perks.join(',')}]`
          );
        }
      }
    }

    if (Object.keys(set).length === 0) counts.unchanged++;
    else updates.push({ id: row._id, set });
  }

  // ── Report BEFORE writing, so a dry run and an apply say the same thing ──────
  const pct = (n: number) => (rows.length === 0 ? '-' : `${((n / rows.length) * 100).toFixed(1)}%`);
  console.log('── what would change');
  console.log(`   rows to update            ${updates.length}  (${pct(updates.length)})`);
  console.log(`   unchanged                 ${counts.unchanged}`);
  console.log(`   gain a non-empty audience ${counts.audience}`);
  console.log(`   gain a non-empty perks    ${counts.perks}`);
  console.log(`   gain or change tier       ${counts.tier}`);
  console.log(`   hasFood 'unknown' → 'yes' ${counts.foodUpgraded}   (UPGRADE ONLY — never overwrites)`);
  console.log(`   connectionScore rewritten ${counts.scoreChanged}   (total +${scoreDelta})`);

  console.log('\n── resulting distribution (every vocabulary value, zeroes included)');
  for (const name of AUDIENCE_NAMES) {
    console.log(`   audience ${name.padEnd(18)} ${String(dist.audience.get(name) ?? 0).padStart(5)}`);
  }
  for (const name of PERK_NAMES) {
    console.log(`   perk     ${name.padEnd(18)} ${String(dist.perks.get(name) ?? 0).padStart(5)}`);
  }
  for (const name of EVENT_TIERS) {
    console.log(`   tier     ${name.padEnd(18)} ${String(dist.tier.get(name) ?? 0).padStart(5)}`);
  }

  if (tierExamples.length > 0) {
    console.log('\n── sample tier assignments (judge these by eye before --apply)');
    for (const line of tierExamples) console.log(`   ${line}`);
  }
  if (foodExamples.length > 0) {
    console.log('\n── sample connectionScore movements from a food upgrade');
    for (const line of foodExamples) console.log(`   ${line}`);
  } else {
    console.log(
      '\n── no connectionScore movement: `FOOD_RE` in the tagger is BROADER than `FOOD_PERKS`'
    );
    console.log(
      '   (it matches dinner/meal/buffet/catering, which have no perk bucket), so the stored'
    );
    console.log(
      '   `hasFood` already says yes wherever the perks would have implied it. Expected, not a bug.'
    );
  }

  // Pre-existing score drift, named separately so this run cannot take credit for it.
  const stale = rows.filter(row => {
    const fresh = connectionScore({
      format: row.format,
      hasFood: row.hasFood,
      attendeeCount: row.attendeeCount,
      capacity: row.capacity,
      category: row.category,
      companies: row.companies,
      organizer: row.organizer,
      title: row.title,
      isFree: row.isFree,
      price: row.price,
    });
    return row.connectionScore !== fresh;
  }).length;
  if (stale > 0) {
    console.log(
      `\n── NOTE: ${stale} row(s) already carry a stale connectionScore for unrelated reasons.`
    );
    console.log(
      '   This script deliberately does NOT fix those — folding them in would credit a card-'
    );
    console.log(
      '   metadata backfill with score changes it did not cause. Run scripts/backfill-connection-score.ts.'
    );
  }

  if (!APPLY) {
    console.log('\nDry run complete. Nothing was written.\n');
    await mongoose.disconnect();
    return;
  }

  let written = 0;
  let failed = 0;
  for (let i = 0; i < updates.length; i += CHUNK) {
    const slice = updates.slice(i, i + CHUNK);
    const result = await Event.bulkWrite(
      slice.map(u => ({
        updateOne: {
          filter: { _id: u.id },
          // A plain `$set` of derived fields. No `$unset`, so an absent `tier` stays
          // absent rather than being stored as an explicit null — the trap CLAUDE.md
          // records for `spotlightAt`, where a stored null fails the `$type: 'date'`
          // filter and reads as "pinned".
          update: { $set: u.set },
        },
      })),
      // Keep going past a single enum ValidationError rather than abandoning the rest
      // of the corpus; the count is reported below.
      { ordered: false }
    ).catch(err => {
      console.warn(`  chunk at ${i} had failures: ${err instanceof Error ? err.message : err}`);
      return null;
    });
    if (result) written += result.modifiedCount ?? 0;
    else failed += slice.length;
    console.log(`  ${Math.min(i + CHUNK, updates.length)}/${updates.length}`);
  }

  console.log(`\n${written} document(s) updated${failed ? `, ${failed} in failed chunks` : ''}\n`);
  await mongoose.disconnect();
}

main().catch(async e => {
  console.error(e);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
