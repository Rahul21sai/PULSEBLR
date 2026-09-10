// Shared query building for the events API.
//
// Kept out of the route handler so the list endpoint, the facet endpoint and the
// digest all narrow the corpus in exactly the same way. A filter that behaves
// differently between "the list" and "the counts next to the filters" is a bug
// users notice immediately.

// `relevance` is pure — no mongoose, no models — so importing it here does not change what this
// module drags into a client bundle. See its header for why the personalised score is a separate
// object from `connectionScore` rather than a replacement for it.
import { relevanceRankExpr, type RelevanceContext } from './relevance';

/**
 * Mongo filters here are assembled dynamically from user input, so a plain
 * record is the honest type. Mongoose 9's strict `FilterQuery<IEvent>` rejects
 * runtime-built `$or` arrays whose branches have different key sets, which is
 * exactly the shape a faceted filter produces.
 */
type EventFilter = Record<string, unknown>;

export interface EventQueryParams {
  q?: string;
  category?: string[];
  area?: string[];
  source?: string[];
  /** Canonical company names (see lib/companies/registry.ts). */
  company?: string[];
  /**
   * Canonical company names the SIGNED-IN CALLER follows (`User.targetCompanies`), for the
   * "Hosted by a company you follow" shelf.
   *
   * ───────────────────────────────────────────────────────────────────────────────────────────
   * IT IS MATCHED ON PRESENCE, NOT LENGTH, AND AN EMPTY ARRAY DELIBERATELY MATCHES NOTHING.
   *
   * That asymmetry with `company` above is the entire safety property. `company` uses
   * `if (params.company?.length)` because an empty list there means "the user selected no
   * company", i.e. do not filter. Here an empty list means the OPPOSITE: the caller asked for
   * "companies I follow" and follows none — either because they are signed out or because they
   * cleared the list. Treating that as "do not filter" would answer a request for a personal
   * shelf with the ENTIRE feed, under a heading claiming every row is a company they follow.
   * `{ $in: [] }` matches zero documents, so the shelf renders empty and the section hides
   * itself. Fail closed, by construction rather than by a caller remembering to check.
   *
   * NOT PARSEABLE FROM A QUERYSTRING — `parseEventParams` never reads it, exactly like
   * `includeDeleted`. It is resolved server-side in `GET /api/events` from the session, because
   * a list a client could supply is not "companies you follow", it is "companies you named", and
   * the two would be indistinguishable in the response.
   *
   * It is pushed into `and` rather than assigned to `filter.companies`, so it INTERSECTS an
   * explicit `company` selection instead of silently clobbering it — both write the same key.
   * ───────────────────────────────────────────────────────────────────────────────────────────
   */
  followedCompanies?: string[];
  /**
   * Card metadata (`lib/event-types.ts`: `AUDIENCE_NAMES`, `PERK_NAMES`, `EVENT_TIERS`).
   *
   * ALL THREE MATCH ZERO DOCUMENTS TODAY. Measured 2026-09-10 against the live corpus:
   * `{ audience: { $exists: true } }`, `{ perks: { $exists: true } }` and
   * `{ tier: { $exists: true } }` each return 0 of 1616 — the schema landed but no writer has
   * run, so not one document carries even the `default: []`. They are supported here anyway
   * because the filter is the cheap half and a tagger backfill is the expensive half: with this
   * in place the backfill lights up the facets with no further query work. The FILTER RAIL is
   * what gates on a non-zero count, so nothing empty is ever offered to a reader.
   *
   * `$in` within a dimension, not `$all` — a facet chip group ORs, the same as `category`.
   */
  audience?: string[];
  perks?: string[];
  tier?: string[];
  format?: string;
  hasFood?: string;
  isFree?: boolean;
  techOnly?: boolean;
  /**
   * Only events an admin has pinned to the home page Spotlight.
   *
   * A filter rather than a bespoke endpoint, so a pinned set is narrowed by the SAME
   * `techOnly` / area / company / time-window logic as everything else. A separate query
   * would be a second definition of "upcoming" to keep in step with this one.
   */
  spotlight?: boolean;
  /** Inclusive lower bound on start time. */
  from?: Date;
  /** Exclusive upper bound on start time. */
  to?: Date;
  /** Include events that already started but haven't finished. */
  includeOngoing?: boolean;
  includePast?: boolean;
  /**
   * Match events that OVERLAP the `from`..`to` window, not just those that START inside it.
   *
   * OPT-IN, and only the calendar sets it. With `from`/`to` supplied, the default branch below
   * matches on `startDateTime` alone — which is right for the feed (a window means "events
   * beginning in this window") and wrong for a calendar, where a three-day conference must appear
   * on all three squares. Without this, tapping day 2 of GIDS or droidCon shows nothing.
   *
   * Deliberately not the default: changing the feed's window semantics would move the counts on
   * every facet chip, and no other caller wants it.
   */
  spanning?: boolean;
  /**
   * Include events an admin soft-deleted. OFF by default, and deliberately NOT parseable from a
   * querystring -- `parseEventParams` does not read it, so no caller can add `?includeDeleted=true`
   * and page through removed rows.
   *
   * Only the control room sets it, because only the control room has a reason to see removed rows
   * (to list them, and to undo). Every public caller leaves it alone.
   */
  includeDeleted?: boolean;
}

