import { EVENT_CATEGORIES } from '../event-types';
import { fromISTInputValue, toISTInputValue } from '../ist-datetime-input';

/**
 * Validate and ALLOWLIST the body of a hand-entered event.
 *
 * Pure — no Mongoose, no I/O — so `tests/` pins it without a database, and so a bad request is
 * refused before `connectDB()` is even called. Same arrangement as `lib/tracker/validate.ts`, and
 * for the same two reasons: a client's typo must not be reported as a 500, and a rejection must not
 * echo Mongoose's wording back to the caller.
 *
 * Also pure enough for the BROWSER: `app/add-event/page.tsx` imports `readSharedEvent` and
 * `MANUAL_EVENT_LIMITS` from here, and `/api/scrape-url` imports `toFormDateTime`. That is the
 * point — the form, the importer and the validator read dates, links and caps from ONE definition,
 * because the two date defects fixed here were two copies of one rule disagreeing (see below).
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
 * `visibility`, `isTargetCompany`, `recruiterMentioned`. Anything not named below is dropped, so a
 * field added to the schema later is not silently writable from the web.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */

/** What the caller is asking for. Defaults to the safest option. */
export type RequestedVisibility = 'private' | 'pending' | 'public';

export interface ManualEventIssue {
  field: string;
  message: string;
}

/**
 * Every cap this validator enforces, EXPORTED so the form's `maxLength` attributes read the same
 * numbers. The caps silently truncate server-side (a 7000-character description is stored as its
 * first 6000); without the form knowing them too, that truncation was invisible to the person typing.
 */
export const MANUAL_EVENT_LIMITS = {
  title: 300,
  description: 6000,
  organizer: 200,
  venue: 300,
  address: 500,
  area: 100,
  city: 100,
  timezone: 60,
  currency: 8,
  /** Every link field. Checked on the NORMALISED href, which can be longer than what was typed. */
  url: 2000,
  tag: 50,
  tags: 10,
} as const;

/** Free-text fields that hold one line. Title and description are handled explicitly. */
const SINGLE_LINE_FIELDS = ['organizer', 'venue', 'address', 'area', 'city', 'timezone', 'currency'] as const;

/** Every field that becomes a link. All four reach an `href`, an `<img src>` or the ICS feed. */
const URL_FIELDS = ['onlineLink', 'applyLink', 'sourceUrl', 'imageUrl'] as const;

const FORMATS = ['online', 'offline', 'hybrid'] as const;
const FOOD = ['yes', 'no', 'unknown'] as const;

export interface ManualEventFields {
  title: string;
  description: string;
  startDateTime: Date;
  endDateTime?: Date;
  /**
   * Accepted since the form has always sent it. It used to be DROPPED: the form posted the field,
   * the allowlist did not name it, and the value vanished with a 201 — so a deadline typed into the
   * form never reached the event page's "Closes" row or the digest's deadlines section. The schema
   * path has existed all along (`lib/models/Event.ts`), so no model change was needed.
   */
  registrationDeadline?: Date;
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

/* ── Control characters ─────────────────────────────────────────────────────────────────────── */

/**
 * C0 controls (U+0000-U+001F), DEL (U+007F), C1 controls (U+0080-U+009F), and the two Unicode line
 * terminators (U+2028 LINE SEPARATOR, U+2029 PARAGRAPH SEPARATOR).
 *
 * Tested by code unit rather than with a regex literal: a character class spelled out of these
 * escapes is exactly what ESLint's `no-control-regex` flags, and a comparison states the ranges
 * more plainly than an escape soup would. Surrogates (U+D800-U+DFFF) are outside every range, so an
 * emoji passes through untouched.
 */
function isControlCharacter(code: number): boolean {
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
}

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (isControlCharacter(value.charCodeAt(i))) return true;
  }
  return false;
}

/** The characters that mean "a new line" in some encoding, other than LF and CR themselves. */
function isLineBreakLike(code: number): boolean {
  return code === 0x0b || code === 0x0c || code === 0x85 || code === 0x2028 || code === 0x2029;
}

