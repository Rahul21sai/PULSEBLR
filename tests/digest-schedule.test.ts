import { describe, expect, it } from 'vitest';
import {
  applyDigestCap,
  buildDigestUnsubscribeUrl,
  DAILY_WINDOW_HOURS,
  DIGEST_EVENT_COUNT,
  DIGEST_KIND,
  digestDecision,
  digestPeriodKey,
  digestUnsubscribeToken,
  digestWhyLine,
  digestWindow,
  formatDigestEmail,
  isDigestDue,
  istWeekday,
  istWeekStartKey,
  MAX_DIGESTS_PER_IST_DAY,
  readDigestFrequency,
  verifyDigestUnsubscribeToken,
  WEEKLY_DIGEST_IST_WEEKDAY,
  WEEKLY_WINDOW_DAYS,
  type DigestEventView,
} from '@/lib/notifications/digest-schedule';
import { unsubscribeToken, verifyUnsubscribeToken } from '@/lib/notifications/reminder-policy';
import { DIGEST_FREQUENCIES } from '@/lib/events/relevance';

/**
 * The digest rules.
 *
 * WHY THIS SUITE IS MOSTLY ABOUT REFUSALS — the same reasoning `tests/reminders.test.ts` records, and
 * it applies harder here. A reminder is about an event the reader saved themselves, so it is at least
 * *expected*. A digest is a RECURRING email nobody asked for individually, sent on a schedule, and
 * `User.preferences.digestFrequency` carries a SCHEMA DEFAULT of `'weekly'` — so the cheapest possible
 * bug in this feature is mailing every account in the database on a Monday morning because a default
 * was mistaken for an answer. A missed digest is one quiet week; an unasked-for one is a spam
 * complaint against the sending domain and cannot be taken back.
 *
 * The double-send guard is deliberately NOT tested here: it is a unique index on `DigestLog`, and a
 * unit test could only assert a re-implementation of it. What IS tested is everything that decides
 * whether a send is attempted at all, and every IST boundary that decides WHEN.
 */

const SECRET = 'test-secret-not-a-real-one';
const OTHER_SECRET = 'a-different-secret';

/** A user document shaped like the one in `lib/models/User.ts`. */
function user(preferences: Record<string, unknown> | null | undefined) {
  return { preferences } as Parameters<typeof digestDecision>[0];
}

const ASKED = { onboardedAt: new Date('2026-09-01T10:00:00+05:30') };

/*
 * IST INSTANTS, chosen so every one of them is a case where reading the RUNNER's clock gives a
 * different answer. The workflow sends at 02:30 UTC, so these are the real shapes.
 */
/** Monday 08:00 IST — the weekly send. */
const MONDAY_MORNING = new Date('2026-09-07T02:30:00Z');
/** Sunday 19:30 UTC, which is Monday 01:00 IST. UTC says Sunday; IST says Monday. */
const MONDAY_JUST_AFTER_MIDNIGHT = new Date('2026-09-06T19:30:00Z');
/** Monday 18:45 UTC, which is Tuesday 00:15 IST. UTC says Monday; IST says Tuesday. */
const TUESDAY_JUST_AFTER_MIDNIGHT = new Date('2026-09-07T18:45:00Z');
/** Sunday 08:00 IST — the last day of the week that started on the 7th. */
const SUNDAY_MORNING = new Date('2026-09-13T02:30:00Z');
/** Tuesday 08:00 IST. */
const TUESDAY_MORNING = new Date('2026-09-08T02:30:00Z');
/** The FOLLOWING Monday, for proving the weekly period key advances. */
const NEXT_MONDAY_MORNING = new Date('2026-09-14T02:30:00Z');

