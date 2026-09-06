/**
 * The filter behind "everyone you have met", shared by the list and its facet counts.
 *
 * ONE BUILDER, TWO CONSUMERS — the same arrangement `lib/events/query.ts` has with
 * `/api/events` and `/api/events/facets`, and for the same reason: the counts beside a filter chip
 * and the rows the chip produces must be computed from one definition, or they drift and the UI
 * becomes untrustworthy in a way nobody notices until a chip says 12 and shows 9.
 *
 * Every filter is applied SERVER-SIDE. The obvious shortcut — serve the contacts and filter in the
 * browser — carries a ceiling that cannot be raised later: `GET /api/contacts` caps at 2000 rows,
 * so the 2001st person is silently invisible and "who do I know at Razorpay" becomes a question
 * about a recent slice rather than about everyone. Worse, the facet counts would be computed from
 * that same truncated page, so they would be confidently wrong rather than merely partial.
 *
 * Pure: no Mongoose, no I/O. It builds a filter object, so `tests/` can pin it without a database.
 */

/** Everything the People page can narrow by. All optional; absent means "no constraint". */
export interface ContactQueryParams {
  /** Free text over name, company, role, headline and note. */
  q?: string;
  /** Canonical registry company name, from `Contact.companies[]`. */
  company?: string;
  /** A user tag, from `Contact.tags[]`. Already lowercase — see `canonicaliseTags`. */
  tag?: string;
  /** One folder, i.e. one event. */
  folderId?: string;
  /** Only people at a company on the user's target list. */
  targetOnly?: boolean;
  /** Only people with a follow-up still outstanding. */
  followUpDue?: boolean;
  /** Only people met more than once. Applied AFTER the query — see `repeat` note below. */
  repeatOnly?: boolean;
}

export type ContactSort = 'recent' | 'oldest' | 'name' | 'company';

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
 * The fields free text searches, and the order is the ranking rationale even though Mongo does not
 * rank a regex: a person is looked up by who they are and where they work, and `note` is included
 * because "how we met" is often the only thing you remember ("the one from the Kafka talk").
 */
const SEARCH_FIELDS = ['name', 'company', 'role', 'headline', 'note'] as const;

/**
 * Build the Mongo filter for one user's contacts.
 *
 * `userId` is a REQUIRED first argument rather than a field on the params object, deliberately: an
 * unscoped contacts query returns other people's private notes, and the digest already had exactly
 * that bug (`generateDailyDigest` ran two `TrackerEntry` queries with no user filter and served the
 * result anonymously). Making it positional and non-optional means a caller cannot forget it by
 * omitting a key.
 */
export function buildContactFilter(
  userId: string,
  params: ContactQueryParams = {}
): Record<string, unknown> {
  const filter: Record<string, unknown> = { userId };

  if (params.folderId) filter.folderId = params.folderId;

  // Exact match on a canonical registry name. Not a regex: `companies[]` holds values the resolver
  // produced, so there is nothing to normalise and a regex would let "Meta" match "Metabase".
  if (params.company) filter.companies = params.company;

  // Same, and tags are already lowercased on write by `canonicaliseTags()`, which is what makes an
  // exact match correct here rather than case-insensitive.
  if (params.tag) filter.tags = params.tag;

  if (params.targetOnly) filter.isTargetCompany = true;

  if (params.followUpDue) {
    // "Still needs following up" — a date is set and it has not been marked done. Deliberately NOT
    // `followUpAt <= now`: the People page's job is to show what is outstanding, and a follow-up
    // scheduled for Friday is outstanding on Wednesday. `getPendingFollowUps` has a separate
    // overdue-vs-upcoming window for the dashboard and digest, and the two disagreeing silently is
    // a bug this repo has already paid for once.
    filter.followUpAt = { $ne: null };
    filter.followedUp = { $ne: true };
  }

  /**
   * SEARCH IS A REGEX, NOT `$text`, and that is a decision rather than a shortcut.
   *
   * Two reasons, either sufficient. MongoDB permits exactly ONE text index per collection, and
   * `Contact` has none — adding one would mean committing to a field set and weights up front for a
   * box whose main job is narrowing a list. And `$text` matches whole words only, so it returns
   * nothing for "razor" until the user finishes typing "razorpay", which is wrong for a filter that
   * updates as you type. `lib/events/query.ts` reaches the same conclusion from the other
   * direction: it keeps a `$text` path for multi-word queries and a substring regex for single
   * words, precisely so the box works mid-typing.
   */
  const q = params.q?.trim();
  if (q) {
    const rx = new RegExp(escapeRegex(q), 'i');
    filter.$or = SEARCH_FIELDS.map(field => ({ [field]: rx }));
  }

  return filter;
}

