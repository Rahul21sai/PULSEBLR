import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_EMAILS_PER_DAY,
  DEFAULT_MAX_EVENTS_PER_PUSH_RUN,
  DEFAULT_MAX_PUSHES_PER_DAY,
  formatPushPayload,
  PUSH_PAYLOAD_MAX_BYTES,
  PUSH_REMINDER_KIND,
  REMINDER_KIND,
  applyReminderCaps,
  pushEventsThisRun,
  validatePushSubscriptionInput,
  type ReminderEventView,
} from '@/lib/notifications/reminder-policy';

/**
 * The web push rules.
 *
 * LIKE `tests/reminders.test.ts`, THE HALF THAT MATTERS IS THE REFUSALS — and on this channel the
 * asymmetry is sharper than on email. A missed notification is a disappointment; a duplicate one
 * vibrates somebody's phone twice and is the fastest route to a revoked permission, which in Chrome
 * cannot be asked for again from code at all. So what is pinned here is the arithmetic that bounds
 * how many go out, the validation that keeps an unusable or hostile subscription out of the database,
 * and two STRUCTURAL assertions about files this suite cannot execute.
 *
 * The double-send guard itself is deliberately not tested: it is a unique index on `ReminderLog`, and
 * a unit test could only assert a re-implementation of it.
 */

const REPO = path.resolve(import.meta.dirname, '..');

/** A real Chrome subscription's shape. The key lengths are the spec's, not a sample's. */
const REAL_P256DH = Buffer.alloc(65, 7).toString('base64url'); // 65 bytes: 0x04 ‖ X(32) ‖ Y(32)
const REAL_AUTH = Buffer.alloc(16, 3).toString('base64url'); // 16 bytes
const REAL_ENDPOINT = 'https://fcm.googleapis.com/fcm/send/dOFzS9V3xkM:APA91bF-3s7pQ';

function browserShape(overrides: Record<string, unknown> = {}) {
  return {
    endpoint: REAL_ENDPOINT,
    expirationTime: null,
    keys: { p256dh: REAL_P256DH, auth: REAL_AUTH },
    ...overrides,
  };
}

describe('PUSH_REMINDER_KIND — a second at-most-once guarantee, not a shared one', () => {
  it('is a different value from the email kind', () => {
    /*
     * THE ASSERTION THE WHOLE FEATURE RESTS ON. `ReminderLog`'s unique index is
     * `{ userId, eventId, kind }`, so if these two were ever made equal, the email row already
     * claimed for an event would silently suppress the push for it — the reader would get whichever
     * channel ran first that morning and nothing in the log would say the other was skipped.
     */
    expect(PUSH_REMINDER_KIND).not.toBe(REMINDER_KIND);
    expect(PUSH_REMINDER_KIND.length).toBeGreaterThan(0);
  });
});

