/**
 * The filter behind "everyone I know", shared by the list, its count and its facet counts.
 *
 * THE THIRD INSTANCE OF ONE PATTERN, deliberately — `lib/events/query.ts`, `lib/contacts/query.ts`,
 * and this. Layer 0: no Mongoose, no I/O, so `tests/` pins it without a database. The reason it is
 * a shared function rather than three similar queries is that the rows a chip produces and the
 * count printed on that chip must come from ONE definition, or they drift and nobody notices until
 * a chip says 12 and shows 9.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT CHANGES BY LISTING `Person` INSTEAD OF `Contact`
 *
 * `buildContactFilter` answers "which CAPTURES match", which is the wrong question for recall: the
 * same human met three times is three rows with three notes and three follow-up dates. This answers
 * "which PEOPLE match", one row per human, with the encounters inside.
 *
 * Three things that were impossible on the Contact version become one predicate each, because the
 * `Person` row carries them:
 *
 *   · `repeatOnly`         was a two-stage aggregate → now `eventCount >= 2`
 *   · sort by last-contacted → now `lastInteractionAt`, a field that did not previously exist
 *   · sort by follow-up due  → now `nextActionAt`, ditto
 *
 * The two-stage version is worth remembering rather than just deleting: "have I met this person
 * before" is a property of a GROUP of contacts sharing a `contactKey`, so on `Contact` it could not
 * be a predicate at all. The first attempt post-filtered the page after the query, which produced a
 * two-row list under a heading that read "6 people" — `countDocuments` had already run against the
 * unfiltered filter — and broke pagination as well. Denormalising the counter onto `Person` is what
 * makes the count and "load more" simply correct, and `scripts/diag-people-spine.ts` re-checks the
 * counter against a live recount so the denormalisation stays honest.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 */

/** Everything the People page can narrow by. All optional; absent means "no constraint". */
export interface PersonQueryParams {
  /** Free text over the person's own fields. See `PERSON_SEARCH_FIELDS`. */
  q?: string;
  /** Canonical registry company name, from `Person.companies[]`. */
  company?: string;
  /** A user tag, from `Person.tags[]`. Already lowercase — see `canonicaliseTags`. */
  tag?: string;
  /** Only people at a company on the user's target list. */
  targetOnly?: boolean;
  /** Only people with a follow-up still outstanding. */
  followUpDue?: boolean;
  /** Only people met at two or more distinct events. ONE predicate — see `REPEAT_MIN_EVENTS`. */
  repeatOnly?: boolean;
  /**
   * Include merged tombstones.
   *
   * NOT parseable from a URL, on purpose — see `parsePersonQuery`. It exists for the merge UI and
   * for `diag-people-spine.ts`, both of which have to see both sides of a merge.
   */
  includeMerged?: boolean;
}

export type PersonSort = 'recent' | 'oldest' | 'name' | 'company' | 'followUp' | 'met';

/**
 * How many DISTINCT EVENTS make somebody a repeat.
 *
 * Exported and spelled once so the list, the facet count and the `met N x` badge cannot disagree
 * about whether two counts as a repeat. `lib/contacts/query.ts` learned this the hard way with
 * `repeatKeys()`, which exists for exactly the same reason.
 */
export const REPEAT_MIN_EVENTS = 2;

/**
 * The fields free text searches, in the order that reads as the ranking rationale even though Mongo
 * does not rank a regex: a person is looked up by who they are and where they work.
 *
 * `note` IS ABSENT, and that is a real recall cost worth stating rather than hiding. On `Contact`
 * the note is searched, because "the one from the Kafka talk" is often the only thing you remember.
 * A `Person` has no note field — notes live on the encounters and on the `Interaction` timeline, so
 * searching them from here would mean a `$lookup` and this module would stop being pure. The
 * federated-search route is the right place to add that; a second index on this collection is not.
 */
export const PERSON_SEARCH_FIELDS = ['displayName', 'company', 'role', 'headline'] as const;

/**
 * Escape a user string for use inside a regex.
 *
 * Load-bearing, not defensive. The search box feeds this directly, so an unescaped `(` from
 * somebody typing a company name like "Ola (Krutrim)" throws a SyntaxError inside the driver and
 * the request 500s — and a `.*` typed into a search box would otherwise scan the collection.
 */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build the Mongo filter for one user's people.
 *
 * `userId` is a REQUIRED first argument rather than a field on the params object, matching the other
 * two builders and for the same reason: an unscoped people query returns somebody else's private
 * notes and follow-up dates, and this repo has already served exactly that
 * (`generateDailyDigest` ran two unfiltered `TrackerEntry` queries and served the result
 * anonymously). A key can be forgotten by omission; a positional argument cannot.
 */
