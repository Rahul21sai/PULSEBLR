// Shared query building for the events API.
//
// Kept out of the route handler so the list endpoint, the facet endpoint and the
// digest all narrow the corpus in exactly the same way. A filter that behaves
// differently between "the list" and "the counts next to the filters" is a bug
// users notice immediately.

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
    format: searchParams.get('format') || undefined,
    hasFood: searchParams.get('hasFood') || undefined,
    techOnly: searchParams.get('techOnly') === 'true',
    spotlight: searchParams.get('spotlight') === 'true',
    includePast: searchParams.get('includePast') === 'true' || searchParams.get('includeAll') === 'true',
    includeOngoing: searchParams.get('includeOngoing') !== 'false',
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

export function buildEventFilter(params: EventQueryParams): EventFilter {
  const filter: EventFilter = {};
  const and: EventFilter[] = [];

  if (params.category?.length) filter.category = { $in: params.category };
  if (params.area?.length) filter.area = { $in: params.area };
  if (params.source?.length) filter.source = { $in: params.source };
  if (params.company?.length) filter.companies = { $in: params.company };
  if (params.format) filter.format = params.format;
  if (params.hasFood) filter.hasFood = params.hasFood;
  if (params.isFree !== undefined) filter.isFree = params.isFree;
  if (params.techOnly) filter.isTechEvent = true;
  // `$type: 'date'` rather than `$exists` or `$ne: null`: it matches the partial index on
  // `spotlightAt` exactly, so the query can use it, and it cannot be satisfied by a stray
  // explicit null left behind by some future write path.
  if (params.spotlight) filter.spotlightAt = { $type: 'date' };

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

export type SortKey = 'soonest' | 'newest' | 'popular' | 'relevance' | 'connections';

export function buildSort(sort: SortKey, hasTextSearch: boolean): Record<string, 1 | -1 | { $meta: 'textScore' }> {
  switch (sort) {
    case 'newest':
      return { createdAt: -1 };
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
