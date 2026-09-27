import { describe, it, expect } from 'vitest';
import ICAL from 'ical.js';
import { PLACEHOLDER_SOURCE_URL } from '../lib/events/placeholder';
import {
  ICS_CRLF,
  buildCalendarFeed,
  buildEventIcs,
  calendarFeedPath,
  escapeIcsText,
  foldLine,
  icsEtag,
  icsParamValue,
  icsUri,
  toIcsUtc,
  toWebcalUrl,
  type DownloadEvent,
  type FeedEvent,
} from '@/lib/calendar/ics';

/**
 * The ICS generator, as pure functions.
 *
 * EVERY ASSERTION HERE WAS PROVEN TO FAIL BEFORE THE THING IT GUARDS WAS WRITTEN. That matters
 * more than usual for this file, because the two fold defects it pins are invisible in review —
 * `line.slice(0, 75)` looks correct, and the output still parses in every client that is lenient
 * about line length. The verification was: run the original inline `foldLine` from
 * `app/api/events/[id]/ics/route.ts` against these inputs and watch the octet and surrogate
 * assertions go red (91 octets, and U+FFFD appearing where the input had none), then swap in the
 * fixed one and watch them go green.
 *
 * NOTHING HERE TOUCHES A DATABASE, A SERVER OR A CLOCK, per the scope docblock in
 * `vitest.config.mts`. The live half — that the route actually answers, that a 304 comes back on
 * the second poll, that a disabled feed 404s — is `scripts/diag-calendar-feed.ts`.
 */

/** Octet length, which is the unit RFC 5545 §3.1 actually specifies. */
const octets = (value: string) => Buffer.byteLength(value, 'utf8');

/**
 * Undo folding: a CRLF followed by exactly one space is a fold and vanishes.
 *
 * Deliberately a TEST helper rather than an export. Nothing in the app unfolds, and this repo
 * deletes unreferenced code (the eight category gradients went for that reason) — but the round
 * trip is the strongest assertion available here, because an off-by-one in either the 75 or the 74
 * budget survives every "is each line short enough" check and only shows up as a lost or
 * duplicated character.
 */
const unfold = (value: string) => value.replace(/\r\n /g, '');

/** Is any UTF-16 code unit an unpaired surrogate? That is unrepresentable in UTF-8. */
function hasLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/** What actually goes on the wire, and back. A lone surrogate becomes U+FFFD in transit. */
const throughUtf8 = (value: string) => Buffer.from(value, 'utf8').toString('utf8');

describe('foldLine — 75 OCTETS, not 75 code units', () => {
  it('leaves a line that already fits alone (control)', () => {
    // THE CONTROL THAT MUST NOT FIRE. Without it, a fold function that mangled every line
    // would still satisfy every assertion below.
    const short = 'SUMMARY:React Bengaluru Meetup #108';
    expect(foldLine(short)).toBe(short);
    expect(foldLine(short)).not.toContain(ICS_CRLF);
  });

  it('folds a 75-code-unit em-dash title that is 91 octets long', () => {
    // MEASURED AGAINST THE ORIGINAL: first line 75 code units / 91 octets. An em-dash is one
    // UTF-16 code unit and three UTF-8 bytes, and scraped Bengaluru titles are full of them.
    const line = `SUMMARY:${'AI — Bengaluru — '.repeat(6)}`;
    expect(octets(line)).toBeGreaterThan(75);

    for (const segment of foldLine(line).split(ICS_CRLF)) {
      expect(octets(segment)).toBeLessThanOrEqual(75);
    }
  });

  it('never splits a surrogate pair on the FIRST fold boundary', () => {
    // The high surrogate has to sit exactly on the boundary for this to fire, so the string is
    // 74 filler units, not the 66 the brief for this work suggested — that one demonstrates the
    // octet defect and leaves a pair intact. Measured on the original: charCodeAt(74) === 0xD83C,
    // charCodeAt(75) === 0xDF89, two lone surrogates in the output, U+FFFD after a round trip.
    const line = `${'x'.repeat(74)}\u{1F389}more text`;
    const folded = foldLine(line);

    expect(hasLoneSurrogate(folded)).toBe(false);
    expect(throughUtf8(folded)).not.toContain('�');
    expect(folded).toContain('\u{1F389}');
  });

  it('never splits a surrogate pair on a CONTINUATION boundary either', () => {
    // The second and later segments have their own 74-octet budget, so a fix applied only to the
    // first slice would leave half the bug live. 148 = 75 + 73, which puts the emoji on the
    // second boundary.
    const line = `${'x'.repeat(148)}\u{1F389}tail`;
    const folded = foldLine(line);

    expect(folded.split(ICS_CRLF).length).toBeGreaterThan(2);
    expect(hasLoneSurrogate(folded)).toBe(false);
    expect(throughUtf8(folded)).not.toContain('�');
  });

  it('round-trips: unfolding returns the input exactly', () => {
    // The assertion that catches an off-by-one in either budget. A fold that dropped or repeated
    // one character per segment passes every length check above and fails only here.
    for (const line of [
      `DESCRIPTION:${'Bengaluru — hardware ₹500 \u{1F389} '.repeat(20)}`,
      `SUMMARY:${'x'.repeat(74)}\u{1F389}more text`,
      `SUMMARY:${'₹'.repeat(200)}`,
      'SUMMARY:short',
      '',
    ]) {
      expect(unfold(foldLine(line))).toBe(line);
    }
  });

  it('keeps every continuation segment prefixed with exactly one space', () => {
    const segments = foldLine(`DESCRIPTION:${'—'.repeat(120)}`).split(ICS_CRLF);
    expect(segments.length).toBeGreaterThan(1);
    for (const segment of segments.slice(1)) {
      expect(segment.startsWith(' ')).toBe(true);
      expect(segment.startsWith('  ')).toBe(false);
    }
  });

  it('folds a 4-octet-per-character line without exceeding the budget', () => {
    // Every character costs 4 octets, so a segment holds 18 of them (72 octets) plus the lead
    // space. This is the case where a code-unit-counting implementation is off by a factor of two.
    for (const segment of foldLine(`SUMMARY:${'\u{1F389}'.repeat(60)}`).split(ICS_CRLF)) {
      expect(octets(segment)).toBeLessThanOrEqual(75);
    }
  });
});

