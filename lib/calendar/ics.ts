/**
 * ICS generation — shared by the per-event download and the per-user subscription feed.
 *
 * ── WHY THIS MODULE EXISTS ───────────────────────────────────────────────────────────────────
 * `app/api/events/[id]/ics/route.ts` had `escapeIcsText`, `toIcsUtc` and `foldLine` defined
 * inline. The subscription feed needs all three, and a second copy of a line-folding function is
 * exactly the kind of duplication this repo has already paid for twice — the `WorthGoing` panel
 * copied `FUNNEL_PATTERN` and fell behind it, and the dashboard hand-rolled a second `NAV_LINKS`
 * that went stale. So they moved here and both callers import them.
 *
 * The three were extracted VERBATIM in one commit, then `foldLine` was fixed in the next. That
 * order is deliberate: the per-event route's output cannot be pinned by a vitest golden test (it
 * needs mongoose and a session), so byte-identity for the ASCII case had to come from not
 * changing the code rather than from a test proving it unchanged.
 *
 * ── THE FOLD BUG, MEASURED ───────────────────────────────────────────────────────────────────
 * RFC 5545 §3.1 folds at 75 **octets**. The original sliced by JavaScript string index, which is
 * UTF-16 code units, and those are not octets for anything outside ASCII. Two independent
 * failures, both reproduced against the original function before it was replaced:
 *
 *   1. OVER-LONG LINES. `foldLine('SUMMARY:' + 'AI — Bengaluru — '.repeat(6))` produced a first
 *      line of 75 code units and **91 octets** — an em-dash is one code unit and three UTF-8
 *      bytes. Outlook rejects lines over the limit. Bengaluru event titles are scraped from
 *      third-party pages and em-dashes, bullets and rupee signs are everywhere in them, so this
 *      is the common case rather than the exotic one.
 *
 *   2. LONE SURROGATES. A slice can land between the two halves of a surrogate pair. Each half is
 *      then an unpaired UTF-16 code unit, which is not representable in UTF-8 — encoding the
 *      response replaces each with U+FFFD, so the emoji is destroyed and one octet of garbage is
 *      left on each side of the fold. Verified by round-tripping the folded output through
 *      `Buffer.from(s, 'utf8').toString('utf8')`: U+FFFD appeared where the input had none.
 *
 *      ⚠ THE REPRO STRING IN THE BRIEF FOR THIS WORK DOES NOT ACTUALLY TRIGGER THIS. It gives
 *      `'x'.repeat(66) + '🎉' + 'more text'`, where the emoji occupies code units 66-67 and the
 *      cut at 75 falls well past it — that string demonstrates defect 1 (77 octets) and not
 *      defect 2. The high surrogate has to sit exactly ON the boundary, i.e. `'x'.repeat(74)`.
 *      Measured: `charCodeAt(74) === 0xD83C`, `charCodeAt(75) === 0xDF89`. The continuation path
 *      has the same bug at its own 74-unit boundary (`'x'.repeat(148) + '🎉'` splits line 1), so
 *      fixing only the first slice would have left half of it live. `tests/calendar-ics.test.ts`
 *      pins the corrected strings for both.
 *
 * Fixed by walking CODE POINTS and accounting octets. Code points, not grapheme clusters: a fold
 * between two code points is always valid UTF-8 and always round-trips, which is the property RFC
 * 5545 cares about. An emoji ZWJ sequence or a combining accent can still be split across a fold
 * and will render as its parts — cosmetic, on a line no human reads, and the alternative is
 * shipping a segmenter to a calendar file.
 */
import crypto from 'crypto';

/** RFC 5545 §3.1: "Lines of text SHOULD NOT be longer than 75 octets, excluding the line break." */
const MAX_LINE_OCTETS = 75;

/**
 * A folded continuation line begins with one space, and that space counts toward the 75.
 * So a continuation carries at most 74 octets of content. The original code used 74 here too —
 * correct by accident, since it was counting the wrong unit.
 */
const CONTINUATION_OCTETS = MAX_LINE_OCTETS - 1;

/** ICS is CRLF-delimited, everywhere, including between folded segments. */
export const ICS_CRLF = '\r\n';

/** RFC 5545 requires escaping these characters inside TEXT values. */
export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** UTC timestamp in the basic format ICS expects: 20260822T103000Z */
export function toIcsUtc(date: Date): string {
  return `${date.toISOString().replace(/[-:]/g, '').split('.')[0]}Z`;
}