/**
 * One line of text: every line break and tab becomes a space, every other control character is
 * removed, and the whitespace that leaves is collapsed.
 *
 * STRIPPED, NOT REJECTED — the opposite of the link fields, deliberately. These characters arrive
 * innocently: an Android share target puts a newline in a shared title, a Windows clipboard carries
 * CRLF, a PDF paste brings a form feed. Refusing them would fail the share flow for ordinary users,
 * and stripping removes the hazard just as completely. The hazard is real: `escapeIcsText()` in
 * `lib/calendar/ics.ts` escapes `\r?\n` but NOT a lone CR, and `ORGANIZER;CN=` / `SUMMARY:` are
 * built from these fields — so a bare CR in an organizer name was a line break some calendar
 * parsers honour, one line into a hand-authored calendar object.
 */
function toSingleLine(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0x09 || code === 0x0a || code === 0x0d || isLineBreakLike(code)) out += ' ';
    else if (!isControlCharacter(code)) out += value[i];
  }
  return out.replace(/\s+/g, ' ');
}

/**
 * Multi-line text (the description): LF and TAB survive, every other line-ending spelling becomes
 * LF — CRLF and a lone CR included, so the stored text contains no CR at all — and every other
 * control character is removed.
 */
function toMultiline(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0x0d) {
      out += '\n';
      if (value.charCodeAt(i + 1) === 0x0a) i++;
    } else if (code === 0x0a || code === 0x09) {
      out += value[i];
    } else if (isLineBreakLike(code)) {
      out += '\n';
    } else if (!isControlCharacter(code)) {
      out += value[i];
    }
  }
  return out;
}

/** Cap by code units, but never cut between the two halves of a surrogate pair. */
function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  let end = max;
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return value.slice(0, end).trimEnd();
}

function text(value: unknown, max: number, multiline = false): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = (multiline ? toMultiline(value) : toSingleLine(value)).trim();
  return cleaned ? clip(cleaned, max) : undefined;
}

/* ── Links ──────────────────────────────────────────────────────────────────────────────────── */

/**
 * Only http(s) URLs are accepted for anything that becomes a link, and what is STORED is the
 * parsed `href`, never the string that was sent.
 *
 * WHY THE SCHEME. `app/events/[id]/page.tsx` renders `applyLink` straight into an `href`, so a
 * `javascript:` or `data:` URL there is stored XSS against anybody who opens the event — and for a
 * `pending` submission, against the admin reviewing it. Those are DROPPED (the field is simply
 * absent), which `tests/manual-event.test.ts` pins by name.
 *
 * WHY THE HREF — security finding F1, CWE-93. This function used to validate with `new URL(raw)`
 * and then return `raw`. The WHATWG parser silently DELETES every CR, LF and TAB before parsing, so
 * `new URL('https://x.example/a\r\nATTENDEE:mailto:v@x')` succeeds — measured: its href is
 * `https://x.example/aATTENDEE:mailto:v@x` — and the validator then stored the string it had not
 * actually validated. `app/api/events/[id]/ics/route.ts` writes `URL:${event.sourceUrl}` unescaped
 * (a URI is not TEXT, so RFC 5545 escaping does not apply), so the CRLF became a line break inside
 * the calendar file and the text after it a property of the user's choosing. `href` is always
 * percent-encoded ASCII — every other control character is encoded by the parser (NUL → `%00`,
 * U+2028 → `%E2%80%A8`) — so it cannot carry a line break into any consumer.
 *
 * WHY CONTROL CHARACTERS ARE REJECTED OUTRIGHT, not merely normalised away. Storing the href
 * already closes the injection; refusing the input as well means the validator never stores a link
 * different from the one the caller sent, and a browser's `type="url"` input strips line breaks
 * itself — so a control character inside a link only arrives from a crafted request or a corrupted
 * paste, and saying so beats a silent rewrite. Surrounding whitespace is trimmed first (a trailing
 * newline on a pasted link is the common, harmless case, and the parser discards it anyway); a
 * control character INSIDE the link is a 400 naming the field.
 */
