// Turning validated tool arguments into the Mongo filter and sort each tool runs. PURE.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THIS MODULE IS THE ONLY PLACE IN `lib/mcp/**` THAT CALLS `buildEventFilter`, AND IT ALWAYS PASSES
// `null` AS THE VIEWER. That is the whole access-control story for this server, so it is worth
// spelling out why it is shaped as a separate pure module rather than inlined into the handlers.
//
// `visibilityClause(null)` yields two arms — `{visibility: 'public'}` and
// `{visibility: {$exists: false}}` — and NO `createdByUserId` arm, so no other user's private or
// pending event can match. `buildEventFilter` takes the viewer POSITIONALLY and REQUIRED precisely
// so a call site cannot forget it (see the note above `visibilityClause`), and this server never
// has a viewer to pass: it reads no cookies, calls no session helper, and issues no `Set-Cookie`.
// v1 is unauthenticated by design, which means "anonymous" is not a fallback here — it is the only
// state that exists.
//
// Because these functions are pure and return the filter itself, `tests/mcp-tools.test.ts` can
// assert the exclusion directly — every plan's filter is inspected for both public arms and for the
// absence of any owner arm, with no database and no server. A guard asserted only by a diagnostic
// somebody has to remember to run is not asserted; that reasoning is `lib/events/seo.ts`'s and it
// applies more strongly here, because the failure mode is disclosure rather than a bad share card.
//
// EVERY QUERY CARRIES `techOnly: true`. The public feed is `techOnly` UNCONDITIONALLY and
// `?techOnly=false` is not honoured anywhere (CLAUDE.md, Architecture) — roughly 74% of the corpus
// is concerts, treks and book clubs that this product deliberately does not present. An MCP server
// that returned them would be a second, contradictory definition of what PulseBLR is, reachable
// from inside Claude, and every row it returned would link to a page the feed itself will not show
// you a way back to. `get_event` is the ONE exception and its reason is at that function.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import {
  buildEventFilter,
  buildSort,
  resolveWindow,
  type EventQueryParams,
  type SortKey,
} from '../events/query';
import type {
  EventsNearArgs,
  GetEventArgs,
  McpWhen,
  SearchEventsArgs,
  TrendingTopicsArgs,
} from './args';

/**
 * The viewer this server always passes. Named rather than a bare `null` at four call sites, so the
 * grep for "who is the viewer here" has one answer and a future edit that introduces a real viewer
 * has one place to change and a name to argue with.
 */
const ANONYMOUS_VIEWER = null;

/** Mongo filter shape, matching `lib/events/query.ts`'s own honest type. */
export type EventFilter = Record<string, unknown>;

export interface QueryPlan {
  filter: EventFilter;
  sort: Record<string, 1 | -1 | { $meta: 'textScore' }>;
  limit: number;
  /** True when the filter uses `$text`, so the caller must project `textScore` to sort by it. */
  hasTextSearch: boolean;
}

/** Resolve a named window into explicit bounds, in IST — `resolveWindow` owns the arithmetic. */
function windowBounds(when: McpWhen | undefined): { from?: Date; to?: Date } {
  if (!when) return {};
  const resolved = resolveWindow(when);
  return resolved ? { from: resolved.from, to: resolved.to } : {};
}

function anonymousFilter(params: EventQueryParams): EventFilter {
  return buildEventFilter(params, ANONYMOUS_VIEWER);
}