describe('readDigestFrequency — the stored cadence, never a default', () => {
  it('is NULL when there are no preferences at all', () => {
    /*
     * The state every account that predates the field is in — measured against the live database on
     * 2026-09-10: 10 users, and NOT ONE of them has a `preferences` object, because mongoose defaults
     * apply on save and these documents were never re-saved. So this is not a hypothetical branch,
     * it is the branch every real row takes today.
     */
    expect(readDigestFrequency(user(undefined))).toBeNull();
    expect(readDigestFrequency(user(null))).toBeNull();
    expect(readDigestFrequency(null)).toBeNull();
    expect(readDigestFrequency(undefined)).toBeNull();
  });

  it('is NULL for anything outside the stored vocabulary', () => {
    // Fails closed rather than picking a cadence. A value from some future write path, a `null` left
    // by an `$unset`, or a number out of a form must never be resolved into "weekly".
    expect(readDigestFrequency(user({ digestFrequency: 'monthly' }))).toBeNull();
    expect(readDigestFrequency(user({ digestFrequency: '' }))).toBeNull();
    expect(readDigestFrequency(user({ digestFrequency: null }))).toBeNull();
    expect(readDigestFrequency(user({ digestFrequency: 7 }))).toBeNull();
    expect(readDigestFrequency(user({ digestFrequency: true }))).toBeNull();
  });

  it('reads each of the three stored values', () => {
    for (const frequency of DIGEST_FREQUENCIES) {
      expect(readDigestFrequency(user({ digestFrequency: frequency }))).toBe(frequency);
    }
  });

  it('accepts the brief-shaped `digest` key as a fallback, and prefers the canonical one', () => {
    // Same accommodation `reminder-policy.ts` makes for `preferences.notifications`: a surface written
    // against the other name would otherwise fail as "this user never gets an email", which is the
    // hardest kind of bug to notice in a notification system.
    expect(readDigestFrequency(user({ digest: 'daily' }))).toBe('daily');
    expect(readDigestFrequency(user({ digestFrequency: 'off', digest: 'daily' }))).toBe('off');
  });
});

describe('digestDecision — consent, and the schema-default trap', () => {
  it('refuses a user who has never been asked, EVEN WITH A PERFECTLY VALID CADENCE', () => {
    /*
     * THE DEFECT THIS WHOLE MODULE EXISTS TO PREVENT, and it is not hypothetical — it is the shipped
     * schema. `lib/models/User.ts` declares
     *
     *   digestFrequency: { type: String, enum: …, default: DEFAULT_PREFERENCES.digestFrequency }
     *
     * and that default is 'weekly', with `preferences` itself carrying a factory default on the
     * document. So EVERY account created or re-saved since preferences landed carries
     * `digestFrequency: 'weekly'` without anybody having chosen it. Checking the cadence alone would
     * mail all of them — a silent opt-in, produced by a schema default, to a recurring email.
     */
    expect(digestDecision(user({ digestFrequency: 'weekly' }), MONDAY_MORNING).outcome).toBe(
      'never-asked'
    );
    expect(digestDecision(user({ digestFrequency: 'daily' }), TUESDAY_MORNING).outcome).toBe(
      'never-asked'
    );
  });

  it('refuses an absent, null or unparseable onboardedAt', () => {
    expect(digestDecision(user({ digestFrequency: 'daily', onboardedAt: null }), MONDAY_MORNING).outcome).toBe('never-asked');
    expect(digestDecision(user({ digestFrequency: 'daily', onboardedAt: '' }), MONDAY_MORNING).outcome).toBe('never-asked');
    expect(digestDecision(user({ digestFrequency: 'daily', onboardedAt: 'not a date' }), MONDAY_MORNING).outcome).toBe('never-asked');
  });

  it('refuses a user with no preferences at all', () => {
    expect(digestDecision(user(undefined), MONDAY_MORNING).outcome).toBe('never-asked');
    expect(digestDecision(null, MONDAY_MORNING).outcome).toBe('never-asked');
  });

  it('separates "asked but no cadence stored" from "never asked", and sends for neither', () => {
    // Reported apart because they mean different things to an operator, but both refuse. A stored
    // cadence is required; there is no fallback to the default.
    const decision = digestDecision(user({ ...ASKED }), MONDAY_MORNING);
    expect(decision.outcome).toBe('no-frequency');
    expect(decision.periodKey).toBeNull();
  });

  it('respects `off` on every day of the week', () => {
    for (const now of [MONDAY_MORNING, TUESDAY_MORNING, SUNDAY_MORNING]) {
      const decision = digestDecision(user({ ...ASKED, digestFrequency: 'off' }), now);
      expect(decision.outcome).toBe('off');
      expect(decision.periodKey).toBeNull();
    }
  });

  it('sends a WEEKLY subscriber on Monday IST and refuses them the other six days', () => {
    const weekly = user({ ...ASKED, digestFrequency: 'weekly' });
    expect(digestDecision(weekly, MONDAY_MORNING).outcome).toBe('due');
    expect(digestDecision(weekly, TUESDAY_MORNING).outcome).toBe('not-due');
    expect(digestDecision(weekly, SUNDAY_MORNING).outcome).toBe('not-due');
  });

  it('sends a DAILY subscriber every day', () => {
    const daily = user({ ...ASKED, digestFrequency: 'daily' });
    for (const now of [MONDAY_MORNING, TUESDAY_MORNING, SUNDAY_MORNING]) {
      expect(digestDecision(daily, now).outcome).toBe('due');
    }
  });

  it('carries a period key ONLY when due', () => {
    // The period key is the at-most-once identity, so producing one for a user who is not being
    // mailed would invite a caller to claim a row for a send that never happens — permanently
    // consuming that period.
    const weekly = user({ ...ASKED, digestFrequency: 'weekly' });
    expect(digestDecision(weekly, MONDAY_MORNING).periodKey).toBe('weekly:2026-09-07');
    expect(digestDecision(weekly, TUESDAY_MORNING).periodKey).toBeNull();
  });
});

