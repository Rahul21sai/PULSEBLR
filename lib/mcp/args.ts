// Tool-argument validation and coercion. PURE — no mongoose, no network.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// TREAT EVERY ARGUMENT AS HOSTILE, AND NOT ONLY FOR THE OBVIOUS REASON.
//
// The usual argument is that an MCP client is driven by a language model, so arguments arrive
// malformed by accident constantly: `limit: "10"` instead of `10`, `free: "true"`, a bare string
// where an array is declared, a category spelled `ai-ml` instead of `AI/ML`. All of that is
// coerced below rather than refused, because a tool that 400s on `"10"` is a tool a model gives up
// on after two tries.
//
// THE SHARPER REASON IS NOSQL OPERATOR INJECTION. These values end up inside a Mongo query. JSON
// can carry an OBJECT where a string is declared, and Mongo reads an object in a value position as
// an OPERATOR — so `{"slug": {"$ne": null}}` is not a slug that fails to match, it is a query for
// "any event whose slug is not null", i.e. the first document in the collection. `{"$gt": ""}` is
// the same trick. Nothing downstream defends against this: `buildEventFilter` escapes the search
// TERM into a regex but does not typecheck what it was handed, and Mongoose only casts against the
// schema for paths it recognises. So the typechecks in `scalarString` and `stringList` are the
// whole defence, and `tests/mcp-tools.test.ts` pins them by name.
//
// WHAT IS DELIBERATELY NOT HERE: a regex built from a client string. The only regex any of these
// tools produces is the one `buildEventFilter` builds from `q`, which escapes the term itself
// (`lib/events/query.ts`). The slug lookup in `get_event` is an EXACT match on purpose — a
// case-insensitive one would need a regex, and a regex over a client-supplied slug is either an
// escaping bug waiting to happen or a `.*` denial-of-service waiting to happen. Slugs are stored
// lowercase; a caller who has one has it verbatim.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import { BENGALURU_AREAS } from '../scrapers/core/geo';
import { GATHERING_CATEGORY_NAMES, TECH_CATEGORY_NAMES } from '../event-types';
import { slugify } from '../events/topics';

/**
 * Result caps.
 *
 * `max` exists because an MCP client will cheerfully ask for everything — a model that wants "all
 * AI events" writes `limit: 1000` without a thought, and the cost of answering lands on Atlas and
 * on the client's context window at the same time. `default` is small for the same reason: ten rows
 * is a readable answer, and a model that wants more can ask again with a page-sized number.
 */
export const RESULT_LIMITS = { default: 10, max: 50 } as const;

/** `trending_topics` counts categories, so its ceiling is the size of the taxonomy, not 50. */
export const TOPIC_LIMITS = { default: 12, max: 22 } as const;

/**
 * The categories these tools accept — the nine tech subjects plus the seven gathering kinds.
 *
 * THE NON-TECH TAIL (`OTHER_CATEGORY_NAMES`: Arts/Culture, Health/Fitness, Community/Social …) IS
 * ABSENT, and for the same reason `lib/events/topics.ts` gives no landing page to those categories:
 * every query this server issues carries `techOnly: true`, matching the public feed, which is
 * `techOnly` UNCONDITIONALLY (CLAUDE.md, Architecture). Offering `Arts/Culture` in the schema would
 * advertise a filter that can only ever return zero rows — worse than omitting it, because a model
 * reads an empty result as "there are no arts events in Bengaluru" rather than "that is not what
 * this server is for".
 *
 * The gathering kinds ARE offered even though `Meetup` and `Conference` are not in
 * `TECH_FLAG_CATEGORIES`: an event stored `[AI/ML, Meetup]` satisfies `techOnly` through `AI/ML`,
 * so `category: ["Meetup"]` correctly narrows to tech meetups rather than returning nothing.
 */
export const MCP_CATEGORIES: readonly string[] = [
  ...TECH_CATEGORY_NAMES,
  ...GATHERING_CATEGORY_NAMES,
];

export const MCP_AREAS: readonly string[] = BENGALURU_AREAS;

export const MCP_WHEN = ['today', 'tomorrow', 'weekend', 'week', 'month'] as const;
export const MCP_FORMATS = ['online', 'offline', 'hybrid'] as const;
export const MCP_SORTS = ['soonest', 'connections', 'popular', 'newest', 'relevance'] as const;

export type McpWhen = (typeof MCP_WHEN)[number];
export type McpFormat = (typeof MCP_FORMATS)[number];
export type McpSort = (typeof MCP_SORTS)[number];