export function planSearchEvents(args: SearchEventsArgs): QueryPlan {
  const named = windowBounds(args.when);

  const params: EventQueryParams = {
    q: args.query,
    category: args.category,
    area: args.area,
    format: args.format,
    isFree: args.free,
    techOnly: true,
    // Explicit bounds win over a named window, so a caller may combine `when` with a tighter
    // `dateFrom` without the window silently overriding it.
    from: args.dateFrom ?? named.from,
    to: args.dateTo ?? named.to,
    // An event that started an hour ago and runs until midnight is still worth telling a caller
    // about — the same reasoning the feed's "upcoming includes in-progress" rule rests on.
    includeOngoing: true,
    includePast: false,
  };

  const filter = anonymousFilter(params);
  const hasTextSearch = Boolean(filter.$text);

  /**
   * Default sort mirrors the app: `connections` normally, `relevance` when there is a query.
   *
   * `connections` rather than `soonest` is not a stylistic choice and is worth defending here,
   * because a chronological default would make this server measurably worse than the website it
   * fronts. Measured (CLAUDE.md §3): the first 20 rows of the default tech feed under `soonest` had
   * median connection score 20 with 15 of 20 online, under `connections` median 88 with 0 online.
   * Online events post more often and at shorter notice, so chronological ordering does not merely
   * fail to rank — it actively selects the worst quartile. A model asking for ten events gets
   * exactly one page, so the ranking IS the answer.
   */
  const sortKey: SortKey = args.sort ?? (args.query ? 'relevance' : 'connections');

  return { filter, sort: buildSort(sortKey, hasTextSearch), limit: args.limit, hasTextSearch };
}

export function planEventsNear(args: EventsNearArgs): QueryPlan {
  const named = windowBounds(args.when);

  /**
   * NO `format` FILTER, DELIBERATELY, and it is not an omission.
   *
   * `Event.area` is resolved by `resolveArea()` from the venue and address strings, so an online
   * event — which has neither — cannot carry a real area. The area filter therefore excludes online
   * events by construction, which is exactly what a tool built around commute should do. Adding
   * `format: 'offline'` on top would additionally drop HYBRID events, which are attendable in
   * person and are the one case where "there is a room you can go to" is true and the format string
   * does not say `offline`.
   */
  const params: EventQueryParams = {
    area: args.area,
    techOnly: true,
    from: named.from,
    to: named.to,
    includeOngoing: true,
    includePast: false,
  };

  const filter = anonymousFilter(params);
  return { filter, sort: buildSort('connections', false), limit: args.limit, hasTextSearch: false };
}

export function planTrendingTopics(args: TrendingTopicsArgs): QueryPlan {
  const named = windowBounds(args.when);

  const params: EventQueryParams = {
    techOnly: true,
    // Default window is the next month rather than "everything upcoming": a corpus stretching to
    // next year answers "what is Bengaluru about eventually", and the question being asked is what
    // is happening now.
    from: named.from,
    to: named.to ?? (named.from ? undefined : resolveWindow('month')?.to),
    includeOngoing: true,
    includePast: false,
  };

  const filter = anonymousFilter(params);
  return { filter, sort: buildSort('connections', false), limit: args.limit, hasTextSearch: false };
}

/**
 * `get_event` — one document by id or slug.
 *
 * ── WHY THIS ONE DROPS `techOnly` AND ALLOWS PAST EVENTS ─────────────────────────────────────
 * It is a fetch of a row the caller already has an identifier for, not a discovery query. The
 * website's own `/events/[id]` page is neither tech-gated nor future-gated, so a `get_event` that
 * refused a past or non-tech event would answer "no such event" about a page that renders fine —
 * the least debuggable kind of wrong answer. Nothing is disclosed by the difference: visibility is
 * still the anonymous clause, which is the only thing that decides what may be read.
 *
 * ── WHY THE SELECTOR IS NESTED IN `$and` RATHER THAN SPREAD ──────────────────────────────────
 * `{...filter, ...selector}` reads as harmless and is a landmine: `buildEventFilter` assigns
 * top-level keys unconditionally, so the day it gains a key this selector also uses, one of the two
 * is silently dropped — and the one that gets dropped might be the visibility clause. Nesting
 * cannot collide. (The one thing that would break under nesting is `$text`, which Mongo forbids in
 * a nested position — there is no `$text` on this path because `get_event` takes no query, and this
 * helper must not be reused for one that does.)
 */
export function planGetEvent(args: GetEventArgs): { filter: EventFilter } {
  const filter = anonymousFilter({
    includePast: true,
    includeOngoing: false,
    techOnly: false,
  });

  const selector: EventFilter = args.id !== undefined ? { _id: args.id } : { slug: args.slug };
  return { filter: { $and: [filter, selector] } };
}
