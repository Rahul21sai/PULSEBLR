/**
 * What an admin may change on a stored event, and what it must look like.
 *
 * WHY AN ALLOWLIST AND NOT A DENYLIST. `PUT /api/events/[id]` used to do
 * `Event.findByIdAndUpdate(id, { $set: body })` having deleted exactly one key, `dedupHash`.
 * That was survivable only because the sole caller sent two booleans and a date. The moment a
 * real edit form exists, a raw `$set` becomes a way to corrupt the corpus from a typo:
 *
 *   · `clusterKey` / `dedupHash` are IDENTITY. Rewriting either detaches the document from its
 *     own cluster, so the next scrape stores a second copy and the feed shows the event twice.
 *   · `source` / `seenInSources` / `lastSeenAt` are PROVENANCE. `pruneStale()` deletes past events
 *     no source has reported for a week, so an edited `lastSeenAt` changes when a row is deleted.
 *   · `companies`, `connectionScore`, `tagConfidence`, `isTargetCompany` and `recruiterMentioned`
 *     are DERIVED — recomputed by `backfill-companies.ts` / `backfill-connection-score.ts` from
 *     other fields. Hand-editing them produces a value the next backfill silently reverts, which
 *     is worse than not offering it: the admin sees their change land and then vanish.
 *
 * A denylist would have to be updated every time the schema grows a field, and the failure mode
 * of forgetting is "this field is now editable". An allowlist fails the other way — a new field
 * is simply not editable until someone adds it, which is a bug report rather than data loss.
 *
 * `spotlightAt` IS here, and it is the one editorial field: a human chose it, so nothing
 * recomputes it. See the Spotlight notes in CLAUDE.md §7.
 *
 * Pure on purpose — no database, no network — so `tests/event-admin-validate.test.ts` can pin the
 * rejections without a server, the same arrangement as `lib/tracker/validate.ts`.
 */
import { EVENT_CATEGORIES } from '../event-types';

/** Every field an admin may edit, with how to coerce and check it. */
const TEXT_FIELDS = [
  'title',
  'description',
  'organizer',
  'venue',
  'address',
  'area',
  'city',
  'timezone',
  'currency',
] as const;

const URL_FIELDS = ['sourceUrl', 'imageUrl', 'applyLink', 'onlineLink'] as const;
const DATE_FIELDS = ['startDateTime', 'endDateTime', 'registrationDeadline', 'spotlightAt'] as const;
const BOOLEAN_FIELDS = ['isFree', 'soldOut', 'isTechEvent'] as const;
const NUMBER_FIELDS = ['price', 'priceMax', 'attendeeCount', 'capacity', 'guestCount'] as const;

const FORMATS = ['online', 'offline', 'hybrid'] as const;
const HAS_FOOD = ['yes', 'no', 'unknown'] as const;

/** Longest value each text field may hold. A description is long; a city name is not. */
const TEXT_MAX: Record<string, number> = {
  title: 300,
  description: 20000,
  organizer: 200,
  venue: 300,
  address: 500,
  area: 120,
  city: 120,
  timezone: 60,
  currency: 8,
};

export interface EventFieldIssue {
  field: string;
  message: string;
}

