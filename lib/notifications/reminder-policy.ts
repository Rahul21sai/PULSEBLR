/**
 * The reminder RULES, as pure functions.
 *
 * Everything here is decidable without a database, a clock of its own or a network, which is
 * why it lives apart from `reminders.ts` (mongoose, Resend) and is what `tests/reminders.test.ts`
 * exercises. The split follows `lib/tracker/validate.ts`: the rules a send must obey are the part
 * worth pinning, and pinning them must not require a running MongoDB.
 *
 * THE FOUR RULES THAT KEEP A REMINDER SYSTEM FROM BECOMING A SPAM COMPLAINT are each one
 * function here, so none of them can be "remembered" at a call site:
 *
 *   1. `remindersEnabled()`  — an absent preference means OFF. Nobody is opted in silently.
 *   2. `isReminderDue()`     — only an event that has NOT started, inside the lead window.
 *   3. `applyReminderCaps()` — at most N emails per user per IST day, at most M events in one.
 *   4. `verifyUnsubscribeToken()` — an unsubscribe link that works with no session at all.
 *
 * The double-send guard is deliberately NOT here: it is a unique index on `ReminderLog`
 * (`lib/models/ReminderLog.ts`). A rule enforced by a remembered check is a rule that fails the
 * first time two runs overlap.
 *
 * ── WEB PUSH SHARES THIS FILE, AND ITS CONSENT RULE IS THE OPPOSITE ONE. ─────────────────────
 *
 * `remindersEnabled()` above governs EMAIL ONLY. It must never gate a push, and the reason is not
 * squeamishness about reusing a flag — it is that the flag answers a different question and gets
 * BOTH directions wrong here:
 *
 *   · The schema default for `preferences.remindersEnabled` is **true**, which is exactly why
 *     `remindersEnabled()` needs the second `onboardedAt` clause. Reuse it for push and a user who
 *     completed onboarding but never granted a notification permission would be "opted in" to a
 *     channel they were never asked about — except no push could be sent anyway, because there is
 *     no subscription. So the flag is not sufficient.
 *   · Read it the other way and it is harmful: somebody who taps "Stop these reminders" in an
 *     EMAIL, and separately went to Settings, tapped a button and granted an OS-level permission,
 *     would have their notifications silently killed by an unsubscribe from a different channel.
 *     One opt-out must not turn off a channel it never mentioned.
 *
 * FOR PUSH, CONSENT *IS* THE EXISTENCE OF A `PushSubscription` ROW. It cannot exist without a
 * click in the app and an explicit OS permission grant, and it disappears the moment either is
 * revoked — which makes it stronger evidence than any boolean this app could store, and
 * self-revoking in a way a boolean is not. The send path therefore derives its recipient list FROM
 * that collection (`PushSubscription.distinct('userId')`) rather than from `User`, so "who may be
 * pushed to" is structural rather than a check somebody has to remember. `tests/push-policy.test.ts`
 * asserts that `lib/notifications/push.ts` does not so much as mention `remindersEnabled`.
 */
import crypto from 'crypto';
import { dayHeading, dayKeyIST, locationLabel, timeIST } from '../format';
import { TRACKER_STATUSES, type TrackerStatus } from '../tracker/validate';
import { escapeHtml } from './html';

/**
 * The `kind` written on every `ReminderLog` row for this feature.
 *
 * Part of the unique key, so a future second kind of reminder ("your follow-up is overdue")
 * gets its own at-most-once guarantee rather than colliding with this one.
 */
export const REMINDER_KIND = 'event-reminder';

/**
 * The `kind` for the WEB PUSH channel — the second kind this collection has ever held, and the
 * one the header of `lib/models/ReminderLog.ts` was written in anticipation of.
 *
 * A SEPARATE KIND IS NOT COSMETIC. The unique index is `{ userId, eventId, kind }`, so sharing
 * `REMINDER_KIND` would mean the email row already claimed for an event silently suppresses the
 * push for it — the reader gets whichever channel happened to run first that morning and no log
 * line says the other was skipped. Two kinds, two at-most-once guarantees.
 *
 * IT ALSO HAS TO BE IN EVERY *QUERY*, not just the index. The frequency cap in `reminders.ts`
 * counts `distinct('batchId')` for a user's rows since IST midnight, and that filter was missing
 * `kind` — so with two kinds in the collection each channel was spending the other's daily
 * allowance. Fixed there; see the comment at that query, which is the one place this is easy to
 * get wrong again.
 */
