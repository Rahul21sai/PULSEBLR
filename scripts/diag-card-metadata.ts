#!/usr/bin/env tsx
/**
 * What would `audience`, `perks` and `tier` actually SAY about this corpus?
 *
 * Read-only. Writes nothing, and does not need `--dry` because it has no other mode.
 *
 * ── WHY THIS IS A DIAGNOSTIC AND NOT A UNIT TEST ─────────────────────────────────
 * `tests/card-metadata.test.ts` pins the patterns against phrases somebody chose. That
 * catches the mistakes you can imagine. It cannot catch the one that matters here,
 * which is a regex matching real scraped copy in a way nobody thought to write down —
 * and CLAUDE.md is emphatic about the shape of that failure: a widened pattern fails by
 * SILENTLY OVER-MATCHING, coverage goes UP, and the aggregate reads as an improvement.
 * `Gaming/XR` was found that way (7 upcoming events tagged with it, ZERO of them games
 * engineering) and so was the `\bpm\b` disaster. Both were found by READING ROWS.
 *
 * So the most important output below is not a percentage. It is the per-value sample
 * blocks, which print the derived value beside the title and the organiser so each one
 * can be judged by eye. Read those. The counts are context for them.
 *
 * ── THE LLM MEASUREMENT THIS SCRIPT CANNOT MAKE ──────────────────────────────────
 * The brief that produced this work asked for a measurement of whether the three new
 * response fields degrade CATEGORY quality — the documented risk being that extra
 * output competes for the same budget, which at batch-of-8 once left 8 of 840 events
 * with LLM tags. That measurement is impossible in this environment and the reason is
 * worth recording rather than reporting as "not done":
 *
 *   IBM ICA        401  {"error":"Developer API key has expired"}
 *   NVIDIA NIM     410  meta/llama-3.1-8b-instruct reached end of life 2026-08-26
 *   NVIDIA NIM     404  every one of the 80 models GET /models lists — "not found for
 *                       account", i.e. the key can enumerate models it cannot call
 *   Anthropic      ANTHROPIC_API_KEY unset
 *
 * There is no provider to measure against, and the same fact means THIS KEYWORD FLOOR
 * IS CURRENTLY THE ENTIRE TAGGER, including for the daily cron on `main`. Everything
 * below is therefore not a fallback measurement — it is a measurement of production.
 * Re-run `scripts/diag-retag-preview.ts` for the category-quality question once a
 * provider works again.
 *
 * Run: npx tsx scripts/diag-card-metadata.ts
 *      npx tsx scripts/diag-card-metadata.ts --all       past events too
 *      npx tsx scripts/diag-card-metadata.ts --samples 8 rows per vocabulary value
 */
import './load-env';
import mongoose from 'mongoose';
import connectDB from '../lib/mongodb';
import Event from '../lib/models/Event';
// NB: `ADVERT_PATTERN` is deliberately NOT imported. The obvious use for it here would
// be "rows where ADVERT_PATTERN fires but tier is not advert" — and that check cannot
// fail, because `advert` has top precedence in `deriveTier`. The advert section below
// compares against an INDEPENDENT list instead, which is the only comparison that can
// tell you anything.
import { deriveCardMetadata, AUDIENCE_KEYWORDS, PERK_KEYWORDS } from '../lib/llm/tagger';
import { connectionScore } from '../lib/events/connection-score';
import {
  AUDIENCE_NAMES,
  PERK_NAMES,
  EVENT_TIERS,
  FOOD_PERKS,
  hasFoodFromPerks,
} from '../lib/event-types';

const argv = process.argv.slice(2);
const ALL = argv.includes('--all');
const sampleArg = argv.indexOf('--samples');
const SAMPLES = sampleArg >= 0 ? Math.max(1, Number(argv[sampleArg + 1]) || 5) : 5;

/**
 * The `dinner`-family words `FOOD_RE` matches and `PERK_NAMES` cannot express.
 *
 * Deliberately a SEPARATE list from the tagger's `FOOD_RE`, and this is the one place
 * in this file where a copy is right rather than wrong: the question being measured is
 * precisely "which food words have no perk bucket", so the list has to be the gap, not
 * the pattern. It is only ever used to count and name rows.
 */
