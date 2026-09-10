/**
 * Follow-up dates in IST, and the request contract for editing a batch of captures at once.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WHY A DATE INPUT NEEDS A MODULE AT ALL. `<input type="date">` holds `YYYY-MM-DD` — wall-clock
 * text with no zone in it. Hand that to Mongoose and it casts to UTC MIDNIGHT, which is 05:30 IST
 * the same morning: 5½ hours into a day the user picked, and 18½ hours short of its end. Nothing
 * visibly breaks, which is the problem. The stored instant sits close enough to the IST midnight
 * boundary that anything reading it in another zone, or subtracting hours from it, reports the
 * PREVIOUS day — a reminder set for 1 April surfacing as 31 March. That is why
 * `app/components/scan/ContactFields.tsx` shipped with four presets and no way to say "3 March".
 *
 * THE RULE HERE: a follow-up day is `YYYY-MM-DD` in **IST**, and its instant is **noon IST** —
 * twelve hours clear of both midnights, so no plausible re-reading of it lands on a neighbouring
 * day. Two existing modules already own the halves of that conversion and are composed rather than
 * re-implemented: `dayKeyIST` (`lib/format.ts`, `Intl` pinned to Asia/Kolkata) turns an instant
 * into its IST day, and `fromISTInputValue` (`lib/ist-datetime-input.ts`, a fixed +05:30) turns IST
 * wall-clock text into an instant. Neither reads the machine's clock, so every function below gives
 * the same answer on a laptop set to UTC, to Auckland, or to Los Angeles.
 *
 * THE ONE EXCEPTION TO NOON, and the reason `nowMs` is a parameter. Noon on the CURRENT IST day has
 * usually already gone — you come back from a conference in the afternoon — and storing a past
 * instant would file the reminder as already overdue the moment it was created. So today clamps
 * forward to the last minute of the IST day: still today, still not overdue. A day that is entirely
 * behind us returns `null` rather than guessing, which is also how a past date typed into the input
 * gets refused.
 *
 * WHY THE BULK CONTRACT LIVES HERE TOO. A bulk follow-up write is this same rule applied to many
 * rows, and the conversion must run on the SERVER — a client that sent `2026-03-01` raw, or an old
 * build of this app replaying a queued body, would otherwise store 05:30 IST. So the validator takes
 * the day string and returns the instant, which makes storing the wrong instant unreachable rather
 * than merely discouraged. Pure, so `tests/follow-up.test.ts` pins it with no server and no database,
 * following `lib/tracker/validate.ts`.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 */

import { dayKeyIST } from '../format';
import { fromISTInputValue } from '../ist-datetime-input';
import { isObjectIdLike, MAX_TAG_LENGTH, type Validated } from '../person-types';

/** The hour a reminder lands on, in IST. Noon: maximum clearance from both midnights. */
const FOLLOW_UP_HOUR_IST = '12:00';

/**
 * The fallback time for TODAY, once noon has gone. `23:59` rather than `23:59:59.999` so the stored
 * instant is a real clock minute — it renders as `23:59` through `timeIST` instead of as a value
 * that looks like a rounding artefact. The cost is the final sixty seconds of the IST day, in which
 * "today" is refused as a past day. Nobody sets a reminder at 23:59:30 for today.
 */
const END_OF_DAY_IST = '23:59';

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Today's IST day, as the `YYYY-MM-DD` an `<input type="date">` holds. */
export function todayDayIST(nowMs: number = Date.now()): string {
  return dayKeyIST(new Date(nowMs));
}

/**
 * `days` IST calendar days after the IST day containing `nowMs`.
 *
 * The arithmetic runs through `Date.UTC`, where it is pure calendar maths with no zone in it — the
 * same reasoning `app/calendar/page.tsx` records for its month grid. Adding milliseconds to the
 * instant instead would be correct for IST (no DST) and would still be the wrong habit to copy.
 */
export function dayOffsetIST(days: number, nowMs: number = Date.now()): string {
  return shiftDay(todayDayIST(nowMs), days);
}

/** A `YYYY-MM-DD` shifted by whole calendar days. Rolls over months and years. */
function shiftDay(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d) + days * MS_PER_DAY);
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