describe('escapeIcsText', () => {
  it('escapes backslash first, so an escape is never double-escaped', () => {
    // Order is load-bearing: escaping the comma before the backslash turns `a,b` into `a\\,b`,
    // i.e. a literal backslash followed by an unescaped comma, which splits the value.
    expect(escapeIcsText('a\\b')).toBe('a\\\\b');
    expect(escapeIcsText('a,b')).toBe('a\\,b');
    expect(escapeIcsText('a;b')).toBe('a\\;b');
    expect(escapeIcsText('a\\,b')).toBe('a\\\\\\,b');
  });

  it('turns real newlines into the literal two-character escape', () => {
    expect(escapeIcsText('one\ntwo')).toBe('one\\ntwo');
    expect(escapeIcsText('one\r\ntwo')).toBe('one\\ntwo');
  });

  it('turns EVERY line-break form into that escape, not only \\r?\\n (CWE-93)', () => {
    // The lone CR is the security finding: ical4j (Android's ICSx5 and DAVx5) ends a content line on
    // it, and `stripHtml` decodes `&#13;` into one, so any scraped description can carry it. The rest
    // are line terminators to Python's `str.splitlines()`, measured.
    for (const brk of ['\r', '\u{2028}', '\u{2029}', '\x85', '\v', '\f']) {
      expect(escapeIcsText(`one${brk}two`)).toBe('one\\ntwo');
    }
  });

  it('removes every control TEXT forbids, and keeps HTAB, which TEXT allows', () => {
    // C0 (NUL, ESC, FS), DEL and C1 (CSI). A strict parser rejects the whole feed over one of these.
    expect(escapeIcsText('a\x00b\x1bc\x1cd\x7fe\x9bf')).toBe('abcdef');
    expect(escapeIcsText('a\tb')).toBe('a\tb');
  });

  it('never doubles the backslash of an escape it inserted for a new break form', () => {
    // Backslashes are escaped BEFORE breaks become `\n`. The other order turns a CR into `\\n`, which
    // reads back as a literal backslash and an `n`.
    expect(escapeIcsText('a\rb\\c')).toBe('a\\nb\\\\c');
  });
});

describe('toIcsUtc', () => {
  it('emits the basic UTC form with no punctuation', () => {
    expect(toIcsUtc(new Date('2026-08-22T10:30:00.000Z'))).toBe('20260822T103000Z');
  });

  it('converts an IST wall time to UTC rather than printing it verbatim', () => {
    // A 7 PM IST event is 13:30 UTC. Printing the local time here would put every Bengaluru
    // evening five and a half hours late in every subscriber's calendar.
    expect(toIcsUtc(new Date('2026-08-22T19:00:00+05:30'))).toBe('20260822T133000Z');
  });
});

/* ── The feed ─────────────────────────────────────────────────────────────────────────────── */