describe('pushEventsThisRun — the two caps are ONE budget on this channel', () => {
  it('gives the per-run cap when the day is untouched', () => {
    expect(pushEventsThisRun({ pushesSentToday: 0, maxPushesPerDay: 3, maxEventsPerRun: 2 })).toBe(2);
  });

  it('clamps to what is LEFT of the day, not to the per-run cap', () => {
    /*
     * THE DEFECT THIS EXISTS TO CATCH, and it is the reason this is a named function rather than a
     * `Math.min` in the sender. `applyReminderCaps` treats its two limits as protecting different
     * things — right for email, where one message can carry five events, and wrong here, where one
     * notification is one event. Passing the per-run cap unclamped, a run with 2 of 3 already spent
     * would fire 2 more and land on 4 — and the overshoot is INVISIBLE, because the cap query only
     * reports the day's total on the NEXT run.
     */
    expect(pushEventsThisRun({ pushesSentToday: 2, maxPushesPerDay: 3, maxEventsPerRun: 2 })).toBe(1);
  });

  it('is 0 when the day is spent, and never negative when it has been overspent', () => {
    expect(pushEventsThisRun({ pushesSentToday: 3, maxPushesPerDay: 3, maxEventsPerRun: 2 })).toBe(0);
    // Overspending is reachable: a raised-then-lowered cap, or two runs racing. A negative here would
    // reach `Array.prototype.slice` as a NEGATIVE end index, which counts from the END and would send
    // the WRONG events rather than none.
    expect(pushEventsThisRun({ pushesSentToday: 9, maxPushesPerDay: 3, maxEventsPerRun: 2 })).toBe(0);
    expect(pushEventsThisRun({ pushesSentToday: -5, maxPushesPerDay: 3, maxEventsPerRun: 2 })).toBe(2);
  });

  it('composes with applyReminderCaps so a run can never exceed the daily allowance', () => {
    // The real call shape in `sendPushReminders`, walked across a whole day.
    const candidates = ['a', 'b', 'c', 'd', 'e'];
    let sentToday = 0;
    let totalSent = 0;
    for (let run = 0; run < 5; run += 1) {
      const capped = applyReminderCaps({
        candidates,
        emailsSentToday: sentToday,
        maxEmailsPerDay: DEFAULT_MAX_PUSHES_PER_DAY,
        maxEventsPerEmail: pushEventsThisRun({ pushesSentToday: sentToday }),
      });
      // One batch per notification on this channel, so the day's count rises by the number sent.
      sentToday += capped.send.length;
      totalSent += capped.send.length;
    }
    expect(totalSent).toBe(DEFAULT_MAX_PUSHES_PER_DAY);
  });

  it('has defaults where the per-run cap cannot on its own exceed the daily one', () => {
    // Belt and braces: the clamp makes this safe either way, but a per-run default above the daily
    // one would mean the clamp is the ONLY thing preventing an overshoot on a fresh day.
    expect(DEFAULT_MAX_EVENTS_PER_PUSH_RUN).toBeLessThanOrEqual(DEFAULT_MAX_PUSHES_PER_DAY);
  });

  it('gives push its own allowance rather than inheriting the email one', () => {
    // Not an arbitrary difference: an email covering three events is one thing in an inbox, while
    // three push notifications are three interruptions. If these were ever unified, the reasoning in
    // `reminder-policy.ts` would need revisiting, not the number.
    expect(DEFAULT_MAX_PUSHES_PER_DAY).not.toBe(DEFAULT_MAX_EMAILS_PER_DAY);
  });
});