function readUrl(field: string, value: unknown, issues: ManualEventIssue[]): string | undefined {
  if (typeof value !== 'string') return undefined;
  const raw = value.trim();
  if (!raw) return undefined;
  if (hasControlCharacter(raw)) {
    issues.push({
      field,
      message: 'That link contains a line break or another hidden character. Paste it again.',
    });
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  // Checked on the href, which is what is stored. Truncating a link is not a cap, it is a
  // different (broken) link — so an over-long one is refused rather than sliced.
  if (url.href.length > MANUAL_EVENT_LIMITS.url) {
    issues.push({ field, message: `That link is longer than ${MANUAL_EVENT_LIMITS.url} characters.` });
    return undefined;
  }
  return url.href;
}

/* ── Dates ──────────────────────────────────────────────────────────────────────────────────── */

/**
 * `YYYY-MM-DD[T ]HH:mm[:ss[.fff]][Z|±HH:MM|±HHMM]` — ISO 8601 / RFC 3339 date-time, with the zone
 * OPTIONAL. The space separator and the colon-less offset are what HTML's own `<time datetime>`
 * grammar permits, which `/api/scrape-url` reads through this same function.
 */
const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?$/i;

/**
 * Whether the components name a moment that exists on the calendar.
 *
 * `Date.UTC` NORMALISES rather than refusing — 30 February becomes 2 March, 24:00 becomes the next
 * day, minute 75 becomes an hour and a quarter — and V8's string parser is just as forgiving
 * (measured: `new Date('2026-02-30T10:00:00Z')` is 2 March). So an impossible value is caught by
 * building the instant and checking every component came back unchanged. It also refuses years
 * 0000-0099, which `Date.UTC` silently maps onto 1900-1999.
 */
function isCalendarMoment(y: number, mo: number, d: number, h: number, mi: number, s: number): boolean {
  const t = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  return (
    t.getUTCFullYear() === y &&
    t.getUTCMonth() === mo - 1 &&
    t.getUTCDate() === d &&
    t.getUTCHours() === h &&
    t.getUTCMinutes() === mi &&
    t.getUTCSeconds() === s
  );
}

/**
 * The ONE rule for turning a submitted date into an instant. Returns `undefined` when the value
 * cannot be read unambiguously.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE BUG THIS REPLACES: A 19:00 EVENT WAS STORED AT 00:30 THE NEXT DAY.
 *
 * `<input type="datetime-local">` holds wall-clock text with no zone — `2026-10-01T19:00` — and the
 * form posted that text as-is. This validator parsed it with `new Date(raw)`, and ECMAScript reads a
 * zone-less DATE-TIME string in the zone of the machine doing the parsing. Measured with Node 22:
 * `new Date('2026-10-01T19:00')` is `13:30Z` on this IST laptop and `19:00Z` under `TZ=UTC`.
 * Vercel functions run in UTC whatever the region — `regions: ["bom1"]` moves the machine, not its
 * clock — so in production a Bengaluru 7 PM event became 19:00 UTC, which is 00:30 IST on the
 * following day. Invisible in development, because the developer's machine IS in IST.
 *
 * So the machine is removed from the question, the way `lib/ist-datetime-input.ts` removes it for
 * the admin editors:
 *
 *   · NO ZONE → Asia/Kolkata wall-clock, via `fromISTInputValue`. This app pins every displayed
 *     time to IST (`lib/format.ts`), so the zone a person means when they type "19:00" into it is
 *     IST, whatever their phone or the server is set to. India has had no DST since 1945, so the
 *     fixed +05:30 that function applies is exact.
 *   · EXPLICIT ZONE (`Z` or an offset) → exactly that instant. The string carries its own zone, so
 *     no machine can reinterpret it. This is what the form now sends, and what a `Date` becomes in
 *     JSON.
 *
 * EVERYTHING ELSE IS REFUSED, because every other shape is either machine-dependent or ambiguous
 * in V8, measured: a date alone (`2026-10-01`) is UTC midnight, i.e. 05:30 IST; `2026/10/01 19:00`
 * is machine-local again; and out-of-range components roll over instead of failing. A 400 naming
 * the field is recoverable; a silently-shifted event is not, because `clusterKey` is built from the
 * IST calendar day, so a shift across midnight also detaches the event from its own dedup identity.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */
export function parseEventDateTime(value: unknown): Date | undefined {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : new Date(value.getTime());
  }
  if (typeof value !== 'string') return undefined;
  const match = DATE_TIME.exec(value.trim());
  if (!match) return undefined;

  const [, y, mo, d, h, mi, s = '00', fraction, zone] = match;
  if (!isCalendarMoment(+y, +mo, +d, +h, +mi, +s)) return undefined;
  const wallClock = `${y}-${mo}-${d}T${h}:${mi}:${s}`;

  if (zone === undefined) {
    // Sub-second precision on a zone-less value is dropped: it is meaningless for an event, and
    // `fromISTInputValue` is the single place the IST offset is applied.
    const iso = fromISTInputValue(wallClock);
    return iso ? new Date(iso) : undefined;
  }

  // Rebuilt in the exact form ECMAScript specifies (three fraction digits, `±HH:MM`) so the result
  // does not depend on how lenient this engine's parser happens to be about the rest.
  const ms = fraction ? fraction.slice(1).padEnd(3, '0').slice(0, 3) : '000';
  const offset = zone.toUpperCase() === 'Z' ? 'Z' : `${zone.slice(0, 3)}:${zone.slice(-2)}`;
  const instant = new Date(`${wallClock}.${ms}${offset}`);
  return Number.isNaN(instant.getTime()) ? undefined : instant;
}

