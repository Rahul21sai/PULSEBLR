// The four tool handlers. THE ONLY module in `lib/mcp/**` that touches Mongo.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// EVERY FILTER COMES FROM `lib/mcp/query-plan.ts`, WHICH IS THE ONLY CALLER OF `buildEventFilter`
// AND ALWAYS PASSES THE ANONYMOUS VIEWER. Nothing here assembles a `$match` of its own — that is a
// rule with a history: `/api/events/calendar` and `/api/companies` both hand-rolled one and both
// leaked private-event counts as a result (CLAUDE.md §7). The plans are pure, so the exclusion is
// asserted in `tests/mcp-tools.test.ts` rather than trusted.
//
// THIS MODULE READS NO SESSION. There is no `getCurrentUserId()` call, no cookie read and no
// `requireUser()`, because v1 is unauthenticated on purpose — there is no user-specific data in the
// surface, so there is no OAuth to build and nothing to leak. That is not a gap to be filled by
// adding a session read here; see the v2 note in `app/mcp/page.tsx`.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import Event from '../models/Event';
import connectDB from '../mongodb';
import { canViewEvent } from '../events/visibility';
import { MIN_TOPIC_EVENTS, topicForDimension } from '../events/topics';
import { absoluteUrl } from '../canonical-origin';
import {
  parseEventsNearArgs,
  parseGetEventArgs,
  parseSearchEventsArgs,
  parseTrendingTopicsArgs,
} from './args';
import { planEventsNear, planGetEvent, planSearchEvents, planTrendingTopics } from './query-plan';
import {
  summariseRow,
  toMcpEventDetail,
  toMcpEventRow,
  type McpEventRow,
  type StoredEvent,
} from './serialize';
import { invalidArgs, toolFailure, toolResult, type ToolOutcome, type ToolRunner } from './server';

/**
 * The list projection. NO `description` — it runs to several KB per event in this corpus and the
 * rows do not show one, so including it would multiply an MCP payload (and a model's context cost)
 * for nothing. Same reasoning as `/api/events`, and the same fields plus what the rows actually use.
 */
const LIST_FIELDS = [
  '_id',
  'title',
  'slug',
  'organizer',
  'category',
  'format',
  'isFree',
  'price',
  'priceMax',
  'currency',
  'venue',
  'area',
  'city',
  'onlineLink',
  'startDateTime',
  'endDateTime',
  'applyLink',
  'attendeeCount',
  'companies',
  'connectionScore',
  'source',
  'sourceUrl',
].join(' ');

/**
 * The detail projection: everything the list needs plus the long fields, AND `visibility` /
 * `createdByUserId`.
 *
 * THOSE LAST TWO ARE NOT DECORATION. The filter already excludes non-public events, but `get_event`
 * is the one id-addressable path in this server, and CLAUDE.md §12 records that FIVE such paths in
 * this app each needed their own guard and that a sixth should be assumed to exist. Selecting the
 * two fields lets `canViewEvent` re-decide the same question independently — two mechanisms, one
 * answer, which is the arrangement `app/events/[id]/page.tsx` already uses.
 */
const DETAIL_FIELDS = [
  LIST_FIELDS,
  'description',
  'address',
  'tags',
  'hasFood',
  'soldOut',
  'capacity',
  'registrationDeadline',
  'imageUrl',
  'seenInSources',
  'visibility',
  'createdByUserId',
  // `deletedAt` is here for the same reason the two above are: `get_event` re-decides through
  // `canViewEvent`, which treats a field it was not given as the permissive case. The filter
  // already excludes deleted rows; this is what makes the second mechanism real rather than
  // decorative.
  'deletedAt',
].join(' ');

/* ────────────────────────────── search_events ────────────────────────────── */

async function runSearchEvents(rawArgs: unknown): Promise<ToolOutcome> {
  const parsed = parseSearchEventsArgs(rawArgs);
  if (!parsed.ok) return invalidArgs(parsed.issues);

  const plan = planSearchEvents(parsed.value);
  await connectDB();

  let query = Event.find(plan.filter).select(LIST_FIELDS).sort(plan.sort).limit(plan.limit);
  // Sorting by `$meta: 'textScore'` requires the score to be projected — without this the sort is
  // silently ignored by Mongo and a relevance search comes back in natural order.
  if (plan.hasTextSearch) query = query.select({ score: { $meta: 'textScore' } });

  const [docs, totalMatching] = await Promise.all([
    query.lean<StoredEvent[]>(),
    Event.countDocuments(plan.filter),
  ]);

  const events = docs.map(toMcpEventRow);
  const payload = {
    events,
    returned: events.length,
    totalMatching,
    sort: describeSort(plan.sort),
    filters: describeFilters(parsed.value),
  };

  if (events.length === 0) {
    return toolResult(
      'No upcoming Bengaluru engineering events match those filters. PulseBLR covers Bengaluru ' +
        'only and software/hardware engineering only, so try widening the date window, dropping a ' +
        'category, or calling trending_topics to see what the calendar actually holds right now.',
      payload
    );
  }

  return toolResult(renderRows(events, totalMatching), payload);
}