/** Parse the querystring into a normalized parameter object. */
export function parseEventParams(searchParams: URLSearchParams): EventQueryParams {
  const list = (key: string): string[] | undefined => {
    const raw = searchParams.get(key);
    if (!raw) return undefined;
    const values = raw.split(',').map(v => v.trim()).filter(Boolean);
    return values.length > 0 ? values : undefined;
  };

  const params: EventQueryParams = {
    q: searchParams.get('q')?.trim() || undefined,
    category: list('category'),
    area: list('area'),
    source: list('source'),
    company: list('company'),
    // `followedCompanies` is ABSENT from this list on purpose — see its note on `EventQueryParams`.
    // A querystring-supplied list would make "companies you follow" indistinguishable from
    // "companies you typed into the URL", and the shelf's heading asserts the first.
    audience: list('audience'),
    perks: list('perks'),
    tier: list('tier'),
    format: searchParams.get('format') || undefined,
    hasFood: searchParams.get('hasFood') || undefined,
    techOnly: searchParams.get('techOnly') === 'true',
    spotlight: searchParams.get('spotlight') === 'true',
    includePast: searchParams.get('includePast') === 'true' || searchParams.get('includeAll') === 'true',
    includeOngoing: searchParams.get('includeOngoing') !== 'false',
    spanning: searchParams.get('spanning') === 'true',
  };

  const isFree = searchParams.get('isFree');
  if (isFree === 'true') params.isFree = true;
  else if (isFree === 'false') params.isFree = false;

  const from = searchParams.get('from');
  const to = searchParams.get('to');
  if (from) {
    const parsed = new Date(from);
    if (!Number.isNaN(parsed.getTime())) params.from = parsed;
  }
  if (to) {
    const parsed = new Date(to);
    if (!Number.isNaN(parsed.getTime())) params.to = parsed;
  }

  // Named time windows are resolved in IST because "today" means the user's day,
  // not a UTC day. A 9 PM IST event would otherwise fall into tomorrow.
  const when = searchParams.get('when');
  if (when && !params.from) {
    const window = resolveWindow(when);
    if (window) {
      params.from = window.from;
      params.to = window.to;
    }
  }

  return params;
}

/** Start of the given IST calendar day, as an absolute instant. */
function istDayStart(offsetDays = 0): Date {
  const now = new Date();
  // Shift into IST, move by whole days, then floor to midnight and shift back.
  const istMs = now.getTime() + 5.5 * 3600 * 1000;
  const ist = new Date(istMs);
  ist.setUTCHours(0, 0, 0, 0);
  ist.setUTCDate(ist.getUTCDate() + offsetDays);
  return new Date(ist.getTime() - 5.5 * 3600 * 1000);
}

/** IST day-of-week (0 = Sunday) for right now. */
function istDayOfWeek(): number {
  return new Date(Date.now() + 5.5 * 3600 * 1000).getUTCDay();
}