export const PUSH_REMINDER_KIND = 'event-reminder-push';

/**
 * How far ahead a saved event earns a reminder.
 *
 * 36 hours, not 24, and the reason is the schedule rather than taste: the workflow runs at
 * 8 AM IST, so a 24-hour window reaches only 8 AM tomorrow — and every evening event tomorrow,
 * which is most of them, would fall in the gap between two runs and never be reminded at all.
 * 36 hours reaches 8 PM tomorrow.
 */
export const DEFAULT_LEAD_HOURS = 36;

/** Emails per user per IST day. Two, so an event saved late in the day can still be reached. */
export const DEFAULT_MAX_EMAILS_PER_DAY = 2;

/** Events in one email. Beyond this it is a digest, and a digest is a different product. */
export const DEFAULT_MAX_EVENTS_PER_EMAIL = 5;

/* ── 1. Consent ─────────────────────────────────────────────────────────────── */

/**
 * The preference shape this module reads off a `User` document.
 *
 * TWO PATHS ARE ACCEPTED, and the reason is worth recording. The brief for this work said to
 * assume `preferences.notifications.remindersEnabled`; the shape that actually landed in
 * `lib/models/User.ts` (owned by the preferences/onboarding stream) is FLATTER —
 * `preferences.remindersEnabled`, beside `topics` / `areas` / `format` / `evenings`, with
 * `digestFrequency` where the brief said `digest`. The flat one is canonical because it is the
 * one the schema, the validator in `lib/events/relevance.ts` and the API all use. The nested one
 * is still read, because it costs one `??` and a surface that was written against the brief's
 * shape would otherwise fail SILENTLY — as a user who never gets an email, which is the hardest
 * kind of bug to notice in a notification system.
 *
 * Read structurally rather than by importing `IUserPreferences`, so this file stays free of
 * mongoose and can be unit-tested.
 */
export interface NotificationPreferences {
  remindersEnabled?: boolean;
  digestFrequency?: 'weekly' | 'daily' | 'off';
  /** The brief's name for `digestFrequency`. Accepted, not written. */
  digest?: 'weekly' | 'daily' | 'off';
}

export interface UserPreferencesLike {
  preferences?:
    | (NotificationPreferences & {
        /** Set when the user has actually BEEN ASKED — saved onboarding, or skipped it. */
        onboardedAt?: Date | string | null;
        notifications?: NotificationPreferences | null;
      })
    | null;
}

/**
 * May this user be emailed a reminder?
 *
 * TWO CONDITIONS, AND THE SECOND ONE IS THE WHOLE POINT.
 *
 *   1. `remindersEnabled === true` — stored on the document, compared identically so a stray
 *      truthy value (the string `"false"` out of a form, say) does not read as consent.
 *   2. `onboardedAt` is set — the user has BEEN ASKED.
 *
 * Condition 2 exists because condition 1 is not sufficient here, and that is not obvious. The
 * schema declares `remindersEnabled: { type: Boolean, default: DEFAULT_PREFERENCES.remindersEnabled }`
 * and that default is **true**, with `preferences` itself carrying a factory default on `User`. So
 * every document created or re-saved after that field landed carries `remindersEnabled: true`
 * WITHOUT ANYBODY HAVING BEEN ASKED — which is exactly the silent opt-in this feature is required
 * not to do. `onboardedAt` is the one field whose documented meaning is "has been asked" (it is
 * set on a successful save AND on an explicit skip), so it is what separates a real answer from a
 * schema default.
 *
 * DELIBERATELY NOT `readPreferences()` from `lib/events/relevance.ts`, even though its own comment
 * says never to read the field directly. That function coerces a MISSING preference block into
 * `DEFAULT_PREFERENCES`, so it answers `remindersEnabled: true` for a user who has no preferences
 * at all — correct for ranking a feed (an unconfigured user should see today's feed, not an empty
 * one) and precisely wrong for consent, where absence must mean no. Ranking may assume; mailing
 * may not.
 *
 * CONSEQUENCE, STATED PLAINLY: until the onboarding flow ships and starts writing `onboardedAt`,
 * this returns false for everybody and no reminder is ever sent. That is the safe direction of
 * failure and it is visible rather than silent — `sendEventReminders` reports the count under
 * `neverAsked`, and `--dry` shows exactly what would go out. If the owner later decides the schema
 * default IS consent, delete the `onboardedAt` clause; nothing else changes.
 */
