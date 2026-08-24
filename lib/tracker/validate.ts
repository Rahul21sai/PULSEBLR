/**
 * Request-body validation for the tracker write path.
 *
 * Pure: no mongoose import, no database, no network — which is why `lib/models/TrackerEntry.ts`
 * can import `TRACKER_STATUSES` from here for its schema enum without a cycle, exactly as
 * `lib/models/Event.ts` imports `EVENT_CATEGORIES` from `lib/event-types.ts`. One definition,
 * so the enum the API rejects against and the enum the schema enforces cannot drift.
 *
 * WHY THIS EXISTS. `POST /api/tracker` passed the raw body to `TrackerEntry.create()` and
 * `PUT /api/tracker/[id]` passed it to `{ $set: body }` with `runValidators: true`. A bad
 * `status` therefore became a Mongoose ValidationError, which reached each route's catch-all
 * and was reported as **500 with `details: err.message`**:
 *
 *   TrackerEntry validation failed: status: `Foo` is not a valid enum value for path `status`.
 *
 * Two defects in one response. A client error was reported as a server fault, so a caller
 * could not tell "fix your request" from "the database is down" and retrying was pointless.
 * And the body echoed the model name and the schema path back to the caller, which is free
 * reconnaissance on the internal shape of the data.
 *
 * The rule here is to reject what the SCHEMA would reject, and to say so in the caller's
 * vocabulary. Two deliberate departures from Mongoose, both to avoid silent damage:
 *
 *   - Mongoose COERCES a number or boolean onto a String path, so `notes: 42` quietly stores
 *     `"42"`. That is validated strictly here instead. No client sends a non-string for free
 *     text (both writers are a textarea and a text input), so nothing legitimate is refused,
 *     and a 400 naming the field beats storing a stringified accident.
 *   - `mongoose.Types.ObjectId.isValid()` returns TRUE for any 12-character string, so a
 *     guard built on it lets `'hello world!'` through to become a real ObjectId. Ids are
 *     matched against 24 hex characters, which is what the app actually stores.
 *
 * Where Mongoose is LENIENT and a client depends on it, that leniency is preserved: a Date
 * path casts `''` and `null` to null, and `EditTrackerModal`'s `EMPTY` draft sends
 * `followUpAt: ''` for anyone recorded without a follow-up date. Verified against the
 * installed Mongoose rather than assumed. `tests/tracker-validation.test.ts` pins it.
 */

/**
 * The tracker pipeline, ordered as a genuine progression with the terminal outcomes last.
 * Capitalised — a lowercase `'interested'` is the likeliest real client typo and is refused.
 *
 * `app/tracker/page.tsx` draws a COLUMN per status but deliberately omits `Rejected`, so it
 * is a subset of this list rather than a mirror of it.
 */
export const TRACKER_STATUSES = [
  'New',
  'Interested',
  'Applied',
  'Shortlisted',
  'Confirmed',
  'Attended',
  'Skipped',
  'Rejected',
] as const;

export type TrackerStatus = (typeof TRACKER_STATUSES)[number];

/** One rejected field. `field` uses dotted/indexed paths, e.g. `connections[1].name`. */
export type TrackerIssue = { field: string; message: string };

/** What the app stores: a 24-character hex ObjectId. Deliberately stricter than isValid(). */
const OBJECT_ID = /^[0-9a-f]{24}$/i;

const ALLOWED_STATUSES = `must be one of: ${TRACKER_STATUSES.join(', ')}`;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Absent, or a real string. `null` clears the field, which Mongoose allows. */
function badString(value: unknown): boolean {
  return value !== undefined && value !== null && typeof value !== 'string';
}

/**
 * Mirrors the Mongoose date cast measured against the installed version: `undefined`,
 * `null` and `''` all clear the field; a finite number is an epoch; a string must parse.
 */
function badDate(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return false;
  if (typeof value === 'number') return !Number.isFinite(value);
  if (typeof value === 'string') return Number.isNaN(new Date(value).getTime());
  if (value instanceof Date) return Number.isNaN(value.getTime());
  return true;
}

function badObjectId(value: unknown): boolean {
  return typeof value !== 'string' || !OBJECT_ID.test(value);
}

/**
 * Validate a parsed tracker request body. Never throws, and returns EVERY problem rather
 * than only the first, so a caller fixes one round trip's worth of mistakes at a time.
 *
 * An empty array means valid. Unknown fields are ignored, because the schema strips them.
 *
 * @param opts.requireEventId `true` for POST (creating needs an event). Left false for PUT,
 *   which sends only the fields being changed and whose route strips `eventId` outright.
 */