const baseEvent: FeedEvent = {
  id: '68a1b2c3d4e5f60718293a4b',
  title: 'React Bengaluru Meetup #108',
  description: 'Talks and pizza.',
  startDateTime: new Date('2026-09-20T13:30:00.000Z'),
  endDateTime: new Date('2026-09-20T16:00:00.000Z'),
  venue: 'Razorpay HQ',
  area: 'Koramangala',
  city: 'Bengaluru',
  organizer: 'React Bangalore',
  sourceUrl: 'https://meetup.com/reactbangalore/events/1',
  eventUrl: 'https://pulseblr.example.com/events/68a1b2c3d4e5f60718293a4b',
  updatedAt: new Date('2026-09-01T05:00:00.000Z'),
};

const feedOf = (events: FeedEvent[]) =>
  buildCalendarFeed({
    events,
    calendarName: 'PulseBLR — saved events',
    calendarDescription: 'Events you saved in PulseBLR.',
  });

describe('buildCalendarFeed — byte stability, which is what the ETag rests on', () => {
  it('produces identical bytes for identical input', () => {
    // THE ASSERTION THE WHOLE CACHING STORY DEPENDS ON. `private, max-age=0, must-revalidate`
    // invites a conditional request on every poll and the 304 is free — but only while the body
    // is byte-identical when nothing changed. A `DTSTAMP: toIcsUtc(new Date())` makes every
    // response a fresh 200 with a new ETag, and the feature looks implemented while never once
    // serving a 304.
    expect(feedOf([baseEvent])).toBe(feedOf([baseEvent]));
  });

  it('takes DTSTAMP from updatedAt, not from the clock', () => {
    const body = feedOf([baseEvent]);
    expect(body).toContain('DTSTAMP:20260901T050000Z');
    expect(body).toContain('LAST-MODIFIED:20260901T050000Z');

    // And it MOVES when the row does — otherwise the assertion above is satisfied by a constant.
    const later = feedOf([{ ...baseEvent, updatedAt: new Date('2026-09-02T06:00:00.000Z') }]);
    expect(later).toContain('DTSTAMP:20260902T060000Z');
    expect(later).not.toBe(body);
  });

  it('orders events deterministically regardless of input order', () => {
    const second: FeedEvent = {
      ...baseEvent,
      id: '68a1b2c3d4e5f60718293a4c',
      title: 'GIDS 2027',
      startDateTime: new Date('2026-10-01T04:00:00.000Z'),
    };
    expect(feedOf([baseEvent, second])).toBe(feedOf([second, baseEvent]));
  });

  it('breaks a start-time tie on id, so two events at one instant cannot swap', () => {
    const a: FeedEvent = { ...baseEvent, id: 'aaa', title: 'A' };
    const b: FeedEvent = { ...baseEvent, id: 'bbb', title: 'B' };
    const body = feedOf([b, a]);
    expect(body.indexOf('UID:aaa@pulseblr')).toBeLessThan(body.indexOf('UID:bbb@pulseblr'));
  });

  it('gives a different ETag for different content and the same for the same', () => {
    const body = feedOf([baseEvent]);
    expect(icsEtag(body)).toBe(icsEtag(feedOf([baseEvent])));
    expect(icsEtag(body)).not.toBe(icsEtag(feedOf([])));
    // A strong validator: quoted, no `W/` prefix. The comparison really is byte-exact.
    expect(icsEtag(body)).toMatch(/^"[A-Za-z0-9_-]{27}"$/);
  });
});