export function resolveWindow(when: string): { from: Date; to: Date } | null {
  const today = istDayStart(0);
  const tomorrow = istDayStart(1);

  switch (when) {
    case 'today':
      return { from: today, to: tomorrow };
    case 'tomorrow':
      return { from: tomorrow, to: istDayStart(2) };
    case 'week':
      return { from: today, to: istDayStart(7) };
    case 'weekend': {
      const dow = istDayOfWeek();
      // Saturday is `6 - dow` days away; on Sat/Sun the weekend is now.
      const toSaturday = dow === 0 ? 0 : 6 - dow;
      const from = dow === 0 ? today : istDayStart(toSaturday);
      const to = dow === 0 ? tomorrow : istDayStart(toSaturday + 2);
      return { from, to };
    }
    case 'month':
      return { from: today, to: istDayStart(31) };
    default:
      return null;
  }
}

/**
 * The absolute window covering ONE IST calendar day, from a `YYYY-MM-DD` key.
 *
 * The inverse of `dayKeyIST` in `lib/format.ts`, and it exists so the week-ahead strip can turn
 * the day a reader tapped into `from`/`to` without inventing a second notion of "a day". The
 * calendar page's comment is the rule this follows: A DAY IS A `YYYY-MM-DD` IST KEY, NEVER A
 * `Date`. Anything reading the browser's clock — `startOfDay`, `setHours(0,0,0,0)` — puts a
 * reader outside IST on the wrong day, which is the defect that made the calendar's grid and its
 * day panel disagree.
 *
 * A FIXED `+05:30` OFFSET IS CORRECT HERE, not a shortcut: IST has no DST, so the offset is
 * constant for every date, and `app/calendar/page.tsx` already builds its IST instants the same
 * way. A named-timezone conversion would be more machinery for an identical answer.
 *
 * `to` is `from + 24h` rather than the next key's midnight for the same reason — with no DST the
 * two are always equal, and this needs no calendar arithmetic to get the month rollover right.
 *
 * Returns `null` on anything that is not a well-formed key, so a hand-edited URL degrades to "no
 * day selected" instead of `Invalid Date`, which would serialise as `null` and silently widen the
 * window to the whole corpus.
 */
export function resolveDayWindow(dayKey: string): { from: Date; to: Date } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const dayOfMonth = Number(match[3]);

  /*
   * THE SHAPE CHECK ABOVE IS NOT ENOUGH, AND A `NaN` CHECK IS NOT EITHER — `Date` SILENTLY ROLLS
   * OVER. Found by `tests/shelves.test.ts`, not by reading: `new Date('2026-02-30T00:00:00+05:30')`
   * does not fail, it returns 1 MARCH. So `?day=2026-02-30` would have drawn nothing as selected in
   * the strip (no card carries that key) while narrowing the feed to a different day entirely, with
   * the URL asserting a date the page was not showing. `2026-13-01` happens to reject, so a NaN
   * guard looks sufficient until a day-of-month is out of range rather than a month.
   *
   * The round trip through `Date.UTC` is the fix, and it is UTC on purpose: this is pure calendar
   * arithmetic — does this year/month/day exist — with no timezone in the question. It is the same
   * rule `app/calendar/page.tsx` follows for "how many days in this month" and "which weekday is the
   * 1st". Mixing IST into a validity check would be borrowing a zone to answer a question that has
   * none.
   */
  const probe = new Date(Date.UTC(year, month - 1, dayOfMonth));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== dayOfMonth
  ) {
    return null;
  }

  const from = new Date(`${dayKey}T00:00:00+05:30`);
  if (Number.isNaN(from.getTime())) return null;
  return { from, to: new Date(from.getTime() + 24 * 3600 * 1000) };
}

/** Build the Mongo filter for a parsed parameter set. */
/**
 * A search term shorter than this carries no signal. One character matched 815 of 815
 * events before prefix-anchoring, and even anchored it only means "every word starting
 * with c". Exported so the UI can tell the user how many characters it needs, rather
 * than silently handing back the whole corpus and calling it a result set.
 */
export const MIN_SEARCH_CHARS = 2;

/**
 * Descriptions run to several KB, so a short prefix matches nearly every event through
 * them and buries the title hits. Only terms this long are specific enough to be worth
 * searching descriptions for.
 */
export const DESCRIPTION_SEARCH_CHARS = 4;

/**
 * How many days before a window a multi-day event may have started and still count as spanning it.
 *
 * Exported so `/api/events/calendar` bounds its per-day expansion with the SAME number the day-panel
 * query uses. If the two disagreed, a dot would appear on a square whose day panel comes back empty,
 * or the reverse — which is the exact "the grid and the panel answer different questions" class of
 * bug this work exists to remove.
 *
 * 14 days: longer than any real conference in this corpus, short enough that an evergreen listing
 * dated years wide is excluded rather than smeared across every square.
 */