/* ────────────────────────────── get_event ────────────────────────────── */

async function runGetEvent(rawArgs: unknown): Promise<ToolOutcome> {
  const parsed = parseGetEventArgs(rawArgs);
  if (!parsed.ok) return invalidArgs(parsed.issues);

  const { filter } = planGetEvent(parsed.value);
  await connectDB();

  const doc = await Event.findOne(filter).select(DETAIL_FIELDS).lean<StoredEvent | null>();

  /**
   * ONE MESSAGE FOR "NOT THERE" AND FOR "NOT PUBLIC", and the wording never distinguishes them.
   *
   * A distinct "you are not allowed to see that" confirms the row exists, and an ObjectId embeds a
   * timestamp and a counter, so one known id makes its neighbours enumerable — "nobody will guess
   * it" is not an access-control argument. `lib/events/visibility.ts` states the same rule as
   * "always 404, never 403"; this is its MCP form.
   *
   * The second check is deliberately redundant with the filter. Both must agree before anything is
   * returned.
   */
  if (!doc || !canViewEvent(doc, null)) {
    const named = parsed.value.id ? `id "${parsed.value.id}"` : `slug "${parsed.value.slug}"`;
    return toolFailure(
      `No public PulseBLR event with ${named}. Event pages are pruned about a week after they ` +
        'finish, so a link from an older conversation may simply have expired — search_events will ' +
        'show what is currently listed.'
    );
  }

  const event = toMcpEventDetail(doc);
  return toolResult(
    [
      event.title,
      `${event.startsAtIST}${event.endsAt ? ` — ends ${event.endsAt}` : ''}`,
      `${event.location} · ${event.price} · ${event.format}`,
      event.organizer ? `Hosted by ${event.organizer}` : null,
      `Connection potential: ${event.connectionScore}/100 (${event.connectionRating})`,
      event.categories.length > 0 ? `Categories: ${event.categories.join(', ')}` : null,
      event.description ? `\n${event.description}` : null,
      `\nEvent page: ${event.url}`,
      event.registerUrl && event.registerUrl !== event.url ? `Register: ${event.registerUrl}` : null,
    ]
      .filter(Boolean)
      .join('\n'),
    { event }
  );
}

/* ────────────────────────────── events_near ────────────────────────────── */

async function runEventsNear(rawArgs: unknown): Promise<ToolOutcome> {
  const parsed = parseEventsNearArgs(rawArgs);
  if (!parsed.ok) return invalidArgs(parsed.issues);

  const plan = planEventsNear(parsed.value);
  await connectDB();

  const [docs, totalMatching] = await Promise.all([
    Event.find(plan.filter).select(LIST_FIELDS).sort(plan.sort).limit(plan.limit).lean<StoredEvent[]>(),
    Event.countDocuments(plan.filter),
  ]);

  const events = docs.map(toMcpEventRow);
  const areas = parsed.value.area;
  const payload = { areas, events, returned: events.length, totalMatching };

  if (events.length === 0) {
    return toolResult(
      `No upcoming engineering events in ${formatList(areas)}. Areas are resolved from venue and ` +
        'address text, so a quiet area is common rather than surprising — the tech-park areas ' +
        '(Whitefield, Outer Ring Road, Koramangala, Indiranagar, HSR Layout, Domlur) carry most of ' +
        'the calendar. Try a neighbouring area or search_events without an area filter.',
      payload
    );
  }

  return toolResult(
    `${totalMatching} upcoming engineering event${totalMatching === 1 ? '' : 's'} in ${formatList(areas)}` +
      `, ranked by connection potential.\n\n${events.map(summariseRow).join('\n\n')}`,
    payload
  );
}

/* ────────────────────────────── trending_topics ────────────────────────────── */

interface CategoryBucket {
  _id: string;
  count: number;
}