describe('buildCalendarFeed — the properties a subscription needs', () => {
  const body = feedOf([baseEvent]);

  it('OMITS METHOD, which is what makes it a subscription rather than an invitation', () => {
    // With METHOD present the object is an iTIP MESSAGE (RFC 5546) and Outlook offers to import
    // it once instead of treating the URL as a living calendar. The per-event download keeps its
    // METHOD:PUBLISH, where a one-shot import is exactly right.
    expect(body).not.toContain('METHOD:');
  });

  it('carries the refresh hints and calendar identity', () => {
    expect(body).toContain('BEGIN:VCALENDAR');
    expect(body).toContain('VERSION:2.0');
    expect(body).toContain('CALSCALE:GREGORIAN');
    expect(body).toContain('REFRESH-INTERVAL;VALUE=DURATION:PT4H');
    expect(body).toContain('X-PUBLISHED-TTL:PT4H');
    expect(body).toContain('X-WR-TIMEZONE:Asia/Kolkata');
    // Both the RFC 7986 name and the de-facto one: neither is honoured everywhere.
    expect(body).toContain('NAME:PulseBLR');
    expect(body).toContain('X-WR-CALNAME:PulseBLR');
    expect(body).toContain('X-WR-CALDESC:Events you saved in PulseBLR.');
    expect(body.trimEnd().endsWith('END:VCALENDAR')).toBe(true);
  });

  it('uses the SAME UID shape as the per-event download, so the two merge', () => {
    // `app/api/events/[id]/ics/route.ts` emits `UID:${event._id}@pulseblr`. A user who both
    // subscribes and downloads one .ics has handed their calendar the same UID twice, and UID is
    // what a client de-duplicates on — so this string being identical is what turns two
    // overlapping copies of an evening into one.
    expect(body).toContain(`UID:${baseEvent.id}@pulseblr`);
  });

  it('keeps the two-hour alarm', () => {
    expect(body).toContain('BEGIN:VALARM');
    expect(body).toContain('TRIGGER:-PT2H');
    expect(body).toContain('ACTION:DISPLAY');
  });

  it('defaults a missing end time to two hours rather than emitting a zero-length event', () => {
    const open = feedOf([{ ...baseEvent, endDateTime: null }]);
    expect(open).toContain('DTSTART:20260920T133000Z');
    expect(open).toContain('DTEND:20260920T153000Z');
  });

  it('renders an empty feed as a valid, event-free calendar', () => {
    // A user who has enabled the feed and saved nothing must get a parseable calendar, not a
    // truncated body — a client that fails to parse usually disables the subscription silently.
    const empty = feedOf([]);
    expect(empty).toContain('BEGIN:VCALENDAR');
    expect(empty).toContain('END:VCALENDAR');
    expect(empty).not.toContain('BEGIN:VEVENT');
  });

  it('omits DESCRIPTION, LOCATION and URL entirely when there is nothing to say', () => {
    // An empty `DESCRIPTION:` is legal but reads as a blank note in every client.
    const bare = feedOf([
      {
        id: 'bare',
        title: 'Untitled gathering',
        startDateTime: new Date('2026-09-20T13:30:00.000Z'),
        updatedAt: new Date('2026-09-01T05:00:00.000Z'),
      },
    ]);
    expect(bare).not.toContain('DESCRIPTION:\r\n');
    expect(bare).not.toContain('LOCATION:');
    expect(bare).not.toContain('URL:');
    // The alarm's own DESCRIPTION is still there — it is not the event's.
    expect(bare).toContain('Untitled gathering starts in 2 hours');
  });
});

describe('buildCalendarFeed — the description cap', () => {
  // Median stored description is 1044 characters and p90 is 3572, so the cap fires on most rows.
  const long = `${'word '.repeat(400)}TAIL_MARKER`;

  it('caps the prose and marks it with an ellipsis', () => {
    const body = unfold(feedOf([{ ...baseEvent, description: long }]));
    expect(body).not.toContain('TAIL_MARKER');
    expect(body).toContain('…');
  });

  it('KEEPS every actionable line, which is the whole reason the cap is safe', () => {
    // The trap this guards: truncating the JOINED description string instead of just the prose
    // silently eats the `Details:` link — i.e. the cap would remove the one thing that makes the
    // truncation acceptable, and the feed would still look fine.
    const body = unfold(
      feedOf([
        {
          ...baseEvent,
          description: long,
          organizer: 'React Bangalore',
          onlineLink: 'https://meet.example.com/abc',
        },
      ])
    );
    expect(body).toContain('Host: React Bangalore');
    expect(body).toContain('Join: https://meet.example.com/abc');
    expect(body).toContain(`Details: ${baseEvent.eventUrl}`);
    expect(body).toContain(`Source: ${baseEvent.sourceUrl}`);
  });

  it('leaves a short description untouched (control)', () => {
    const body = unfold(feedOf([baseEvent]));
    expect(body).toContain('DESCRIPTION:Talks and pizza.');
    expect(body).not.toContain('…');
  });

  it('cuts at the limit rather than absurdly early when there is no whitespace', () => {
    // A 600-character run with no space is a URL or a hash. Preferring a word boundary must not
    // mean cutting at character 3 because that is where the only space happens to be.
    const body = unfold(feedOf([{ ...baseEvent, description: `a ${'x'.repeat(900)}` }]));
    // `[\s\S]` rather than the `s` (dotAll) flag: this repo's tsconfig target predates ES2018, so
    // `/…/s` is a tsc error even though esbuild transpiles it for vitest without complaint.
    const match = body.match(/DESCRIPTION:([\s\S]*?)\\n\\nHost/);
    expect(match).toBeTruthy();
    expect(match![1].length).toBeGreaterThan(500);
  });

  it('is deterministic, so the cap cannot destabilise the ETag', () => {
    const a = feedOf([{ ...baseEvent, description: long }]);
    expect(a).toBe(feedOf([{ ...baseEvent, description: long }]));
  });
});