export const SPAN_FLOOR_DAYS = 14;

/**
 * The visibility clause. Three arms, and every one of them is load-bearing.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * `{ visibility: { $exists: false } }` IS NOT OPTIONAL. Roughly 1500 stored documents predate the
 * field entirely and carry no `visibility` key at all. Omitting this arm does not narrow the feed,
 * it EMPTIES it — on deploy, for everybody, including signed-out visitors. It is the arm somebody
 * removes as redundant after the corpus has been rewritten once.
 *
 * IT GOES INSIDE `and`, NEVER AS A TOP-LEVEL `filter.$or`. The search branch already owns `$or`
 * inside `and`, and the top-level keys above are assigned unconditionally — so a second top-level
 * `$or` would be silently clobbered by whichever assignment ran last, or collide with `$text`.
 * A filter that is quietly dropped is exactly the failure mode this is defending against.
 *
 * `viewerId` IS REQUIRED, and positional. An optional parameter here fails OPEN: forget it at one
 * call site and every user's private events appear in that response. `tests/search-filter.test.ts`
 * casts its argument through `Parameters<typeof buildEventFilter>[0]`, so the suite would NOT catch
 * a caller that omitted it — only the type can, and only if it is required.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */
export function visibilityClause(viewerId: string | null): EventFilter {
  const arms: EventFilter[] = [
    { visibility: 'public' },
    { visibility: { $exists: false } },
  ];
  // Signed-out visitors get the two public arms and nothing else. `createdByUserId: null` would
  // match documents whose owner field is absent, i.e. the entire scraped corpus — harmless here but
  // meaningless, and it would read as though anonymous callers owned something.
  if (viewerId) arms.push({ createdByUserId: viewerId });
  return { $or: arms };
}

/**
 * "Not deleted", as a filter fragment. One definition, so the predicate cannot drift.
 *
 * `null` rather than `$exists`: in MongoDB `{ deletedAt: null }` matches a null field AND an absent
 * one, which is both halves of what is needed -- ~1500 documents have no such key, and a restore
 * writing an explicit null must not leave a row invisible. See `lib/models/Event.ts`.
 */
export function notDeletedClause(): EventFilter {
  return { deletedAt: null };
}

/**
 * The full scope of "an event this viewer may see": visible to them AND not deleted.
 *
 * -------------------------------------------------------------------------------------------
 * THIS EXISTS BECAUSE `buildEventFilter` IS NOT THE ONLY READER, and the exceptions are easy to
 * miss. Two "similar events" queries -- one in `GET /api/events/[id]`, one in the `/events/[id]`
 * page -- hand-roll their own filter and spread `visibilityClause(viewerId)` into it. They are
 * correct about visibility and were structurally incapable of learning about any arm added to
 * `buildEventFilter` afterwards. Soft delete is exactly such an arm: without this, an event an
 * admin had just removed would keep appearing as a suggestion at the foot of every related page.
 *
 * So a hand-rolled event query spreads THIS, not `visibilityClause`. Reach for `visibilityClause`
 * alone only when you specifically want deleted rows too -- which in practice means the control
 * room, and that uses `includeDeleted` instead.
 * -------------------------------------------------------------------------------------------
 */
export function publicEventScope(viewerId: string | null): EventFilter {
  return { ...visibilityClause(viewerId), ...notDeletedClause() };
}

