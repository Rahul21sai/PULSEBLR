#!/usr/bin/env tsx
/**
 * Does `app/sitemap.ts` leak anything?
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The design spec's verification list asks for exactly this: "`app/sitemap.ts` contains no `/c/`,
 * `/f/`, `/admin`, or non-public event URL — assert with a script." A sitemap is the one file in
 * the app whose entire purpose is to hand URLs to Google, so a mistake here is not an in-app
 * disclosure that a later fix can claw back — it is a permanent, indexed, cached one. `/c/<token>`
 * is somebody's contact card and `/f/<token>` is somebody's folder intake form; both are addressed
 * by a token whose only protection is that it was never published.
 *
 * IT IMPORTS THE REAL `sitemap()` AND ASSERTS OVER WHAT IT RETURNS. Not a fetch of
 * `/sitemap.xml` (which needs a server, and a cached route at that — `revalidate = 3600`, so a
 * fetch can answer from an hour-old generation and prove nothing about the current corpus), and
 * emphatically not a reimplementation of its query. A diagnostic that mirrors the predicate it
 * checks eventually checks the mirror: `scripts/diag-flagship-events.ts` hand-rolled "in feed =
 * upcoming AND isTechEvent" and consequently reported a `visibility: 'pending'` row as being in a
 * feed no reader can see. Every predicate here is imported — `canViewEvent`, `notDeletedClause`,
 * `PROTECTED_PATHS` via `robots()`, `findTopic`.
 *
 * THE PROTECTED-PAGE CHECK IS DERIVED, NOT TYPED OUT. `app/robots.ts` already builds its disallow
 * list from `PROTECTED_PATHS` plus `/api/`, `/login`, `/c/` and `/f/`, precisely so the two cannot
 * drift. So the strongest available formulation of "no signed-in page" is: NO SITEMAP URL MAY BE ONE
 * THIS APP'S OWN robots.txt FORBIDS A CRAWLER FROM FETCHING. That is a self-contradiction check, it
 * covers every entry on that list at once, and a protected route added tomorrow is covered without
 * editing this file.
 *
 * THE EVENT CHECK RUNS IN BOTH DIRECTIONS, and only one of them has teeth.
 *
 *   FORWARD — for every `/events/<id>` in the output, look the document up and assert
 *   `canViewEvent(doc, null)`. The projection must carry `visibility`, `createdByUserId` AND
 *   `deletedAt`, because every check in that function treats a field it was not given as the
 *   PERMISSIVE case: an incomplete `.select()` does not throw and does not deny, it silently
 *   returns true for everything. `POST /api/folders` shipped that exact bug.
 *
 *   REVERSE — independently query every row an anonymous visitor may NOT see and assert none of
 *   their ids appears in the sitemap. This is the direction that cannot be defeated by a bad
 *   projection, because it never consults one. It is also the direction that reports its own
 *   teeth: if the corpus holds no private, pending or soft-deleted rows at all, the forward check
 *   passed against no adversary and this says so rather than calling it a win. `diag-event-
 *   visibility.ts` makes the same argument — "a guard that returns nothing passes every leak test".
 *
 * A DATABASE FAILURE IS REPORTED AS INCONCLUSIVE, NOT AS CLEAN. `sitemap()` deliberately degrades
 * to its five static entries when Atlas is unreachable ("a short sitemap costs a day of crawl
 * freshness; a failed build costs the release"). That is right for the route and fatal for a
 * verifier: every assertion here would pass over five hardcoded URLs. Zero event entries therefore
 * exits non-zero, labelled INCONCLUSIVE so nobody reads it as a leak.
 *
 * Read-only. No writes, no network beyond the database read `sitemap()` performs itself.
 *
 * Run: npx tsx scripts/diag-sitemap.ts
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */
import './load-env';
import mongoose from 'mongoose';