/** Mongo sort spec for each option the UI offers. */
export function buildContactSort(sort: ContactSort = 'recent'): Record<string, 1 | -1> {
  switch (sort) {
    case 'oldest':
      return { scannedAt: 1 };
    case 'name':
      return { name: 1 };
    case 'company':
      // Contacts with no company sort last under ascending order in Mongo (null before strings),
      // so this is `company` then `name` and the empty ones cluster at the top — acceptable,
      // because "who has no company recorded" is itself something the user wants to see and fix.
      return { company: 1, name: 1 };
    case 'recent':
    default:
      // Matches `{ userId, scannedAt: -1 }` and the two array indexes, so the common paths are
      // served by an index rather than an in-memory sort.
      return { scannedAt: -1 };
  }
}

/**
 * Parse query params off a URL into a validated shape.
 *
 * Kept here rather than in the route so the list route and the facet route parse identically — a
 * facet count computed from a differently-parsed request is the exact drift this module exists to
 * prevent.
 */
export function parseContactQuery(search: URLSearchParams): ContactQueryParams {
  const str = (key: string): string | undefined => {
    const raw = search.get(key);
    if (typeof raw !== 'string') return undefined;
    const trimmed = raw.trim();
    // A cap, because both feed a regex or an index probe and neither benefits from 5 KB of input.
    return trimmed ? trimmed.slice(0, 200) : undefined;
  };

  return {
    q: str('q'),
    company: str('company'),
    // Lowercased to match how tags are stored. Without this, a tag chip built from a URL somebody
    // shared with different casing would match nothing and read as an empty facet.
    tag: str('tag')?.toLowerCase(),
    folderId: str('folderId'),
    targetOnly: search.get('targetOnly') === 'true',
    followUpDue: search.get('followUpDue') === 'true',
    repeatOnly: search.get('repeatOnly') === 'true',
  };
}

/**
 * `repeatOnly` CANNOT BE A SINGLE PREDICATE, so it is resolved in two stages.
 *
 * "Have I met this person before" is a property of a GROUP of contacts sharing a `contactKey`, not
 * of any single document. The row itself carries no repeat flag, and adding one would be
 * denormalised state that goes stale the moment that person is scanned at a second event. So the
 * qualifying keys are resolved first — from the `contactKey → event count` aggregate — and then
 * matched with `contactKey: { $in: repeatKeys(counts) }`, which IS a predicate.
 *
 * ONE DEFINITION OF "REPEAT", exported and used, so the list route and any future consumer cannot
 * disagree about whether two counts as a repeat. The first version of this exported an
 * `isRepeat(key, counts)` predicate for filtering the page after the query, which produced a row
 * list of two under a heading that said "6 people" — the count had been computed before the
 * filtering. Filtering in the query means `countDocuments` and pagination are simply correct.
 *
 * An empty result is meaningful, not an edge case: `$in: []` matches nothing, which is the right
 * answer when nobody has been met twice.
 */
export function repeatKeys(counts: Map<string, number>): string[] {
  return [...counts.entries()].filter(([key, count]) => key && count > 1).map(([key]) => key);
}