export function buildEventFilter(
  params: EventQueryParams,
  /** The signed-in user, or `null` for an anonymous visitor. Required — see `visibilityClause`. */
  viewerId: string | null
): EventFilter {
  const filter: EventFilter = {};
  const and: EventFilter[] = [visibilityClause(viewerId)];

  if (params.category?.length) filter.category = { $in: params.category };
  if (params.area?.length) filter.area = { $in: params.area };
  if (params.source?.length) filter.source = { $in: params.source };
  if (params.company?.length) filter.companies = { $in: params.company };
  /*
   * PRESENCE, NOT LENGTH — and it goes into `and`, not onto `filter.companies`.
   *
   * Both reasons are on the parameter's own doc comment and both are load-bearing: an empty list
   * has to match NOTHING (a shelf headed "companies you follow" may never fall back to the whole
   * feed), and a top-level assignment would clobber the `company` selection two lines above since
   * they write the same key. In `and` the two intersect, which is what a reader who has both a
   * company chip and a following shelf would expect.
   */
  if (params.followedCompanies) and.push({ companies: { $in: params.followedCompanies } });
  if (params.audience?.length) filter.audience = { $in: params.audience };
  if (params.perks?.length) filter.perks = { $in: params.perks };
  if (params.tier?.length) filter.tier = { $in: params.tier };
  if (params.format) filter.format = params.format;
  if (params.hasFood) filter.hasFood = params.hasFood;
  if (params.isFree !== undefined) filter.isFree = params.isFree;
  if (params.techOnly) filter.isTechEvent = true;
  // `$type: 'date'` rather than `$exists` or `$ne: null`: it matches the partial index on
  // `spotlightAt` exactly, so the query can use it, and it cannot be satisfied by a stray
  // explicit null left behind by some future write path.
  if (params.spotlight) filter.spotlightAt = { $type: 'date' };
  // Soft-deleted rows leave every listing, count and facet unless a caller explicitly asks for
  // them. A plain top-level key rather than a push into `and`: it is a single equality with no
  // `$or` to collide with, unlike the visibility clause.
  if (!params.includeDeleted) Object.assign(filter, notDeletedClause());

  const now = new Date();
  const lowerBound = params.from ?? (params.includePast ? undefined : now);

  if (lowerBound) {
    if (params.includeOngoing && !params.from) {
      // An event that started an hour ago but runs until midnight is still
      // attendable, so "upcoming" must include in-progress events — otherwise a
      // multi-day festival vanishes on its second day.
      //
      // The `ongoingFloor` is essential: matching purely on "end date is in the
      // future" let an Eventbrite evergreen listing dated 2015→2030 sit at the top
      // of the feed forever. An event only counts as ongoing if it also STARTED
      // within the last few days.
      const ongoingFloor = new Date(lowerBound.getTime() - 3 * 24 * 3600 * 1000);
      and.push({
        $or: [
          { startDateTime: { $gte: lowerBound } },
          { startDateTime: { $gte: ongoingFloor }, endDateTime: { $gte: lowerBound } },
        ],
      });
    } else if (params.spanning) {
      /**
       * OVERLAP, for the calendar. Structurally the same shape as the `includeOngoing` branch
       * above, and for the same reason — including the floor.
       *
       * THE FLOOR IS NOT OPTIONAL. Matching purely on "ends after this day" is what let an
       * Eventbrite evergreen listing dated 2015→2030 sit at the top of the feed forever; on a
       * calendar the same row would land on every square of every month, so one bad end date would
       * make the whole grid look full. `SPAN_FLOOR_DAYS` bounds how far back a start may be, which
       * caps a genuine multi-day event at a plausible conference length and drops the impossible
       * ones. `scripts/cleanup-implausible.ts` deletes those, but this must not depend on it having
       * been run.
       */
      const spanFloor = new Date(lowerBound.getTime() - SPAN_FLOOR_DAYS * 24 * 3600 * 1000);
      and.push({
        $or: [
          { startDateTime: { $gte: lowerBound } },
          { startDateTime: { $gte: spanFloor }, endDateTime: { $gte: lowerBound } },
        ],
      });
    } else {
      and.push({ startDateTime: { $gte: lowerBound } });
    }
  }
  if (params.to) and.push({ startDateTime: { $lt: params.to } });

  if (params.q) {
    // Two search strategies, split on word count:
    //
    //  · Multi-word queries use $text against the weighted compound index, which
    //    gives real relevance ranking ("ai product meetup" ranks sensibly).
    //  · Single-word queries use a regex, because $text only matches WHOLE words
    //    and a search box must work while you are still typing ("kuber" has to
    //    find Kubernetes events).
    //
    // The regex is anchored to a WORD START (\b), not a bare substring. That
    // distinction is the difference between a search box and a no-op: measured
    // against the live corpus, unanchored substrings returned
    //
    //    q="a"    -> 815 of 815 events   (the entire corpus)
    //    q="c"    -> 803 of 815
    //    q="AI"   -> 519 of 815          ("tr-ai-ning", "ch-ai-r", "av-ai-lable")
    //    q="rust" ->  28                 (including "t-rust")
    //
    // A query that returns everything is indistinguishable from no query at all.
    // Prefix-anchoring keeps mid-typing useful ("kub" still finds Kubernetes) while
    // refusing to match the inside of unrelated words.
    const term = params.q.trim();

    if (/\s/.test(term)) {
      filter.$text = { $search: term };
    } else if (term.length >= MIN_SEARCH_CHARS) {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const prefix = new RegExp(`\\b${escaped}`, 'i');

      // DESCRIPTION is searched only for longer terms. Descriptions run to
      // several KB, so a 2-character prefix hits almost every event through them
      // and drowns the title matches that are actually relevant — leaving it out
      // of the regex branch entirely was also wrong (`q=kubernetes` once returned
      // 0 while the text index found 3), so the rule is length, not exclusion.
      const fields: Array<Record<string, unknown>> = [
        { title: prefix },
        { organizer: prefix },
        { venue: prefix },
        { tags: prefix },
      ];
      if (term.length >= DESCRIPTION_SEARCH_CHARS) fields.push({ description: prefix });

      and.push({ $or: fields });
    }
    // A 1-character term falls through unfiltered on purpose: it carries no signal,
    // and the UI tells the user to keep typing rather than showing them everything
    // and calling it a result set.
  }

  if (and.length > 0) filter.$and = and;
  return filter;
}

