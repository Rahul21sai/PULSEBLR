import { describe, expect, it } from 'vitest';
import {
  applyReminderCaps,
  buildUnsubscribeUrl,
  DEFAULT_LEAD_HOURS,
  DEFAULT_MAX_EMAILS_PER_DAY,
  DEFAULT_MAX_EVENTS_PER_EMAIL,
  formatReminderEmail,
  hasBeenAsked,
  isReminderDue,
  istDayStart,
  REMINDABLE_TRACKER_STATUSES,
  REMINDER_KIND,
  remindersEnabled,
  unsubscribeToken,
  verifyUnsubscribeToken,
  WHY_LINE,
  type ReminderEventView,
} from '@/lib/notifications/reminder-policy';
import { TRACKER_STATUSES } from '@/lib/tracker/validate';

/**
 * The reminder rules.
 *
 * WHY THIS SUITE IS MOSTLY ABOUT REFUSALS. Every test here that matters asserts that an email is
 * NOT sent, or that a link does NOT verify. A reminder system fails in two directions and they are
 * not symmetrical: a missed email is a disappointment, while an email to somebody who never asked
 * is a spam complaint against the sending domain, and it cannot be taken back. So the negative half
 * is the half worth pinning — the same reasoning `tests/off-city.test.ts` records for a gate whose
 * false positives delete data.
 *
 * The double-send guard is deliberately NOT tested here: it is a unique index on `ReminderLog`, and
 * a unit test could only assert a re-implementation of it. What IS tested is everything that
 * decides whether a send is attempted at all.
 */

const SECRET = 'test-secret-not-a-real-one';
const OTHER_SECRET = 'a-different-secret';

/** A user document shaped like the one that actually landed in `lib/models/User.ts`. */
function user(preferences: Record<string, unknown> | null | undefined) {
  return { preferences } as Parameters<typeof remindersEnabled>[0];
}

const ASKED = { onboardedAt: new Date('2026-09-01T10:00:00+05:30') };

describe('remindersEnabled — consent', () => {
  it('is FALSE when there are no preferences at all', () => {
    // The state every account that predates the field is in. This is the single most important
    // assertion in the file: absent must never read as consent.
    expect(remindersEnabled(user(undefined))).toBe(false);
    expect(remindersEnabled(user(null))).toBe(false);
    expect(remindersEnabled(null)).toBe(false);
    expect(remindersEnabled(undefined)).toBe(false);
  });

  it('is FALSE when the flag is true but the user has never been asked', () => {
    /*
     * THE DEFECT THIS EXISTS TO CATCH, and it is not hypothetical — it is the shipped schema
     * default. `lib/models/User.ts` declares
     *   remindersEnabled: { type: Boolean, default: DEFAULT_PREFERENCES.remindersEnabled }
     * with that default being TRUE, and `preferences` itself has a factory default on the User
     * schema. So every document created or re-saved after that landed carries the flag set without
     * anybody having seen a choice. Checking the flag alone would mail all of them.
     */
    expect(remindersEnabled(user({ remindersEnabled: true }))).toBe(false);
    expect(remindersEnabled(user({ remindersEnabled: true, onboardedAt: null }))).toBe(false);
  });

  it('is TRUE only when the flag is set AND the user has been asked', () => {
    expect(remindersEnabled(user({ remindersEnabled: true, ...ASKED }))).toBe(true);
  });

  it('respects an explicit opt-out from somebody who was asked', () => {
    expect(remindersEnabled(user({ remindersEnabled: false, ...ASKED }))).toBe(false);
  });

  it('does not accept a truthy non-boolean as consent', () => {
    // `"false"` is the realistic accident: a checkbox value round-tripped through a form or a
    // query string arrives as a string, and every non-empty string is truthy.
    for (const value of ['false', 'true', 1, {}, [], 'yes']) {
      expect(remindersEnabled(user({ remindersEnabled: value, ...ASKED }))).toBe(false);
    }
  });

  it('reads the flat schema path AND the nested one the brief specified', () => {
    // The shape that landed is flat (`preferences.remindersEnabled`); the brief named
    // `preferences.notifications.remindersEnabled`. Both are honoured, because a surface written
    // against the other shape would otherwise fail as "this user never gets an email" — the least
    // visible failure a notification system has.
    expect(remindersEnabled(user({ remindersEnabled: true, ...ASKED }))).toBe(true);
    expect(remindersEnabled(user({ notifications: { remindersEnabled: true }, ...ASKED }))).toBe(true);
  });

  it('lets the flat path override the nested one', () => {
    // The flat path is canonical: it is what the schema, the validator and the API write.
    expect(
      remindersEnabled(user({ remindersEnabled: false, notifications: { remindersEnabled: true }, ...ASKED }))
    ).toBe(false);
  });

  it('hasBeenAsked distinguishes never-asked from opted-out, and rejects a junk date', () => {
    expect(hasBeenAsked(user({}))).toBe(false);
    expect(hasBeenAsked(user({ onboardedAt: null }))).toBe(false);
    expect(hasBeenAsked(user({ onboardedAt: 'not a date' }))).toBe(false);
    expect(hasBeenAsked(user({ onboardedAt: '2026-09-01T10:00:00+05:30' }))).toBe(true);
    expect(hasBeenAsked(user(ASKED))).toBe(true);
  });
});