describe('buildCalendarFeed — hostile scraped text', () => {
  it('holds EVERY emitted line to 75 octets for a realistic scraped title', () => {
    // The structural invariant. Title, description, venue and organiser are all third-party text,
    // so this is the assertion that would have caught the 91-octet line in production.
    const nasty: FeedEvent = {
      ...baseEvent,
      title: 'AI — Bengaluru — Agents, RAG & Evals \u{1F389} ₹499 — Koramangala',
      description: `${'Bengaluru — hardware, VLSI ₹500 \u{1F389} '.repeat(30)}`,
      venue: 'WeWork Galaxy — 43, Residency Rd — Shanthala Nagar',
      organizer: 'The Product Folks — Bengaluru \u{1F389}',
    };

    const body = feedOf([nasty]);
    for (const line of body.split(ICS_CRLF)) {
      expect(octets(line)).toBeLessThanOrEqual(75);
    }
    expect(hasLoneSurrogate(body)).toBe(false);
    expect(throughUtf8(body)).not.toContain('�');
  });

  it('escapes a title carrying a comma and a semicolon', () => {
    const body = feedOf([{ ...baseEvent, title: 'Kafka, Flink; and you' }]);
    // Unfolded, so the assertion is about escaping rather than about where a fold landed.
    expect(unfold(body)).toContain('SUMMARY:Kafka\\, Flink\\; and you');
  });

  it('uses CRLF throughout, with no bare LF anywhere', () => {
    // A bare LF is the classic reason a feed parses in one client and not another. `\n` inside a
    // description has already become the literal `\\n` escape by this point.
    const body = feedOf([{ ...baseEvent, description: 'line one\nline two' }]);
    expect(body.replace(/\r\n/g, '')).not.toContain('\n');
    expect(unfold(body)).toContain('line one\\nline two');
  });
});

/* ── Line injection (CWE-93): every content line, in both producers ─────────────────────────── */

/**
 * WHAT WAS MUTATION-CHECKED, AND HOW. These were run against the three pre-fix sinks: the old
 * `escapeIcsText`, a raw `URL:`, and the organiser TEXT-escaped inside `CN=`. 122 of the 179 tests in
 * this file failed. That was every security row EXCEPT the 20 CRLF and LF rows whose field reaches
 * only TEXT, and those pass there too, because `\r?\n` was always handled.
 *
 * The 20 were then checked by stripping `escapeIcsText` of BOTH break normalisation and control
 * removal, which fails all 20. Disabling the normalisation ALONE fails none of them, because
 * `stripControlChars` deletes CR and LF by itself. That is measured, not assumed: the fix has two
 * layers, and breaking one still leaves the output inert.
 *
 * The rows marked "(control)" are meant to pass either way.
 */

/**
 * Every character SOME parser in circulation ends a line on, not just CRLF.
 *
 *   · CR: ical4j, behind Android's ICSx5 and DAVx5 (the security panel's finding)
 *   · LF: ical.js, measured in its `_eachLine`
 *   · VT, FF, FS, GS, RS, NEL, U+2028, U+2029: Python's `str.splitlines()`, measured
 *
 * A check that split on CRLF alone would agree with the builder about where every line ends, and
 * see nothing wrong. That is exactly how a lone CR went unnoticed.
 */
const ANY_BREAK = /\r\n|[\n\v\f\r\x1c-\x1e\x85\u{2028}\u{2029}]/u;

/** What the most permissive of those parsers would see: RFC-unfolded, then split on ANY_BREAK. */
const hostileLines = (body: string) => unfold(body).split(ANY_BREAK).filter(line => line !== '');

/**
 * A body's shape: each line's property name, with BEGIN and END kept whole, so a forged component
 * shows up as an extra `BEGIN:VEVENT` and not as one more anonymous `BEGIN`.
 */
const skeleton = (body: string) =>
  hostileLines(body).map(line => {
    const name = /^[A-Z][A-Z0-9-]*/.exec(line)?.[0];
    if (!name) return `<not a property: ${JSON.stringify(line.slice(0, 24))}>`;
    return name === 'BEGIN' || name === 'END' ? line : name;
  });

/** Anything TEXT forbids (C0 but HTAB, and DEL), plus C1 and LS/PS, anywhere outside the CRLF delimiters. */
const STRAY_CONTROL = /[\x00-\x08\x0a-\x1f\x7f-\x9f\u{2028}\u{2029}]/u;
const hasStrayControl = (body: string) => STRAY_CONTROL.test(unfold(body).split(ICS_CRLF).join(''));

/** The UID lines a permissive parser would see. The attack's payoff is a second one, naming another event. */
const uidLines = (body: string) => hostileLines(body).filter(line => line.startsWith('UID:'));