const UNBUCKETED_FOOD = /\b(dinner|meals?|buffet|catering|thali|biryani)\b/i;

/**
 * An independent advert signature, for cross-checking `ADVERT_PATTERN` against a list
 * that was written by somebody else for the same quarry.
 *
 * These are `scripts/diag-coaching-leak.ts`'s patterns. Duplicating them is normally
 * the documented sin — `diag-scorecard.ts` kept a copy of the category patterns and it
 * drifted within one session. Here the duplication IS the instrument: two lists that
 * agree tell you something, and one list compared against itself tells you nothing. If
 * these ever diverge, that shows up below as a number instead of as a silent gap.
 */
const COACHING_INDEPENDENT = [
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
  isTechEvent?: boolean;
  source?: string;
  audience?: string[];
  perks?: string[];
  tier?: string;
}

const pct = (n: number, of: number) => (of === 0 ? '  -  ' : `${((n / of) * 100).toFixed(1)}%`);
const trim = (s: unknown, n: number) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n);

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

async function main() {
  await connectDB();
  const now = new Date();

  const when = ALL
    ? {}
    : { $or: [{ startDateTime: { $gte: now } }, { endDateTime: { $gte: now } }] };

  const rows = (await Event.find(
    { ...when, deletedAt: null },
    {
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
      isTechEvent: 1,
      source: 1,
      audience: 1,
      perks: 1,
      tier: 1,
    }
  ).lean()) as unknown as Row[];

  console.log(`\ncard metadata over ${rows.length} ${ALL ? 'stored' : 'upcoming'} event(s)\n`);

  // ── What is STORED today ────────────────────────────────────────────────────
  const storedAudience = rows.filter(r => (r.audience || []).length > 0).length;
  const storedPerks = rows.filter(r => (r.perks || []).length > 0).length;
  const storedTier = rows.filter(r => r.tier).length;
  console.log('── stored today (before any backfill)');
  console.log(`   audience  ${String(storedAudience).padStart(5)}  ${pct(storedAudience, rows.length)}`);
  console.log(`   perks     ${String(storedPerks).padStart(5)}  ${pct(storedPerks, rows.length)}`);
  console.log(`   tier      ${String(storedTier).padStart(5)}  ${pct(storedTier, rows.length)}`);

  // ── What the derivation WOULD produce ───────────────────────────────────────
  const derived = rows.map(r => ({
    row: r,
    meta: deriveCardMetadata({
      title: r.title || '',
      description: r.description || '',
      venue: r.venue,
      organizer: r.organizer,
      attendeeCount: r.attendeeCount,
      isFree: r.isFree,
      price: r.price,
      categories: r.category,
      hints: r.tags,
    }),
  }));

  const withAudience = derived.filter(d => d.meta.audience.length > 0);
  const withPerks = derived.filter(d => d.meta.perks.length > 0);
  const withTier = derived.filter(d => d.meta.tier);
  console.log('\n── derived coverage (keyword floor; see header — this IS production today)');
  console.log(`   audience  ${String(withAudience.length).padStart(5)}  ${pct(withAudience.length, rows.length)}`);
  console.log(`   perks     ${String(withPerks.length).padStart(5)}  ${pct(withPerks.length, rows.length)}`);
  console.log(`   tier      ${String(withTier.length).padStart(5)}  ${pct(withTier.length, rows.length)}`);
  console.log(
    `   none of the three ${String(derived.filter(d => !d.meta.tier && d.meta.audience.length === 0 && d.meta.perks.length === 0).length).padStart(5)}` +
      '   ← rows a card would show nothing extra for'
  );

  // ── Distribution of every vocabulary value ──────────────────────────────────
  const count = (values: string[]) => {
    const m = new Map<string, number>();
    for (const v of values) m.set(v, (m.get(v) ?? 0) + 1);
    return m;
  };
  const audienceCounts = count(derived.flatMap(d => d.meta.audience));
  const perkCounts = count(derived.flatMap(d => d.meta.perks));
  const tierCounts = count(derived.flatMap(d => (d.meta.tier ? [d.meta.tier] : [])));

  console.log('\n── distribution: audience (every value in AUDIENCE_NAMES, zeroes included)');
  for (const name of AUDIENCE_NAMES) {
    const n = audienceCounts.get(name) ?? 0;
    console.log(`   ${name.padEnd(18)} ${String(n).padStart(5)}  ${pct(n, rows.length)}`);
  }
  console.log('\n── distribution: perks');
  for (const name of PERK_NAMES) {
    const n = perkCounts.get(name) ?? 0;
    const food = FOOD_PERKS.has(name) ? ' (food)' : '';
    console.log(`   ${name.padEnd(18)} ${String(n).padStart(5)}  ${pct(n, rows.length)}${food}`);
  }
  console.log('\n── distribution: tier');
  for (const name of EVENT_TIERS) {
    const n = tierCounts.get(name) ?? 0;
    console.log(`   ${name.padEnd(18)} ${String(n).padStart(5)}  ${pct(n, rows.length)}`);
  }
  console.log(
    `   ${'(absent)'.padEnd(18)} ${String(rows.length - withTier.length).padStart(5)}  ${pct(rows.length - withTier.length, rows.length)}  ← "nothing said", not "ordinary"`
  );

  // ── The TECH feed, separately, because that is the only thing a reader sees ──
  //
  // The public feed is `techOnly` UNCONDITIONALLY, so a false positive on a trek or a
  // board-game night costs a reader nothing — it never renders. Reporting one number
  // over the whole corpus would hide which mistakes are actually reachable.
  const tech = derived.filter(d => d.row.isTechEvent);
  console.log(`\n── the same, restricted to the TECH feed (${tech.length} rows) — the only rows a reader sees`);
  for (const name of AUDIENCE_NAMES) {
    const n = tech.filter(d => d.meta.audience.includes(name)).length;
    console.log(`   audience ${name.padEnd(18)} ${String(n).padStart(4)}  ${pct(n, tech.length)}`);
  }
  for (const name of PERK_NAMES) {
    const n = tech.filter(d => d.meta.perks.includes(name)).length;
    console.log(`   perk     ${name.padEnd(18)} ${String(n).padStart(4)}  ${pct(n, tech.length)}`);
  }
  for (const name of EVENT_TIERS) {
    const n = tech.filter(d => d.meta.tier === name).length;
    console.log(`   tier     ${name.padEnd(18)} ${String(n).padStart(4)}  ${pct(n, tech.length)}`);
  }

  // ── THE PART THAT MATTERS: rows to judge by eye ─────────────────────────────
  //
  // Each line prints WHAT MATCHED, not just that something did. Without it a sample is
  // barely better than a count: `Thursday Jamming night` carrying `juniors` is only
  // judgeable once you can see it came from "beginners welcome" in the description. The
  // matched substring is the difference between a list you can argue with and a list you
  // have to trust.
  const matchedText = (d: (typeof derived)[number], pattern: RegExp, scope?: string) => {
    const haystack =
      scope === 'title'
        ? d.row.title || ''
        : `${d.row.title ?? ''} ${d.row.description ?? ''} ${(d.row.tags || []).join(' ')}`;
    return trim(haystack.match(pattern)?.[0], 30);
  };
  const patternsFor = <T,>(table: Array<[T, RegExp, string?]>, name: T) =>
    table.filter(([n]) => n === name);

  console.log('\n══ SAMPLES — judge each of these by eye. A count cannot see over-matching. ══');
  for (const name of AUDIENCE_NAMES) {
    const hits = derived.filter(d => d.meta.audience.includes(name));
    if (hits.length === 0) {
      console.log(`\n  audience "${name}" — 0 rows (unreachable from keywords, or genuinely absent)`);
      continue;
    }
    console.log(`\n  audience "${name}" — ${hits.length} rows (${tech.filter(d => d.meta.audience.includes(name)).length} in the tech feed)`);
    for (const d of hits.slice(0, SAMPLES)) {
      const hit = patternsFor(AUDIENCE_KEYWORDS as Array<[string, RegExp, string?]>, name as string)
        .map(([, p, s]) => matchedText(d, p, s))
        .find(Boolean);
      console.log(
        `    ${trim(d.row.title, 46).padEnd(46)} via="${hit}"  host=${trim(d.row.organizer, 18)}`
      );
    }
  }
  for (const name of PERK_NAMES) {
    const hits = derived.filter(d => d.meta.perks.includes(name));
    console.log(`\n  perk "${name}" — ${hits.length} rows (${tech.filter(d => d.meta.perks.includes(name)).length} in the tech feed)`);
    for (const d of hits.slice(0, SAMPLES)) {
      const hit = patternsFor(PERK_KEYWORDS as Array<[string, RegExp, string?]>, name as string)
        .map(([, p, s]) => matchedText(d, p, s))
        .find(Boolean);
      console.log(
        `    ${trim(d.row.title, 46).padEnd(46)} via="${hit}"  host=${trim(d.row.organizer, 18)}`
      );
    }
  }
  for (const name of EVENT_TIERS) {
    const hits = derived.filter(d => d.meta.tier === name);
    console.log(`\n  tier "${name}" — ${hits.length} rows`);
    for (const { row } of hits.slice(0, SAMPLES * 2)) {
      console.log(
        `    ${trim(row.title, 50).padEnd(50)} n=${String(row.attendeeCount ?? '-').padStart(4)} venue=${trim(row.venue, 22)}`
      );
    }
  }

  // ── The `101` branch, named rather than trusted ─────────────────────────────
  const juniorsPattern = AUDIENCE_KEYWORDS.find(([n]) => n === 'juniors')?.[1];
  const phraseOnly =
    /\b(beginners?|beginner[- ]friendly|newcomers?|no prior experience|no experience (?:needed|required)|entry[- ]level|getting started|first[- ]time contributors?|intro to|introduction to)\b/i;
  if (juniorsPattern) {
    const only101 = derived.filter(d => {
      const text = `${d.row.title ?? ''} ${d.row.description ?? ''}`;
      return juniorsPattern.test(text) && !phraseOnly.test(text);
    });
    console.log(
      `\n── the "101" branch of \`juniors\`: ${only101.length} row(s) rely on it ALONE (no phrase form)`
    );
    console.log('   Each is a candidate false positive — "Room 101", "only 101 seats". Judge them:');
    for (const { row } of only101.slice(0, 12)) {
      const m = `${row.title ?? ''} ${row.description ?? ''}`.match(/[a-z]{3,}\s+101\b/i);
      console.log(`    ${trim(row.title, 52).padEnd(52)} matched="${trim(m?.[0], 24)}"`);
    }
    if (only101.length === 0) console.log('    (none — the branch is currently costing nothing)');
  }

  // ── The `dinner` gap, as a number ───────────────────────────────────────────
  const dinnerGap = derived.filter(d => {
    const text = `${d.row.title ?? ''} ${d.row.description ?? ''}`;
    return UNBUCKETED_FOOD.test(text) && hasFoodFromPerks(d.meta.perks) === null;
  });
  console.log(
    `\n── \`PERK_NAMES\` HAS NO \`dinner\` BUCKET: ${dinnerGap.length} row(s) name dinner/meal/buffet/catering`
  );
  console.log(
    '   and get NO food perk as a result. `hasFood` still catches them (FOOD_RE is broader),'
  );
  console.log(
    '   so this is the food FACET under-reporting, not a wrong `hasFood`. Add `dinner` to'
  );
  console.log('   PERK_NAMES to close it; mapping dinner onto `snacks` would make the chip lie.');
  for (const { row } of dinnerGap.slice(0, 8)) {
    const m = `${row.title ?? ''} ${row.description ?? ''}`.match(UNBUCKETED_FOOD);
    console.log(`    ${trim(row.title, 52).padEnd(52)} matched="${trim(m?.[0], 12)}"`);
  }

  // ── advert vs the independent coaching list ─────────────────────────────────
  const mine = new Set<string>();
  const theirs = new Set<string>();
  for (const { row, meta } of derived) {
    const text = `${row.title ?? ''} ${row.description ?? ''}`;
    if (meta.tier === 'advert') mine.add(String(row._id));
    if (COACHING_INDEPENDENT.some(re => re.test(text))) theirs.add(String(row._id));
  }
  const both = [...mine].filter(id => theirs.has(id)).length;
  console.log('\n── `tier: advert` vs `diag-coaching-leak.ts`\'s independent signature');
  console.log(`   ADVERT_PATTERN says advert                 ${mine.size}`);
  console.log(`   the independent list says coaching advert  ${theirs.size}`);
  console.log(`   both agree                                 ${both}`);
  console.log(`   only ADVERT_PATTERN (this one is wider)    ${mine.size - both}`);
  console.log(`   MISSED by ADVERT_PATTERN                   ${theirs.size - both}   ← the number to care about`);
  const missed = derived.filter(d => {
    const text = `${d.row.title ?? ''} ${d.row.description ?? ''}`;
    return d.meta.tier !== 'advert' && COACHING_INDEPENDENT.some(re => re.test(text));
  });
  for (const { row, meta } of missed.slice(0, 10)) {
    console.log(`    [tier=${String(meta.tier ?? 'absent').padEnd(9)}] ${trim(row.title, 56)}`);
  }
  // And how many of the adverts are in the tech feed, which is where they do harm.
  const advertsInTech = derived.filter(d => d.meta.tier === 'advert' && d.row.isTechEvent).length;
  console.log(
    `   of the adverts, in the TECH feed           ${advertsInTech}   ← what the operator gets a handle on`
  );

  // ── attendeeCount distribution: the evidence for the flagship thresholds ────
  const counts = rows
    .map(r => r.attendeeCount)
    .filter((n): n is number => typeof n === 'number' && n > 0)
    .sort((a, b) => a - b);
  console.log('\n── `attendeeCount`, which the flagship thresholds are set against');
  console.log(`   rows carrying one   ${counts.length} of ${rows.length}  ${pct(counts.length, rows.length)}`);
  if (counts.length > 0) {
    console.log(
      `   median ${percentile(counts, 0.5)} · p75 ${percentile(counts, 0.75)} · p90 ${percentile(counts, 0.9)} · p99 ${percentile(counts, 0.99)} · max ${counts[counts.length - 1]}`
    );
    console.log(
      `   >= 120 (MODERATE)  ${counts.filter(n => n >= 120).length}     >= 400 (BIG)  ${counts.filter(n => n >= 400).length}`
    );
  }

  // ── connectionScore movement from newly-derived food ────────────────────────
  //
  // `hasFood === 'yes'` is worth +8, so filling an 'unknown' MOVES THE DEFAULT SORT.
  // A backfill that writes perks without recomputing the score leaves the feed ranked
  // on stale numbers, which is why this is measured here and not assumed.
  let foodUpgrades = 0;
  let scoreMoved = 0;
  let totalDelta = 0;
  for (const { row, meta } of derived) {
    const upgraded =
      row.hasFood === 'unknown' || row.hasFood === undefined
        ? (hasFoodFromPerks(meta.perks) ?? row.hasFood)
        : row.hasFood;
    if (upgraded !== row.hasFood) foodUpgrades++;
    const before = connectionScore({
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
    const after = connectionScore({
      format: row.format,
      hasFood: upgraded,
      attendeeCount: row.attendeeCount,
      capacity: row.capacity,
      category: row.category,
      companies: row.companies,
      organizer: row.organizer,
      title: row.title,
      isFree: row.isFree,
      price: row.price,
    });
    if (after !== before) {
      scoreMoved++;
      totalDelta += after - before;
    }
    // Also worth knowing: is the STORED score already out of step with the current
    // weights? If so a card-metadata backfill is not what moved it.
    void before;
  }
  console.log('\n── knock-on: `hasFood` upgraded from perks, and what that does to the ranking');
  console.log(`   hasFood 'unknown' → 'yes' from perks   ${foodUpgrades}`);
  console.log(`   connectionScore would change            ${scoreMoved}  (total +${totalDelta})`);
  console.log(
    '   The default feed sort IS `connections`, so these rows move. A backfill that'
  );
  console.log('   writes perks and not the score leaves the feed ranked on stale numbers.');

  // Rows whose STORED score already disagrees with a fresh computation, so the
  // backfill's own report can be read honestly.
  const stale = derived.filter(({ row }) => {
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
  console.log(
    `   already stale BEFORE any of this        ${stale}  ← pre-existing drift, not caused here`
  );

  // ── Pattern-level over-match canaries ──────────────────────────────────────
  //
  // The phrases the tests refuse, run against the live corpus. A non-zero count here
  // means a real row matches something a test says must not match — i.e. the test and
  // the corpus disagree, which is worth knowing about immediately.
  console.log('\n── how much work each narrowing guard is doing (bare word present → value withheld)');
  /*
   * ── THIS SECTION WAS REDESIGNED TWICE AND BOTH MISTAKES ARE WORTH RECORDING ───────
   *
   * ATTEMPT 1 probed the exact phrases `tests/card-metadata.test.ts` pins as refusals —
   * "senior citizen", "security guard", "user research", "no recording", "certification
   * prep". All five returned 0 matching rows, so all five printed a clean 0 while
   * exercising nothing. Those unit tests guard against copy this corpus does not
   * currently contain, which is worth knowing and is NOT the same thing as a guard that
   * holds. The output now says "PROVED NOTHING" instead of 0 for that case.
   *
   * ATTEMPT 2 probed BARE words the patterns refuse — `data`, `senior`, `leadership` —
   * and asked how many rows "leaked" the value. That cannot work: the patterns ARE the
   * qualified forms, so a row only ever carries the value when qualified evidence was
   * present, and a leak is impossible BY CONSTRUCTION. A check that cannot fail is
   * exactly the thing CLAUDE.md's scorecard rule bars ("no dimension scores itself on a
   * proxy that cannot fail").
   *
   * So the question is inverted into one that has a real answer: of the rows containing
   * the bare word, how many did the guard WITHHOLD the value from? That number is the
   * guard's yield. A yield of 0 means the narrowing is costing complexity for nothing;
   * a yield close to the row count means the bare word would have been a disaster,
   * which is the `\bpm\b` → "6 PM" case stated as a measurement instead of a story.
   */
  const canaries: Array<[string, RegExp, string]> = [
    // Bare `certification`/`certified` names an exam, not a thing you are handed.
    ['certification / certified (bare)', /\bcertif(?:ication|ied)\b/i, 'certificate'],
    // Bare `leadership` is Toastmasters and business copy.
    ['leadership (bare)', /\bleadership\b/i, 'leaders'],
    // Bare `senior` is "senior citizen", "senior management", "senior school".
    ['senior (bare, unqualified)', /\bsenior\b/i, 'senior-engineers'],
    // Bare `data` is "data centre", "your data", "data privacy".
    ['data (bare)', /\bdata\b/i, 'data'],
    // Bare `recording` may be forbidden rather than promised.
    ['recording (bare)', /\brecord(?:ing|ed)\b/i, 'recording'],
    // Bare `security` is guards and job security.
    ['security (bare)', /\bsecurity\b/i, 'security'],
  ];
  for (const [label, probe, value] of canaries) {
    const rowsWith = derived.filter(d =>
      probe.test(`${d.row.title ?? ''} ${d.row.description ?? ''}`)
    );
    const carried = rowsWith.filter(
      d => d.meta.audience.includes(value) || d.meta.perks.includes(value)
    );
    const withheld = rowsWith.length - carried.length;
    // A ZERO MEANS TWO DIFFERENT THINGS AND THEY MUST NOT LOOK ALIKE.
    const verdict =
      rowsWith.length === 0
        ? 'PROVED NOTHING — word absent from the corpus'
        : withheld === 0
          ? 'guard yields NOTHING — consider dropping the narrowing'
          : `withheld from ${withheld}, allowed ${carried.length}`;
    console.log(`   "${label}" → "${value}": in ${String(rowsWith.length).padStart(4)} row(s); ${verdict}`);
  }

  await mongoose.disconnect();
}

main().catch(async e => {
  console.error(e);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