describe('validatePushSubscriptionInput — the structural half of an SSRF guard', () => {
  it('accepts what a browser actually hands over', () => {
    const { subscription, issues } = validatePushSubscriptionInput(browserShape());
    expect(issues).toEqual([]);
    expect(subscription).toEqual({
      endpoint: REAL_ENDPOINT,
      p256dh: REAL_P256DH,
      auth: REAL_AUTH,
      userAgent: undefined,
    });
  });

  it('also accepts a flat body, so a caller that already destructured is not punished', () => {
    const { subscription } = validatePushSubscriptionInput({
      endpoint: REAL_ENDPOINT,
      p256dh: REAL_P256DH,
      auth: REAL_AUTH,
    });
    expect(subscription?.endpoint).toBe(REAL_ENDPOINT);
  });

  /*
   * ── THE SSRF CASES. ──────────────────────────────────────────────────────────────────────────
   * `endpoint` is a URL the caller supplies which the server POSTs to hours later from a cron
   * runner, with nobody watching — the same shape as the hole `lib/security/safe-fetch.ts` was
   * written to close on `/api/scrape-url`. Each of these must be refused at the door, because once
   * stored the send path is the only thing standing in front of it.
   */
  const unsafeEndpoints: [string, string][] = [
    ['http, not https', 'http://fcm.googleapis.com/fcm/send/abc'],
    ['a scheme that is not http at all', 'file:///etc/passwd'],
    ['embedded credentials', 'https://user:pass@fcm.googleapis.com/fcm/send/abc'],
    ['loopback by name', 'https://localhost/fcm/send/abc'],
    ['loopback by address', 'https://127.0.0.1/push'],
    ['the cloud metadata address', 'https://169.254.169.254/latest/meta-data/'],
    ['a private range address', 'https://10.0.0.7/push'],
    ['a decimal-encoded address', 'https://2130706433/push'],
    ['a bracketed IPv6 literal', 'https://[::1]/push'],
    ['a bare hostname with no dot', 'https://metadata/push'],
    ['not a URL at all', 'fcm.googleapis.com/fcm/send/abc'],
  ];

  for (const [label, endpoint] of unsafeEndpoints) {
    it(`refuses ${label}`, () => {
      const { subscription, issues } = validatePushSubscriptionInput(browserShape({ endpoint }));
      expect(subscription).toBeNull();
      expect(issues.some(issue => issue.field === 'endpoint')).toBe(true);
    });
  }

  it('refuses an endpoint longer than any real push service produces', () => {
    const long = `https://fcm.googleapis.com/fcm/send/${'x'.repeat(1200)}`;
    const { subscription } = validatePushSubscriptionInput(browserShape({ endpoint: long }));
    expect(subscription).toBeNull();
  });

  /*
   * ── THE KEY LENGTH CASES. ────────────────────────────────────────────────────────────────────
   * Both lengths are fixed by the Web Push spec, so these are hard checks. Without them `web-push`
   * throws while deriving the content encryption key — inside the cron run, per event, hours after
   * the request that stored the bad row.
   */
  it('refuses a p256dh that is not 65 bytes', () => {
    const { subscription, issues } = validatePushSubscriptionInput(
      browserShape({ keys: { p256dh: Buffer.alloc(64, 7).toString('base64url'), auth: REAL_AUTH } })
    );
    expect(subscription).toBeNull();
    expect(issues.some(issue => issue.field === 'keys.p256dh')).toBe(true);
  });

  it('refuses an auth secret that is not 16 bytes', () => {
    const { subscription, issues } = validatePushSubscriptionInput(
      browserShape({ keys: { p256dh: REAL_P256DH, auth: Buffer.alloc(12, 3).toString('base64url') } })
    );
    expect(subscription).toBeNull();
    expect(issues.some(issue => issue.field === 'keys.auth')).toBe(true);
  });

  it('refuses a key with junk INTERLEAVED, which the length check cannot see', () => {
    /*
     * THE CASE A LENGTH CHECK ALONE MISSES, and it is not the obvious one — the first version of this
     * test used 87 characters of `!`, which passes for the wrong reason and left the alphabet regex
     * unexercised (verified by deleting the regex: the suite stayed green).
     *
     * Node's base64 decoder DISCARDS invalid characters rather than failing. So junk in place of a key
     * decodes SHORT and the length check refuses it — but junk spliced INTO a valid key decodes to
     * exactly the right 65 bytes and sails through. Measured: 89 characters, 65 bytes decoded, byte-
     * identical to the clean key. No browser can emit that, so accepting it means the stored string
     * and the key material it represents are no longer in one-to-one correspondence — and a validator
     * that accepts input no legitimate client sends is one more shape the send path has to survive.
     */
    const interleaved = `${REAL_P256DH.slice(0, 40)}!!${REAL_P256DH.slice(40)}`;
    expect(Buffer.from(interleaved, 'base64').length).toBe(65); // the length check is satisfied
    const { subscription } = validatePushSubscriptionInput(
      browserShape({ keys: { p256dh: interleaved, auth: REAL_AUTH } })
    );
    expect(subscription).toBeNull();
  });

  it('refuses a missing or non-object body without throwing', () => {
    for (const body of [null, undefined, 'a string', 42, [], true]) {
      const { subscription, issues } = validatePushSubscriptionInput(body);
      expect(subscription).toBeNull();
      expect(issues.length).toBeGreaterThan(0);
    }
  });

  it('names every field it refuses and echoes no value back', () => {
    const { issues } = validatePushSubscriptionInput({});
    expect(issues.map(i => i.field).sort()).toEqual(['endpoint', 'keys.auth', 'keys.p256dh']);
    // An endpoint is a live capability — anyone holding it can push to that device, subject only to
    // VAPID — so it must not come back in an error a log or a client might keep.
    const joined = JSON.stringify(validatePushSubscriptionInput(browserShape({ endpoint: 'http://x.example/p' })).issues);
    expect(joined).not.toContain('x.example');
  });

  it('truncates a userAgent rather than refusing it', () => {
    const { subscription } = validatePushSubscriptionInput(
      browserShape({ userAgent: 'M'.repeat(900) })
    );
    // The schema caps this field at 300; a request refused over a cosmetic field would cost the user
    // their notifications for nothing.
    expect(subscription?.userAgent?.length).toBe(300);
  });
});