describe('REMINDABLE_TRACKER_STATUSES', () => {
  it('is a subset of the real status list', () => {
    // Guards against a typo silently making a status unremindable — a string that matches nothing
    // in the enum would just never appear in a query result, with no error anywhere.
    for (const status of REMINDABLE_TRACKER_STATUSES) {
      expect(TRACKER_STATUSES).toContain(status);
    }
  });

  it('excludes the three statuses that mean "do not email me about this"', () => {
    // Attended already happened; Skipped and Rejected are the user saying no. Each is a different
    // reason and each is fatal on its own.
    expect(REMINDABLE_TRACKER_STATUSES).not.toContain('Attended');
    expect(REMINDABLE_TRACKER_STATUSES).not.toContain('Skipped');
    expect(REMINDABLE_TRACKER_STATUSES).not.toContain('Rejected');
  });

  it('includes New, which is what saving an event writes', () => {
    // If this ever stops being true the whole feature is dead: the trigger for a reminder is "I
    // saved this", and SaveButton writes `New`.
    expect(REMINDABLE_TRACKER_STATUSES).toContain('New');
  });

  it('accounts for every status, so a new one has to be decided about', () => {
    const excluded = TRACKER_STATUSES.filter(
      s => !(REMINDABLE_TRACKER_STATUSES as readonly string[]).includes(s)
    );
    expect([...REMINDABLE_TRACKER_STATUSES, ...excluded].sort()).toEqual([...TRACKER_STATUSES].sort());
  });
});

describe('isReminderDue — the window', () => {
  const now = new Date('2026-09-10T08:00:00+05:30');

  it('refuses an event that has already started', () => {
    // A reminder for something in progress is a notification you were too late for, and sending it
    // teaches the reader to ignore the next one.
    expect(isReminderDue(new Date('2026-09-10T07:59:00+05:30'), now)).toBe(false);
    expect(isReminderDue(new Date('2026-09-09T19:00:00+05:30'), now)).toBe(false);
  });

  it('refuses the exact current instant', () => {
    expect(isReminderDue(now, now)).toBe(false);
  });

  it('accepts an event later today and tomorrow evening', () => {
    // The case the 36-hour default exists for: at an 8 AM run, a 24-hour window would stop at 8 AM
    // tomorrow and miss every evening event tomorrow — which is most of them.
    expect(isReminderDue(new Date('2026-09-10T19:00:00+05:30'), now)).toBe(true);
    expect(isReminderDue(new Date('2026-09-11T19:00:00+05:30'), now)).toBe(true);
  });

  it('refuses an event beyond the lead window', () => {
    expect(isReminderDue(new Date('2026-09-11T20:01:00+05:30'), now)).toBe(false);
    expect(isReminderDue(new Date('2026-09-25T19:00:00+05:30'), now)).toBe(false);
  });

  it('treats the boundary as inclusive', () => {
    const edge = new Date(now.getTime() + DEFAULT_LEAD_HOURS * 3600_000);
    expect(isReminderDue(edge, now)).toBe(true);
    expect(isReminderDue(new Date(edge.getTime() + 1000), now)).toBe(false);
  });

  it('honours an explicit lead window', () => {
    const tomorrowEvening = new Date('2026-09-11T19:00:00+05:30');
    expect(isReminderDue(tomorrowEvening, now, 12)).toBe(false);
    expect(isReminderDue(tomorrowEvening, now, 36)).toBe(true);
  });

  it('refuses missing and unparseable dates instead of treating them as due', () => {
    expect(isReminderDue(null, now)).toBe(false);
    expect(isReminderDue(undefined, now)).toBe(false);
    expect(isReminderDue('', now)).toBe(false);
    expect(isReminderDue('not a date', now)).toBe(false);
    expect(isReminderDue(new Date('nope'), now)).toBe(false);
  });

  it('accepts an ISO string as readily as a Date', () => {
    // Both shapes reach it: mongoose hands back `Date`, a JSON round trip hands back a string.
    expect(isReminderDue('2026-09-10T19:00:00+05:30', now)).toBe(true);
  });
});