/** Accumulates every complaint so one reply can name them all, rather than one per round trip. */
export type Issues = string[];

export type Validated<T> = { ok: true; value: T } | { ok: false; issues: Issues };

/* ────────────────────────────── primitives ────────────────────────────── */

/*
 * THE PRIMITIVES BELOW ARE EXPORTED FOR `lib/mcp/personal-args.ts` AND FOR NOTHING ELSE.
 *
 * They were module-private while there was one arguments file. There are now two — the public tools
 * and the authenticated ones — and the operator-injection guard those two files share must have
 * exactly ONE implementation. A copied `scalarString` is the failure this repo has already paid for
 * twice in other shapes: `WorthGoing` copied the funnel regex and fell behind it, and
 * `cleanup-non-bengaluru.ts` mirrored the off-city predicate instead of importing it. A drifted copy
 * of THIS one does not merely mis-rank an event, it lets `{"$ne": null}` reach a Mongo value
 * position on a query scoped to somebody's private contacts.
 *
 * So: import them, never re-implement them, and do not widen what they accept.
 */

/**
 * A string, or undefined. THE OPERATOR-INJECTION GUARD.
 *
 * Numbers and booleans are stringified because a model sends `id: 12345` for something that looks
 * numeric. Objects and arrays are REFUSED — that is the whole point: an object reaching a Mongo
 * value position is an operator, not a value.
 */
export function scalarString(value: unknown, field: string, issues: Issues): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  issues.push(`"${field}" must be a string.`);
  return undefined;
}

/** Longest string this layer will pass through. Long enough for any real query, short enough that
 *  a megabyte of text cannot be pushed into a regex or a `$text` search. */
const MAX_STRING_CHARS = 200;

/** How many entries a list argument may carry, so `category: [...1000 values]` cannot be sent. */
const MAX_LIST_ITEMS = 20;

export function boundedString(value: unknown, field: string, issues: Issues): string | undefined {
  const raw = scalarString(value, field, issues);
  if (raw === undefined) return undefined;
  if (raw.length > MAX_STRING_CHARS) {
    issues.push(`"${field}" must be ${MAX_STRING_CHARS} characters or fewer.`);
    return undefined;
  }
  return raw;
}

/**
 * A list of strings from a string, a comma-separated string, or an array.
 *
 * The comma form is accepted because models write `category: "AI/ML, Cloud/DevOps"` as often as
 * they write an array, and because this app's own querystring convention is comma-separated. Any
 * non-scalar ELEMENT is refused, for the operator-injection reason above.
 */
export function stringList(value: unknown, field: string, issues: Issues): string[] | undefined {
  if (value === undefined || value === null) return undefined;

  let parts: unknown[];
  if (Array.isArray(value)) {
    parts = value;
  } else {
    const single = scalarString(value, field, issues);
    if (single === undefined) return undefined;
    parts = single.split(',');
  }

  if (parts.length > MAX_LIST_ITEMS) {
    issues.push(`"${field}" accepts at most ${MAX_LIST_ITEMS} values.`);
    return undefined;
  }

  const out: string[] = [];
  for (const part of parts) {
    const item = boundedString(part, field, issues);
    if (item !== undefined && !out.includes(item)) out.push(item);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Match a client string onto one of `allowed`, tolerantly.
 *
 * Three forms are accepted for the same value, all of which a model produces: exact
 * (`'Cloud/DevOps'`), case-insensitive (`'cloud/devops'`), and the slug this app already publishes
 * at `/topics/cloud-devops` (`'cloud-devops'`). `slugify` is reused rather than re-implemented so
 * the accepted spelling and the public URL cannot drift.
 */
function matchEnum(raw: string, allowed: readonly string[]): string | undefined {
  const exact = allowed.find(a => a === raw);
  if (exact) return exact;
  const lower = raw.toLowerCase();
  const ci = allowed.find(a => a.toLowerCase() === lower);
  if (ci) return ci;
  const slug = slugify(raw);
  return allowed.find(a => slugify(a) === slug);
}

export function enumValue(
  value: unknown,
  field: string,
  allowed: readonly string[],
  issues: Issues
): string | undefined {
  const raw = boundedString(value, field, issues);
  if (raw === undefined) return undefined;
  const matched = matchEnum(raw, allowed);
  if (matched === undefined) {
    issues.push(`"${field}" must be one of: ${allowed.join(', ')}. Received "${raw}".`);
    return undefined;
  }
  return matched;
}

export function enumList(
  value: unknown,
  field: string,
  allowed: readonly string[],
  issues: Issues
): string[] | undefined {
  const raw = stringList(value, field, issues);
  if (raw === undefined) return undefined;
  const out: string[] = [];
  for (const item of raw) {
    const matched = matchEnum(item, allowed);
    if (matched === undefined) {
      issues.push(`"${field}" must be one of: ${allowed.join(', ')}. Received "${item}".`);
      continue;
    }
    if (!out.includes(matched)) out.push(matched);
  }
  return out.length > 0 ? out : undefined;
}

/** `true`/`false`, plus the string and 0/1 forms a model sends. Anything else is an issue. */
export function boolValue(value: unknown, field: string, issues: Issues): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && (value === 0 || value === 1)) return value === 1;
  if (typeof value === 'string') {
    const lower = value.trim().toLowerCase();
    if (lower === 'true' || lower === 'yes') return true;
    if (lower === 'false' || lower === 'no') return false;
  }
  issues.push(`"${field}" must be true or false.`);
  return undefined;
}

