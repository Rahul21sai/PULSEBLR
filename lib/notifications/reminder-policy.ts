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
function whenLabel(start: Date | string): string {
  return `${dayHeading(start)} · ${timeIST(start)}`;
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
      ? `${dayHeading(events[0].startDateTime)}: ${events[0].title}`
      : `${events.length} saved events coming up`;

  const eventUrl = (event: ReminderEventView) => `${base}/events/${event.id}`;

  /* ── text ── */
  const lines: string[] = [lede, ''];
  for (const event of events) {
    lines.push(`• ${event.title}`);
    lines.push(`  ${whenLabel(event.startDateTime)} · ${whereLabel(event)}`);
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
      <div class="meta">${escapeHtml(whenLabel(event.startDateTime))}</div>
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
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; color: #1D1D1F; max-width: 600px; margin: 0 auto; padding: 20px; background: #FFFFFF; }
    .lede { font-size: 17px; font-weight: 600; margin: 0 0 18px 0; }
    .card { border-left: 3px solid #0071E3; background: #F7F7F9; border-radius: 8px; padding: 14px 16px; margin-bottom: 12px; }
    .title { font-size: 16px; font-weight: 600; margin-bottom: 4px; }
    .title a { color: #1D1D1F; text-decoration: none; }
    .meta { font-size: 14px; color: #6E6E73; }
    .actions { margin: 22px 0 8px 0; }
    .button { display: inline-block; background: #1D1D1F; color: #FFFFFF; padding: 12px 22px; text-decoration: none; border-radius: 999px; font-size: 14px; font-weight: 600; }
    .footer { border-top: 1px solid rgba(0,0,0,0.07); margin-top: 26px; padding-top: 16px; font-size: 12.5px; color: #8E8E93; }
    .footer a { color: #6E6E73; }
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
    <p>${escapeHtml(dayHeading(now))} · PulseBLR, Bengaluru</p>
  </div>
</body>
</html>`;

  return { subject, html, text };
}