describe('istDayStart — the frequency cap boundary', () => {
  it('is IST midnight, not UTC midnight', () => {
    // THE BUG THIS PINS. The runner is UTC and the 8 AM IST send is 02:30 UTC. Under a UTC day
    // boundary the morning's send lands in the PREVIOUS day's bucket, so the cap counts zero and
    // waves a second email through every single morning.
    const at0830IST = new Date('2026-09-10T08:30:00+05:30');
    expect(istDayStart(at0830IST).toISOString()).toBe('2026-09-09T18:30:00.000Z');
  });

  it('puts a late-evening IST instant in the same IST day', () => {
    // 23:30 IST on the 10th is 18:00Z on the 10th — a UTC boundary would agree here, which is
    // exactly why the 08:30 case above is the one that catches the mistake.
    const late = new Date('2026-09-10T23:30:00+05:30');
    expect(istDayStart(late).toISOString()).toBe('2026-09-09T18:30:00.000Z');
  });

  it('rolls over at IST midnight, not five and a half hours later', () => {
    const justBefore = new Date('2026-09-10T23:59:00+05:30');
    const justAfter = new Date('2026-09-11T00:01:00+05:30');
    expect(istDayStart(justBefore).toISOString()).not.toBe(istDayStart(justAfter).toISOString());
    expect(istDayStart(justAfter).toISOString()).toBe('2026-09-10T18:30:00.000Z');
  });

  it('is always at or before the instant it is given', () => {
    for (const iso of [
      '2026-01-01T00:00:00+05:30',
      '2026-06-15T12:00:00+05:30',
      '2026-12-31T23:59:59+05:30',
    ]) {
      const at = new Date(iso);
      expect(istDayStart(at).getTime()).toBeLessThanOrEqual(at.getTime());
    }
  });
});

describe('applyReminderCaps', () => {
  const three = ['a', 'b', 'c'];

  it('sends nothing when nothing is due', () => {
    const result = applyReminderCaps({ candidates: [], emailsSentToday: 0 });
    expect(result.send).toEqual([]);
    expect(result.blockedBy).toBe('nothing-due');
  });

  it('blocks everything once the daily email cap is reached', () => {
    const result = applyReminderCaps({
      candidates: three,
      emailsSentToday: DEFAULT_MAX_EMAILS_PER_DAY,
    });
    expect(result.send).toEqual([]);
    expect(result.blockedBy).toBe('daily-cap');
    // Deferred rather than dropped: a later run picks them up, and the report can say so.
    expect(result.deferred).toEqual(three);
  });

  it('blocks when already over the cap, not merely at it', () => {
    const result = applyReminderCaps({ candidates: three, emailsSentToday: 99, maxEmailsPerDay: 2 });
    expect(result.send).toEqual([]);
    expect(result.blockedBy).toBe('daily-cap');
  });

  it('sends when under the cap', () => {
    const result = applyReminderCaps({ candidates: three, emailsSentToday: 0 });
    expect(result.send).toEqual(three);
    expect(result.deferred).toEqual([]);
    expect(result.blockedBy).toBeUndefined();
  });

  it('caps events per email and defers the rest', () => {
    const many = Array.from({ length: 9 }, (_, i) => `e${i}`);
    const result = applyReminderCaps({ candidates: many, emailsSentToday: 0, maxEventsPerEmail: 4 });
    expect(result.send).toHaveLength(4);
    expect(result.deferred).toHaveLength(5);
    // Nothing is lost between the two halves.
    expect([...result.send, ...result.deferred]).toEqual(many);
  });

  it('a cap of one email per day means one email per day', () => {
    expect(
      applyReminderCaps({ candidates: three, emailsSentToday: 1, maxEmailsPerDay: 1 }).send
    ).toEqual([]);
    expect(
      applyReminderCaps({ candidates: three, emailsSentToday: 0, maxEmailsPerDay: 1 }).send
    ).toEqual(three);
  });

  it('has conservative defaults', () => {
    expect(DEFAULT_MAX_EMAILS_PER_DAY).toBeLessThanOrEqual(2);
    expect(DEFAULT_MAX_EVENTS_PER_EMAIL).toBeLessThanOrEqual(5);
  });
});