/**
 * How many octets one code point occupies in UTF-8.
 *
 * Computed arithmetically rather than with `Buffer.byteLength(char)` to avoid allocating a buffer
 * per character of every description. An unpaired surrogate (0xD800-0xDFFF) falls in the 3-octet
 * band, which is what Node actually emits for one — the U+FFFD replacement is also three octets —
 * so the accounting stays honest even for input that was already malformed.
 */
function utf8Size(codePoint: number): number {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

/**
 * Fold one content line at 75 octets, never splitting a code point.
 *
 * See the module header for the two defects this replaces and the measurements behind them.
 * Unfolding (strip every CRLF followed by one space) returns the input exactly;
 * `tests/calendar-ics.test.ts` asserts that round trip, which is the assertion that would catch
 * an off-by-one in either budget.
 */
export function foldLine(line: string): string {
  // Fast path on the whole string: most lines are short ASCII and never need touching.
  if (Buffer.byteLength(line, 'utf8') <= MAX_LINE_OCTETS) return line;

  const segments: string[] = [];
  let current = '';
  let octets = 0;
  // The first segment gets the full budget; every one after it spends an octet on its lead space.
  let budget = MAX_LINE_OCTETS;

  // `for...of` iterates CODE POINTS, so a surrogate pair arrives as one two-unit string and can
  // never be divided. That is the whole fix for defect 2.
  for (const codePoint of line) {
    const size = utf8Size(codePoint.codePointAt(0)!);
    if (octets + size > budget) {
      segments.push(current);
      current = '';
      octets = 0;
      budget = CONTINUATION_OCTETS;
    }
    current += codePoint;
    octets += size;
  }
  if (current) segments.push(current);

  return segments.map((segment, i) => (i === 0 ? segment : ` ${segment}`)).join(ICS_CRLF);
}

/* ── The subscription feed ───────────────────────────────────────────────────────────────────── */

/**
 * One event as the feed needs it.
 *
 * Dates may be `Date` or ISO string, because a `.lean()` populate hands back either depending on
 * how the field was written. Every optional field is nullable as well as absent for the same
 * reason — `.lean()` gives `null` where the document gives `undefined`.
 */
export interface FeedEvent {
  id: string;
  title: string;
  description?: string | null;
  startDateTime: Date | string;
  endDateTime?: Date | string | null;
  venue?: string | null;
  address?: string | null;
  area?: string | null;
  city?: string | null;
  organizer?: string | null;
  onlineLink?: string | null;
  sourceUrl?: string | null;
  /** This event's page in this app. Put in the body so a reminder is one tap from the detail view. */
  eventUrl?: string | null;
  /**
   * ⚠ DTSTAMP AND LAST-MODIFIED COME FROM HERE, NEVER FROM `new Date()`, AND THE ETAG DEPENDS ON
   * IT. `Cache-Control: private, max-age=0, must-revalidate` invites a conditional request on
   * every poll, and the 304 that answers it is free — but only if the body is byte-identical when
   * nothing has changed. A `DTSTAMP` read off the clock makes every response a fresh 200 with a
   * new ETag, which is not a caching bug so much as a caching absence: the feature would look
   * implemented and never once serve a 304. `tests/calendar-ics.test.ts` asserts two builds from
   * identical input are byte-equal, which is the only way this stays true.
   */
  updatedAt: Date | string;
}

export interface CalendarFeedInput {
  events: FeedEvent[];
  /** Shown as the calendar's name in the subscriber's sidebar. */
  calendarName: string;
  calendarDescription: string;
}

/** How often a client is asked to re-poll. Advisory — see the honesty note in the settings UI. */
const REFRESH_DURATION = 'PT4H';

/** Lead time on the alarm, matching the per-event download so a merge does not double up. */
const ALARM_TRIGGER = '-PT2H';

/** No published end time: assume two hours, as the per-event route does. */
const DEFAULT_DURATION_MS = 2 * 3600 * 1000;

/**
 * How much of a scraped description survives into the feed.
 *
 * ── MEASURED, NOT GUESSED. ───────────────────────────────────────────────────────────────────
 * Over 400 stored events: median description 1044 characters, p75 1817, p90 3572, mean 1312, and
 * 69% over 500. A four-event feed built without a cap came to 300 folded lines, most of it one
 * trek operator's "Follow Plan The Unplanned on Facebook, Instagram, LinkedIn, Twitter, YouTube,
 * and Pinterest" footer repeated per event. Estimated whole-feed size uncapped: ~16 KB at 10 saved
 * events, ~82 KB at 50 — re-downloaded by every subscribed device on every poll.
 *
 * TWO REASONS, AND THE SECOND IS THE STRONGER ONE:
 *
 *   1. SIZE. The ETag absorbs most of it (a 304 carries no body), so this is not the emergency the
 *      raw numbers suggest — but the first fetch and every fetch after any change pays in full, and
 *      Apple Calendar lets a user poll every five minutes.
 *   2. IT IS THE WRONG PLACE TO READ 3.5 KB. A calendar entry's notes pane is glanced at on a
 *      phone on the way to a venue. The substance of a scraped description is at the top and the
 *      tail is marketing boilerplate, so a cap loses little and the full text is one tap away —
 *      `Details:` links to the event page, and that line is appended AFTER truncation so it can
 *      never be the thing that gets cut.
 *
 * Nothing is silently lost: the truncation is marked with an ellipsis, so the reader can see there
 * is more rather than believing they have the whole description.
 */
const MAX_DESCRIPTION_CHARS = 600;

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * Trim prose to `MAX_DESCRIPTION_CHARS`, preferring a word boundary.
 *
 * Deterministic, because the ETag depends on the body being byte-stable for fixed input — so no
 * sentence detection that could behave differently on a re-run, and no locale-aware segmentation.
 * Falls back to a hard cut when the last space is implausibly early (a 600-character run with no
 * whitespace is a URL or a hash, and cutting it at character 40 would be worse than cutting it at
 * the limit).
 */
function truncateProse(value: string): string {
  if (value.length <= MAX_DESCRIPTION_CHARS) return value;
  const clipped = value.slice(0, MAX_DESCRIPTION_CHARS);
  const lastSpace = clipped.lastIndexOf(' ');
  const cut = lastSpace > MAX_DESCRIPTION_CHARS * 0.6 ? clipped.slice(0, lastSpace) : clipped;
  return `${cut.trimEnd()}…`;
}

/**
 * The whole feed as one VCALENDAR.
 *
 * ── WHY THERE IS NO `METHOD:PUBLISH` HERE, WHEN THE PER-EVENT ROUTE HAS ONE ──────────────────
 * `METHOD` makes the object an iTIP *message* (RFC 5546) rather than a calendar store. For the
 * single-event download that is right — it IS a one-shot message, "here, import this". For a
 * subscription it is wrong: Outlook reads a METHOD-bearing body as an invitation to import once
 * and does not treat the URL as a living calendar. So the property is present in exactly one of
 * the two producers, on purpose, and neither is a copy of the other.
 *
 * ── WHY THE UID IS THE SAME STRING IN BOTH ───────────────────────────────────────────────────
 * `<eventId>@pulseblr`, byte for byte what `app/api/events/[id]/ics/route.ts` emits. A user who
 * subscribes to the feed AND downloads one event's .ics has given their calendar the same UID
 * twice, and UID is the identity a client de-duplicates on — so they get a merge instead of two
 * overlapping copies of the same evening. Changing either producer's UID shape silently
 * reintroduces the duplicate.
 */
export function buildCalendarFeed(input: CalendarFeedInput): string {
  const { calendarName, calendarDescription } = input;

  // Deterministic order, because the body has to be byte-stable for the ETag and Mongo's return
  // order is not a guarantee. Start time first (the order a reader would expect), id as the
  // tie-break so two events at the same instant cannot swap between polls.
  const events = [...input.events].sort((a, b) => {
    const delta = asDate(a.startDateTime).getTime() - asDate(b.startDateTime).getTime();
    return delta !== 0 ? delta : a.id.localeCompare(b.id);
  });

  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//PulseBLR//Bengaluru Events//EN',
    'CALSCALE:GREGORIAN',
    // NAME is RFC 7986's standard property; X-WR-CALNAME is what Google, Apple and Outlook have
    // actually read for twenty years. Both, because neither alone is honoured everywhere.
    `NAME:${escapeIcsText(calendarName)}`,
    `X-WR-CALNAME:${escapeIcsText(calendarName)}`,
    `X-WR-CALDESC:${escapeIcsText(calendarDescription)}`,
    // Every DTSTART below is a UTC instant, so this changes no event's time. It tells the client
    // which zone to PRESENT a floating value in and which zone the calendar is "about", which is
    // what stops a subscriber in another zone seeing a Bengaluru evening on the wrong day.
    'X-WR-TIMEZONE:Asia/Kolkata',
    `REFRESH-INTERVAL;VALUE=DURATION:${REFRESH_DURATION}`,
    `X-PUBLISHED-TTL:${REFRESH_DURATION}`,
  ];

  for (const event of events) {
    const start = asDate(event.startDateTime);
    const end = event.endDateTime
      ? asDate(event.endDateTime)
      : new Date(start.getTime() + DEFAULT_DURATION_MS);
    const stamp = toIcsUtc(asDate(event.updatedAt));

    const location = [event.venue, event.address, event.area, event.city]
      .filter(Boolean)
      .join(', ');

    const descriptionParts: string[] = [];
    // Only the PROSE is capped. Every line below it is actionable — the host, the join link, the
    // page with the untruncated text — so they are appended afterwards and can never be the thing
    // truncation removes. See `MAX_DESCRIPTION_CHARS` for the measurements.
    if (event.description) descriptionParts.push(truncateProse(event.description));
    if (event.organizer) descriptionParts.push(`Host: ${event.organizer}`);
    if (event.onlineLink) descriptionParts.push(`Join: ${event.onlineLink}`);
    if (event.eventUrl) descriptionParts.push(`Details: ${event.eventUrl}`);
    if (event.sourceUrl) descriptionParts.push(`Source: ${event.sourceUrl}`);

    lines.push(
      'BEGIN:VEVENT',
      // See the header: identical to the per-event route so the two merge rather than duplicate.
      `UID:${event.id}@pulseblr`,
      `DTSTAMP:${stamp}`,
      `LAST-MODIFIED:${stamp}`,
      `DTSTART:${toIcsUtc(start)}`,
      `DTEND:${toIcsUtc(end)}`,
      `SUMMARY:${escapeIcsText(event.title)}`
    );
    if (descriptionParts.length) {
      lines.push(`DESCRIPTION:${escapeIcsText(descriptionParts.join('\n\n'))}`);
    }
    if (location) lines.push(`LOCATION:${escapeIcsText(location)}`);
    // A URI value is not TEXT, so it is NOT escaped — same as the per-event route.
    if (event.eventUrl || event.sourceUrl) {
      lines.push(`URL:${event.eventUrl || event.sourceUrl}`);
    }
    lines.push(
      'STATUS:CONFIRMED',
      'BEGIN:VALARM',
      `TRIGGER:${ALARM_TRIGGER}`,
      'ACTION:DISPLAY',
      `DESCRIPTION:${escapeIcsText(event.title)} starts in 2 hours`,
      'END:VALARM',
      'END:VEVENT'
    );
  }

  lines.push('END:VCALENDAR');

  // Trailing CRLF: RFC 5545 makes every content line CRLF-TERMINATED rather than
  // CRLF-separated, and a few strict parsers drop an unterminated final line.
  return `${lines.map(foldLine).join(ICS_CRLF)}${ICS_CRLF}`;
}