export function validateTrackerInput(
  body: unknown,
  opts: { requireEventId?: boolean } = {}
): TrackerIssue[] {
  if (!isPlainObject(body)) {
    return [{ field: 'body', message: 'request body must be a JSON object' }];
  }

  const issues: TrackerIssue[] = [];
  const add = (field: string, message: string) => issues.push({ field, message });

  // Read only own properties, so a payload carrying `constructor` or `__proto__` cannot
  // smuggle an inherited value in as if it were a field.
  const has = (key: string) => Object.prototype.hasOwnProperty.call(body, key);

  // ── eventId ────────────────────────────────────────────────────────────────────────
  // Checked here rather than left to `Event.findById()`, which throws a CastError on a
  // malformed id — a 500 for what is plainly a bad request.
  if (opts.requireEventId && !has('eventId')) {
    add('eventId', 'eventId is required');
  } else if (has('eventId') && badObjectId(body.eventId)) {
    add('eventId', 'eventId must be a 24-character hex id');
  }

  // ── status ─────────────────────────────────────────────────────────────────────────
  if (has('status') && !TRACKER_STATUSES.includes(body.status as TrackerStatus)) {
    add('status', `status ${ALLOWED_STATUSES}`);
  }

  // ── free text ──────────────────────────────────────────────────────────────────────
  for (const field of ['notes', 'outcome'] as const) {
    if (has(field) && badString(body[field])) add(field, `${field} must be a string`);
  }

  if (has('appliedAt') && badDate(body.appliedAt)) {
    add('appliedAt', 'appliedAt must be a valid date');
  }

  // ── connections ────────────────────────────────────────────────────────────────────
  // `ConnectionSchema.name` is `required`, so `connections: [{}]` was a 500 as well. The
  // index is named in the field path because this array arrives whole from the edit modal
  // and "a name is required" alone does not say which person is missing one.
  if (has('connections') && body.connections !== undefined && body.connections !== null) {
    if (!Array.isArray(body.connections)) {
      add('connections', 'connections must be an array');
    } else {
      body.connections.forEach((raw, i) => {
        const at = `connections[${i}]`;
        if (!isPlainObject(raw)) {
          add(at, `${at} must be an object`);
          return;
        }
        const ownKey = (key: string) => Object.prototype.hasOwnProperty.call(raw, key);

        if (typeof raw.name !== 'string' || raw.name.trim() === '') {
          add(`${at}.name`, `${at}.name is required`);
        }
        for (const field of ['role', 'company', 'linkedin', 'context'] as const) {
          if (ownKey(field) && badString(raw[field])) {
            add(`${at}.${field}`, `${at}.${field} must be a string`);
          }
        }
        if (ownKey('followUpAt') && badDate(raw.followUpAt)) {
          add(`${at}.followUpAt`, `${at}.followUpAt must be a valid date`);
        }
        if (
          ownKey('followedUp') &&
          raw.followedUp !== undefined &&
          raw.followedUp !== null &&
          typeof raw.followedUp !== 'boolean'
        ) {
          add(`${at}.followedUp`, `${at}.followedUp must be true or false`);
        }
        if (ownKey('seenAtEventIds') && raw.seenAtEventIds !== undefined && raw.seenAtEventIds !== null) {
          if (!Array.isArray(raw.seenAtEventIds)) {
            add(`${at}.seenAtEventIds`, `${at}.seenAtEventIds must be an array`);
          } else if (raw.seenAtEventIds.some(badObjectId)) {
            add(
              `${at}.seenAtEventIds`,
              `${at}.seenAtEventIds must contain only 24-character hex ids`
            );
          }
        }
      });
    }
  }

  return issues;
}

/**
 * The 400 body both tracker routes return, so they cannot drift apart.
 *
 * `error` is the first message because that is what the existing clients surface (they read
 * `error` and show it inline); `issues` carries the full list for a caller that wants to
 * mark up several fields at once. Nothing from the Mongoose error object appears in either.
 */
export function trackerValidationError(issues: TrackerIssue[]): {
  error: string;
  issues: TrackerIssue[];
} {
  return { error: issues[0]?.message ?? 'invalid request body', issues };
}

/**
 * Is this thrown value the schema refusing a bad request, rather than a server fault?
 *
 * Defence in depth. `validateTrackerInput` runs before the write, so a Mongoose
 * ValidationError should now be unreachable — but if a gap ever opens (a field added to the
 * schema and not to the validator), the outcome must not revert to a 500 that echoes
 * `err.message`. The routes use this to answer 400 with wording of their own while logging
 * the real error server-side.
 *
 * Matched on `name` rather than `instanceof` so this module needs no mongoose import and
 * stays unit-testable without one. `code: 11000` is deliberately NOT included: a duplicate
 * key is a genuine conflict, which both routes already answer with a 409.
 */
export function isSchemaRejection(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const name = (error as { name?: unknown }).name;
  return name === 'ValidationError' || name === 'CastError';
}