import sitemap from '../app/sitemap';
import robots from '../app/robots';
import Event from '../lib/models/Event';
import connectDB from '../lib/mongodb';
import { canViewEvent, type ViewableEvent } from '../lib/events/visibility';
import { notDeletedClause } from '../lib/events/query';
import { PROTECTED_PATHS } from '../lib/protected-routes';
import { findTopic } from '../lib/events/topics';
import { canonicalOrigin } from '../lib/canonical-origin';

let failures = 0;
let leaks = 0;

function check(label: string, ok: boolean, detail = ''): boolean {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  return ok;
}

const cut = (s: unknown, n: number): string => String(s ?? '—').slice(0, n).padEnd(n);
const ist = (d?: Date | string | null): string =>
  d ? new Date(new Date(d).getTime() + 5.5 * 3600_000).toISOString().slice(0, 10) : '??????????';

/**
 * The prefixes this app's own robots.txt forbids a crawler from fetching.
 *
 * Read out of `robots()` rather than retyped, so `/c/`, `/f/`, `/login`, `/api/` and every entry of
 * `PROTECTED_PATHS` arrive here by derivation. `rules` is typed as one rule or an array of them and
 * each `disallow` as a string or an array, so both are normalised.
 */
function disallowedPrefixes(): string[] {
  const { rules } = robots();
  const list = Array.isArray(rules) ? rules : [rules];
  const out: string[] = [];
  for (const rule of list) {
    const disallow = rule?.disallow;
    if (!disallow) continue;
    for (const prefix of Array.isArray(disallow) ? disallow : [disallow]) {
      // A bare '/' would mark every URL disallowed. robots.txt resolves that against the longer
      // `allow: '/'` rather than blanket-refusing the site, so honouring it here would only make
      // this script cry wolf. Skipped deliberately; nothing else is filtered.
      if (prefix === '/' || prefix === '') continue;
      out.push(prefix);
    }
  }
  return out;
}

/** robots.txt Disallow semantics: a path is refused when it begins with the prefix. */
function matchedPrefix(pathname: string, prefixes: string[]): string | null {
  return prefixes.find(p => pathname.startsWith(p)) ?? null;
}

interface Row {
  _id: mongoose.Types.ObjectId;
  title?: string;
  source?: string;
  sourceEventId?: string;
  startDateTime?: Date;
  visibility?: 'private' | 'pending' | 'public';
  createdByUserId?: string;
  deletedAt?: Date;
}

/**
 * Exactly the fields `canViewEvent` reads, plus enough to name a row in a report.
 *
 * Printed in the output on purpose. The failure mode this projection guards against is invisible —
 * a missing field makes the guard return true for everything rather than throwing — so the only
 * defence a reader has is being able to see the field list next to the result.
 */
const VIEW_FIELDS = 'title source sourceEventId startDateTime visibility createdByUserId deletedAt';