export function remindersEnabled(user: UserPreferencesLike | null | undefined): boolean {
  const prefs = user?.preferences;
  if (!prefs) return false;
  const flag = prefs.remindersEnabled ?? prefs.notifications?.remindersEnabled;
  if (flag !== true) return false;
  return hasBeenAsked(user);
}

/** Has this user actually been shown the choice? See `remindersEnabled`. */
export function hasBeenAsked(user: UserPreferencesLike | null | undefined): boolean {
  const at = user?.preferences?.onboardedAt;
  if (!at) return false;
  return !Number.isNaN(new Date(at).getTime());
}

/* ── 2. Which events are due ────────────────────────────────────────────────── */

/**
 * The tracker statuses that earn a reminder.
 *
 * It is a DENY list expressed as an allow list, and the three excluded values are excluded for
 * three different reasons rather than one:
 *
 *   `Attended`  — it already happened. A reminder is now a mistake, not a nudge.
 *   `Skipped`   — the user moved the card there to say no. Emailing anyway overrides them.
 *   `Rejected`  — the terminal negative outcome; `app/tracker/page.tsx` does not even draw it.
 *
 * `New` IS included, and it is the important one: it is what `SaveButton` writes, so "I saved
 * this event" is the whole trigger for this feature.
 *
 * Typed as `TrackerStatus[]` so adding a status to `TRACKER_STATUSES` cannot quietly make it
 * remindable — it has to be listed here, and `tests/reminders.test.ts` asserts this stays a
 * subset with the three negatives absent.
 */
export const REMINDABLE_TRACKER_STATUSES: readonly TrackerStatus[] = [
  'New',
  'Interested',
  'Applied',
  'Shortlisted',
  'Confirmed',
];

/** Every status, re-exported so a caller need not import two modules to build the query. */
export const ALL_TRACKER_STATUSES = TRACKER_STATUSES;

/**
 * Is this event inside the reminder window right now?
 *
 * Strictly in the FUTURE: an event that has already started is not a reminder, it is a
 * notification you were too late for, and sending it teaches the reader to ignore the next one.
 * An unparseable date is refused rather than treated as due — `pipeline.ts` rejects evergreen
 * listings with absurd ranges, but nothing guarantees a stored date is sane.
 */
export function isReminderDue(
  startDateTime: Date | string | null | undefined,
  now: Date,
  leadHours: number = DEFAULT_LEAD_HOURS
): boolean {
  if (!startDateTime) return false;
  const start = new Date(startDateTime).getTime();
  if (Number.isNaN(start)) return false;
  const from = now.getTime();
  if (start <= from) return false;
  return start <= from + leadHours * 3600_000;
}

/**
 * The instant IST midnight began, as a UTC `Date` — the lower bound for "how many emails have
 * I already sent this person today".
 *
 * IST rather than UTC for the reason `lib/format.ts` exists at all: the runner is UTC and the
 * 8 AM IST send is 02:30 UTC, so a UTC day boundary would put the morning's send in the
 * PREVIOUS day's bucket and the cap would wave a second email through every single morning.
 * IST has no DST, so going through the day key is exact.
 */
export function istDayStart(now: Date): Date {
  return new Date(`${dayKeyIST(now)}T00:00:00+05:30`);
}

/* ── 3. Caps ────────────────────────────────────────────────────────────────── */

export interface ReminderCapResult<T> {
  /** What to put in this email. */
  send: T[];
  /** Everything the caps held back. Not an error — a later run picks them up. */
  deferred: T[];
  /** Set when nothing may be sent at all, for the report. */
  blockedBy?: 'daily-cap' | 'nothing-due';
}

/**
 * Apply both caps: emails per day, then events per email.
 *
 * Two separate limits, because they protect different things. The daily cap protects the
 * INBOX — it is the number a recipient would count if they were annoyed. The per-email cap
 * protects the MESSAGE: a reminder listing twenty events is a digest, it buries the one that
 * matters, and the digest already exists for that job.
 *
 * `deferred` is returned rather than dropped so the caller can report honestly that something
 * was held back. A silent truncation here reads later as "the reminder never arrived".
 */