/**
 * A bounded integer. Out-of-range values are CLAMPED rather than refused.
 *
 * Clamping is right here and refusing would not be: `limit: 500` is a model asking for more than
 * we will give, not a malformed request, and answering with 50 rows plus a note is more useful than
 * an error it has to recover from. A non-numeric value IS an issue, because silently substituting
 * the default for `limit: "lots"` hides a real misunderstanding.
 */
export function intValue(
  value: unknown,
  field: string,
  bounds: { default: number; max: number },
  issues: Issues
): number {
  if (value === undefined || value === null) return bounds.default;

  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^-?\d+$/.test(value.trim())
        ? Number(value.trim())
        : NaN;

  if (!Number.isFinite(numeric)) {
    issues.push(`"${field}" must be an integer.`);
    return bounds.default;
  }
  return Math.min(bounds.max, Math.max(1, Math.trunc(numeric)));
}

/**
 * A date argument, resolved in IST.
 *
 * ── A BARE `YYYY-MM-DD` IS IST MIDNIGHT, NOT UTC MIDNIGHT, AND THE DIFFERENCE IS HALF A DAY ──
 * `new Date('2026-09-12')` is 00:00 UTC, which is 05:30 IST — so a caller asking for the 12th would
 * get 05:30 on the 12th through 05:29 on the 13th. That is precisely the defect CLAUDE.md §7
 * records for the calendar's day panel ("a half-day-shifted list under a heading naming the right
 * day"), and it is invisible in testing from any machine set to IST. A bare date is therefore
 * completed to `T00:00:00+05:30` explicitly.
 *
 * `inclusiveEnd` exists because `buildEventFilter` treats `to` as an EXCLUSIVE upper bound while
 * a human (and a model) reading `dateTo: "2026-09-14"` means "through the 14th". For the end of a
 * range a bare date advances one IST day, so the whole named day is included. A value carrying its
 * own time is taken literally in both directions — someone who wrote a time meant it.
 */
const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/;

function dateValue(
  value: unknown,
  field: string,
  issues: Issues,
  { inclusiveEnd = false }: { inclusiveEnd?: boolean } = {}
): Date | undefined {
  const raw = boundedString(value, field, issues);
  if (raw === undefined) return undefined;

  if (BARE_DATE.test(raw)) {
    const start = new Date(`${raw}T00:00:00+05:30`);
    if (Number.isNaN(start.getTime())) {
      issues.push(`"${field}" is not a valid date. Use YYYY-MM-DD or a full ISO timestamp.`);
      return undefined;
    }
    if (inclusiveEnd) start.setUTCDate(start.getUTCDate() + 1);
    return start;
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    issues.push(`"${field}" is not a valid date. Use YYYY-MM-DD or a full ISO timestamp.`);
    return undefined;
  }
  return parsed;
}

/* ────────────────────────────── tool arguments ────────────────────────────── */

export interface SearchEventsArgs {
  query?: string;
  category?: string[];
  area?: string[];
  when?: McpWhen;
  dateFrom?: Date;
  dateTo?: Date;
  format?: McpFormat;
  free?: boolean;
  sort?: McpSort;
  limit: number;
}