describe('unsubscribe token', () => {
  it('verifies the token it generates', () => {
    const token = unsubscribeToken('user-1', SECRET);
    expect(verifyUnsubscribeToken('user-1', token, SECRET)).toBe(true);
  });

  it('is deterministic, so a link keeps working across runs', () => {
    // It has to survive being clicked days after the email was sent, with no stored state.
    expect(unsubscribeToken('user-1', SECRET)).toBe(unsubscribeToken('user-1', SECRET));
  });

  it('refuses another user id with the same token', () => {
    // Without binding the id into the HMAC, one valid link would unsubscribe anybody.
    const token = unsubscribeToken('user-1', SECRET);
    expect(verifyUnsubscribeToken('user-2', token, SECRET)).toBe(false);
  });

  it('refuses a token signed with a different secret', () => {
    const token = unsubscribeToken('user-1', OTHER_SECRET);
    expect(verifyUnsubscribeToken('user-1', token, SECRET)).toBe(false);
  });

  it('refuses missing, empty and malformed input rather than throwing', () => {
    // A throw here is a 500 on an unsubscribe link: the reader cannot get off the list and the
    // page blames itself. `timingSafeEqual` throws on a length mismatch, which is why the verifier
    // compares lengths first — these cases are what prove it does.
    expect(verifyUnsubscribeToken(null, null, SECRET)).toBe(false);
    expect(verifyUnsubscribeToken('user-1', '', SECRET)).toBe(false);
    expect(verifyUnsubscribeToken('', 'anything', SECRET)).toBe(false);
    expect(verifyUnsubscribeToken('user-1', 'short', SECRET)).toBe(false);
    expect(verifyUnsubscribeToken('user-1', 'x'.repeat(500), SECRET)).toBe(false);
    expect(verifyUnsubscribeToken('user-1', undefined, SECRET)).toBe(false);
  });

  it('FAILS CLOSED when the secret is unset', () => {
    // If a blank secret verified, every token would verify against every other one.
    const token = unsubscribeToken('user-1', SECRET);
    expect(verifyUnsubscribeToken('user-1', token, '')).toBe(false);
    expect(verifyUnsubscribeToken('user-1', token, undefined)).toBe(false);
  });

  it('refuses to MINT a token without a secret, loudly', () => {
    // Loud rather than fail-open on the generating side: an email that reached an inbox with a
    // dead unsubscribe link is the one failure that turns a reminder into a complaint the reader
    // cannot act on. Better to refuse to send.
    expect(() => unsubscribeToken('user-1', '')).toThrow(/NEXTAUTH_SECRET/);
    expect(() => unsubscribeToken('', SECRET)).toThrow(/userId/);
  });

  it('is URL-safe, so a mail client cannot mangle it', () => {
    for (const id of ['user-1', '1001028394857362718', 'devlogin:someone@example.com']) {
      expect(unsubscribeToken(id, SECRET)).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('builds an absolute URL and tolerates a trailing slash on the base', () => {
    const a = buildUnsubscribeUrl('https://pulseblr.app', 'user-1', SECRET);
    const b = buildUnsubscribeUrl('https://pulseblr.app/', 'user-1', SECRET);
    expect(a).toBe(b);
    expect(a).toContain('https://pulseblr.app/api/reminders/unsubscribe?u=user-1&t=');
  });

  it('percent-encodes an id that needs it', () => {
    // The dev-login provider's ids contain an `@` and a `:`.
    const url = buildUnsubscribeUrl('https://pulseblr.app', 'devlogin:a@b.com', SECRET);
    expect(url).toContain('u=devlogin%3Aa%40b.com');
    // And it round-trips: what the route reads back out must verify.
    const parsed = new URL(url);
    expect(
      verifyUnsubscribeToken(parsed.searchParams.get('u'), parsed.searchParams.get('t'), SECRET)
    ).toBe(true);
  });
});

describe('formatReminderEmail', () => {
  const now = new Date('2026-09-10T08:00:00+05:30');
  const unsubscribeUrl = 'https://pulseblr.app/api/reminders/unsubscribe?u=user-1&t=abc';
  const appUrl = 'https://pulseblr.app';

  const kubernetes: ReminderEventView = {
    id: '68b0e2ddc9943efb38705263',
    title: 'BLR Kubernetes Meetup',
    startDateTime: new Date('2026-09-10T19:00:00+05:30'),
    venue: 'Razorpay HQ',
    area: 'Koramangala',
    format: 'offline',
  };
  const online: ReminderEventView = {
    id: '68b0e2ddc9943efb38705264',
    title: 'Build Your First AI Agent',
    startDateTime: new Date('2026-09-11T18:30:00+05:30'),
    format: 'online',
  };

  function build(events: ReminderEventView[]) {
    return formatReminderEmail({ events, unsubscribeUrl, appUrl, now });
  }

  it('names the single event in the subject with an IST day word', () => {
    expect(build([kubernetes]).subject).toBe('Today: BLR Kubernetes Meetup');
    expect(build([online]).subject).toBe('Tomorrow: Build Your First AI Agent');
  });

  it('counts, rather than listing, when there is more than one', () => {
    expect(build([kubernetes, online]).subject).toBe('2 saved events coming up');
  });

  it('puts the unsubscribe link in BOTH the html and the text part', () => {
    /*
     * Requirement, and it has to be in both: a text-only client that never renders the HTML part
     * must still offer a way out.
     *
     * THE TWO PARTS CARRY DIFFERENT BYTES, AND BOTH ARE CORRECT. In the text part the URL is
     * literal. In the `href` the `&` between the query parameters is escaped to `&amp;`, which is
     * the correct way to write an ampersand in an HTML attribute — a browser parses it back to `&`,
     * so the link resolves to the same place. This assertion is written the long way round because
     * the short version (`toContain(unsubscribeUrl)`) FAILS against correct output, and the
     * tempting "fix" is to stop escaping the attribute, which would be a real XSS hole the moment
     * a URL ever carried anything but a hex token.
     */
    const { html, text } = build([kubernetes]);
    expect(text).toContain(unsubscribeUrl);

    expect(html).toContain(unsubscribeUrl.replace(/&/g, '&amp;'));
    // And it is the same URL once the entity is decoded, i.e. the link genuinely works.
    const href = html.match(/href="([^"]*unsubscribe[^"]*)"/)?.[1];
    expect(href).toBeTruthy();
    expect(href!.replace(/&amp;/g, '&')).toBe(unsubscribeUrl);
  });

  it('says why the email arrived, in both parts', () => {
    const { html, text } = build([kubernetes]);
    expect(text).toContain(WHY_LINE);
    expect(html).toContain('saved this event in PulseBLR');
  });

  it('renders IST times, never the ambient locale', () => {
    // The runner is UTC. 19:00 IST is 13:30Z, so a UTC-formatted email would say 13:30 and put
    // some events on the wrong day entirely.
    const { text } = build([kubernetes]);
    expect(text).toContain('19:00');
    expect(text).not.toContain('13:30');
  });

  it('shows a venue for an in-person event and "Online" for an online one', () => {
    expect(build([kubernetes]).text).toContain('Razorpay HQ');
    expect(build([online]).text).toContain('Online');
  });

  it('links to the event page, and prefers applyLink in the text part', () => {
    const withApply = { ...kubernetes, applyLink: 'https://lu.ma/blr-k8s' };
    expect(build([withApply]).text).toContain('https://lu.ma/blr-k8s');
    // The HTML title always links to our own page, so the reader can reach the app.
    expect(build([withApply]).html).toContain(`${appUrl}/events/${kubernetes.id}`);
  });

  it('ESCAPES a hostile event title', () => {
    /*
     * Titles are scraped from third-party pages, so they are exactly as untrusted as the source
     * names and notes the digest escapes. An unescaped `<script>` in an email body is a live
     * injection in any client that renders HTML.
     */
    const nasty: ReminderEventView = {
      ...kubernetes,
      title: '<script>alert("xss")</script> & "quoted" \'meetup\'',
    };
    const { html } = build([nasty]);
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;');
    expect(html).toContain('&quot;');
    expect(html).toContain('&#39;');
  });

  it('escapes a hostile venue too, not just the title', () => {
    const nasty: ReminderEventView = { ...kubernetes, venue: '<img src=x onerror=alert(1)>' };
    expect(build([nasty]).html).not.toContain('<img src=x');
  });

  it('tolerates a trailing slash on the app URL without doubling it', () => {
    const { html } = formatReminderEmail({
      events: [kubernetes],
      unsubscribeUrl,
      appUrl: 'https://pulseblr.app/',
      now,
    });
    expect(html).not.toContain('pulseblr.app//');
  });

  it('produces a text part with no HTML tags left in it', () => {
    // Some clients show the text part verbatim; a stray tag there reads as a broken email.
    expect(build([kubernetes, online]).text).not.toMatch(/<[a-z/][^>]*>/i);
  });

  it('lists every event it was given', () => {
    const { text, html } = build([kubernetes, online]);
    for (const event of [kubernetes, online]) {
      expect(text).toContain(event.title);
      expect(html).toContain(event.title);
    }
  });
});

describe('REMINDER_KIND', () => {
  it('is a stable string, because it is part of a unique index', () => {
    // Changing this value would make every already-sent reminder invisible to the guard and
    // re-send the lot. It is data, not a label.
    expect(REMINDER_KIND).toBe('event-reminder');
  });
});
