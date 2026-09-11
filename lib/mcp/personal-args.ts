// Argument validation for the FOUR AUTHENTICATED tools. PURE — no mongoose, no network.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// EVERY PRIMITIVE HERE IS IMPORTED FROM `args.ts`, NOT REDEFINED. Read the block above the
// primitives in that file before adding anything: these values reach a Mongo query scoped to one
// person's private contacts, so the object-in-a-value-position guard matters strictly more here than
// it does on the public tools, where the worst case is an event that is on a public web page anyway.
//
// NOTE WHAT IS ABSENT FROM EVERY SHAPE IN THIS FILE: a `userId`, a `user`, an `email`, an `as`. The
// caller cannot name whose data it wants, and there is no argument it could pass to try. Identity
// arrives from the verified token and is threaded to the handlers as a REQUIRED POSITIONAL parameter
// — see `personal-handlers.ts`. If a future tool here ever accepts an identifier that selects a
// person's data, that is the moment this server acquires an authorisation bug.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import { TRACKER_STATUSES } from '../tracker/validate';
import type { PersonSort } from '../people/query';
import {
  MCP_WHEN,
  asRecord,
  boolValue,
  boundedString,
  enumList,
  enumValue,
  intValue,
  type Issues,
  type McpWhen,
  type Validated,
} from './args';

/**
 * Result caps for the personal tools.
 *
 * Higher default than the public tools' 10, lower max than their 50, and both differ on purpose. A
 * question like "who do I know at Razorpay" wants the WHOLE answer — five of six people is a wrong
 * answer, not a truncated one — so the default is 25. The ceiling is 100 rather than 50 because these
 * rows are much smaller than an event row (a name, a company, a date) and because the set is bounded
 * by how many people one human has actually met, which is not the open-ended corpus the public tools
 * page through.
 */
export const PERSONAL_LIMITS = { default: 25, max: 100 } as const;

/** The statuses a tracker entry can hold, from the app's own vocabulary — never retyped. */
export const MCP_TRACKER_STATUSES: readonly string[] = TRACKER_STATUSES;

/**
 * How `my_people` may be ordered.
 *
 * `satisfies readonly PersonSort[]` is the drift guard: these strings are passed straight to
 * `buildPersonSort`, and if that module renames a sort key this array stops type-checking instead of
 * silently producing an unsorted query. A hand-copied list with no such check is how the schema and
 * the sorter would part company — nothing fails when a sort key merely does not match, the rows just
 * come back in natural order.
 */
export const MY_PEOPLE_SORTS = [
  'recent',
  'oldest',
  'name',
  'company',
  'followUp',
  'met',
] as const satisfies readonly PersonSort[];

export type MyPeopleSort = (typeof MY_PEOPLE_SORTS)[number];

/**
 * How far ahead `my_follow_ups` will look.
 *
 * 0 is OVERDUE ONLY, which is `getPendingFollowUps`'s own default and the honest answer to "what
 * have I dropped". The digest passes 3. The cap is 30 because a follow-up set further out than a
 * month is a calendar entry, not a debt.
 */
export const FOLLOW_UP_HORIZON = { default: 0, max: 30 } as const;

/* ────────────────────────────── my_saved_events ────────────────────────────── */

export interface MySavedEventsArgs {
  status?: string[];
  when?: McpWhen;
  includePast: boolean;
  limit: number;
}

export function parseMySavedEventsArgs(raw: unknown): Validated<MySavedEventsArgs> {
  const args = asRecord(raw);
  const issues: Issues = [];

  const value: MySavedEventsArgs = {
    status: enumList(args.status, 'status', MCP_TRACKER_STATUSES, issues),
    when: enumValue(args.when, 'when', MCP_WHEN, issues) as McpWhen | undefined,
    /**
     * Defaults to FALSE, so the tool answers "what have I got coming up" unless asked otherwise.
     * `boolValue` returns undefined for an absent argument, and `?? false` is the default — not
     * `Boolean(...)`, which would also turn an explicit `false` into false by accident and hide the
     * difference between "not asked" and "asked for no".
     */
    includePast: boolValue(args.includePast, 'includePast', issues) ?? false,
    limit: intValue(args.limit, 'limit', PERSONAL_LIMITS, issues),
  };

  return issues.length > 0 ? { ok: false, issues } : { ok: true, value };
}