export interface EventValidationResult {
  /** The `$set` payload — only allowlisted, coerced values. */
  update: Record<string, unknown>;
  issues: EventFieldIssue[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate and coerce an admin event edit.
 *
 * Unknown keys are IGNORED rather than rejected, and that is deliberate: the admin form round-trips
 * a whole event object including derived fields it never intends to change, so erroring on their
 * presence would make every save fail. Silently dropping them is what makes the allowlist usable.
 */
export function validateEventUpdate(body: unknown): EventValidationResult {
  const issues: EventFieldIssue[] = [];
  const update: Record<string, unknown> = {};

  if (!isPlainObject(body)) {
    return { update, issues: [{ field: 'body', message: 'must be a JSON object' }] };
  }

  for (const field of TEXT_FIELDS) {
    if (!(field in body)) continue;
    const raw = body[field];
    if (raw === null || raw === '') {
      // `title` and `description` are `required` in the schema, so clearing them would be
      // rejected by Mongoose as a 500 rather than reported as the admin's mistake.
      if (field === 'title' || field === 'description') {
        issues.push({ field, message: 'cannot be empty' });
      } else {
        update[field] = undefined;
      }
      continue;
    }
    if (typeof raw !== 'string') {
      issues.push({ field, message: 'must be text' });
      continue;
    }
    const trimmed = raw.trim();
    if ((field === 'title' || field === 'description') && !trimmed) {
      issues.push({ field, message: 'cannot be empty' });
      continue;
    }
    if (trimmed.length > TEXT_MAX[field]) {
      issues.push({ field, message: `must be ${TEXT_MAX[field]} characters or fewer` });
      continue;
    }
    update[field] = field === 'currency' ? trimmed.toUpperCase() : trimmed;
  }

  for (const field of URL_FIELDS) {
    if (!(field in body)) continue;
    const raw = body[field];
    if (raw === null || raw === '') {
      if (field === 'sourceUrl') {
        issues.push({ field, message: 'cannot be empty' });
      } else {
        update[field] = undefined;
      }
      continue;
    }
    if (typeof raw !== 'string') {
      issues.push({ field, message: 'must be a URL' });
      continue;
    }
    // http(s) only. A `javascript:` value here would be rendered into an href on the event page.
    let parsed: URL;
    try {
      parsed = new URL(raw.trim());
    } catch {
      issues.push({ field, message: 'must be a full URL including https://' });
      continue;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      issues.push({ field, message: 'must be http or https' });
      continue;
    }
    update[field] = parsed.toString();
  }

  for (const field of DATE_FIELDS) {
    if (!(field in body)) continue;
    const raw = body[field];
    if (raw === null || raw === '') {
      // Null is meaningful for spotlightAt: the route can only `$set`, and the home page filters
      // on `{ $type: 'date' }`, so an explicit null reads as "not pinned". See CLAUDE.md §7.
      if (field === 'startDateTime') {
        issues.push({ field, message: 'cannot be empty' });
      } else {
        update[field] = null;
      }
      continue;
    }
    if (typeof raw !== 'string' && !(raw instanceof Date)) {
      issues.push({ field, message: 'must be a date' });
      continue;
    }
    const parsed = raw instanceof Date ? raw : new Date(raw);
    if (Number.isNaN(parsed.getTime())) {
      issues.push({ field, message: 'is not a valid date' });
      continue;
    }
    update[field] = parsed;
  }

  /*
   * END BEFORE START is the one cross-field check worth making here.
   *
   * Nothing in the schema forbids it, and `lib/events/query.ts` treats an event as ongoing when
   * it has started and not yet ended — so a backwards range makes an event that can never be
   * "now" and sorts strangely. Only checked when both values are known after coercion, which
   * includes the case where only one of the two was submitted.
   */
  const nextStart = update.startDateTime instanceof Date ? update.startDateTime : undefined;
  const nextEnd = update.endDateTime instanceof Date ? update.endDateTime : undefined;
  if (nextStart && nextEnd && nextEnd.getTime() < nextStart.getTime()) {
    issues.push({ field: 'endDateTime', message: 'must be after the start time' });
  }

  for (const field of BOOLEAN_FIELDS) {
    if (!(field in body)) continue;
    const raw = body[field];
    if (typeof raw !== 'boolean') {
      issues.push({ field, message: 'must be true or false' });
      continue;
    }
    update[field] = raw;
  }

  for (const field of NUMBER_FIELDS) {
    if (!(field in body)) continue;
    const raw = body[field];
    if (raw === null || raw === '') {
      update[field] = undefined;
      continue;
    }
    const num = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(num)) {
      issues.push({ field, message: 'must be a number' });
      continue;
    }
    if (num < 0) {
      issues.push({ field, message: 'cannot be negative' });
      continue;
    }
    update[field] = num;
  }

  if ('format' in body) {
    const raw = body.format;
    if (typeof raw !== 'string' || !(FORMATS as readonly string[]).includes(raw)) {
      issues.push({ field: 'format', message: `must be one of ${FORMATS.join(', ')}` });
    } else {
      update.format = raw;
    }
  }

  if ('hasFood' in body) {
    const raw = body.hasFood;
    if (typeof raw !== 'string' || !(HAS_FOOD as readonly string[]).includes(raw)) {
      issues.push({ field: 'hasFood', message: `must be one of ${HAS_FOOD.join(', ')}` });
    } else {
      update.hasFood = raw;
    }
  }

  /*
   * `category` is checked against EVENT_CATEGORIES — the same list the schema's enum is built
   * from — so an unknown value is reported as the admin's typo rather than surfacing as a
   * Mongoose ValidationError turned 500. Named individually, because "category is invalid" does
   * not tell you WHICH of six chips is wrong.
   */
  if ('category' in body) {
    const raw = body.category;
    if (!Array.isArray(raw)) {
      issues.push({ field: 'category', message: 'must be a list' });
    } else {
      const allowed = EVENT_CATEGORIES as readonly string[];
      const bad = raw.filter(c => typeof c !== 'string' || !allowed.includes(c));
      if (bad.length) {
        issues.push({ field: 'category', message: `unknown categories: ${bad.join(', ')}` });
      } else {
        update.category = [...new Set(raw as string[])];
      }
    }
  }

  if ('tags' in body) {
    const raw = body.tags;
    if (!Array.isArray(raw)) {
      issues.push({ field: 'tags', message: 'must be a list' });
    } else {
      update.tags = [
        ...new Set(
          raw
            .filter((t): t is string => typeof t === 'string')
            .map(t => t.trim())
            .filter(Boolean)
            .slice(0, 20)
        ),
      ];
    }
  }

  return { update, issues };
}

/** The 400 body: names every bad field, and leaks no Mongoose wording. */
export function eventValidationError(issues: EventFieldIssue[]) {
  return {
    error: issues.length === 1
      ? `${issues[0].field} ${issues[0].message}`
      : `${issues.length} fields are invalid`,
    fields: issues,
  };
}
