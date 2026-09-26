import { EVENT_CATEGORIES } from '../event-types';

/**
 * Validate and ALLOWLIST the body of a hand-entered event.
 *
 * Pure — no Mongoose, no I/O — so `tests/` pins it without a database, and so a bad request is
 * refused before `connectDB()` is even called. Same arrangement as `lib/tracker/validate.ts`, and
 * for the same two reasons: a client's typo must not be reported as a 500, and a rejection must not
 * echo Mongoose's wording back to the caller.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THIS IS AN ALLOWLIST, NOT A CLEANUP, AND THAT IS THE WHOLE POINT.
 *
 * `POST /api/events` used to build its document with `{ ...body }`. That was survivable while the
 * route was admin-only; the moment any signed-in user can create an event it is three separate
 * privilege escalations, all through the request body:
 *
 *   1. `dedupHash` — the route accepted `body.dedupHash || generate(...)`. A user could pre-claim
 *      the hash of an event not yet scraped; the next run would then MERGE the real public event
 *      into their private document instead of inserting it, and count it as a success. The city
 *      loses the event and the scrape reports nothing wrong.
 *   2. `visibility` and `createdByUserId` — settable directly, so a submission could publish itself
 *      without review, or be assigned to somebody else's account.
 *   3. `spotlightAt` and `connectionScore` — a user could pin their own event into the home page
 *      Spotlight with a perfect score. `spotlightAt` is the one field CLAUDE.md describes as
 *      editorial, human-chosen, and recomputed by nothing.
 *
 * So the derived, editorial and provenance fields are not sanitised, they are simply not accepted:
 * `dedupHash`, `clusterKey`, `source`, `sourceEventId`, `spotlightAt`, `connectionScore`,
 * `companies`, `isTechEvent`, `tagConfidence`, `lastSeenAt`, `seenInSources`, `createdByUserId`,
 * `visibility`, `isTargetCompany`, `recruiterMentioned`. Anything not named in `TEXT_FIELDS` or
 * handled explicitly below is dropped, so a field added to the schema later is not silently
 * writable from the web.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */

/** What the caller is asking for. Defaults to the safest option. */
export type RequestedVisibility = 'private' | 'pending' | 'public';

export interface ManualEventIssue {
  field: string;
  message: string;
}

/** Free-text fields a user may set, with their caps. */
const TEXT_FIELDS: Array<[key: string, max: number]> = [
  ['title', 300],
  ['description', 6000],
  ['organizer', 200],
  ['venue', 300],
  ['address', 500],
  ['area', 100],
  ['city', 100],
  ['onlineLink', 2000],
  ['applyLink', 2000],
  ['sourceUrl', 2000],
  ['imageUrl', 2000],
  ['timezone', 60],
  ['currency', 8],
];

const FORMATS = ['online', 'offline', 'hybrid'] as const;
const FOOD = ['yes', 'no', 'unknown'] as const;

export interface ManualEventFields {
  title: string;
  description: string;
  startDateTime: Date;
  endDateTime?: Date;
  category: string[];
  format: (typeof FORMATS)[number];
  hasFood: (typeof FOOD)[number];
  isFree: boolean;
  price?: number;
  organizer?: string;
  venue?: string;
  address?: string;
  area?: string;
  city?: string;
  onlineLink?: string;
  applyLink?: string;
  sourceUrl?: string;
  imageUrl?: string;
  timezone?: string;
  currency?: string;
  tags: string[];
}

export interface ManualEventResult {
  fields?: ManualEventFields;
  visibility: RequestedVisibility;
  issues: ManualEventIssue[];
}

function str(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

/**
 * Only http(s) URLs are accepted for anything that becomes a link.
 *
 * `app/events/[id]/page.tsx` renders `applyLink` straight into an `href`, so a `javascript:` or
 * `data:` URL there is stored XSS against anybody who opens the event — and for a `pending`
 * submission, against the admin reviewing it. This is the concrete hazard the admin-only guard on
 * this route existed to prevent, so it has to be handled explicitly now that users can post.
 */
function httpUrl(value: unknown, max: number): string | undefined {
  const raw = str(value, max);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? raw : undefined;
  } catch {
    return undefined;
  }
}

const URL_FIELDS = new Set(['onlineLink', 'applyLink', 'sourceUrl', 'imageUrl']);