describe('the IST day boundary — where a UTC runner gets it wrong', () => {
  it('reads Monday 01:00 IST as MONDAY even though UTC still says Sunday', () => {
    /*
     * The decisive assertion in this file for the "when" half. `2026-09-06T19:30:00Z` is Sunday in
     * UTC and Monday in IST. A `new Date().getDay()` on the runner answers 0 (Sunday), so a weekly
     * digest computed that way would be skipped — and since the cron only fires once a day, it would
     * be skipped FOREVER, silently, with no error anywhere.
     */
    expect(istWeekday(MONDAY_JUST_AFTER_MIDNIGHT)).toBe(WEEKLY_DIGEST_IST_WEEKDAY);
    expect(isDigestDue('weekly', MONDAY_JUST_AFTER_MIDNIGHT)).toBe(true);
  });

  it('reads Tuesday 00:15 IST as TUESDAY even though UTC still says Monday', () => {
    // The mirror image, and the one that would cause a DOUBLE send: a late-evening UTC run on Monday
    // is already Tuesday in IST, so treating it as Monday would produce a second weekly digest.
    expect(istWeekday(TUESDAY_JUST_AFTER_MIDNIGHT)).toBe(2);
    expect(isDigestDue('weekly', TUESDAY_JUST_AFTER_MIDNIGHT)).toBe(false);
  });

  it('puts SUNDAY in the week that already started, not the one about to', () => {
    /*
     * `(weekday + 6) % 7` maps Monday to 0 and Sunday to 6. Getting this backwards is the classic
     * week-start bug and here it is not cosmetic: a Sunday run would compute next Monday's key, find
     * no claimed row, and mail every weekly subscriber a second time the day BEFORE their digest is
     * due.
     */
    expect(istWeekStartKey(SUNDAY_MORNING)).toBe('2026-09-07');
    expect(istWeekStartKey(MONDAY_MORNING)).toBe('2026-09-07');
    expect(istWeekStartKey(TUESDAY_MORNING)).toBe('2026-09-07');
    expect(istWeekStartKey(MONDAY_JUST_AFTER_MIDNIGHT)).toBe('2026-09-07');
  });

  it('crosses a month boundary by calendar arithmetic, not by subtracting milliseconds', () => {
    // Wednesday 1 April 2026 IST; the week began on Monday 30 March. A `now - n*86400000` shortcut
    // gets this right too, which is exactly why it is worth pinning the month rollover explicitly —
    // `setUTCDate` is what makes it right, and a "simplification" back to date maths on a `Date`
    // built from the local clock would not be.
    expect(istWeekStartKey(new Date('2026-04-01T02:30:00Z'))).toBe('2026-03-30');
  });
});