/**
 * An IST day → the instant to store, as a UTC ISO string. `null` when the day is not a real date or
 * has already passed.
 *
 * Noon IST normally; the last minute of the day when noon has gone but the day has not. See the
 * header for why both branches exist.
 */
export function followUpInstantForDay(
  day: unknown,
  nowMs: number = Date.now()
): string | null {
  if (typeof day !== 'string' || !DAY_KEY.test(day)) return null;

  const noon = fromISTInputValue(`${day}T${FOLLOW_UP_HOUR_IST}`);
  if (!noon) return null;

  /**
   * THE CALENDAR CHECK, and it is not belt-and-braces. `Date.UTC(2026, 1, 30)` — inside
   * `fromISTInputValue` — silently rolls 30 February onto 2 March rather than refusing it, so a
   * malformed body would store a reminder on a day the caller never named. Asking whether the
   * instant lands back on the day we asked for catches every impossible date with one comparison,
   * and it asks the question in the units that matter: the IST day.
   */
  if (dayKeyIST(noon) !== day) return null;

  if (Date.parse(noon) > nowMs) return noon;

  const endOfDay = fromISTInputValue(`${day}T${END_OF_DAY_IST}`);
  if (endOfDay && Date.parse(endOfDay) > nowMs) return endOfDay;

  // The whole IST day is behind us. Refused rather than stored as instantly-overdue.
  return null;
}

/**
 * The preset offsets, as an instant. `days` is counted in IST calendar days, so "tomorrow" means
 * tomorrow in Bengaluru whatever the browser's clock says.
 */
export function followUpInstantInDays(days: number, nowMs: number = Date.now()): string | null {
  return followUpInstantForDay(dayOffsetIST(days, nowMs), nowMs);
}

/**
 * A stored follow-up → the IST day it falls on, as `YYYY-MM-DD`. `''` when there is none.
 *
 * This is what the date input is filled from, and what the preset chips compare against. Comparing
 * ISO string prefixes instead — which the version this replaces did — reads the **UTC** day, so a
 * reminder stored at 21:00 IST matched the day before and no chip lit up.
 */
export function followUpDayIST(value: string | Date | null | undefined): string {
  if (!value) return '';
  const at = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(at.getTime())) return '';
  return dayKeyIST(at);
}

/* ────────────────────────── the bulk-edit request contract ────────────────────────── */

/**
 * A real cap, not a formality. The route loads every matched capture as a DOCUMENT — `Contact`'s
 * `contactKey` hook is `pre('validate')`, which does not run on `updateOne` or `bulkWrite`, so each
 * row is saved individually. 200 is well past a conference's worth of scans, which is the case this
 * exists for: coming home with forty people and tagging them one edit sheet at a time is forty
 * sheets.
 */
export const MAX_BULK_CONTACTS = 200;

/** Tags per request. Matches `MAX_TAGS_PER_CONTACT`, which is what canonicalisation emits. */
export const MAX_BULK_TAGS = 20;

/**
 * A discriminated union rather than one wide object with optional fields.
 *
 * The three actions write disjoint sets of fields, and a flat shape lets a caller send a `folderId`
 * with `action: 'tag'` and be quietly ignored — which is how a move that did nothing gets reported
 * as a move that worked. Nothing here is optional, so the route cannot read a field the validator
 * did not decide.
 */
export type ContactBulkRequest =
  | { action: 'tag'; contactIds: string[]; add: string[]; remove: string[] }
  /** `followUpAt` is the resolved INSTANT, already converted from the caller's IST day. */
  | { action: 'followUp'; contactIds: string[]; followUpAt: string | null }
  | { action: 'move'; contactIds: string[]; folderId: string };

/**
 * Validate a bulk-edit body. Never throws; returns the first problem with the field it is about.
 *
 * IDS ARE CHECKED FOR SHAPE ONLY, and that must not start looking like an ownership check. The route
 * filters `{ _id: { $in: ids }, userId }`, so a foreign id cannot widen the write — it fails to
 * match and contributes nothing. Putting ownership here would need a database read inside a pure
 * function and, worse, would invite the route to trust the verdict instead of scoping its own query.
 *
 * A MALFORMED ID IS REFUSED, NOT SKIPPED. Skipping would answer 200 for a request that changed fewer
 * people than it named, with no way for the caller to tell which.
 *
 * TAGS ARE NOT CANONICALISED HERE. `canonicaliseTags()` lives in `lib/contacts/service.ts`, which
 * imports mongoose, so it cannot be reached from a module the browser loads — and a second
 * lowercaser is precisely how `"AI/ML"` and `"ai/ml"` become two chips for one idea. Shape here, the
 * one canonicaliser in the route.
 */