describe('formatPushPayload — the contract with public/sw.js', () => {
  const event: ReminderEventView = {
    id: '68b1f0c4a1b2c3d4e5f60718',
    title: 'React Bangalore Meetup #108',
    startDateTime: '2026-09-15T19:00:00+05:30',
    venue: 'Razorpay Office',
    area: 'Indiranagar',
    city: 'Bengaluru',
    format: 'in-person',
  };
  const now = new Date('2026-09-14T08:00:00+05:30');

  it('carries exactly the four fields the service worker can read', () => {
    const payload = formatPushPayload(event, now);
    expect(Object.keys(payload).sort()).toEqual(['body', 'tag', 'title', 'url']);
    expect(payload.title).toBe('React Bangalore Meetup #108');
    expect(payload.url).toBe('/events/68b1f0c4a1b2c3d4e5f60718');
  });

  it('tags per EVENT, so a repeat replaces rather than stacks', () => {
    const a = formatPushPayload(event, now);
    const b = formatPushPayload({ ...event, id: 'other' }, now);
    expect(a.tag).not.toBe(b.tag);
    // Same event twice must coalesce — that is the whole reason the tag is derived from the id.
    expect(formatPushPayload(event, now).tag).toBe(a.tag);
  });

  it('gives a RELATIVE url, never an absolute one', () => {
    /*
     * `clients.openWindow()` resolves a relative URL against the service worker's own origin, so the
     * notification cannot be made to open somewhere else — and it does not depend on NEXTAUTH_URL
     * being right on whichever machine ran the cron. An absolute URL here would be both a smaller
     * guarantee and one more thing to misconfigure.
     */
    const payload = formatPushPayload(event, now);
    expect(payload.url.startsWith('/')).toBe(true);
    expect(payload.url).not.toMatch(/^https?:/);
  });

  it('says WHEN and WHERE in the body, in IST', () => {
    const payload = formatPushPayload(event, now);
    // 19:00 IST on the 15th, seen from the 14th. `dayHeading` and `timeIST` are the feed's own
    // functions, so the notification and the app cannot disagree about which day an event is on —
    // including the 24-hour clock, which is what `timeIST` actually renders (this assertion was
    // written expecting "7:00 PM" and was wrong, not the formatter).
    expect(payload.body).toContain('Tomorrow');
    expect(payload.body).toContain('19:00');
    expect(payload.body).toContain('Indiranagar');
  });

  it('stays under the payload ceiling even for a pathological scraped title and venue', () => {
    /*
     * A push service answers 413 over its limit (4096 bytes, and aes128gcm adds ~103 on top), and a
     * 413 is a defect in this payload rather than a dead subscription — so it would recur every run.
     * Titles and venues here are scraped from third-party pages and are not length-bounded upstream.
     */
    const payload = formatPushPayload(
      { ...event, title: 'T'.repeat(5000), venue: 'V'.repeat(5000) },
      now
    );
    expect(Buffer.byteLength(JSON.stringify(payload), 'utf8')).toBeLessThanOrEqual(
      PUSH_PAYLOAD_MAX_BYTES
    );
    expect(payload.title.length).toBeGreaterThan(0);
  });

  it('is serialisable, and flat, because the worker degrades rather than reports', () => {
    // `public/sw.js`'s `push` listener falls back to treating the raw text as a body when
    // `event.data.json()` throws — so an unserialisable or nested payload shows a notification with
    // no title and no destination rather than surfacing an error anybody could see.
    const payload = formatPushPayload(event, now);
    expect(() => JSON.parse(JSON.stringify(payload))).not.toThrow();
    for (const value of Object.values(payload)) expect(typeof value).toBe('string');
  });

  it('survives an event with no venue, area, city or title', () => {
    const bare = formatPushPayload(
      { id: 'x', title: '', startDateTime: '2026-09-15T19:00:00+05:30' },
      now
    );
    expect(bare.title.length).toBeGreaterThan(0);
    expect(bare.tag).toBe('pblr-event-x');
  });
});