const BREAKS: [string, string][] = [
  ['a lone CR', '\r'],
  ['CRLF', '\r\n'],
  ['a lone LF', '\n'],
  ['U+2028', '\u{2028}'],
  ['U+2029', '\u{2029}'],
  ['NEL (U+0085)', '\x85'],
  ['VT, a C0 control Python splits on', '\v'],
  ['FS, a C0 control Python splits on', '\x1c'],
  ['ESC, a C0 control no parser splits on but TEXT forbids', '\x1b'],
  ['NUL', '\x00'],
];

/** Close this event, open a forged one claiming another event's UID, and give it a title. */
const forgedText = (brk: string) =>
  ['Evil', 'END:VEVENT', 'BEGIN:VEVENT', 'UID:other@pulseblr', 'SUMMARY:pwned'].join(brk);

/** The security panel's exploit shape: the same forgery riding on a URL. */
const forgedUrl = (brk: string) =>
  ['https://example.com/x', 'END:VEVENT', 'BEGIN:VEVENT', 'UID:other@pulseblr', 'SUMMARY:pwned'].join(brk);

/** A fixed clock for the per-event download, whose DTSTAMP is the moment it was built. */
const NOW = new Date('2026-09-27T06:00:00.000Z');

const baseDownload: DownloadEvent = {
  id: baseEvent.id,
  title: baseEvent.title,
  description: baseEvent.description,
  startDateTime: baseEvent.startDateTime,
  endDateTime: baseEvent.endDateTime,
  venue: baseEvent.venue,
  area: baseEvent.area,
  city: baseEvent.city,
  organizer: baseEvent.organizer,
  sourceUrl: baseEvent.sourceUrl,
};

/**
 * One hostile input field. `set(null)` gives the CLEAN stand-in the expected shape is built from:
 * ordinary text for a text field, and absence for a URL field, because a refused URL must look
 * exactly like no URL at all.
 */
interface Field<E> {
  label: string;
  kind: 'text' | 'url';
  set: (value: string | null) => Partial<E>;
}

const FEED_FIELDS: Field<FeedEvent>[] = [
  { label: 'title (SUMMARY and the alarm)', kind: 'text', set: v => ({ title: v ?? 'Clean' }) },
  { label: 'description (DESCRIPTION)', kind: 'text', set: v => ({ description: v ?? 'Clean' }) },
  { label: 'venue (LOCATION)', kind: 'text', set: v => ({ venue: v ?? 'Clean' }) },
  { label: 'organizer (DESCRIPTION, Host:)', kind: 'text', set: v => ({ organizer: v ?? 'Clean' }) },
  { label: 'onlineLink (DESCRIPTION, Join:)', kind: 'url', set: v => ({ onlineLink: v }) },
  // With no eventUrl, sourceUrl is what reaches the URL: line.
  { label: 'sourceUrl (URL and Source:)', kind: 'url', set: v => ({ sourceUrl: v, eventUrl: null }) },
  { label: 'eventUrl (URL and Details:)', kind: 'url', set: v => ({ eventUrl: v }) },
];

const DOWNLOAD_FIELDS: Field<DownloadEvent>[] = [
  { label: 'title (SUMMARY and the alarm)', kind: 'text', set: v => ({ title: v ?? 'Clean' }) },
  { label: 'description (DESCRIPTION)', kind: 'text', set: v => ({ description: v ?? 'Clean' }) },
  { label: 'venue (LOCATION)', kind: 'text', set: v => ({ venue: v ?? 'Clean' }) },
  { label: 'organizer (ORGANIZER;CN= and Host:)', kind: 'text', set: v => ({ organizer: v ?? 'Clean' }) },
  { label: 'onlineLink (DESCRIPTION, Join:)', kind: 'url', set: v => ({ onlineLink: v }) },
  { label: 'sourceUrl (URL and Source:)', kind: 'url', set: v => ({ sourceUrl: v }) },
];

/**
 * Every field × every break, through one producer. Three assertions, and each catches something the
 * others do not:
 *   · skeleton: no line was added or removed, which catches a forged property or component whatever
 *     break carried it
 *   · uidLines: the attack's actual payoff, a second UID, is absent
 *   · hasStrayControl: nothing TEXT forbids is left, which catches ESC and NUL. Those break no
 *     line, but a strict parser rejects the whole calendar over them.
 */
function injectionMatrix<E>(producer: string, build: (overrides: Partial<E>) => string, fields: Field<E>[]) {
  describe(`${producer}: no input can start a content line`, () => {
    for (const field of fields) {
      const expected = skeleton(build(field.set(null)));
      for (const [breakLabel, brk] of BREAKS) {
        it(`${field.label}, ${breakLabel}`, () => {
          const body = build(field.set(field.kind === 'url' ? forgedUrl(brk) : forgedText(brk)));
          expect(skeleton(body)).toEqual(expected);
          expect(uidLines(body)).toEqual([`UID:${baseEvent.id}@pulseblr`]);
          expect(hasStrayControl(body)).toBe(false);
        });
      }
    }
  });
}