export function validateContactBulk(
  input: unknown,
  nowMs: number = Date.now()
): Validated<ContactBulkRequest> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return bad('Expected a JSON object');
  }
  const body = input as Record<string, unknown>;

  /**
   * OWN PROPERTIES ONLY, following `lib/tracker/validate.ts`. `JSON.parse` cannot actually hand over
   * an inherited field — `{"__proto__":{}}` becomes an own property — so this is defence in depth
   * rather than a live hole. It is here because the alternative reads identically and is wrong: a
   * body constructed in-process, or one replayed from the outbox by an older build, is not
   * necessarily a `JSON.parse` result, and a validator that can be answered by a prototype is a
   * validator whose verdict is not about the request.
   */
  const has = (key: string) => Object.prototype.hasOwnProperty.call(body, key);
  const own = (key: string): unknown => (has(key) ? body[key] : undefined);

  const ids = idList(own('contactIds'));
  if (!ids.ok) return ids;
  const contactIds = ids.value;

  switch (own('action')) {
    case 'tag': {
      const add = tagList(own('add'), 'add');
      if (!add.ok) return add;
      const remove = tagList(own('remove'), 'remove');
      if (!remove.ok) return remove;
      if (!add.value.length && !remove.value.length) {
        // Not a no-op success: a request that changes nothing but answers 200 is indistinguishable
        // from one that worked, which is how a typo'd field becomes "bulk tagging is broken".
        return bad('Type a tag to apply or remove', 'add');
      }
      return { ok: true, value: { action: 'tag', contactIds, add: add.value, remove: remove.value } };
    }

    case 'followUp': {
      if (!has('day')) return bad('day is required', 'day');
      // `null` clears the reminder. Distinguished from a missing field so a client cannot clear
      // forty follow-up dates by forgetting to send one.
      if (own('day') === null) {
        return { ok: true, value: { action: 'followUp', contactIds, followUpAt: null } };
      }
      const followUpAt = followUpInstantForDay(own('day'), nowMs);
      if (!followUpAt) {
        return bad('Pick a date that is today or later', 'day');
      }
      return { ok: true, value: { action: 'followUp', contactIds, followUpAt } };
    }

    case 'move': {
      const folderId = own('folderId');
      if (!isObjectIdLike(folderId)) return bad('folderId must be an id', 'folderId');
      return { ok: true, value: { action: 'move', contactIds, folderId } };
    }

    default:
      return bad('action must be one of: tag, followUp, move', 'action');
  }
}

function bad<T>(error: string, field?: string): Validated<T> {
  return field ? { ok: false, error, field } : { ok: false, error };
}

function idList(raw: unknown): Validated<string[]> {
  if (!Array.isArray(raw)) return bad('contactIds must be an array', 'contactIds');
  if (!raw.length) return bad('Select at least one person', 'contactIds');
  if (raw.length > MAX_BULK_CONTACTS) {
    return bad(`Change at most ${MAX_BULK_CONTACTS} people at a time`, 'contactIds');
  }

  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!isObjectIdLike(entry)) return bad('contactIds must all be ids', 'contactIds');
    if (seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }
  return { ok: true, value: out };
}

function tagList(raw: unknown, field: 'add' | 'remove'): Validated<string[]> {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return bad(`${field} must be an array`, field);
  if (raw.length > MAX_BULK_TAGS) {
    return bad(`${field} must have ${MAX_BULK_TAGS} entries or fewer`, field);
  }

  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') return bad(`${field} entries must be text`, field);
    const trimmed = entry.trim();
    if (trimmed.length > MAX_TAG_LENGTH) {
      return bad(`a tag must be ${MAX_TAG_LENGTH} characters or fewer`, field);
    }
    // Blanks dropped rather than refused: an empty chip is somebody mid-typing, not a reason to
    // fail a batch of forty people.
    if (trimmed) out.push(trimmed);
  }
  return { ok: true, value: out };
}