/**
 * Any date an event page publishes → the IST wall-clock text a `datetime-local` input holds, or
 * `undefined` when the value names no unambiguous instant.
 *
 * FOR `/api/scrape-url`, which used to emit `toISOString().slice(0, 16)`: UTC wall-clock with the
 * zone cut off. The form showed a Bengaluru 19:00 event as 13:30, and on the UTC production server
 * that bug and the validator's cancelled out — the import "worked" only because two wrong
 * conversions met in the middle. Fixing the validator alone would have broken every imported event
 * by 5.5 hours, so both sides read through `parseEventDateTime` now and the round trip
 * (instant → this text → validator → same instant) is pinned in `tests/manual-event-time.test.ts`.
 *
 * A date with no time is deliberately NOT converted. Prefilling midnight would present a time
 * nobody published as though the page had said it, and the person would have no reason to check.
 */
export function toFormDateTime(value: unknown): string | undefined {
  const instant = parseEventDateTime(value);
  return instant ? toISTInputValue(instant) : undefined;
}

/** Absent, null and the empty string all mean "not given" — what a form sends for an untouched field. */
function isBlank(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && !value.trim());
}

/* ── The share target ───────────────────────────────────────────────────────────────────────── */

const URL_IN_TEXT = /https?:\/\/[^\s<>"'`]+/i;

/** Trailing characters that end a sentence around a link rather than belonging to it. */
const TRAILING_PUNCTUATION = '.,;:!?\'"»”’>]}';

function countOf(value: string, char: string): number {
  return value.split(char).length - 1;
}

/**
 * The first http(s) link in some text, normalised to its href, or `undefined`.
 *
 * A closing parenthesis is only trimmed when it is unbalanced, so `…/wiki/Foo_(bar)` survives while
 * `(see https://lu.ma/x)` loses the bracket that belongs to the sentence.
 */
function firstHttpUrl(value: string): string | undefined {
  const match = URL_IN_TEXT.exec(value);
  if (!match) return undefined;
  let candidate = match[0];
  for (;;) {
    const last = candidate.slice(-1);
    if (last && TRAILING_PUNCTUATION.includes(last)) {
      candidate = candidate.slice(0, -1);
    } else if (last === ')' && countOf(candidate, '(') < countOf(candidate, ')')) {
      candidate = candidate.slice(0, -1);
    } else {
      break;
    }
  }
  if (hasControlCharacter(candidate)) return undefined;
  try {
    const url = new URL(candidate);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** True when a string is one link and nothing else but punctuation or whitespace. */
function isOnlyALink(value: string): boolean {
  if (!URL_IN_TEXT.test(value)) return false;
  return value.replace(URL_IN_TEXT, '').replace(/[\s.,;:!?'"()[\]{}<>«»“”‘’-]/g, '') === '';
}

export interface SharedEventDraft {
  title: string;
  description: string;
  /** The first http(s) link in what was shared, normalised; `''` when there is none. */
  url: string;
}

/**
 * What the Android / PWA share target (`GET /add-event?title=&text=&url=`) handed over, as form
 * values.
 *
 * WHY THE LINK IS LOOKED FOR IN `text`. Android's share intent has no URL slot — it carries
 * EXTRA_SUBJECT and EXTRA_TEXT — so Chrome maps those to `title` and `text` and the `url` parameter
 * usually arrives EMPTY, with the link inside `text`. The page used to read only `url`, so sharing
 * a Luma page from the Android share sheet put the bare link into the Description box and left the
 * Event URL and the importer empty — the one field the importer needs, in the one place it never
 * looked. `url` is still preferred when a sender does fill it.
 *
 * A text that is NOTHING BUT the link is not a description and is not copied there; text with
 * prose around a link is kept whole, link included, so nothing the person shared is lost.
 */
export function readSharedEvent(shared: {
  title?: string | null;
  text?: string | null;
  url?: string | null;
}): SharedEventDraft {
  const title = shared.title ? toSingleLine(shared.title).trim() : '';
  const body = shared.text ? toMultiline(shared.text).trim() : '';
  const url =
    (shared.url ? firstHttpUrl(shared.url) : undefined) ??
    (body ? firstHttpUrl(body) : undefined) ??
    (title ? firstHttpUrl(title) : undefined) ??
    '';
  return {
    title: title && !isOnlyALink(title) ? clip(title, MANUAL_EVENT_LIMITS.title) : '',
    description: body && !isOnlyALink(body) ? clip(body, MANUAL_EVENT_LIMITS.description) : '',
    url,
  };
}

/* ── The validator ──────────────────────────────────────────────────────────────────────────── */

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
  const title = text(input.title, MANUAL_EVENT_LIMITS.title);
  if (!title) issues.push({ field: 'title', message: 'A title is required.' });

  // Every date goes through `parseEventDateTime` — see its note for why a zone-less value is IST.
  let startDateTime: Date | undefined;
  if (isBlank(input.startDateTime)) {
    issues.push({ field: 'startDateTime', message: 'A start date and time is required.' });
  } else {
    startDateTime = parseEventDateTime(input.startDateTime);
    if (!startDateTime) {
      issues.push({ field: 'startDateTime', message: 'That start date is not a valid date and time.' });
    }
  }

  let endDateTime: Date | undefined;
  if (!isBlank(input.endDateTime)) {
    const parsed = parseEventDateTime(input.endDateTime);
    if (!parsed) {
      issues.push({ field: 'endDateTime', message: 'That end date is not a valid date and time.' });
    } else if (startDateTime && parsed < startDateTime) {
      // Caught here rather than stored: an event ending before it starts renders as a negative
      // duration everywhere and is always a typo.
      issues.push({ field: 'endDateTime', message: 'The end time is before the start time.' });
    } else {
      endDateTime = parsed;
    }
  }

  /**
   * ── Registration deadline: no later than the event's LAST MOMENT. ───────────────────────────
   *
   * The decision, and why it is neither of the two obvious rules:
   *
   *   · NOT "before the start". Multi-day conferences and hackathons keep on-site registration open
   *     into the event, and refusing a day-2 deadline on a three-day event would be refusing a fact.
   *   · NOT unchecked. Registration that closes after the event is over is meaningless, and is
   *     nearly always the picker's month or day set one step too far — the error a datetime input
   *     makes easy. Stored, it would sit in the digest's "deadlines approaching" section for an
   *     event that has already happened.
   *
   * So the bound is the END when one is given, and the START when it is not — the start being the
   * latest moment this form can vouch for. Someone whose registration stays open during the event
   * adds the end time, which the message says. A deadline already in the past is ACCEPTED: "it has
   * closed" is true, useful information about an event, not an input error.
   */
  let registrationDeadline: Date | undefined;
  if (!isBlank(input.registrationDeadline)) {
    const parsed = parseEventDateTime(input.registrationDeadline);
    const latest = endDateTime ?? startDateTime;
    if (!parsed) {
      issues.push({
        field: 'registrationDeadline',
        message: 'That registration deadline is not a valid date and time.',
      });
    } else if (latest && parsed > latest) {
      issues.push({
        field: 'registrationDeadline',
        message: endDateTime
          ? 'Registration cannot close after the event ends.'
          : 'Registration cannot close after the event starts. Add an end time if registration stays open during the event.',
      });
    } else {
      registrationDeadline = parsed;
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
      message: `Not a category we know: ${bad.slice(0, 3).map(c => toSingleLine(c).slice(0, 40)).join(', ')}.`,
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

  // ── Price ─────────────────────────────────────────────────────────────────
  let price: number | undefined;
  let priceInvalid = false;
  if (!isBlank(input.price)) {
    // A number, or a numeric string — never `Number(true)` (1) or `Number([5])` (5).
    const n =
      typeof input.price === 'number'
        ? input.price
        : typeof input.price === 'string'
          ? Number(input.price.trim())
          : Number.NaN;
    if (!Number.isFinite(n) || n < 0) {
      issues.push({ field: 'price', message: 'Price must be a number, zero or more.' });
      priceInvalid = true;
    } else {
      price = n;
    }
  }

  let explicitFree: boolean | undefined;
  if (input.isFree !== undefined && input.isFree !== null) {
    if (typeof input.isFree === 'boolean') {
      explicitFree = input.isFree;
    } else {
      issues.push({ field: 'isFree', message: 'isFree must be true or false.' });
    }
  }

  /**
   * ── Free or paid: the caller's EXPLICIT answer is honoured, never overruled. ──────────────────
   *
   * This used to be `const isFree = price === undefined || price === 0`, which ignored the body's
   * `isFree` entirely. The form sends `price: undefined` when the price box is blank, so switching
   * "Free event" OFF and forgetting the price stored the event as FREE — the opposite of what the
   * person had just said, with a 201. `tests/manual-event.test.ts` pinned that as correct.
   *
   * Now: `isFree: false` needs a positive price, and without one the save is refused naming `price`
   * — a paid event with no price is incomplete, and only the person knows the number. The mirror
   * case, `isFree: true` with a positive price, is refused naming `isFree`, for the same reason in
   * the other direction: storing "paid ₹500" over an explicit "free" is the identical silent
   * overrule. Only when `isFree` is ABSENT is it derived from the price, which is still what keeps
   * a stored "free" and a stored "₹500" from disagreeing.
   */
  let isFree = price === undefined || price === 0;
  if (explicitFree === false) {
    if (!priceInvalid && (price === undefined || price <= 0)) {
      issues.push({
        field: 'price',
        message: 'Enter the ticket price for a paid event, or mark it as free.',
      });
    }
    isFree = false;
  } else if (explicitFree === true) {
    if (price !== undefined && price > 0) {
      issues.push({
        field: 'isFree',
        message: 'An event marked free cannot have a price. Remove the price or mark it as paid.',
      });
    }
    isFree = true;
  }

  // ── Links ─────────────────────────────────────────────────────────────────
  // Read before the early return so a bad link is reported alongside every other issue.
  const links: Partial<Record<(typeof URL_FIELDS)[number], string>> = {};
  for (const key of URL_FIELDS) {
    const value = readUrl(key, input[key], issues);
    if (value !== undefined) links[key] = value;
  }

  if (issues.length || !title || !startDateTime) {
    return { visibility, issues };
  }

  const fields: ManualEventFields = {
    title,
    // Falling back to the title keeps `description` (a required schema path) satisfied without
    // inventing text. The feed shows a two-line excerpt, so a repeated title reads as terse
    // rather than broken.
    description: text(input.description, MANUAL_EVENT_LIMITS.description, true) ?? title,
    startDateTime,
    ...(endDateTime ? { endDateTime } : {}),
    ...(registrationDeadline ? { registrationDeadline } : {}),
    category,
    format,
    hasFood,
    isFree,
    ...(price !== undefined ? { price } : {}),
    tags: Array.isArray(input.tags)
      ? input.tags
          .filter((t): t is string => typeof t === 'string')
          .map(t => text(t, MANUAL_EVENT_LIMITS.tag))
          .filter((t): t is string => Boolean(t))
          .slice(0, MANUAL_EVENT_LIMITS.tags)
      : [],
    ...links,
  };

  for (const key of SINGLE_LINE_FIELDS) {
    const value = text(input[key], MANUAL_EVENT_LIMITS[key]);
    if (value !== undefined) fields[key] = value;
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