injectionMatrix<FeedEvent>(
  'buildCalendarFeed',
  overrides => feedOf([{ ...baseEvent, ...overrides }]),
  FEED_FIELDS
);
injectionMatrix<DownloadEvent>(
  'buildEventIcs',
  overrides => buildEventIcs({ ...baseDownload, ...overrides }, NOW),
  DOWNLOAD_FIELDS
);

describe("the security panel's exploit, verbatim", () => {
  // A scraped sourceUrl of `https://example.com/x` CR `END:VEVENT` CR `BEGIN:VEVENT` CR
  // `UID:other@pulseblr` and so on: a second event that a client applies to whichever real event
  // owns that UID.
  const exploit = [
    'https://example.com/x',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:other@pulseblr',
    'DTSTART:20260920T133000Z',
    'SUMMARY:pwned',
  ].join('\r');

  it('yields exactly one VEVENT from the feed, to a parser that ends lines on CR', () => {
    for (const body of [
      feedOf([{ ...baseEvent, sourceUrl: exploit }]),
      feedOf([{ ...baseEvent, sourceUrl: exploit, eventUrl: null }]),
      feedOf([{ ...baseEvent, eventUrl: exploit }]),
    ]) {
      expect(hostileLines(body).filter(line => line === 'BEGIN:VEVENT')).toHaveLength(1);
      expect(uidLines(body)).toEqual([`UID:${baseEvent.id}@pulseblr`]);
    }
  });

  it('yields exactly one VEVENT from the per-event download too', () => {
    const body = buildEventIcs({ ...baseDownload, sourceUrl: exploit }, NOW);
    expect(hostileLines(body).filter(line => line === 'BEGIN:VEVENT')).toHaveLength(1);
    expect(uidLines(body)).toEqual([`UID:${baseEvent.id}@pulseblr`]);
  });

  it('and a REAL parser agrees, for the LF and CRLF forms the old code fell to', () => {
    // ical.js (installed) splits on LF only, so it cannot see the CR form. That is why the checks
    // above use a permissive splitter rather than trusting a parser as the oracle. For LF and CRLF it
    // IS an independent witness. Against the route's old inline code it parsed TWO VEVENTs, the second
    // with UID other@pulseblr, and the real event's ORGANIZER landed inside the forged one.
    for (const brk of ['\n', '\r\n']) {
      for (const body of [
        buildEventIcs({ ...baseDownload, sourceUrl: forgedUrl(brk) }, NOW),
        feedOf([{ ...baseEvent, eventUrl: forgedUrl(brk) }]),
      ]) {
        const events = new ICAL.Component(ICAL.parse(body)).getAllSubcomponents('vevent');
        expect(events.map(event => event.getFirstPropertyValue('uid'))).toEqual([
          `${baseEvent.id}@pulseblr`,
        ]);
      }
    }
    const download = buildEventIcs({ ...baseDownload, sourceUrl: forgedUrl('\n') }, NOW);
    const vevent = new ICAL.Component(ICAL.parse(download)).getFirstSubcomponent('vevent');
    expect(vevent?.getFirstProperty('organizer')?.getParameter('cn')).toBe('React Bangalore');
  });
});

describe('icsUri: a URI cannot be escaped, so it is validated', () => {
  it('passes a canonical URL through unchanged (control)', () => {
    expect(icsUri(baseEvent.sourceUrl)).toBe(baseEvent.sourceUrl);
    expect(icsUri(baseEvent.eventUrl)).toBe(baseEvent.eventUrl);
  });

  it('refuses the exploit rather than repairing it', () => {
    // The repair it refuses: WHATWG parsing silently DELETES CR, LF and TAB, so the attack comes back
    // as a "valid" URL with its line breaks filed off.
    expect(new URL(forgedUrl('\r')).href).toContain('xEND:VEVENT');
    for (const [, brk] of BREAKS) expect(icsUri(forgedUrl(brk))).toBeNull();
  });

  it('trims surrounding whitespace, since a trailing newline is an ordinary scraping artefact', () => {
    expect(icsUri('https://meetup.com/x/events/1\n')).toBe('https://meetup.com/x/events/1');
    expect(icsUri('  https://meetup.com/x/events/1\r\n')).toBe('https://meetup.com/x/events/1');
  });

  it('refuses anything that is not an absolute http(s) URL', () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', '/events/123', 'not a url', '', '   ', null, undefined]) {
      expect(icsUri(bad)).toBeNull();
    }
  });

  it('emits the parsed, percent-encoded href', () => {
    expect(icsUri('https://example.com')).toBe('https://example.com/');
    expect(icsUri('https://example.com/a b')).toBe('https://example.com/a%20b');
  });
});