describe('digestPeriodKey — the at-most-once identity', () => {
  it('keys weekly by the IST Monday, so every day of one week shares one key', () => {
    const keys = [MONDAY_MORNING, TUESDAY_MORNING, SUNDAY_MORNING].map(now =>
      digestPeriodKey('weekly', now)
    );
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe('weekly:2026-09-07');
  });

  it('advances on the next Monday', () => {
    expect(digestPeriodKey('weekly', NEXT_MONDAY_MORNING)).toBe('weekly:2026-09-14');
  });

  it('keys daily by the IST day, so two days differ', () => {
    expect(digestPeriodKey('daily', MONDAY_MORNING)).toBe('daily:2026-09-07');
    expect(digestPeriodKey('daily', TUESDAY_MORNING)).toBe('daily:2026-09-08');
    // The 01:00 IST case again: same IST day as the 08:00 run, so a re-run overnight collides
    // correctly instead of minting a fresh key.
    expect(digestPeriodKey('daily', MONDAY_JUST_AFTER_MIDNIGHT)).toBe('daily:2026-09-07');
  });

  it('prefixes by cadence, so weekly and daily keys can never collide', () => {
    // They deliberately DO share a date on a Monday — which is precisely the hole
    // `MAX_DIGESTS_PER_IST_DAY` exists to close, and the next describe block pins.
    expect(digestPeriodKey('weekly', MONDAY_MORNING)).not.toBe(
      digestPeriodKey('daily', MONDAY_MORNING)
    );
  });

  it('has no key for `off`', () => {
    expect(digestPeriodKey('off', MONDAY_MORNING)).toBeNull();
  });
});

describe('applyDigestCap — the per-IST-day cap', () => {
  it('permits the first digest of the day', () => {
    expect(applyDigestCap({ digestsSentToday: 0 })).toEqual({ send: true });
  });

  it('refuses a second, which is the cadence-switch hole', () => {
    /*
     * THE SEQUENCE THIS REFUSES, and it is the only reason the cap is not redundant with the period
     * key: a user on `weekly` receives Monday's digest, then switches to `daily` that afternoon.
     * `weekly:2026-09-07` and `daily:2026-09-07` are DIFFERENT rows, so a re-run the same evening
     * finds no claim and would mail them twice on the day they changed a setting.
     */
    expect(applyDigestCap({ digestsSentToday: 1 })).toEqual({ send: false, blockedBy: 'daily-cap' });
    expect(applyDigestCap({ digestsSentToday: 9 }).send).toBe(false);
  });

  it('defaults to exactly one per day', () => {
    expect(MAX_DIGESTS_PER_IST_DAY).toBe(1);
    expect(applyDigestCap({ digestsSentToday: MAX_DIGESTS_PER_IST_DAY }).send).toBe(false);
  });

  it('honours an operator override without losing the refusal', () => {
    expect(applyDigestCap({ digestsSentToday: 1, maxPerDay: 2 }).send).toBe(true);
    expect(applyDigestCap({ digestsSentToday: 2, maxPerDay: 2 }).send).toBe(false);
  });
});

describe('digestWindow — what a cadence may talk about', () => {
  it('opens at NOW, never at the start of the calendar period', () => {
    // A Monday 08:00 send whose window opened at Monday midnight would lead with events that finished
    // before the reader woke up. This is the difference between a digest and an archive.
    const window = digestWindow('weekly', MONDAY_MORNING);
    expect(window.from.getTime()).toBe(MONDAY_MORNING.getTime());
  });

  it('reaches seven days for weekly and 48 hours for daily', () => {
    const weekly = digestWindow('weekly', MONDAY_MORNING);
    expect(weekly.to.getTime() - weekly.from.getTime()).toBe(WEEKLY_WINDOW_DAYS * 24 * 3600_000);

    const daily = digestWindow('daily', MONDAY_MORNING);
    expect(daily.to.getTime() - daily.from.getTime()).toBe(DAILY_WINDOW_HOURS * 3600_000);
  });

  it('reaches PAST tomorrow evening on the daily cadence', () => {
    /*
     * The reason `DAILY_WINDOW_HOURS` is 48 rather than 24, and it is a schedule fact rather than
     * generosity. The send is 08:00 IST; a 24-hour window ends at 08:00 tomorrow, so every evening
     * event tomorrow — which is most of them in this corpus — falls between two runs and appears in
     * no digest at all.
     */
    const { to } = digestWindow('daily', MONDAY_MORNING);
    const tomorrowEvening = new Date('2026-09-08T13:30:00Z'); // 19:00 IST on Tuesday
    expect(to.getTime()).toBeGreaterThan(tomorrowEvening.getTime());
  });

  it('returns an empty window for `off` rather than throwing', () => {
    // A caller reaching here with `off` has a bug; an empty window makes it visible as "nothing to
    // send" instead of a crash in a cron job at 2:30 in the morning.
    const window = digestWindow('off', MONDAY_MORNING);
    expect(window.to.getTime()).toBe(window.from.getTime());
  });
});