export function applyReminderCaps<T>(input: {
  candidates: T[];
  emailsSentToday: number;
  maxEmailsPerDay?: number;
  maxEventsPerEmail?: number;
}): ReminderCapResult<T> {
  const {
    candidates,
    emailsSentToday,
    maxEmailsPerDay = DEFAULT_MAX_EMAILS_PER_DAY,
    maxEventsPerEmail = DEFAULT_MAX_EVENTS_PER_EMAIL,
  } = input;

  if (candidates.length === 0) return { send: [], deferred: [], blockedBy: 'nothing-due' };
  if (emailsSentToday >= maxEmailsPerDay) {
    return { send: [], deferred: [...candidates], blockedBy: 'daily-cap' };
  }
  return {
    send: candidates.slice(0, maxEventsPerEmail),
    deferred: candidates.slice(maxEventsPerEmail),
  };
}

/* ── 4. Unsubscribe, with no session ───────────────────────────────────────── */

/**
 * The unsubscribe link is a SIGNED user id, verified with `NEXTAUTH_SECRET`.
 *
 * Why signed rather than stored: an unsubscribe has to work from a mail client with no cookie,
 * no session and possibly no account still signed in anywhere, and it has to work on the first
 * tap. A per-user token in the database would do the same job and would need a field on
 * `lib/models/User.ts`, which is not this stream's file to edit. An HMAC needs no storage and
 * cannot be guessed.
 *
 * WHAT IS IN THE URL, stated plainly: the Google `sub`, which is this app's `userId`. That is an
 * internal identifier, and `IUserCard` argues against putting one in a shareable link. For the
 * public card that argument is decisive, because the id there resolves to a readable profile and
 * the space could be enumerated. Here it resolves to nothing: every route in this app derives
 * `userId` from the session and never from input, so holding the id grants no read and no write.
 * The residual risk is the one every mailing list carries — forward the email and the recipient
 * can unsubscribe you — and its blast radius is one boolean turning off.
 *
 * Truncated to 32 base64url characters (192 bits). Full length is no more secure in any way that
 * matters here and makes the URL wrap in a mail client.
 */
const UNSUB_TOKEN_CHARS = 32;

export function unsubscribeToken(userId: string, secret: string): string {
  if (!userId) throw new Error('unsubscribeToken requires a userId');
  // Loud rather than fail-open. A blank secret would make every token verify against every
  // other one, and a broken unsubscribe link is the one defect in this feature that turns a
  // reminder into a complaint the reader cannot act on. Better to refuse to send at all.
  if (!secret) throw new Error('unsubscribeToken requires NEXTAUTH_SECRET to be set');
  return crypto
    .createHmac('sha256', secret)
    .update(`reminders:v1:${userId}`)
    .digest('base64url')
    .slice(0, UNSUB_TOKEN_CHARS);
}

/**
 * Constant-time verification, and false for anything malformed.
 *
 * `timingSafeEqual` THROWS when the two buffers differ in length, so the length is compared
 * first. A thrown exception here would be a 500 on an unsubscribe link — the reader cannot get
 * off the list and the page blames itself.
 */