export function parseSearchEventsArgs(raw: unknown): Validated<SearchEventsArgs> {
  const args = asRecord(raw);
  const issues: Issues = [];

  const value: SearchEventsArgs = {
    query: boundedString(args.query, 'query', issues),
    category: enumList(args.category, 'category', MCP_CATEGORIES, issues),
    area: enumList(args.area, 'area', MCP_AREAS, issues),
    when: enumValue(args.when, 'when', MCP_WHEN, issues) as McpWhen | undefined,
    dateFrom: dateValue(args.dateFrom, 'dateFrom', issues),
    dateTo: dateValue(args.dateTo, 'dateTo', issues, { inclusiveEnd: true }),
    format: enumValue(args.format, 'format', MCP_FORMATS, issues) as McpFormat | undefined,
    free: boolValue(args.free, 'free', issues),
    sort: enumValue(args.sort, 'sort', MCP_SORTS, issues) as McpSort | undefined,
    limit: intValue(args.limit, 'limit', RESULT_LIMITS, issues),
  };

  // A reversed range returns zero rows and reads as "there is nothing on", which is a wrong answer
  // rather than an empty one. Name it instead.
  if (value.dateFrom && value.dateTo && value.dateTo <= value.dateFrom) {
    issues.push('"dateTo" must be after "dateFrom".');
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true, value };
}

export interface GetEventArgs {
  /** Exactly one of these is set. */
  id?: string;
  slug?: string;
}

/** A Mongo ObjectId in hex. Checked here so a bad id is a named argument error, not a cast throw. */
const OBJECT_ID = /^[0-9a-fA-F]{24}$/;

/**
 * `get_event` takes an id OR a slug, and requires exactly one.
 *
 * Accepting both and preferring one silently would make a caller that sent a mismatched pair
 * believe it fetched the event it named. Accepting neither would return an arbitrary document.
 *
 * A FULL EVENT URL IS ACCEPTED IN `id`, because that is what a model has to hand: it read
 * `https://…/events/68b1…` out of a previous `search_events` result, and asking it to strip the
 * path is a round trip wasted. Only the trailing segment is taken, and it still has to be a valid
 * ObjectId.
 */
export function parseGetEventArgs(raw: unknown): Validated<GetEventArgs> {
  const args = asRecord(raw);
  const issues: Issues = [];

  const idRaw = boundedString(args.id, 'id', issues);
  const slug = boundedString(args.slug, 'slug', issues);

  let id: string | undefined;
  if (idRaw !== undefined) {
    const tail = idRaw.split(/[/?#]/).filter(Boolean).pop() ?? idRaw;
    if (OBJECT_ID.test(tail)) {
      id = tail.toLowerCase();
    } else {
      issues.push('"id" must be a 24-character event id, or a PulseBLR event URL containing one.');
    }
  }

  if (id === undefined && slug === undefined) {
    issues.push('Provide either "id" (a 24-character event id) or "slug".');
  } else if (id !== undefined && slug !== undefined) {
    issues.push('Provide "id" or "slug", not both.');
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: id !== undefined ? { id } : { slug } };
}

export interface EventsNearArgs {
  area: string[];
  when?: McpWhen;
  limit: number;
}

export function parseEventsNearArgs(raw: unknown): Validated<EventsNearArgs> {
  const args = asRecord(raw);
  const issues: Issues = [];

  const area = enumList(args.area, 'area', MCP_AREAS, issues);
  const when = enumValue(args.when, 'when', MCP_WHEN, issues) as McpWhen | undefined;
  const limit = intValue(args.limit, 'limit', RESULT_LIMITS, issues);

  if (area === undefined && !issues.some(i => i.startsWith('"area"'))) {
    issues.push(`"area" is required. One of: ${MCP_AREAS.join(', ')}.`);
  }

  if (issues.length > 0 || area === undefined) {
    return { ok: false, issues: issues.length > 0 ? issues : ['"area" is required.'] };
  }
  return { ok: true, value: { area, when, limit } };
}

export interface TrendingTopicsArgs {
  when?: McpWhen;
  limit: number;
}

export function parseTrendingTopicsArgs(raw: unknown): Validated<TrendingTopicsArgs> {
  const args = asRecord(raw);
  const issues: Issues = [];

  const value: TrendingTopicsArgs = {
    when: enumValue(args.when, 'when', MCP_WHEN, issues) as McpWhen | undefined,
    limit: intValue(args.limit, 'limit', TOPIC_LIMITS, issues),
  };

  return issues.length > 0 ? { ok: false, issues } : { ok: true, value };
}

/** Arguments may legitimately be absent; anything non-object is treated as absent-with-a-complaint
 *  by the individual field readers, which each name their own field. */
export function asRecord(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return {};
}