export function validateManualEvent(body: unknown): ManualEventResult {
  const issues: ManualEventIssue[] = [];
  const input = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;

  // ── Visibility ────────────────────────────────────────────────────────────
  // Defaults to 'private'. A default of 'public' would mean a client that forgot the field
  // published to everybody, which is the wrong way for this to fail.
  let visibility: RequestedVisibility = 'private';
  if (input.visibility !== undefined) {
    if (input.visibility === 'private' || input.visibility === 'pending' || input.visibility === 'public') {
      visibility = input.visibility;
    } else {
      issues.push({
        field: 'visibility',
        message: "visibility must be one of: private, pending, public",
      });
    }
  }

  // ── Required ──────────────────────────────────────────────────────────────
  const title = str(input.title, 300);
  if (!title) issues.push({ field: 'title', message: 'A title is required.' });

  const startRaw = input.startDateTime;
  let startDateTime: Date | undefined;
  if (typeof startRaw === 'string' || startRaw instanceof Date) {
    const parsed = new Date(startRaw);
    if (Number.isNaN(parsed.getTime())) {
      issues.push({ field: 'startDateTime', message: 'That start date is not a valid date.' });
    } else {
      startDateTime = parsed;
    }
  } else {
    issues.push({ field: 'startDateTime', message: 'A start date and time is required.' });
  }

  let endDateTime: Date | undefined;
  if (input.endDateTime !== undefined && input.endDateTime !== null && input.endDateTime !== '') {
    const parsed = new Date(input.endDateTime as string);
    if (Number.isNaN(parsed.getTime())) {
      issues.push({ field: 'endDateTime', message: 'That end date is not a valid date.' });
    } else if (startDateTime && parsed < startDateTime) {
      // Caught here rather than stored: an event ending before it starts renders as a negative
      // duration everywhere and is always a typo.
      issues.push({ field: 'endDateTime', message: 'The end time is before the start time.' });
    } else {
      endDateTime = parsed;
    }
  }

  // ── Category ──────────────────────────────────────────────────────────────
  // Checked against the taxonomy HERE rather than left to the schema enum, which is the same
  // defect the tracker `status` enum had: a bad value became a Mongoose ValidationError, reached
  // the catch-all, and was returned as a 500 quoting the schema path.
  const allowed = new Set<string>(EVENT_CATEGORIES as unknown as string[]);
  const requested = Array.isArray(input.category)
    ? input.category.filter((c): c is string => typeof c === 'string')
    : [];
  const bad = requested.filter(c => !allowed.has(c));
  if (bad.length) {
    issues.push({
      field: 'category',
      message: `Not a category we know: ${bad.slice(0, 3).join(', ')}.`,
    });
  }
  /**
   * AN EMPTY CATEGORY IS PASSED THROUGH AS EMPTY. A VALIDATOR MUST NOT INVENT A CLASSIFICATION.
   *
   * ─────────────────────────────────────────────────────────────────────────────────────────────
   * This line used to read `if (!category.length) category.push('Meetup')`, and that default is the
   * whole of the "I added an event and it never appears on the home page" bug.
   *
   * `'Meetup'` is not a neutral placeholder. It is a GATHERING category deliberately excluded from
   * `TECH_FLAG_CATEGORIES` — its own comment in `lib/event-types.ts` says "not even arguable: 323
   * upcoming rows, mostly Toastmasters, board games and treks". So substituting it turns "the user
   * picked nothing" into a POSITIVE ASSERTION that the event is a non-tech social gathering, the
   * create path correctly derives `isTechEvent: false` from that assertion, and the feed — which is
   * unconditionally `techOnly` — correctly hides it. Every layer behaves; the input was a lie.
   *
   * Measured on the live corpus: 12 of 12 hand-added events owned by a real user were stored
   * `category: ["Meetup"]`, `isTechEvent: false`, and 0 of the 5 future-dated ones matched the feed.
   *
   * The original comment (kept below, because the hazard it names is real) explains why the value
   * was `'Meetup'` rather than the retired `'Networking/Meetup'`: that string was dropped in the
   * 32 → 22 consolidation and defaulting to it made every manual creation fail on the schema enum.
   * That is an argument about WHICH value to invent, and the answer is none.
   *
   * WHO DECIDES INSTEAD: `app/api/events/route.ts`, which runs the keyword floor over the title and
   * description and refuses the save when that also finds no topic. It has to be the route rather
   * than here, because this function is pure and the floor is the only thing that can read a title
   * and tell `Hacktoberfest Hack Day` from `Sunday Jamming`. Note the schema's `required` on an
   * array rejects `[]`, so a caller that ignores this and writes straight through gets a loud
   * ValidationError rather than a quiet non-tech row — the failure mode is the right way round now.
   * ─────────────────────────────────────────────────────────────────────────────────────────────
   */
  const category = requested.filter(c => allowed.has(c));

  // ── Enums with defaults ───────────────────────────────────────────────────
  const format = FORMATS.includes(input.format as never)
    ? (input.format as (typeof FORMATS)[number])
    : 'offline';
  const hasFood = FOOD.includes(input.hasFood as never)
    ? (input.hasFood as (typeof FOOD)[number])
    : 'unknown';

  let price: number | undefined;
  if (input.price !== undefined && input.price !== null && input.price !== '') {
    const n = Number(input.price);
    if (!Number.isFinite(n) || n < 0) {
      issues.push({ field: 'price', message: 'Price must be a number, zero or more.' });
    } else {
      price = n;
    }
  }
  // Derived from price rather than trusted from the body, so "free" and "₹500" cannot disagree.
  const isFree = price === undefined || price === 0;

  if (issues.length || !title || !startDateTime) {
    return { visibility, issues };
  }

  const fields: ManualEventFields = {
    title,
    // Falling back to the title keeps `description` (a required schema path) satisfied without
    // inventing text. The feed shows a two-line excerpt, so a repeated title reads as terse
    // rather than broken.
    description: str(input.description, 6000) ?? title,
    startDateTime,
    ...(endDateTime ? { endDateTime } : {}),
    category,
    format,
    hasFood,
    isFree,
    ...(price !== undefined ? { price } : {}),
    tags: Array.isArray(input.tags)
      ? input.tags
          .filter((t): t is string => typeof t === 'string')
          .map(t => t.trim())
          .filter(Boolean)
          .slice(0, 10)
      : [],
  };

  for (const [key, max] of TEXT_FIELDS) {
    if (key === 'title' || key === 'description') continue;
    const value = URL_FIELDS.has(key) ? httpUrl(input[key], max) : str(input[key], max);
    if (value !== undefined) (fields as unknown as Record<string, unknown>)[key] = value;
  }

  return { fields, visibility, issues };
}

/** The 400 body: names the field, never quotes Mongoose. */
export function manualEventError(issues: ManualEventIssue[]) {
  return {
    error: issues[0]?.message ?? 'That event could not be saved.',
    issues,
  };
}