describe('the unsubscribe token', () => {
  it('verifies its own token and rejects a foreign secret', () => {
    const token = digestUnsubscribeToken('user-1', SECRET);
    expect(verifyDigestUnsubscribeToken('user-1', token, SECRET)).toBe(true);
    expect(verifyDigestUnsubscribeToken('user-1', token, OTHER_SECRET)).toBe(false);
  });

  it('rejects another user’s token, a truncated one, and a padded one', () => {
    const token = digestUnsubscribeToken('user-1', SECRET);
    expect(verifyDigestUnsubscribeToken('user-2', token, SECRET)).toBe(false);
    expect(verifyDigestUnsubscribeToken('user-1', token.slice(0, -1), SECRET)).toBe(false);
    expect(verifyDigestUnsubscribeToken('user-1', `${token}x`, SECRET)).toBe(false);
  });

  it('returns false rather than throwing on anything missing', () => {
    // A thrown exception here is a 500 on an unsubscribe link: the reader cannot get off the list and
    // the page blames itself. `timingSafeEqual` throws on a length mismatch, which is why the length
    // is compared first.
    const token = digestUnsubscribeToken('user-1', SECRET);
    expect(verifyDigestUnsubscribeToken(null, token, SECRET)).toBe(false);
    expect(verifyDigestUnsubscribeToken('user-1', null, SECRET)).toBe(false);
    expect(verifyDigestUnsubscribeToken('user-1', token, '')).toBe(false);
    expect(verifyDigestUnsubscribeToken('', '', '')).toBe(false);
  });

  it('refuses to mint a token with no secret, LOUDLY', () => {
    // Fail closed, not open: a blank secret would make every token verify against every other one.
    expect(() => digestUnsubscribeToken('user-1', '')).toThrow(/NEXTAUTH_SECRET/);
    expect(() => digestUnsubscribeToken('', SECRET)).toThrow(/userId/);
  });

  it('IS NOT INTERCHANGEABLE WITH THE REMINDER TOKEN — in both directions', () => {
    /*
     * THE MOST IMPORTANT ASSERTION IN THIS BLOCK. The two links do different things: this one sets
     * `digestFrequency = 'off'`, the reminder one sets `remindersEnabled = false`. If one token
     * verified at both routes, a reader who unsubscribed from the weekly summary could have their
     * saved-event reminders silently turned off too — or the reverse — depending on which URL a mail
     * client happened to rewrite. Two mailings, two consents, two scope strings.
     */
    const digest = digestUnsubscribeToken('user-1', SECRET);
    const reminder = unsubscribeToken('user-1', SECRET);
    expect(digest).not.toBe(reminder);
    expect(verifyUnsubscribeToken('user-1', digest, SECRET)).toBe(false);
    expect(verifyDigestUnsubscribeToken('user-1', reminder, SECRET)).toBe(false);
  });

  it('builds an absolute URL the digest route can read, with the id percent-encoded', () => {
    const url = buildDigestUnsubscribeUrl('https://pulseblr.example.com/', 'dev login:me', SECRET);
    expect(url.startsWith('https://pulseblr.example.com/api/digest/unsubscribe?')).toBe(true);
    // A `devlogin:` id contains a colon and a real name can contain worse; an unencoded id would
    // truncate the parameter and produce a link that silently fails to verify.
    expect(url).toContain('u=dev%20login%3Ame');
    // NOT the reminder path. The routes are separate on purpose.
    expect(url).not.toContain('/api/reminders/');
  });
});