/*
 * ── STRUCTURAL ASSERTIONS ────────────────────────────────────────────────────────────────────
 *
 * The two things below cannot be executed by this suite — one is a mongoose query and the other is a
 * negative claim about a whole module — but both are exactly the kind of thing a later
 * "simplification" undoes silently. Reading the source and asserting on it is the only instrument
 * available, and it is the same reasoning `tests/soft-delete.test.ts` records for asserting an exact
 * predicate object: no count over today's data can tell the right version from the wrong one.
 */
describe('the push send path does not borrow email consent', () => {
  it('never mentions remindersEnabled', () => {
    /*
     * Consent for push is the EXISTENCE of a `PushSubscription` row — a click plus an OS permission
     * grant. Reusing `remindersEnabled()` gets it wrong in both directions: the flag's schema default
     * is `true`, so it would opt in accounts never asked about notifications; and read the other way,
     * tapping "Stop these reminders" in an EMAIL would silently kill a channel that email never
     * mentioned. The instinct to reuse the flag is the entire risk, so it is asserted rather than
     * documented and hoped for.
     */
    const source = fs.readFileSync(path.join(REPO, 'lib/notifications/push.ts'), 'utf8');
    // Strip the comments: the header explains at length WHY the flag is not read, and the words have
    // to be allowed to appear there or the assertion punishes the documentation.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter(line => !line.trim().startsWith('//'))
      .join('\n');
    expect(code).not.toContain('remindersEnabled');
    expect(code).not.toContain('onboardedAt');
    // And it must reach for the subscription collection, which is what makes consent structural.
    expect(code).toContain("PushSubscription.distinct('userId')");
  });
});

describe('the daily frequency cap is scoped by kind on BOTH channels', () => {
  it('scopes the email cap query by kind', () => {
    /*
     * THE CROSS-CHANNEL BUG, PINNED. `reminders.ts` looked up already-sent rows with
     * `kind: REMINDER_KIND` but counted the daily cap with `distinct('batchId', { userId, sentAt })`
     * and no kind. Measured against the real collection with a two-row fixture under
     * `PUSH_REMINDER_KIND`: the unscoped query returned 2 batch ids, which is `DEFAULT_MAX_EMAILS_
     * PER_DAY` exactly — so a user who had received two push notifications and zero emails was at
     * the EMAIL daily cap, reported as `daily-cap` with nothing in the inbox to explain it. The
     * scoped query returned 0.
     *
     * A unit test cannot run a mongoose `distinct`, so the filter object itself is what is asserted.
     * The index cannot enforce this — a `distinct` has to ask.
     */
    const source = fs.readFileSync(path.join(REPO, 'lib/notifications/reminders.ts'), 'utf8');
    const call = source.slice(source.indexOf("ReminderLog.distinct('batchId'"));
    const filter = call.slice(0, call.indexOf('});') + 3);
    expect(filter).toContain('kind: REMINDER_KIND');
    expect(filter).toContain('userId');
    expect(filter).toContain('sentAt');
  });

  it('scopes the push cap query by kind', () => {
    const source = fs.readFileSync(path.join(REPO, 'lib/notifications/push.ts'), 'utf8');
    const call = source.slice(source.indexOf("ReminderLog.distinct('batchId'"));
    const filter = call.slice(0, call.indexOf('});') + 3);
    expect(filter).toContain('kind: PUSH_REMINDER_KIND');
  });
});