async function main() {
  console.log('');
  console.log('app/sitemap.ts — leak assertions');
  console.log('='.repeat(96));
  console.log('');

  // The route calls `connectDB()` itself; this is here so a connection failure is reported as one
  // rather than surfacing as an empty sitemap that looks like a clean pass.
  await connectDB();

  const entries = await sitemap();
  const origin = canonicalOrigin();

  const paths: string[] = [];
  const malformed: string[] = [];
  const foreignOrigin: string[] = [];

  for (const entry of entries) {
    let parsed: URL;
    try {
      parsed = new URL(entry.url);
    } catch {
      malformed.push(entry.url);
      continue;
    }
    if (`${parsed.protocol}//${parsed.host}` !== origin) foreignOrigin.push(entry.url);
    paths.push(parsed.pathname);
  }

  const eventPaths = paths.filter(p => p.startsWith('/events/'));
  const topicPaths = paths.filter(p => p.startsWith('/topics/'));
  const otherPaths = paths.filter(p => !p.startsWith('/events/') && !p.startsWith('/topics/'));

  console.log(`  entries ${entries.length}   |   events ${eventPaths.length}   `
    + `|   topics ${topicPaths.length}   |   static/other ${otherPaths.length}`);
  console.log(`  canonical origin  ${origin}`);
  console.log('');
  console.log('  static/other URLs, in full — this set is small enough to read rather than assert about:');
  for (const p of otherPaths) console.log(`    ${p}`);
  console.log('');

  /* ── 0. Is this run capable of proving anything at all? ─────────────────────────────────── */

  console.log('0. Is the run conclusive?');
  console.log('');
  const conclusive = check(
    'sitemap() reached the database (event entries present)',
    eventPaths.length > 0,
    eventPaths.length > 0
      ? `${eventPaths.length} event URLs`
      : 'INCONCLUSIVE — sitemap() caught a database error and fell back to static entries only, '
        + 'so every assertion below would pass over 5 hardcoded URLs. This is NOT a clean result'
  );
  console.log('');

  /* ── 1. /c/<token> and /f/<token> ───────────────────────────────────────────────────────── */

  console.log('1. Token-addressed public pages — somebody\'s card, somebody\'s intake form');
  console.log('');
  // Named explicitly as well as covered by the derived check in section 2, because these are the
  // two entries in robots.ts that are NOT protected paths — no gate will ever exclude them, so the
  // only thing keeping them out of the sitemap is that nothing generates them.
  const cardLike = paths.filter(p => p === '/c' || p.startsWith('/c/'));
  const intakeLike = paths.filter(p => p === '/f' || p.startsWith('/f/'));
  check('no /c/<token> contact-card URL', cardLike.length === 0, cardLike.join(', '));
  check('no /f/<token> folder-intake URL', intakeLike.length === 0, intakeLike.join(', '));
  // The prefix trap `lib/protected-routes.ts` documents, asserted from the other side: /calendar
  // and /card must not be mistaken for /c/, and /folders must not be mistaken for /f/.
  check(
    'the /c/ and /f/ tests did not misfire on /calendar, /card or /folders',
    !cardLike.includes('/calendar') && !cardLike.includes('/card') && !intakeLike.includes('/folders')
  );
  console.log('');

  /* ── 2. Anything this app's own robots.txt disallows ────────────────────────────────────── */

  console.log('2. Self-contradiction — a submitted URL that robots.txt forbids fetching');
  console.log('');
  const prefixes = disallowedPrefixes();
  console.log(`  disallow list, derived from app/robots.ts (${prefixes.length} prefixes):`);
  console.log(`    ${prefixes.join('  ')}`);
  console.log(`  of which ${PROTECTED_PATHS.length} come from PROTECTED_PATHS, so a new protected page`);
  console.log('  is covered here without editing this script.');
  console.log('');
  const contradictions = paths
    .map(p => ({ path: p, prefix: matchedPrefix(p, prefixes) }))
    .filter((r): r is { path: string; prefix: string } => r.prefix !== null);
  check(
    'no sitemap URL matches a robots.txt Disallow prefix',
    contradictions.length === 0,
    contradictions.map(c => `${c.path} (matches ${c.prefix})`).join(', ')
  );
  check(
    '/admin specifically is absent',
    !paths.some(p => p === '/admin' || p.startsWith('/admin')),
    paths.filter(p => p.startsWith('/admin')).join(', ')
  );
  console.log('');

  /* ── 3. Structural hygiene ──────────────────────────────────────────────────────────────── */

  console.log('3. Structural hygiene');
  console.log('');
  check('every URL parses as an absolute URL', malformed.length === 0, malformed.join(', '));
  check(
    'every URL is on the canonical origin',
    foreignOrigin.length === 0,
    foreignOrigin.slice(0, 5).join(', ')
  );
  const dupes = [...new Set(paths.filter((p, i) => paths.indexOf(p) !== i))];
  check('no duplicate URL', dupes.length === 0, dupes.slice(0, 8).join(', '));
  // A topic slug the taxonomy does not resolve would be a submitted 404. The EVENT floor for these
  // pages is `diag-landing-pages.ts`'s job; this is only the "does the slug exist" half, which is
  // pure and free.
  const unknownTopics = topicPaths.filter(p => !findTopic(p.slice('/topics/'.length)));
  check(
    'every /topics/<slug> resolves in the taxonomy',
    unknownTopics.length === 0,
    unknownTopics.join(', ')
  );
  console.log('');

  /* ── 4. FORWARD: every event URL is visible to an anonymous viewer ──────────────────────── */

  console.log('4. FORWARD — canViewEvent(doc, null) for every /events/<id> in the output');
  console.log('');
  console.log(`  projection: ${VIEW_FIELDS}`);
  console.log('  canViewEvent reads visibility, createdByUserId and deletedAt, and treats a field it');
  console.log('  was not given as PERMISSIVE — so an incomplete projection here would silently return');
  console.log('  true for everything rather than failing. All three are carried above.');
  console.log('');

  const rawIds = eventPaths.map(p => p.slice('/events/'.length));
  const badIds = rawIds.filter(id => !mongoose.Types.ObjectId.isValid(id));
  check('every event URL carries a valid ObjectId', badIds.length === 0, badIds.slice(0, 5).join(', '));

  const validIds = rawIds.filter(id => mongoose.Types.ObjectId.isValid(id));
  const docs = (await Event.find({ _id: { $in: validIds } })
    .select(VIEW_FIELDS)
    .lean()) as unknown as Row[];
  const byId = new Map(docs.map(d => [String(d._id), d]));

  const missing = validIds.filter(id => !byId.has(id));
  const hidden = validIds
    .map(id => byId.get(id))
    .filter((d): d is Row => Boolean(d))
    .filter(d => !canViewEvent(d as ViewableEvent, null));
  const deleted = docs.filter(d => d.deletedAt);

  if (!check(
    'every sitemap event is visible to the anonymous viewer',
    hidden.length === 0,
    hidden.length > 0 ? `${hidden.length} LEAKED` : `${byId.size} checked`
  )) leaks += hidden.length;
  for (const row of hidden) {
    console.log(
      `        LEAK  ${String(row._id)}  visibility=${cut(row.visibility, 8)} `
      + `owner=${row.createdByUserId ? 'set' : 'absent '} deleted=${row.deletedAt ? 'YES' : 'no '} `
      + `${ist(row.startDateTime)}  ${cut(row.title, 56)}`
    );
  }

  if (!check(
    'no soft-deleted event in the sitemap',
    deleted.length === 0,
    deleted.length > 0
      ? `${deleted.length} present — notDeletedClause() is ${JSON.stringify(notDeletedClause())}`
      : `notDeletedClause() = ${JSON.stringify(notDeletedClause())}`
  )) leaks += deleted.length;

  // A submitted URL whose document is gone is a guaranteed 404 in Search Console, and worth
  // reporting — but it is not a disclosure, and `pruneStale()` deletes events during a scrape, so a
  // concurrent run can produce one legitimately. Reported, not failed.
  if (missing.length > 0) {
    console.log(`  NOTE  ${missing.length} sitemap event id(s) resolve to no document.`);
    console.log('        Not a leak and not counted as a failure: pruneStale() removes events during');
    console.log('        a scrape, so a run concurrent with one can produce this. It would be a real');
    console.log('        defect if it persisted with no scrape running.');
    for (const id of missing.slice(0, 8)) console.log(`          ${id}`);
  }
  console.log('');

  /* ── 5. REVERSE: no hidden row's id appears in the sitemap ──────────────────────────────── */

  console.log('5. REVERSE — every row an anonymous viewer may NOT see, checked against the output');
  console.log('');
  console.log('  Queried independently of the projection above, so a bad `.select()` cannot hide a');
  console.log('  leak from this direction. It also reports its own teeth: with no hidden rows in the');
  console.log('  corpus, section 4 passed against no adversary at all.');
  console.log('');

  const hiddenRows = (await Event.find({
    $or: [
      { visibility: { $in: ['private', 'pending'] } },
      // `$ne: null` is the complement of `notDeletedClause()`'s `{ deletedAt: null }`, which matches
      // a null field AND an absent one — so this is exactly "soft-deleted", nothing else.
      { deletedAt: { $ne: null } },
    ],
  })
    .select(VIEW_FIELDS)
    .lean()) as unknown as Row[];

  const sitemapIds = new Set(validIds);
  const buckets = {
    private: hiddenRows.filter(r => r.visibility === 'private').length,
    pending: hiddenRows.filter(r => r.visibility === 'pending').length,
    deleted: hiddenRows.filter(r => r.deletedAt).length,
  };
  const pendingUnowned = hiddenRows.filter(r => r.visibility === 'pending' && !r.createdByUserId);

  console.log(`  hidden rows in the corpus: ${hiddenRows.length}`
    + `   (private ${buckets.private}, pending ${buckets.pending}, soft-deleted ${buckets.deleted})`);
  console.log(`  of the pending rows, ${pendingUnowned.length} `
    + `${pendingUnowned.length === 1 ? 'is' : 'are'} UNOWNED (createdByUserId absent).`);
  console.log('  That is the interesting case: several queries here scope themselves to "scraped');
  console.log('  only" with `createdByUserId: { $exists: false }`, which an unowned pending row');
  console.log('  satisfies — so it is the row most likely to slip through a filter that looks right.');
  console.log('');

  const escaped = hiddenRows.filter(r => sitemapIds.has(String(r._id)));
  if (!check(
    'no hidden row appears in the sitemap',
    escaped.length === 0,
    escaped.length > 0
      ? `${escaped.length} LEAKED`
      : `${hiddenRows.length} hidden row${hiddenRows.length === 1 ? '' : 's'} checked`
  )) leaks += escaped.length;
  for (const row of escaped) {
    console.log(
      `        LEAK  ${String(row._id)}  visibility=${cut(row.visibility, 8)} `
      + `owner=${row.createdByUserId ? 'set' : 'absent '} deleted=${row.deletedAt ? 'YES' : 'no '} `
      + `${ist(row.startDateTime)}  ${cut(row.title, 56)}`
    );
  }

  if (hiddenRows.length === 0) {
    console.log('  NOTE  the corpus holds NO private, pending or soft-deleted event right now, so the');
    console.log('        non-public assertions above are vacuously true. Not a failure — but not');
    console.log('        evidence either. Re-run when a submission or a soft delete exists.');
  } else {
    console.log('  the hidden rows this run had to exclude, all of which are correctly absent above:');
    for (const row of hiddenRows.slice(0, 20)) {
      console.log(
        `    ${cut(row.visibility ?? (row.deletedAt ? 'deleted' : '?'), 8)} `
        + `owner=${row.createdByUserId ? 'set    ' : 'absent '} ${ist(row.startDateTime)}  `
        + `${cut(row.source, 12)} ${cut(row.sourceEventId, 30)} ${cut(row.title, 48)}`
      );
    }
    if (hiddenRows.length > 20) console.log(`    … and ${hiddenRows.length - 20} more`);
  }
  console.log('');

  /* ── verdict ────────────────────────────────────────────────────────────────────────────── */

  console.log('='.repeat(96));
  if (leaks > 0) {
    console.log(`LEAK — ${leaks} non-public or disallowed URL(s) in the sitemap. Named above.`);
    console.log('A sitemap entry is handed to a crawler and cached, so this is a live disclosure');
    console.log('rather than an in-app one. Fix app/sitemap.ts, do not widen this script.');
  } else if (!conclusive) {
    console.log('INCONCLUSIVE — sitemap() could not reach the database, so nothing was proven.');
    console.log('This is NOT a clean result. Exiting non-zero so it cannot be read as one.');
  } else if (failures > 0) {
    console.log(`${failures} assertion(s) failed. See above — these are structural rather than leaks.`);
  } else {
    console.log(`CLEAN — ${entries.length} URLs, ${eventPaths.length} of them events, and every one is`);
    console.log('reachable by a signed-out visitor. No /c/, no /f/, no /admin, no protected page, no');
    console.log(`private, pending or soft-deleted event. ${hiddenRows.length} hidden `
      + `row${hiddenRows.length === 1 ? ' was' : 's were'} in the corpus at the time of the run`);
    console.log('and none of them reached the output.');
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