export function verifyUnsubscribeToken(
  userId: string | null | undefined,
  token: string | null | undefined,
  secret: string | null | undefined
): boolean {
  if (!userId || !token || !secret) return false;
  let expected: string;
  try {
    expected = unsubscribeToken(userId, secret);
  } catch {
    return false;
  }
  const a = Buffer.from(expected);
  const b = Buffer.from(token);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** The absolute URL that appears in the email. */
export function buildUnsubscribeUrl(appUrl: string, userId: string, secret: string): string {
  const base = appUrl.replace(/\/+$/, '');
  const token = unsubscribeToken(userId, secret);
  return `${base}/api/reminders/unsubscribe?u=${encodeURIComponent(userId)}&t=${encodeURIComponent(
    token
  )}`;
}

/* ── The email itself ───────────────────────────────────────────────────────── */

/** One saved event, as the email needs it. Dates may be ISO strings or `Date`; both work. */
export interface ReminderEventView {
  id: string;
  title: string;
  startDateTime: Date | string;
  venue?: string | null;
  area?: string | null;
  city?: string | null;
  format?: string | null;
  /** Where to register, when the event carries one. Falls back to the event page. */
  applyLink?: string | null;
}

export interface ReminderEmail {
  subject: string;
  html: string;
  text: string;
}

/**
 * "Tonight" / "Tomorrow" / "Sat, 15 Aug", in IST.
 *
 * Through `dayHeading()`, which the feed already uses, so the email and the app cannot disagree
 * about which day an event is on. The failure this avoids is an email saying "tomorrow" about
 * something the app lists as today.
 */
function whenLabel(start: Date | string, now: Date): string {
  // `now` is THREADED, not defaulted, and the parameter is required on purpose: this function
  // exists inside a formatter that already takes an explicit clock, and letting it fall back to
  // the ambient one is precisely the bug this signature closes. See the note in `lib/format.ts`.
  return `${dayHeading(start, now)} · ${timeIST(start)}`;
}

function whereLabel(event: ReminderEventView): string {
  return locationLabel({
    format: event.format ?? undefined,
    venue: event.venue,
    area: event.area,
    city: event.city,
  });
}

/**
 * ONE LINE SAYING WHY THIS ARRIVED. Non-negotiable, and it is a sentence rather than a
 * category: "you saved this" is something the reader can check, "you are subscribed to
 * reminders" is not.
 */
export const WHY_LINE =
  'You are getting this because you saved this event in PulseBLR. Nothing else triggers it.';

export function formatReminderEmail(input: {
  events: ReminderEventView[];
  unsubscribeUrl: string;
  appUrl: string;
  now?: Date;
}): ReminderEmail {
  const { events, unsubscribeUrl, appUrl } = input;
  const base = appUrl.replace(/\/+$/, '');
  const now = input.now ?? new Date();

  const lede =
    events.length === 1 ? 'An event you saved is coming up.' : 'Events you saved are coming up.';

  const subject =
    events.length === 1
      ? `${dayHeading(events[0].startDateTime, now)}: ${events[0].title}`
      : `${events.length} saved events coming up`;

  const eventUrl = (event: ReminderEventView) => `${base}/events/${event.id}`;

  /* ── text ── */
  const lines: string[] = [lede, ''];
  for (const event of events) {
    lines.push(`• ${event.title}`);
    lines.push(`  ${whenLabel(event.startDateTime, now)} · ${whereLabel(event)}`);
    lines.push(`  ${event.applyLink || eventUrl(event)}`);
    lines.push('');
  }
  lines.push('-'.repeat(47));
  lines.push(WHY_LINE);
  lines.push(`Your saved events: ${base}/tracker`);
  lines.push(`Stop these reminders: ${unsubscribeUrl}`);
  const text = lines.join('\n');

  /* ── html ──
     EVERY interpolated value is escaped. An event title is scraped from a third-party page, so
     it is exactly as untrusted as the source names and error strings the digest escapes. */
  const cards = events
    .map(
      event => `
    <div class="card">
      <div class="title"><a href="${escapeHtml(eventUrl(event))}">${escapeHtml(
        event.title
      )}</a></div>
      <div class="meta">${escapeHtml(whenLabel(event.startDateTime, now))}</div>
      <div class="meta">${escapeHtml(whereLabel(event))}</div>
    </div>`
    )
    .join('');

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    /* LITERAL HEXES ON PURPOSE - DO NOT CONVERT THESE TO var(). This is a standalone
       document: app/globals.css is not in scope, so a custom property would resolve to
       nothing and paint transparent.

       Every colour below mirrors one of the nine tokens - ground/--paper, card/--surface,
       body/--ink, secondary/--ink-2, quiet/--ink-3, rule/--rule, link/--accent. Read the
       CURRENT value out of the palette block in app/globals.css and re-sync by hand; this
       comment deliberately does NOT repeat the hexes, because a value copied into a comment
       is a snapshot that goes stale silently and then gets trusted. */
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; color: #121417; max-width: 600px; margin: 0 auto; padding: 20px; background: #FFFFFF; }
    .lede { font-size: 17px; font-weight: 600; margin: 0 0 18px 0; }
    .card { border-left: 3px solid #12513C; background: #FAF9F5; border-radius: 8px; padding: 14px 16px; margin-bottom: 12px; }
    .title { font-size: 16px; font-weight: 600; margin-bottom: 4px; }
    .title a { color: #121417; text-decoration: none; }
    .meta { font-size: 14px; color: #55595F; }
    .actions { margin: 22px 0 8px 0; }
    .button { display: inline-block; background: #121417; color: #FFFFFF; padding: 12px 22px; text-decoration: none; border-radius: 999px; font-size: 14px; font-weight: 600; }
    .footer { border-top: 1px solid rgba(0,0,0,0.07); margin-top: 26px; padding-top: 16px; font-size: 12.5px; color: #8A8F96; }
    .footer a { color: #55595F; }
  </style>
</head>
<body>
  <p class="lede">${escapeHtml(lede)}</p>
${cards}
  <div class="actions">
    <a class="button" href="${escapeHtml(`${base}/tracker`)}">Open your saved events</a>
  </div>
  <div class="footer">
    <p>${escapeHtml(WHY_LINE)}</p>
    <p><a href="${escapeHtml(
      unsubscribeUrl
    )}">Stop these reminders</a> — one tap, no sign-in needed.</p>
    <p>${escapeHtml(dayHeading(now, now))} · PulseBLR, Bengaluru</p>
  </div>
</body>
</html>`;

  return { subject, html, text };
}

/* ── WEB PUSH: the rules, as pure functions ─────────────────────────────────── */

/**
 * Notifications per user per IST day.
 *
 * THREE, WHERE EMAIL GETS TWO, and the asymmetry is deliberate rather than generous. A push is
 * about ONE event (see `formatPushPayload` on `tag`), so the number a recipient would count if they
 * were annoyed is the number of EVENTS, not the number of runs — where an email covering three
 * events is still one thing in an inbox. So push's two caps collapse into a single budget, and the
 * number has to be the one that reads as "a few reminders", not "a few digests".
 */
export const DEFAULT_MAX_PUSHES_PER_DAY = 3;

/**
 * Notifications one run may fire.
 *
 * Never larger than the daily allowance would permit — see `pushEventsThisRun`, which is what
 * actually enforces it. This exists so an operator running the script by hand at 3 pm cannot empty
 * the whole day's budget in one go on a busy week.
 */
export const DEFAULT_MAX_EVENTS_PER_PUSH_RUN = 2;

/**
 * How many notifications this run may send, given what has already gone out today.
 *
 * WHY THIS IS A FUNCTION AND NOT A CLAMP AT THE CALL SITE. `applyReminderCaps` treats its two
 * limits as protecting different things — the inbox, and the message — which is right for email
 * and wrong for push, where one notification is one event and the two limits are the SAME budget.
 * Passing `maxEventsPerEmail` unclamped would let a single run of 3 fire past a daily cap of 3 that
 * already had 2 spent, and the overshoot would be invisible: the cap query reports the day's total
 * only on the NEXT run. So the arithmetic is named, exported and pinned by a test rather than
 * remembered as a `Math.min` in the sender.
 *
 * Returns 0 when the day is spent, which `applyReminderCaps` then reports as `daily-cap`.
 */
export function pushEventsThisRun(input: {
  pushesSentToday: number;
  maxPushesPerDay?: number;
  maxEventsPerRun?: number;
}): number {
  const {
    pushesSentToday,
    maxPushesPerDay = DEFAULT_MAX_PUSHES_PER_DAY,
    maxEventsPerRun = DEFAULT_MAX_EVENTS_PER_PUSH_RUN,
  } = input;
  const remaining = maxPushesPerDay - Math.max(0, pushesSentToday);
  return Math.max(0, Math.min(maxEventsPerRun, remaining));
}

/* ── The subscription a browser hands us ───────────────────────────────────── */

/** One problem with a submitted subscription, named by field. Never echoes the value back. */
export interface PushSubscriptionIssue {
  field: string;
  message: string;
}

/** The stored shape. Flat, because `p256dh` and `auth` are what `web-push` wants as strings. */
export interface PushSubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string;
}

/**
 * An endpoint longer than this is not a push service, and a unique index on it is not something to
 * hand an unbounded string. Real ones measure ~180 chars (FCM) to ~230 (Mozilla).
 */
const MAX_ENDPOINT_CHARS = 1000;

/** An uncompressed P-256 public point. Exactly 65 bytes, always — 0x04 plus two 32-byte coords. */
const P256DH_BYTES = 65;

/** The auth secret from the Web Push spec. Exactly 16 bytes, always. */
const AUTH_SECRET_BYTES = 16;

/** base64 or base64url, padded or not. Browsers are not consistent about which they emit. */
const BASE64ISH = /^[A-Za-z0-9+/_-]+={0,2}$/;

function decodedByteLength(value: string): number | null {
  if (!BASE64ISH.test(value)) return null;
  // Node's base64 decoder accepts the URL-safe alphabet, so one call covers both. It is LENIENT
  // about junk, which is why the regex above runs first — otherwise a string of the right length
  // full of invalid characters would decode to the right byte count and pass.
  return Buffer.from(value, 'base64').length;
}

/** Bracketed IPv6, or four dotted decimal octets. Either means somebody is not naming a service. */
function isIpLiteral(hostname: string): boolean {
  if (hostname.startsWith('[')) return true;
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
}

/**
 * Validate a subscription submitted by a browser, BEFORE it reaches the database.
 *
 * ── THIS IS HALF OF AN SSRF GUARD, AND SAYING SO IS THE POINT. ────────────────────────────────
 * `endpoint` is a URL supplied by the caller which the server will later POST to, from a cron
 * runner, without a user watching. That is the same shape as `POST /api/scrape-url`, which was a
 * general-purpose in-network proxy until `lib/security/safe-fetch.ts` was written — and unlike that
 * route, the fetch here happens hours later and through `web-push`'s own `https.request`, so
 * `safeFetch` cannot wrap it.
 *
 * What is enforceable purely, at write time, is the structural half: https only, no embedded
 * credentials, a real dotted hostname rather than an IP literal or `localhost`. That already
 * removes every literal metadata / loopback / private-range address. The remaining vector — a
 * public hostname that RESOLVES to 169.254.169.254 — needs DNS, so it is checked in the send path
 * with `assertSafeUrl()`; see the note there, including the TOCTOU limit it inherits.
 *
 * ── THE KEY LENGTHS ARE CHECKED BECAUSE THE FAILURE OTHERWISE LANDS HOURS LATER. ──────────────
 * `web-push` throws while deriving the aes128gcm content encryption key if `p256dh` is not a valid
 * 65-byte point, and that throw happens inside the cron run, per event, long after the request that
 * stored the bad row. Refusing it at the door turns a 3 AM stack trace into a 400 the client can
 * report. Both lengths are fixed by the spec, so this is a hard check rather than a heuristic.
 *
 * ── TWO BODY SHAPES ARE ACCEPTED. ────────────────────────────────────────────────────────────
 * `PushSubscription.toJSON()` in the browser produces `{ endpoint, keys: { p256dh, auth } }`, so
 * that is the canonical shape; a flat `{ endpoint, p256dh, auth }` is accepted too, because a
 * caller that has already destructured is not making a mistake worth a 400.
 */
export function validatePushSubscriptionInput(
  body: unknown
): { subscription: PushSubscriptionInput; issues: [] } | { subscription: null; issues: PushSubscriptionIssue[] } {
  const issues: PushSubscriptionIssue[] = [];
  const fail = () => ({ subscription: null, issues });

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    issues.push({ field: 'body', message: 'Expected a JSON object.' });
    return fail();
  }

  const raw = body as Record<string, unknown>;
  const keys = (raw.keys && typeof raw.keys === 'object' ? raw.keys : {}) as Record<string, unknown>;

  const endpoint = typeof raw.endpoint === 'string' ? raw.endpoint.trim() : '';
  const p256dh = typeof keys.p256dh === 'string' ? keys.p256dh.trim() : typeof raw.p256dh === 'string' ? raw.p256dh.trim() : '';
  const auth = typeof keys.auth === 'string' ? keys.auth.trim() : typeof raw.auth === 'string' ? raw.auth.trim() : '';

  /* ── endpoint ── */
  if (!endpoint) {
    issues.push({ field: 'endpoint', message: 'A push endpoint is required.' });
  } else if (endpoint.length > MAX_ENDPOINT_CHARS) {
    issues.push({ field: 'endpoint', message: `A push endpoint may be at most ${MAX_ENDPOINT_CHARS} characters.` });
  } else {
    let url: URL | null = null;
    try {
      url = new URL(endpoint);
    } catch {
      issues.push({ field: 'endpoint', message: 'Not a valid absolute URL.' });
    }
    if (url) {
      if (url.protocol !== 'https:') {
        issues.push({ field: 'endpoint', message: 'A push endpoint must be https.' });
      }
      if (url.username || url.password) {
        issues.push({ field: 'endpoint', message: 'A push endpoint must not contain credentials.' });
      }
      const host = url.hostname.toLowerCase();
      if (isIpLiteral(host) || !host.includes('.') || host === 'localhost') {
        issues.push({ field: 'endpoint', message: 'A push endpoint must name a public host.' });
      }
    }
  }

  /* ── keys ── */
  if (!p256dh) {
    issues.push({ field: 'keys.p256dh', message: 'The p256dh key is required.' });
  } else if (decodedByteLength(p256dh) !== P256DH_BYTES) {
    issues.push({
      field: 'keys.p256dh',
      message: `The p256dh key must be base64 of exactly ${P256DH_BYTES} bytes.`,
    });
  }

  if (!auth) {
    issues.push({ field: 'keys.auth', message: 'The auth secret is required.' });
  } else if (decodedByteLength(auth) !== AUTH_SECRET_BYTES) {
    issues.push({
      field: 'keys.auth',
      message: `The auth secret must be base64 of exactly ${AUTH_SECRET_BYTES} bytes.`,
    });
  }

  if (issues.length > 0) return fail();

  const userAgent = typeof raw.userAgent === 'string' ? raw.userAgent.trim().slice(0, 300) : undefined;
  return { subscription: { endpoint, p256dh, auth, userAgent: userAgent || undefined }, issues: [] };
}

/* ── The notification itself ───────────────────────────────────────────────── */

/**
 * The payload put on the wire, and therefore the CONTRACT WITH `public/sw.js`.
 *
 * FOUR FIELDS, AND THE WORKER READS ALL FOUR — verified against the file rather than assumed. Its
 * `push` listener takes `title`, `body` and `url`, and sets `tag` only when a non-empty string
 * arrives (an empty tag is not the same as no tag, and it makes `renotify` a TypeError). Every value
 * here is a flat primitive because that handler's `event.data.json()` can only degrade to treating
 * the raw text as a body: a nested shape it does not expect would show the user a notification with
 * no title and no destination rather than an error anybody could see.
 *
 * Do not add a field here expecting it to render. The worker ignores what it does not read, silently,
 * and there is no channel back — a payload field with no handler is the "vocabulary value with no
 * keyword pattern" problem moved onto the wire.
 */
export interface PushPayload {
  title: string;
  body: string;
  /**
   * A PATH, not an absolute URL. `clients.openWindow()` resolves it against the service worker's
   * own origin, so the notification cannot be made to open somewhere else, and it does not depend
   * on `NEXTAUTH_URL` being correct on whichever machine happened to run the cron.
   */
  url: string;
  /** Per EVENT, so a re-send replaces the previous notification instead of stacking beside it. */
  tag: string;
}

/**
 * The push services enforce a payload ceiling — 4096 bytes is the figure FCM and Mozilla both
 * publish — and aes128gcm adds ~103 bytes of header and tag on top of the plaintext. Over the
 * limit the service answers **413**, which is a defect in this payload and not a dead subscription,
 * so the send path reports it separately rather than pruning the row.
 *
 * 3000 leaves a very wide margin on purpose: the only unbounded inputs here are a scraped title
 * and a scraped venue string, and the two caps below already bound them far below this. This is the
 * backstop that makes "a pathological title cannot break the send" a fact rather than a hope.
 */
export const PUSH_PAYLOAD_MAX_BYTES = 3000;

/** Android collapses a notification title at ~40 chars; this is a payload bound, not a design one. */
const PUSH_TITLE_MAX_CHARS = 120;
const PUSH_BODY_MAX_CHARS = 160;

function clamp(value: string, max: number): string {
  const text = value.trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * One event → one notification.
 *
 * The body is built from the SAME `whenLabel` / `whereLabel` helpers the reminder email uses, so a
 * notification and the email about the same event cannot disagree about which day it is on — which
 * is the whole reason `lib/format.ts` is pinned to Asia/Kolkata. Two formatters would drift, and
 * the symptom is a notification saying "Tomorrow" about something the app lists as today.
 */
export function formatPushPayload(event: ReminderEventView, now: Date = new Date()): PushPayload {
  const payload: PushPayload = {
    title: clamp(event.title || 'A saved event', PUSH_TITLE_MAX_CHARS),
    body: clamp(`${whenLabel(event.startDateTime, now)} · ${whereLabel(event)}`, PUSH_BODY_MAX_CHARS),
    url: `/events/${event.id}`,
    tag: `pblr-event-${event.id}`,
  };

  // Defensive, and it must not throw: dropping the body still delivers a usable notification (the
  // title names the event and the tap still opens it), whereas a 413 delivers nothing.
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > PUSH_PAYLOAD_MAX_BYTES) {
    payload.body = '';
    payload.title = clamp(payload.title, 60);
  }
  return payload;
}