/* ────────────────────────────── my_people ────────────────────────────── */

export interface MyPeopleArgs {
  query?: string;
  company?: string;
  tag?: string;
  targetOnly?: boolean;
  followUpDue?: boolean;
  repeatOnly?: boolean;
  sort?: MyPeopleSort;
  limit: number;
}

export function parseMyPeopleArgs(raw: unknown): Validated<MyPeopleArgs> {
  const args = asRecord(raw);
  const issues: Issues = [];

  const value: MyPeopleArgs = {
    query: boundedString(args.query, 'query', issues),
    /**
     * `company` is NOT an enum here, and that is not laxity.
     *
     * `buildPersonFilter` matches it EXACTLY against `Person.companies[]`, whose values are canonical
     * registry names. A model asked "who do I know at razorpay" will send the user's spelling, not
     * the registry's — so the handler resolves it case-insensitively against the companies this user
     * actually has people at, and says what those are when nothing matches. Validating against the
     * 375-name registry here instead would refuse a company the registry has never heard of, which
     * is precisely the long tail `Contact.tags` exists for.
     */
    company: boundedString(args.company, 'company', issues),
    tag: boundedString(args.tag, 'tag', issues),
    targetOnly: boolValue(args.targetOnly, 'targetOnly', issues),
    followUpDue: boolValue(args.followUpDue, 'followUpDue', issues),
    repeatOnly: boolValue(args.repeatOnly, 'repeatOnly', issues),
    sort: enumValue(args.sort, 'sort', MY_PEOPLE_SORTS, issues) as MyPeopleSort | undefined,
    limit: intValue(args.limit, 'limit', PERSONAL_LIMITS, issues),
  };

  return issues.length > 0 ? { ok: false, issues } : { ok: true, value };
}

/* ────────────────────────────── who_did_i_meet_at ────────────────────────────── */

export interface WhoDidIMeetAtArgs {
  event: string;
  limit: number;
}

export function parseWhoDidIMeetAtArgs(raw: unknown): Validated<WhoDidIMeetAtArgs> {
  const args = asRecord(raw);
  const issues: Issues = [];

  const event = boundedString(args.event, 'event', issues);
  const limit = intValue(args.limit, 'limit', PERSONAL_LIMITS, issues);

  // Only complain about absence if the field-level reader has not already complained about its type,
  // so `{event: {$ne: null}}` yields one clear issue rather than two contradictory ones.
  if (event === undefined && !issues.some(i => i.startsWith('"event"'))) {
    issues.push('"event" is required — the name of the event or folder, or part of it.');
  }

  if (issues.length > 0 || event === undefined) {
    return { ok: false, issues: issues.length > 0 ? issues : ['"event" is required.'] };
  }
  return { ok: true, value: { event, limit } };
}

/* ────────────────────────────── my_follow_ups ────────────────────────────── */

export interface MyFollowUpsArgs {
  includeUpcomingDays: number;
  limit: number;
}

export function parseMyFollowUpsArgs(raw: unknown): Validated<MyFollowUpsArgs> {
  const args = asRecord(raw);
  const issues: Issues = [];

  /**
   * `intValue` clamps to a minimum of 1, which is wrong for a HORIZON where 0 is the meaningful
   * default (overdue only). So an absent argument short-circuits to the default rather than going
   * through the clamp — a deliberate divergence from every other numeric argument in this server,
   * and the reason this is not a one-liner.
   */
  const includeUpcomingDays =
    args.includeUpcomingDays === undefined || args.includeUpcomingDays === null
      ? FOLLOW_UP_HORIZON.default
      : intValue(
          args.includeUpcomingDays,
          'includeUpcomingDays',
          { default: FOLLOW_UP_HORIZON.default, max: FOLLOW_UP_HORIZON.max },
          issues
        );

  const limit = intValue(args.limit, 'limit', PERSONAL_LIMITS, issues);

  return issues.length > 0
    ? { ok: false, issues }
    : { ok: true, value: { includeUpcomingDays, limit } };
}