describe('formatDigestEmail — the non-negotiables', () => {
  const events: DigestEventView[] = [
    {
      id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      title: 'Bangalore Kubernetes Meetup #14',
      startDateTime: new Date('2026-09-09T13:00:00Z'),
      venue: 'Razorpay HQ',
      area: 'Koramangala',
      city: 'Bengaluru',
      format: 'offline',
      organizer: 'CNCF Bangalore',
      isFree: true,
      applyLink: 'https://example.com/register',
    },
    {
      // A hostile title, because event titles are scraped from third-party pages.
      id: 'bbbbbbbbbbbbbbbbbbbbbbbb',
      title: '<script>alert("xss")</script> & "Rust" Night',
      startDateTime: new Date('2026-09-11T13:30:00Z'),
      format: 'online',
      organizer: 'Rust <b>BLR</b>',
    },
  ];

  const email = formatDigestEmail({
    events,
    frequency: 'weekly',
    unsubscribeUrl: 'https://pulseblr.example.com/api/digest/unsubscribe?u=u1&t=tok',
    appUrl: 'https://pulseblr.example.com',
    now: MONDAY_MORNING,
  });

  it('carries the unsubscribe link in BOTH the HTML and the text part', () => {
    // Non-negotiable. A text-only client that cannot find a way off the list is a reader who presses
    // "report spam" instead, and that is a domain-reputation problem rather than a preference change.
    expect(email.html).toContain('/api/digest/unsubscribe?u=u1&amp;t=tok');
    expect(email.text).toContain('/api/digest/unsubscribe?u=u1&t=tok');
  });

  it('says WHY it arrived, naming the cadence the reader chose', () => {
    // A sentence the reader can check, not a category. "You are subscribed" is unverifiable; "you
    // chose a weekly digest" is.
    expect(email.html).toContain('you chose a weekly digest');
    expect(email.text).toContain('you chose a weekly digest');
    expect(digestWhyLine('daily')).toContain('a daily digest');
  });

  it('escapes every interpolated value, so a scraped title cannot inject markup', () => {
    expect(email.html).not.toContain('<script>');
    expect(email.html).toContain('&lt;script&gt;');
    expect(email.html).toContain('Rust &lt;b&gt;BLR&lt;/b&gt;');
    // And the plain-text part keeps it verbatim, which is correct — there is nothing to escape.
    expect(email.text).toContain('<script>alert("xss")</script>');
  });

  it('links every event and prefers its registration link in the text part', () => {
    expect(email.html).toContain('/events/aaaaaaaaaaaaaaaaaaaaaaaa');
    expect(email.text).toContain('https://example.com/register');
    // The second event has no applyLink, so it falls back to the event page rather than emitting a
    // bare undefined.
    expect(email.text).toContain('/events/bbbbbbbbbbbbbbbbbbbbbbbb');
    expect(email.text).not.toContain('undefined');
  });

  it('never renders a raw ISO timestamp — dates go through the IST formatters', () => {
    // The digest is sent by a UTC runner at 02:30 UTC. A date formatted on the ambient locale reports
    // the PREVIOUS day, so an email would confidently say "today" about something that already
    // happened. `lib/format.ts` is pinned to Asia/Kolkata.
    expect(email.html).not.toContain('2026-09-09T13:00:00');
    expect(email.text).not.toContain('2026-09-09T13:00:00');
    expect(email.text).toContain('18:30');
  });

  it('has a subject that says which cadence this is, and counts events on the daily one', () => {
    expect(email.subject).toBe('PulseBLR: your week in Bengaluru tech');
    const daily = formatDigestEmail({
      events,
      frequency: 'daily',
      unsubscribeUrl: 'https://x/api/digest/unsubscribe',
      appUrl: 'https://x',
      now: MONDAY_MORNING,
    });
    expect(daily.subject).toBe('PulseBLR: 2 events coming up');
  });

  it('reads correctly for a single event', () => {
    // The singular branch exists because "1 Bengaluru tech events" is the tell of a template nobody
    // read back.
    const one = formatDigestEmail({
      events: [events[0]],
      frequency: 'weekly',
      unsubscribeUrl: 'https://x/api/digest/unsubscribe',
      appUrl: 'https://x',
      now: MONDAY_MORNING,
    });
    expect(one.text.startsWith('One Bengaluru tech event')).toBe(true);
  });
});

describe('the constants the rest of the app depends on', () => {
  it('pins the digest size at five', () => {
    // The product decision, not a layout limit: a digest is a curation claim, and twenty events is a
    // listings page — which already exists at `/`.
    expect(DIGEST_EVENT_COUNT).toBe(5);
  });

  it('pins the log `kind`, because it is half of a unique index', () => {
    // Changing this string silently frees every period already claimed, so every subscriber would be
    // mailed once more. It is a data migration, not a rename.
    expect(DIGEST_KIND).toBe('event-digest');
  });

  it('sends the weekly digest on Monday', () => {
    expect(WEEKLY_DIGEST_IST_WEEKDAY).toBe(1);
    expect(istWeekday(MONDAY_MORNING)).toBe(1);
  });
});