export type SortKey = 'soonest' | 'newest' | 'popular' | 'relevance' | 'connections' | 'foryou';

export function buildSort(sort: SortKey, hasTextSearch: boolean): Record<string, 1 | -1 | { $meta: 'textScore' }> {
  switch (sort) {
    case 'newest':
      return { createdAt: -1 };
    case 'foryou':
      /**
       * THE PERSONALISED RANK IS NOT COMPUTABLE HERE, AND THIS FALLBACK IS THE POINT.
       *
       * `foryou` sorts on `relevanceRank`, a field that exists only inside the pipeline
       * `buildForYouPipeline` builds — it is per-user and per-request and is never stored. A
       * `find()` caller therefore cannot honour it, and there are two legitimate ways to reach
       * here: an anonymous visitor whose URL says `sort=foryou`, and a signed-in user who has
       * expressed no preference the ranking can act on.
       *
       * So it degrades to the CORPUS-WIDE ranking, which is the closest true answer and is
       * exactly what "For you" reduces to when there is nothing personal to add. It deliberately
       * does NOT fall through to the `default` case: sorting on a field that does not exist is a
       * silent no-op that returns natural insertion order, which would look like the ranking had
       * simply stopped working. Falling back to a real ranking fails visibly-correct instead.
       */
      return { connectionScore: -1, startDateTime: 1 };
    case 'connections':
      // The product's core question: where will I actually meet useful people?
      // Ties break by soonest so the list still reads as a schedule.
      return { connectionScore: -1, startDateTime: 1 };
    case 'popular':
      // Nulls sort last in descending order, so events with no attendee data fall
      // below those with counts — which is the intent of a "popular" sort.
      return { attendeeCount: -1, startDateTime: 1 };
    case 'relevance':
      return hasTextSearch ? { score: { $meta: 'textScore' }, startDateTime: 1 } : { startDateTime: 1 };
    case 'soonest':
    default:
      return { startDateTime: 1 };
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The personalised feed ("For you")
//
// WHY IT IS AN AGGREGATION AND NOT A POST-SORT. The feed is paginated 30 rows at a time. Scoring
// a page in JavaScript reorders 30 events that a DIFFERENT sort already chose, which is not a
// ranking — it is shuffling the wrong thirty. The personalised score has to be computed in the
// database, over the whole matched set, before the skip and the limit.
//
// WHY IT LIVES IN THIS FILE. Same reason everything else here does: the list, the counts and the
// facets must narrow the corpus identically. `buildForYouPipeline` therefore takes the SAME
// `buildEventFilter` output as the `find()` path, so `For you` and `Everything` can differ in
// ORDER and in nothing else. That is the property the two-view guarantee rests on — if this
// assembled its own `$match`, a "recommender that never hides events" would be one refactor away
// from hiding them.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The fields the feed list returns, as ONE definition shared by both paths.
 *
 * It was a `.select(...)` string literal inside `GET /api/events`. That was fine while there was a
 * single query; with a `find()` path and an aggregation path answering the same request, a literal
 * in the route means the personalised feed and the default feed can come to return different
 * fields — and the symptom would be a card rendering fine in one tab and missing its cover, its
 * price or its meter in the other, with nothing to suggest why.
 *
 * `description` is deliberately ABSENT, unchanged from the original: it runs to 6 KB per event and
 * the feed renders a two-line excerpt, so sending it would multiply the payload for nothing. The
 * detail endpoint returns everything.
 */
export const FEED_FIELDS = [
  'title', 'source', 'sourceUrl', 'slug', 'organizer', 'hostAvatarUrl', 'category', 'tags',
  'format', 'hasFood', 'isFree', 'price', 'priceMax', 'currency', 'soldOut', 'venue', 'area',
  'city', 'lat', 'lng', 'onlineLink', 'imageUrl', 'startDateTime', 'endDateTime', 'applyLink',
  'registrationDeadline', 'attendeeCount', 'capacity', 'isTechEvent', 'companies',
  'connectionScore', 'isTargetCompany', 'recruiterMentioned', 'seenInSources', 'spotlightAt',
  'createdAt',
  /*
   * CARD METADATA, CARRIED BEFORE ANYTHING RENDERS IT — and that is deliberate, not an oversight.
   *
   * `FeedEvent` already types all three and no document carries any of them yet (0 of 1616 on
   * 2026-09-10), so today they add three absent keys to the payload: no bytes, no query cost.
   * What they do add is the ability for a card to show an audience or a perk the moment the tagger
   * backfills, because this constant is the ONE definition both feed paths project through and a
   * card cannot reach around it. Leaving them out would mean the tagger work lands and the cards
   * still show nothing until somebody edits this line — the field would be populated, projected
   * away, and look like a tagger failure.
   *
   * `agenda` and `speakers` are deliberately still absent: they are per-event depth for the DETAIL
   * page, they are unbounded in size, and the feed renders a two-line excerpt — the same reason
   * `description` is not here.
   */
  'audience', 'perks', 'tier',
] as const;

/** `FEED_FIELDS` as a space-separated string, for `Query.select()`. */
export const FEED_SELECT = FEED_FIELDS.join(' ');

/** `FEED_FIELDS` as an aggregation `$project` inclusion document. `_id` is included implicitly. */
export function feedProjection(): Record<string, 1> {
  return Object.fromEntries(FEED_FIELDS.map(field => [field, 1])) as Record<string, 1>;
}

/**
 * The aggregation that ranks the feed by `connectionScore × relevanceScore`.
 *
 * `filter` MUST be the output of `buildEventFilter` — it is placed unmodified as the first stage,
 * which is also what lets a `$text` search work here (Mongo permits `$text` only in a pipeline's
 * first `$match`).
 *
 * IT RE-RANKS AND ONLY RE-RANKS. There is no `$match` of its own, no threshold on the computed
 * score and nothing dropped: the row set is identical to what `Everything` returns for the same
 * filters, and `Event.countDocuments(filter)` is still the right total for it. If a future change
 * wants to hide low-relevance events, that is a product decision that has to be visible in the UI,
 * not a stage added quietly here.
 *
 * `relevanceRank` is projected AWAY at the end. It is a per-request number with no meaning outside
 * this sort, and shipping it would invite a client to treat it as a stored property of the event —
 * which is precisely the confusion between `connectionScore` (stored, shared, backfilled) and
 * relevance (derived, per-user, never written) that `lib/events/relevance.ts` exists to keep apart.
 */
export function buildForYouPipeline(
  filter: EventFilter,
  context: RelevanceContext,
  page: { skip: number; limit: number }
): Array<Record<string, unknown>> {
  return [
    { $match: filter },
    { $addFields: { relevanceRank: relevanceRankExpr(context) } },
    // Ties break by soonest, exactly as `buildSort('connections')` does, so the list still reads
    // as a schedule once the ranking has had its say.
    { $sort: { relevanceRank: -1, startDateTime: 1 } },
    { $skip: page.skip },
    { $limit: page.limit },
    { $project: feedProjection() },
  ];
}
