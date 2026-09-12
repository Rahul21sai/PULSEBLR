#!/usr/bin/env tsx
/**
 * Which topic landing pages are thin — and therefore prerendered as a 404?
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * `/topics/[slug]`'s `generateStaticParams` is deliberately pure: it returns EVERY candidate slug
 * without touching the database, so a build never depends on Atlas to decide which pages exist. The
 * ≥ `MIN_TOPIC_EVENTS` floor is then applied at render, which means a slug below it is prerendered
 * as a 404 and becomes a real page on a later revalidation when supply arrives. That is the correct
 * behaviour for a set that changes daily, and it is not a bug.
 *
 * WHAT NOBODY CAN CURRENTLY SEE IS HOW MANY, AND WHICH. Every one of those slugs is a URL in the
 * sitemap's sibling set, a link a reader may follow from outside the app, and a dead end when they
 * do. The design spec's verification list asks for exactly this script: "a new
 * `diag-landing-pages.ts` reporting any generated topic page below the 3-event floor."
 *
 * A THIN SLUG IS INFORMATION, NOT A FAILURE, and this script exits zero for one. The floor working
 * as designed is not a defect — reporting it as one would make a diagnostic that cries wolf, and
 * this repo has already had a canary switched off for exactly that (`diag-api-auth.ts`'s email
 * pattern matched a font URL and reported all seven pages as leaking). The only things that exit
 * non-zero here are structural contradictions: a prerendered param the taxonomy cannot resolve, or a
 * disagreement between the floor as this script reads it and the floor `publishedTopics()` applies.
 *
 * IT RANKS RATHER THAN COUNTING, which is the most repeated lesson in this repo's CLAUDE.md: a
 * count is not a ranking and an aggregate hides the thing you needed to see. "28 candidates, 23
 * published" says nothing actionable. A slug sitting at 2 events is one scrape from being a real
 * page and worth a seed or a keyword; a slug at 0 is a taxonomy entry with no supply at all and may
 * never be a page, which is a different decision entirely — for `hardware-robotics` it is a
 * SETTLED supply fact this codebase has already probed five classes of source for, not something to
 * fix.
 *
 * EVERY DEFINITION IS IMPORTED, NONE REIMPLEMENTED. `MIN_TOPIC_EVENTS`, `countTopicEvents()` and
 * `publishedTopics()` from `lib/events/topic-counts.ts`; `topicStaticParams()` and `findTopic()`
 * from `lib/events/topics.ts` — the same modules the page and the sitemap use. A diagnostic that
 * mirrors the predicate it checks eventually checks the mirror: `diag-flagship-events.ts`
 * hand-rolled "in feed = upcoming AND isTechEvent" and consequently reported a `visibility:
 * 'pending'` row as being in a feed no reader can see.
 *
 * Read-only. No writes. Two aggregations (one per shared function), and the second one earns its
 * keep by cross-checking the first.
 *
 * Run: npx tsx scripts/diag-landing-pages.ts
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */
import './load-env';
import mongoose from 'mongoose';

import connectDB from '../lib/mongodb';
import { countTopicEvents, publishedTopics } from '../lib/events/topic-counts';
import { MIN_TOPIC_EVENTS, findTopic, topicStaticParams, type Topic } from '../lib/events/topics';

let failures = 0;

function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
}

const cut = (s: unknown, n: number): string => String(s ?? '—').slice(0, n).padEnd(n);

/**
 * What a slug one event short of the floor is worth doing about, versus one with nothing at all.
 *
 * This is the whole reason the report ranks. The two ends of the thin list call for opposite
 * responses and an aggregate count collapses them into one number.
 */
function prospect(count: number): string {
  if (count === MIN_TOPIC_EVENTS - 1) return 'ONE event from publishing';
  if (count > 0) return `${MIN_TOPIC_EVENTS - count} events from publishing`;
  return 'no supply at all — may never publish';
}