describe('icsParamValue: a parameter is not TEXT', () => {
  it('quotes a name containing a colon, comma or semicolon, so a parser keeps it whole', () => {
    // Measured with ical.js against the route's old inline code: CN parsed as "Tech", and the rest of
    // the name, `Bengaluru\, Koramangala\; "HQ"`, became the ORGANIZER's calendar ADDRESS.
    const body = buildEventIcs({ ...baseDownload, organizer: 'Tech: Bengaluru, Koramangala; "HQ"' }, NOW);
    const organizer = new ICAL.Component(ICAL.parse(body))
      .getFirstSubcomponent('vevent')
      ?.getFirstProperty('organizer');
    expect(organizer?.getParameter('cn')).toBe("Tech: Bengaluru, Koramangala; 'HQ'");
    expect(organizer?.getFirstValue()).toBe('MAILTO:noreply@pulseblr.local');
  });

  it('turns breaks into spaces and drops controls, since a parameter can carry neither', () => {
    expect(icsParamValue('React\rBangalore\u{2028}Chapter\x00')).toBe('React Bangalore Chapter');
  });

  it('leaves an ordinary name exactly as it was (control)', () => {
    // The common case must not change a byte: no quotes added, nothing escaped.
    expect(icsParamValue('React Bangalore')).toBe('React Bangalore');
    expect(icsParamValue("GDG Cloud (Bengaluru) & friends' club")).toBe(
      "GDG Cloud (Bengaluru) & friends' club"
    );
  });
});

describe('buildEventIcs: the per-event download, now testable', () => {
  it('emits the SAME UID line as the feed, so subscribing and downloading merge (control)', () => {
    // This was a comment in both files. With both producers pure it can be an assertion.
    expect(uidLines(buildEventIcs(baseDownload, NOW))).toEqual(uidLines(feedOf([baseEvent])));
  });

  it('keeps METHOD:PUBLISH, a DTSTAMP from `now`, the URL and the organiser (control)', () => {
    const body = unfold(buildEventIcs(baseDownload, NOW));
    expect(body).toContain('METHOD:PUBLISH');
    expect(body).toContain(`DTSTAMP:${toIcsUtc(NOW)}`);
    expect(body).toContain(`URL:${baseEvent.sourceUrl}`);
    expect(body).toContain('ORGANIZER;CN=React Bangalore:MAILTO:noreply@pulseblr.local');
    expect(body).toContain('TRIGGER:-PT2H');
  });
});

describe('the subscription URL', () => {
  it('ends in .ics, which several clients sniff before the Content-Type', () => {
    expect(calendarFeedPath('abc123')).toBe('/api/calendar/abc123/feed.ics');
  });

  it('swaps only the scheme for webcal, and leaves an unknown scheme alone', () => {
    expect(toWebcalUrl('https://pulseblr.example.com/api/calendar/t/feed.ics')).toBe(
      'webcal://pulseblr.example.com/api/calendar/t/feed.ics'
    );
    expect(toWebcalUrl('http://localhost:3000/api/calendar/t/feed.ics')).toBe(
      'webcal://localhost:3000/api/calendar/t/feed.ics'
    );
    expect(toWebcalUrl('ftp://example.com/x')).toBe('ftp://example.com/x');
  });
});

describe('the manual-event placeholder never reaches a calendar', () => {
  // A hand-added event with no link stores PLACEHOLDER_SOURCE_URL. It is not a page anybody can
  // open, so neither producer may print it as `Source:` nor emit it as the URL property.
  const placeholder = PLACEHOLDER_SOURCE_URL;

  it('the per-event download omits it', () => {
    const body = unfold(buildEventIcs({ ...baseDownload, sourceUrl: placeholder }, NOW));
    expect(body).not.toContain(placeholder);
    expect(body).not.toMatch(/^URL[:;]/m);
  });

  it('the feed falls back to the app link, never the placeholder', () => {
    const body = unfold(feedOf([{ ...baseEvent, sourceUrl: placeholder }]));
    expect(body).not.toContain(placeholder);
    expect(body).toContain(`URL:${baseEvent.eventUrl}`);
  });

  it('a real source link is still printed (control)', () => {
    expect(unfold(buildEventIcs(baseDownload, NOW))).toContain(`Source: ${baseDownload.sourceUrl}`);
  });
});