export function buildPersonFilter(
  userId: string,
  params: PersonQueryParams = {}
): Record<string, unknown> {
  const filter: Record<string, unknown> = { userId };

  /**
   * A MERGED PERSON IS NEVER LISTED. `mergedInto` is a soft tombstone so an old `/people/<id>` URL
   * still resolves after a merge — which means the loser row is still in the collection and still
   * matches every other arm of this filter. Forget this and the merge appears not to have worked:
   * one row per human is the entire point.
   *
   * `mergedInto: null` rather than `{ $exists: false }`, and the distinction is the one
   * `Event.spotlightAt` records for `$type: 'date'`. Equality-to-null in Mongo matches BOTH a
   * missing field and an explicitly-null one. Every Person written before any merge lacks the key
   * entirely, and an unmerge writes an explicit null — under `$exists: false` the unmerged person
   * would stay invisible, so the reversal would look like it did nothing.
   */
  if (!params.includeMerged) filter.mergedInto = null;

  // Exact match on a canonical registry name. Not a regex: `companies[]` holds values the resolver
  // produced, so there is nothing to normalise and a regex would let "Meta" match "Metabase".
  if (params.company) filter.companies = params.company;

  // Same, and tags are already lowercased on write by `canonicaliseTags()`, which is what makes an
  // exact match correct here rather than case-insensitive.
  if (params.tag) filter.tags = params.tag;

  if (params.targetOnly) filter.isTargetCompany = true;

  /**
   * ONE predicate where the Contact version needed two (`followUpAt != null` AND
   * `followedUp != true`). `recomputePerson()` sets `nextActionAt` to the SOONEST OUTSTANDING
   * follow-up across the person's encounters and to null when there is none, so the row already
   * answers "does this person still owe me an action".
   *
   * Deliberately NOT `nextActionAt <= now`. This page shows what is OUTSTANDING, and a follow-up
   * scheduled for Friday is outstanding on Wednesday. `getPendingFollowUps` keeps its own
   * overdue-vs-upcoming window for the dashboard and the digest, and those two silently disagreeing
   * is a bug this repo has already paid for once.
   */
  if (params.followUpDue) filter.nextActionAt = { $ne: null };

  /**
   * `repeatOnly` IS ONE PREDICATE NOW. On `Contact` this was a two-stage query and had to be; here
   * `eventCount` is denormalised, recomputed by `recomputePerson()`, and counts DISTINCT EVENTS —
   * not `met` interactions, and not folders, which is the bug `detectRepeatConnections` already
   * carries a scar from.
   */
  if (params.repeatOnly) filter.eventCount = { $gte: REPEAT_MIN_EVENTS };

  /**
   * SEARCH IS A REGEX, NOT `$text`, for the two reasons `lib/contacts/query.ts` gives and one more.
   * MongoDB permits exactly one text index per collection; `$text` matches whole words, so it
   * returns nothing for "razor" until the user finishes typing "razorpay", which is wrong for a box
   * that filters as you type; and the federated-search route fans out to this builder, so it must
   * behave identically whether it is called from the page or from search.
   */
  const q = params.q?.trim();
  if (q) {
    const rx = new RegExp(escapeRegex(q), 'i');
    filter.$or = PERSON_SEARCH_FIELDS.map(field => ({ [field]: rx }));
  }

  return filter;
}

/**
 * Mongo sort spec for each option the UI offers.
 *
 * `lastInteractionAt` is the default because "who have I gone quiet on" is the question this half of
 * the product exists to answer, and it is the one thing no competitor shows at any price. There is
 * deliberately no relationship-strength score to sort by: a fabricated warmth number is worse than
 * none, and these two dates answer the real question with facts.
 */
export function buildPersonSort(sort: PersonSort = 'recent'): Record<string, 1 | -1> {
  switch (sort) {
    case 'oldest':
      return { lastInteractionAt: 1 };
    case 'name':
      // The EFFECTIVE name — `derivePersonFields` has already applied any user override into
      // `displayName`, so sorting and searching agree with what is rendered.
      return { displayName: 1 };
    case 'company':
      // People with no company recorded cluster at the top under ascending order in Mongo (null
      // before strings). Acceptable, and the same trade `buildContactSort` makes: "who has no
      // employer recorded" is itself something the user wants to see and fix.
      return { company: 1, displayName: 1 };
    case 'followUp':
      /**
       * PAIR THIS WITH `followUpDue: true`. Ascending Mongo order puts nulls FIRST, so on its own
       * this sort leads with everybody who has no follow-up at all — the exact opposite of what the
       * label promises. Excluding the nulls is the filter's job, not the sort's; encoding it here
       * would mean a sort that silently changes the result set, which is worse.
       */
      return { nextActionAt: 1 };
    case 'met':
      // Most-met first, then most-recent, so the tie inside "met 2 x" is broken by who is warm.
      return { eventCount: -1, lastInteractionAt: -1 };
    case 'recent':
    default:
      // Matches `{ userId, lastInteractionAt: -1 }`, so the default listing is served by an index
      // rather than an in-memory sort — which is capped at 32 MB and fails hard, not slowly.
      return { lastInteractionAt: -1 };
  }
}

/**
 * Parse query params off a URL into a validated shape.
 *
 * Kept here rather than in the route so the list route, the facet route and the export route parse
 * identically — a facet count computed from a differently-parsed request is the exact drift this
 * module exists to prevent, and the export route has already diverged once by building its filter
 * from a different function than the page it claimed to mirror.
 */
export function parsePersonQuery(search: URLSearchParams): PersonQueryParams {
  const str = (key: string): string | undefined => {
    const raw = search.get(key);
    if (typeof raw !== 'string') return undefined;
    const trimmed = raw.trim();
    // A cap, because both feed a regex or an index probe and neither benefits from 5 KB of input.
    return trimmed ? trimmed.slice(0, 200) : undefined;
  };

  /**
   * `includeMerged` IS NOT PARSED, on purpose. It is not a reader-facing option — showing tombstones
   * would render the same human twice, which is precisely what merging fixed — and accepting it from
   * a URL would let an old bookmark or a shared link silently undo that. Same reasoning as stripping
   * `?techOnly=false` from the feed rather than merely ignoring it. Server callers that genuinely
   * need both sides pass the flag in code.
   */
  return {
    q: str('q'),
    company: str('company'),
    // Lowercased to match how tags are stored. Without this, a tag chip built from a URL somebody
    // shared with different casing would match nothing and read as an empty facet.
    tag: str('tag')?.toLowerCase(),
    targetOnly: search.get('targetOnly') === 'true',
    followUpDue: search.get('followUpDue') === 'true',
    repeatOnly: search.get('repeatOnly') === 'true',
  };
}