async function main() {
  console.log('');
  console.log('/topics/[slug] — the floor, and what it is refusing to publish');
  console.log('='.repeat(100));
  console.log('');

  await connectDB();

  const params = topicStaticParams();
  const counts = await countTopicEvents();
  const published = await publishedTopics();
  const publishedSlugs = new Set(published.map(p => p.topic.slug));

  /*
   * The candidate set is `topicStaticParams()` — what the build actually prerenders — resolved back
   * through `findTopic`, which is the function the page itself uses to turn a slug into a topic or a
   * 404. Iterating `TOPICS` directly would be one step further from what ships.
   */
  const candidates: Array<{ slug: string; topic: Topic | null; count: number }> = params.map(
    ({ slug }) => ({ slug, topic: findTopic(slug), count: counts.get(slug) ?? 0 })
  );

  const resolved = candidates.filter(
    (c): c is { slug: string; topic: Topic; count: number } => c.topic !== null
  );
  const thin = resolved.filter(c => c.count < MIN_TOPIC_EVENTS).sort((a, b) => b.count - a.count);
  const renders = resolved.filter(c => c.count >= MIN_TOPIC_EVENTS).sort((a, b) => b.count - a.count);

  console.log(`  MIN_TOPIC_EVENTS = ${MIN_TOPIC_EVENTS}   (imported, not retyped)`);
  console.log(`  prerendered params: ${params.length}   |   published: ${publishedSlugs.size}`
    + `   |   prerendered as a 404: ${thin.length}`);
  console.log('');
  console.log('  Corpus behind every count: buildEventFilter({ techOnly: true, includeOngoing: true },');
  console.log('  null) — upcoming, tech-only, and the ANONYMOUS viewer, so no private or pending row');
  console.log('  is counted. Category counts count an event once per category it carries.');
  console.log('');

  /* ── 1. Every candidate, ranked ─────────────────────────────────────────────────────────── */

  console.log('1. Every prerendered slug, ranked by supply');
  console.log('');
  console.log(`  ${'events'.padStart(6)}  ${'kind'.padEnd(8)} ${cut('slug', 24)} ${cut('topic', 22)} verdict`);
  console.log(`  ${'─'.repeat(6)}  ${'─'.repeat(8)} ${'─'.repeat(24)} ${'─'.repeat(22)} ${'─'.repeat(38)}`);
  for (const row of [...renders, ...thin]) {
    const ok = row.count >= MIN_TOPIC_EVENTS;
    console.log(
      `  ${String(row.count).padStart(6)}  ${cut(row.topic.kind, 8)} ${cut(row.slug, 24)} `
      + `${cut(row.topic.name, 22)} ${ok ? 'renders' : `404  ← ${prospect(row.count)}`}`
    );
  }
  console.log('');

  /* ── 2. The thin ones, which is what the spec asked for ─────────────────────────────────── */

  console.log(`2. Below the floor — ${thin.length} slug(s) prerendered as a 404, closest first`);
  console.log('');
  if (thin.length === 0) {
    console.log('  None. Every candidate slug clears the floor, so every prerendered param is a real');
    console.log('  page. Note this is the state to expect to CHANGE: supply moves daily and an area or');
    console.log('  category can drop below three between two scrapes.');
  } else {
    for (const row of thin) {
      console.log(`  /topics/${row.slug}`);
      console.log(`      ${row.count} upcoming · ${row.topic.kind} "${row.topic.name}" · ${prospect(row.count)}`);
      console.log(`      ${row.topic.heading}`);
    }
    console.log('');
    console.log('  Read the top of this list and the bottom as different problems. A slug one event');
    console.log('  short is a supply question a seed or a discovery keyword can answer this week; a');
    console.log('  slug at zero is a taxonomy entry with no supply at all, and may never be a page.');
    const empty = thin.filter(r => r.count === 0);
    if (empty.length > 0) {
      console.log('');
      console.log(`  At zero right now: ${empty.map(r => `${r.slug} (${r.topic.kind} "${r.topic.name}")`).join(', ')}.`);
      console.log('  Before treating one as a supply gap, check whether it is a CLASSIFICATION question');
      console.log('  instead: Gaming/XR is the one tech category whose everyday sense is a leisure');
      console.log('  activity, and it was deliberately re-decided down to near-nothing because the');
      console.log('  classifier had been using it as the bin for anything it was unsure about — of 7');
      console.log('  events once carrying it, zero were games engineering. Zero there is the cleanup');
      console.log('  holding, not a missing source. Hardware/Robotics is the opposite case and a');
      console.log('  SETTLED one: five classes of source were probed and none publishes machine-');
      console.log('  readable Bengaluru hardware events, so do not re-probe it if it drops below.');
    }
  }
  console.log('');

  /* ── 3. Totals, split by the dimension that behaves differently ─────────────────────────── */

  console.log('3. Totals');
  console.log('');
  const byKind = (kind: Topic['kind']) => {
    const all = resolved.filter(r => r.topic.kind === kind);
    return { all: all.length, thin: all.filter(r => r.count < MIN_TOPIC_EVENTS).length };
  };
  const cats = byKind('category');
  const areas = byKind('area');
  console.log(`  categories   ${String(cats.all - cats.thin).padStart(3)} render, `
    + `${String(cats.thin).padStart(3)} 404   of ${cats.all}`);
  console.log(`  areas        ${String(areas.all - areas.thin).padStart(3)} render, `
    + `${String(areas.thin).padStart(3)} 404   of ${areas.all}`);
  console.log(`  ────────────────────────────────────────────`);
  console.log(`  all          ${String(renders.length).padStart(3)} render, `
    + `${String(thin.length).padStart(3)} 404   of ${resolved.length}`);
  console.log('');
  // The two kinds are worth splitting because they fail for different reasons. A thin CATEGORY is a
  // classification or supply question about the whole city; a thin AREA is usually just resolution —
  // `Other` sits on a large share of the corpus, and area resolution measured 63.7% against a 77%
  // ceiling, so an area at zero may have events that simply were not placed.
  const bands = [0, 1, MIN_TOPIC_EVENTS - 1];
  for (const n of bands) {
    const at = thin.filter(r => r.count === n);
    if (at.length === 0) continue;
    console.log(`  at ${n} event${n === 1 ? ' ' : 's'}: ${at.length}   ${at.map(r => r.slug).join(', ')}`);
  }
  if (thin.length > 0) console.log('');

  /* ── 4. Structural cross-checks — the only things here that can fail ────────────────────── */

  console.log('4. Cross-checks (these, and only these, can fail)');
  console.log('');
  const unresolvable = candidates.filter(c => !c.topic).map(c => c.slug);
  check(
    'every prerendered param resolves through findTopic()',
    unresolvable.length === 0,
    unresolvable.length > 0
      ? `${unresolvable.join(', ')} — the build would prerender a slug the page 404s on taxonomy alone`
      : `${params.length} params`
  );

  /*
   * The floor as this script reads it must agree with the floor `publishedTopics()` applies. Both
   * derive from `countTopicEvents()`, so a disagreement is either a real inconsistency or the corpus
   * moving between the two aggregations — the two calls are not one snapshot, and a scrape writing
   * events between them is normal here. Reported either way, with the caveat, because a silent
   * mismatch is the thing worth catching.
   */
  const shouldPublish = new Set(resolved.filter(r => r.count >= MIN_TOPIC_EVENTS).map(r => r.slug));
  const onlyMine = [...shouldPublish].filter(s => !publishedSlugs.has(s));
  const onlyTheirs = [...publishedSlugs].filter(s => !shouldPublish.has(s));
  check(
    'countTopicEvents() + MIN_TOPIC_EVENTS agrees with publishedTopics()',
    onlyMine.length === 0 && onlyTheirs.length === 0,
    onlyMine.length === 0 && onlyTheirs.length === 0
      ? `${publishedSlugs.size} slugs, both ways`
      : `mine-only [${onlyMine.join(', ')}] theirs-only [${onlyTheirs.join(', ')}] — `
        + 'two aggregations at two instants, so a concurrent scrape can cause this'
  );

  check(
    'publishedTopics() returns no slug below the floor',
    published.every(p => p.count >= MIN_TOPIC_EVENTS),
    published.filter(p => p.count < MIN_TOPIC_EVENTS).map(p => `${p.topic.slug}=${p.count}`).join(', ')
  );

  // `counts` must cover every candidate. `countTopicEvents()` seeds its map from TOPICS with zeroes,
  // so a missing key would mean the two modules have diverged about what a topic is — and it would
  // present as a slug silently reported at 0 rather than as an error.
  const uncounted = candidates.filter(c => !counts.has(c.slug)).map(c => c.slug);
  check(
    'countTopicEvents() has an entry for every candidate slug',
    uncounted.length === 0,
    uncounted.length > 0
      ? `${uncounted.join(', ')} — reported as 0 above, but that is a missing key, not a measurement`
      : `${counts.size} slugs counted`
  );
  console.log('');

  /* ── verdict ────────────────────────────────────────────────────────────────────────────── */

  console.log('='.repeat(100));
  if (failures > 0) {
    console.log(`${failures} structural check(s) failed — see section 4. These are contradictions`);
    console.log('between the shared definitions, not supply facts.');
  } else {
    console.log(`OK — ${renders.length} of ${resolved.length} topic pages render; ${thin.length} `
      + `${thin.length === 1 ? 'is' : 'are'} prerendered as a 404 by the`);
    console.log(`${MIN_TOPIC_EVENTS}-event floor. That is the floor working, so this exits zero: a thin`);
    console.log('page is a supply report, not a defect. Section 2 is the list to act on, top first.');
  }
  console.log('');

  await mongoose.disconnect();
  if (failures > 0) process.exitCode = 1;
}

main().catch(async e => {
  console.error(e);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