async function runTrendingTopics(rawArgs: unknown): Promise<ToolOutcome> {
  const parsed = parseTrendingTopicsArgs(rawArgs);
  if (!parsed.ok) return invalidArgs(parsed.issues);

  const plan = planTrendingTopics(parsed.value);
  await connectDB();

  const [buckets, totalEvents] = await Promise.all([
    /**
     * `$match` is the plan's filter, unmodified — the aggregation pipeline is the one place a
     * hand-rolled predicate is easiest to slip in and hardest to notice, which is exactly what
     * leaked private-event counts from `/api/events/calendar`. `$unwind` then counts one row per
     * (event, category) pair, which is why the counts sum to more than `totalEvents`.
     */
    Event.aggregate<CategoryBucket>([
      { $match: plan.filter },
      { $unwind: '$category' },
      { $group: { _id: '$category', count: { $sum: 1 } } },
      { $sort: { count: -1, _id: 1 } },
      { $limit: plan.limit },
    ]),
    Event.countDocuments(plan.filter),
  ]);

  const window = parsed.value.when ?? 'month';

  const topics = buckets.map(bucket => {
    /**
     * The link is a TOPIC PAGE only when one may exist, and a filtered feed otherwise.
     *
     * `/topics/<slug>` applies a ≥ `MIN_TOPIC_EVENTS` floor at render and 404s below it, so linking
     * unconditionally would hand a model a URL that is a 404 for precisely the thin topics it is
     * most likely to mention. The count is already in hand here, so the floor can be applied
     * before choosing — and the feed URL is always valid.
     */
    const topic = topicForDimension('category', bucket._id);
    const url =
      topic && bucket.count >= MIN_TOPIC_EVENTS
        ? absoluteUrl(`/topics/${topic.slug}`)
        : absoluteUrl(`/?category=${encodeURIComponent(bucket._id)}`);

    return {
      category: bucket._id,
      events: bucket.count,
      shareOfUpcoming: totalEvents > 0 ? Math.round((bucket.count / totalEvents) * 100) / 100 : 0,
      url,
    };
  });

  const payload = { window, totalEvents, topics };

  if (topics.length === 0) {
    return toolResult(
      `No upcoming Bengaluru engineering events in the "${window}" window, so there is nothing to ` +
        'summarise. Try when="month".',
      payload
    );
  }

  const lines = topics.map(
    t => `· ${t.category} — ${t.events} event${t.events === 1 ? '' : 's'}  ${t.url}`
  );
  return toolResult(
    `${totalEvents} upcoming Bengaluru engineering events in the "${window}" window. Categories by ` +
      'volume (an event carries several, so these sum to more than the total):\n\n' +
      lines.join('\n'),
    payload
  );
}

/* ────────────────────────────── wiring ────────────────────────────── */

const HANDLERS: Record<string, (args: unknown) => Promise<ToolOutcome>> = {
  search_events: runSearchEvents,
  get_event: runGetEvent,
  events_near: runEventsNear,
  trending_topics: runTrendingTopics,
};

/**
 * The runner handed to `dispatch()`.
 *
 * An unknown name cannot reach here — `dispatch` checks it against `TOOL_DEFS` first, so the tool a
 * client sees listed and the tool that runs are the same set. The guard below exists so this
 * function is total rather than relying on that ordering.
 */
export const runTool: ToolRunner = async (name, args) => {
  const handler = HANDLERS[name];
  if (!handler) {
    return { error: { code: -32602, message: `Unknown tool "${name}".` } };
  }
  return handler(args);
};

/* ────────────────────────────── prose helpers ────────────────────────────── */

function renderRows(events: McpEventRow[], totalMatching: number): string {
  const shown = events.length;
  const head =
    shown < totalMatching
      ? `${shown} of ${totalMatching} matching events, ranked best-first. Ask for a higher limit to see more.`
      : `${shown} matching event${shown === 1 ? '' : 's'}.`;
  return `${head}\n\n${events.map(summariseRow).join('\n\n')}`;
}

/** "A, B and C" — so a message about three areas reads like a sentence. */
function formatList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * Echo back which filters were actually applied.
 *
 * Worth the few lines: arguments here are coerced (`"ai-ml"` becomes `AI/ML`, `limit: 500` becomes
 * 50), so a model that gets an unexpected result set can see what the server understood rather than
 * assuming its own arguments were used verbatim.
 */
function describeFilters(args: {
  query?: string;
  category?: string[];
  area?: string[];
  when?: string;
  dateFrom?: Date;
  dateTo?: Date;
  format?: string;
  free?: boolean;
  limit: number;
}): Record<string, unknown> {
  const applied: Record<string, unknown> = { techOnly: true, city: 'Bengaluru', limit: args.limit };
  if (args.query) applied.query = args.query;
  if (args.category) applied.category = args.category;
  if (args.area) applied.area = args.area;
  if (args.when) applied.when = args.when;
  if (args.dateFrom) applied.dateFrom = args.dateFrom.toISOString();
  if (args.dateTo) applied.dateTo = args.dateTo.toISOString();
  if (args.format) applied.format = args.format;
  if (args.free !== undefined) applied.free = args.free;
  return applied;
}

/** Name the sort that was used, from the sort object, so the payload cannot claim a different one. */
function describeSort(sort: Record<string, unknown>): string {
  const keys = Object.keys(sort);
  if (keys.includes('score')) return 'relevance';
  if (keys.includes('connectionScore')) return 'connections';
  if (keys.includes('attendeeCount')) return 'popular';
  if (keys.includes('createdAt')) return 'newest';
  return 'soonest';
}