/**
 * A strong ETag for a feed body.
 *
 * Strong rather than weak (`W/`) because the comparison really is byte-exact — `buildCalendarFeed`
 * is deterministic for fixed input, which is what `FeedEvent.updatedAt` exists to guarantee.
 * Truncated to 27 base64url characters (162 bits): a collision would serve one user a stale
 * calendar, and that is already far past the point where the hash stops being the weak link.
 */
export function icsEtag(body: string): string {
  return `"${crypto.createHash('sha256').update(body, 'utf8').digest('base64url').slice(0, 27)}"`;
}

/**
 * The path a calendar client subscribes to.
 *
 * ── IT ENDS IN `.ics`, AND THAT IS FUNCTIONAL, NOT COSMETIC. ─────────────────────────────────
 * Several clients sniff the extension before they trust the Content-Type, and Google's "From URL"
 * field is the one most likely to reject a bare path. The route therefore lives at
 * `app/api/calendar/[token]/feed.ics/route.ts` — a directory whose name contains a dot, which is
 * legal in the App Router and has no other precedent in this repo, so it was verified by
 * requesting it from a running server rather than assumed.
 *
 * Kept pure (no `absoluteUrl()`) so it can be unit-tested: `lib/canonical-origin.ts` reads
 * `NEXTAUTH_URL` and THROWS in production when it is unset, which is right for minting a
 * long-lived link and wrong for a test.
 */
export function calendarFeedPath(token: string): string {
  return `/api/calendar/${token}/feed.ics`;
}

/**
 * The same URL under the `webcal:` scheme.
 *
 * On iOS and macOS this hands the URL straight to Calendar with a subscribe prompt, which turns a
 * three-screen copy-paste into one tap. It is not a different protocol — the client fetches over
 * http(s) exactly as before — so only the scheme is swapped, and an origin that is neither http
 * nor https is returned untouched rather than mangled.
 */
export function toWebcalUrl(httpUrl: string): string {
  return httpUrl.replace(/^https?:/, 'webcal:');
}
