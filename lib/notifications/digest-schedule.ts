/**
 * The digest RULES, as pure functions.
 *
 * Everything here is decidable without a database, a clock of its own or a network, which is why it
 * lives apart from `./digest.ts` (mongoose, Resend) and is what `tests/digest-schedule.test.ts`
 * exercises. The split is copied deliberately from `./reminder-policy.ts` — that stream established
 * the shape, and a second notification feature inventing a second arrangement is how two senders end
 * up with two definitions of consent and two answers to "what day is it".
 *
 * WHAT THIS FEATURE IS. `DIGEST_FREQUENCIES` and `User.preferences.digestFrequency` have existed
 * since preferences landed and NOTHING CONSUMED THEM: `scripts/send-digest.ts` mailed one hardcoded
 * `USER_EMAIL` every single morning regardless of what anybody had chosen. So the preference was a
 * control with no wire behind it. These are the rules that give it one.
 *
 * THE FIVE RULES, one function each, so none of them can be "remembered" at a call site:
 *
 *   1. `digestDecision()`          — consent, then cadence, then whether today is the day.
 *   2. `digestPeriodKey()`         — the at-most-once identity of one digest. IST, always.
 *   3. `applyDigestCap()`          — at most one digest email per user per IST day, whatever else.
 *   4. `digestWindow()`            — which events a given cadence is allowed to talk about.
 *   5. `verifyDigestUnsubscribeToken()` — an opt-out that works with no session at all.
 *
 * The double-send guard is deliberately NOT here: it is a unique index on `DigestLog`
 * (`lib/models/DigestLog.ts`). A rule enforced by a remembered check is a rule that fails the first
 * time two runs overlap.
 */
import crypto from 'crypto';
import { dayHeading, dayKeyIST, locationLabel, timeIST } from '../format';
// ONE definition of the cadence vocabulary. `lib/events/relevance.ts` owns it (the schema enum on
// `User.preferences.digestFrequency` is generated from the same constant), it is pure, and importing
// it is what stops this module accepting a fourth value the database can never hold.
import { DIGEST_FREQUENCIES, type DigestFrequency } from '../events/relevance';
// `hasBeenAsked` is IMPORTED, not re-implemented. "Has this user been asked?" must have exactly one
// answer across both notification streams — a reminder sender and a digest sender that disagree
// about consent is the worst possible way for this to go wrong, and it would go wrong silently.
import { hasBeenAsked, istDayStart, type UserPreferencesLike } from './reminder-policy';
import { escapeHtml } from './html';

export { istDayStart };
export type { DigestFrequency };

/**
 * The `kind` written on every `DigestLog` row for this feature.
 *
 * Part of the unique key, so a future second periodic mailing ("your month in review") gets its own
 * at-most-once guarantee rather than colliding with this one.
 */
export const DIGEST_KIND = 'event-digest';

/**
 * Events in one digest. FIVE, and the number is the product decision rather than a layout limit.
 *
 * A digest is a curation claim: these are the five worth your week. Twenty events is a listings
 * page, and a listings page already exists at `/` — mailing one teaches the reader to archive the
 * next one unread. `lib/notifications/reminder-policy.ts` draws the same line from the other side
 * ("beyond this it is a digest, and a digest is a different product").
 */
export const DIGEST_EVENT_COUNT = 5;

/**
 * Digest emails per user per IST day. ONE.
 *
 * The period key below already gives at-most-once per cadence period, so this looks redundant. It
 * is not, and the hole it closes is a real sequence: a user on `weekly` receives Monday's digest,
 * then switches to `daily` that afternoon. `weekly:2026-09-07` and `daily:2026-09-07` are DIFFERENT
 * period keys, so a re-run the same evening finds no claimed row and would mail them a second time
 * on the day they changed a setting. Counting rows since IST midnight refuses that.
 */
export const MAX_DIGESTS_PER_IST_DAY = 1;

/**
 * Which IST weekday the weekly digest goes out on. `1` = Monday (`Date.getUTCDay()` numbering, the
 * same convention `User.preferences.evenings` stores and `relevance.ts` documents).
 *
 * Monday because the digest is about the week AHEAD. A Friday digest is a weekend-plans email and
 * this product's events are overwhelmingly weekday evenings.
 */
export const WEEKLY_DIGEST_IST_WEEKDAY = 1;

/** How far ahead the weekly digest looks. Seven days, i.e. the week it is announcing. */
export const WEEKLY_WINDOW_DAYS = 7;

/**
 * How far ahead the DAILY digest looks. 48 hours, not 24, and the reason is the schedule rather
 * than generosity — the same reasoning `DEFAULT_LEAD_HOURS` records for reminders.
 *
 * The workflow runs at 8 AM IST. A 24-hour window reaches 8 AM tomorrow, so every evening event
 * tomorrow — which is most of them — falls in the gap between two runs and is never in any digest at
 * all. 48 hours reaches tomorrow night, and today's overlap with yesterday's send is harmless
 * because a digest is a "what's on" list, not an at-most-once-per-event promise.
 */
export const DAILY_WINDOW_HOURS = 48;

/* ── 1. Consent, then cadence, then "is today the day" ──────────────────────── */

/**
 * The stored cadence, read STRUCTURALLY off the document — never through `readPreferences()`.
 *
 * `lib/events/relevance.ts#readPreferences` coerces a missing preference block into
 * `DEFAULT_PREFERENCES`, whose `digestFrequency` is `'weekly'`. That is correct for ranking a feed
 * (an unconfigured user should see today's events, not an empty page) and it is precisely wrong
 * here, because it would answer "weekly" for a user who has never had an opinion — i.e. it would
 * manufacture consent out of an absent field. Ranking may assume; mailing may not.
 *
 * Returns `null` for anything that is not one of the three stored values, so an absent field, a
 * null, or a string from some future write path all fail closed instead of defaulting to a cadence.
 */
export function readDigestFrequency(
  user: UserPreferencesLike | null | undefined
): DigestFrequency | null {
  const prefs = user?.preferences;
  if (!prefs) return null;
  // `prefs.digest` is the name the reminders stream's brief used for this field and which its
  // `NotificationPreferences` interface still accepts. Read as a fallback for the same reason it
  // does: a surface written against that shape would otherwise fail as "this user never gets an
  // email", which is the hardest kind of bug to notice in a notification system.
  const raw = prefs.digestFrequency ?? prefs.digest;
  if (typeof raw !== 'string') return null;
  return DIGEST_FREQUENCIES.includes(raw as DigestFrequency) ? (raw as DigestFrequency) : null;
}

/**
 * Is today a day this cadence sends on?
 *
 * `weekly` is Monday IST and nothing else. Note what that means operationally and why it is right:
 * the workflow runs EVERY morning, and this function is what turns six of those seven runs into a
 * no-op for a weekly subscriber. Putting the cadence in the cron instead would need two workflows
 * and would make "which users are due" a scheduling question rather than a preference one.
 */
export function isDigestDue(frequency: DigestFrequency, now: Date): boolean {
  switch (frequency) {
    case 'off':
      return false;
    case 'daily':
      return true;
    case 'weekly':
      return istWeekday(now) === WEEKLY_DIGEST_IST_WEEKDAY;
    default:
      return false;
  }
}

export type DigestOutcome =
  /** No `preferences.onboardedAt` — the user has never been shown the choice. */
  | 'never-asked'
  /** Asked, but no cadence is stored. Fails closed; see `readDigestFrequency`. */
  | 'no-frequency'
  /** Asked, and said `off`. */
  | 'off'
  /** Consented, but today is not this cadence's day. */
  | 'not-due'
  /** Consented and due. */
  | 'due';

export interface DigestDecision {
  outcome: DigestOutcome;
  /** The stored cadence, or `null` when there is none to honour. */
  frequency: DigestFrequency | null;
  /** The at-most-once identity for this send. Only set when `outcome === 'due'`. */
  periodKey: string | null;
}

/**
 * May this user be mailed a digest right now, and under what identity?
 *
 * TWO CONDITIONS FOR CONSENT, AND THE FIRST ONE IS THE WHOLE POINT.
 *
 *   1. `onboardedAt` is set — the user has BEEN ASKED.
 *   2. the stored cadence is `weekly` or `daily`.
 *
 * Condition 1 is not obvious and it is the trap this feature exists inside. `lib/models/User.ts`
 * declares `digestFrequency: { type: String, enum: …, default: DEFAULT_PREFERENCES.digestFrequency }`
 * and that default is **`'weekly'`**, with `preferences` itself carrying a factory default on the
 * document. So checking the cadence ALONE would mail every account created or re-saved since
 * preferences landed, none of whom chose anything — a silent opt-in, from a schema default, to a
 * recurring email. `onboardedAt` is the one field whose documented meaning is "has been asked": the
 * server stamps it in `PUT /api/me/preferences` on any successful save INCLUDING a skip, so it
 * separates a real answer from a default.
 *
 * The order matters for the REPORT, not for the verdict: `never-asked` and `off` are reported
 * separately because they mean opposite things to an operator. "Never asked" is the onboarding flow
 * not having reached anybody yet and is expected today; "off" is a decision this run must respect.
 * Collapsing them is how "nothing was sent" becomes a mystery.
 */
export function digestDecision(
  user: UserPreferencesLike | null | undefined,
  now: Date
): DigestDecision {
  if (!hasBeenAsked(user)) return { outcome: 'never-asked', frequency: null, periodKey: null };

  const frequency = readDigestFrequency(user);
  if (!frequency) return { outcome: 'no-frequency', frequency: null, periodKey: null };
  if (frequency === 'off') return { outcome: 'off', frequency, periodKey: null };
  if (!isDigestDue(frequency, now)) return { outcome: 'not-due', frequency, periodKey: null };

  return { outcome: 'due', frequency, periodKey: digestPeriodKey(frequency, now) };
}

/* ── 2. The period key — the at-most-once identity ──────────────────────────── */

/**
 * IST weekday for an instant, `0` = Sunday.
 *
 * Computed by formatting the instant to an IST DAY KEY first and doing the weekday arithmetic in
 * `Date.UTC`, which is pure calendar maths with no zone left in it. That is the arrangement
 * CLAUDE.md records for the calendar grid, and it exists because the alternative — a `Date` and
 * `getDay()` — reads the RUNNER's clock. The runner is UTC and the send is 02:30 UTC, so on a
 * Monday morning IST `getDay()` answers `0` and a weekly digest would never send at all.
 */
export function istWeekday(now: Date): number {
  return utcFromDayKey(dayKeyIST(now)).getUTCDay();
}

/**
 * The IST Monday of the week containing this instant, as a `YYYY-MM-DD` day key.
 *
 * `(weekday + 6) % 7` days back, which maps Monday to 0 and SUNDAY TO 6 — i.e. Sunday belongs to
 * the week that already started, not the one about to. Getting that backwards would give Sunday's
 * run a fresh period key and mail every weekly subscriber a second time the day before their
 * digest is due.
 */
export function istWeekStartKey(now: Date): string {
  const day = utcFromDayKey(dayKeyIST(now));
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return dayKeyFromUtc(day);
}

/**
 * The identity of one digest, for the send log's unique index.
 *
 * PREFIXED BY CADENCE on purpose. `daily:2026-09-07` and `weekly:2026-09-07` are different rows,
 * which is what lets a user switch cadence without the switch itself being interpreted as "already
 * sent" — and it is exactly why `MAX_DIGESTS_PER_IST_DAY` exists to catch the other side of that.
 *
 * A `YYYY-MM-DD` IST day key rather than an ISO week number, because ISO week numbering has a
 * year-boundary rule (a January date can be week 52 of the previous year) that nothing here needs
 * and that would silently mis-key one send a year.
 */
export function digestPeriodKey(frequency: DigestFrequency, now: Date): string | null {
  if (frequency === 'daily') return `daily:${dayKeyIST(now)}`;
  if (frequency === 'weekly') return `weekly:${istWeekStartKey(now)}`;
  return null;
}

/** `YYYY-MM-DD` → the same calendar date at UTC midnight. Zone-free arithmetic only. */
function utcFromDayKey(key: string): Date {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

/** The inverse of `utcFromDayKey`. Not `toISOString().slice(0, 10)` — that is the same thing but
 * silently wrong the moment somebody passes a non-midnight date, so the parts are read explicitly. */
function dayKeyFromUtc(date: Date): string {
  const year = String(date.getUTCFullYear()).padStart(4, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/* ── 3. The cap ─────────────────────────────────────────────────────────────── */

export interface DigestCapResult {
  send: boolean;
  blockedBy?: 'daily-cap';
}

/**
 * Apply the per-IST-day cap. See `MAX_DIGESTS_PER_IST_DAY` for the sequence this refuses.
 *
 * A separate function rather than an inline `>=` because it is the last thing standing between a
 * cadence change and two emails in one morning, and a comparison written at the call site is a
 * comparison that gets copied to a second call site with the operator flipped.
 */
export function applyDigestCap(input: {
  digestsSentToday: number;
  maxPerDay?: number;
}): DigestCapResult {
  const max = input.maxPerDay ?? MAX_DIGESTS_PER_IST_DAY;
  if (input.digestsSentToday >= max) return { send: false, blockedBy: 'daily-cap' };
  return { send: true };
}

/* ── 4. Which events may this cadence talk about ────────────────────────────── */

export interface DigestWindow {
  /** Inclusive lower bound. Always `now` — a digest never announces something already started. */
  from: Date;
  /** Exclusive upper bound. */
  to: Date;
}

/**
 * The time window a cadence covers.
 *
 * `from` IS ALWAYS `now`, never the start of the calendar period, and that is the difference
 * between a digest and an archive. A Monday 8 AM send whose window opened at Monday midnight would
 * lead with events that finished before the reader woke up.
 *
 * Returns a zero-length window for `off` rather than throwing: a caller that reaches here with
 * `off` has a bug, and an empty window makes it visible as "nothing to send" instead of a crash in
 * a cron job at 2:30 in the morning.
 */
export function digestWindow(frequency: DigestFrequency, now: Date): DigestWindow {
  if (frequency === 'weekly') {
    return { from: now, to: new Date(now.getTime() + WEEKLY_WINDOW_DAYS * 24 * 3600_000) };
  }
  if (frequency === 'daily') {
    return { from: now, to: new Date(now.getTime() + DAILY_WINDOW_HOURS * 3600_000) };
  }
  return { from: now, to: now };
}

/* ── 5. Unsubscribe, with no session ───────────────────────────────────────── */

/**
 * The digest unsubscribe link is a SIGNED user id, verified with `NEXTAUTH_SECRET`.
 *
 * WHY THIS IS NOT `reminder-policy.ts#unsubscribeToken`, given the algorithm is identical: the
 * SCOPE STRING differs, and that is the entire point. That one signs `reminders:v1:<id>` and its
 * route sets `preferences.remindersEnabled = false`; this signs `digest:v1:<id>` and its route sets
 * `preferences.digestFrequency = 'off'`. Sharing one token would mean the link at the foot of a
 * digest also verifies at the reminder route — so a reader who unsubscribed from a weekly summary
 * could have their saved-event reminders silently turned off too, or vice versa, depending on which
 * URL a mail client happened to rewrite. Two mailings, two consents, two tokens.
 *
 * (`reminder-policy.ts` is another stream's settled file, so the scope could not be added there as
 * a parameter. Fifteen duplicated lines of HMAC is the cheaper half of that trade.)
 *
 * WHAT IS IN THE URL: the Google `sub`, i.e. this app's `userId`. Holding it grants no read and no
 * write — every route in this app derives `userId` from the session and never from input — and the
 * only reachable effect is one enum turning to `'off'`. See `reminder-policy.ts` for the longer
 * argument; it applies unchanged.
 */
const UNSUB_TOKEN_CHARS = 32;
const UNSUB_SCOPE = 'digest:v1';

export function digestUnsubscribeToken(userId: string, secret: string): string {
  if (!userId) throw new Error('digestUnsubscribeToken requires a userId');
  // Loud rather than fail-open. A blank secret makes every token verify against every other one,
  // and an email that reached an inbox with no working way off the list is the one failure this
  // design is arranged to prevent. Better to refuse to send at all.
  if (!secret) throw new Error('digestUnsubscribeToken requires NEXTAUTH_SECRET to be set');
  return crypto
    .createHmac('sha256', secret)
    .update(`${UNSUB_SCOPE}:${userId}`)
    .digest('base64url')
    .slice(0, UNSUB_TOKEN_CHARS);
}

/**
 * Constant-time verification, and `false` for anything malformed.
 *
 * `timingSafeEqual` THROWS when the buffers differ in length, so length is compared first. A thrown
 * exception here is a 500 on an unsubscribe link — the reader cannot get off the list and the page
 * blames itself.
 */
export function verifyDigestUnsubscribeToken(
  userId: string | null | undefined,
  token: string | null | undefined,
  secret: string | null | undefined
): boolean {
  if (!userId || !token || !secret) return false;
  let expected: string;
  try {
    expected = digestUnsubscribeToken(userId, secret);
  } catch {
    return false;
  }
  const a = Buffer.from(expected);
  const b = Buffer.from(token);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** The absolute URL that appears in the email. */
export function buildDigestUnsubscribeUrl(appUrl: string, userId: string, secret: string): string {
  const base = appUrl.replace(/\/+$/, '');
  const token = digestUnsubscribeToken(userId, secret);
  return `${base}/api/digest/unsubscribe?u=${encodeURIComponent(userId)}&t=${encodeURIComponent(
    token
  )}`;
}

/* ── The email itself ───────────────────────────────────────────────────────── */

/** One event, as the digest email needs it. Dates may be ISO strings or `Date`; both work. */
export interface DigestEventView {
  id: string;
  title: string;
  startDateTime: Date | string;
  venue?: string | null;
  area?: string | null;
  city?: string | null;
  format?: string | null;
  organizer?: string | null;
  isFree?: boolean | null;
  /** Where to register, when the event carries one. Falls back to the event page. */
  applyLink?: string | null;
}

export interface DigestEmail {
  subject: string;
  html: string;
  text: string;
}

/**
 * ONE LINE SAYING WHY THIS ARRIVED. Non-negotiable, and it names the SETTING rather than the
 * product, because "you are subscribed" is not something a reader can check and "you chose weekly
 * in PulseBLR" is.
 */
export function digestWhyLine(frequency: DigestFrequency): string {
  const cadence = frequency === 'daily' ? 'a daily' : 'a weekly';
  return (
    `You are getting this because you chose ${cadence} digest in PulseBLR. ` +
    'It is the only thing that triggers it, and one tap below turns it off.'
  );
}

/** "Tomorrow · 18:30", in IST, through the same helpers the feed uses. */
function whenLabel(start: Date | string): string {
  return `${dayHeading(start)} · ${timeIST(start)}`;
}

function whereLabel(event: DigestEventView): string {
  return locationLabel({
    format: event.format ?? undefined,
    venue: event.venue,
    area: event.area,
    city: event.city,
  });
}

/**
 * The digest email.
 *
 * IT IS NOT `formatDigestAsHTML` FROM `./digest.ts`. That one is the operator's daily report —
 * tracker updates, follow-ups and **source health**, the last of which names every failing scraper
 * and quotes its error string. It was safe while `scripts/send-digest.ts` mailed exactly one
 * hardcoded address (the owner's); it is not safe now that the sender walks every consenting user,
 * because scraper internals are not a reader's business. So this is a second, narrower formatter and
 * the old one keeps its one remaining caller, the admin-only preview route.
 *
 * EVERY interpolated value is escaped. An event title is scraped from a third-party page, so it is
 * exactly as untrusted as the strings `reminder-policy.ts` escapes.
 */
export function formatDigestEmail(input: {
  events: DigestEventView[];
  frequency: DigestFrequency;
  unsubscribeUrl: string;
  appUrl: string;
  now?: Date;
}): DigestEmail {
  const { events, frequency, unsubscribeUrl } = input;
  const base = input.appUrl.replace(/\/+$/, '');
  const now = input.now ?? new Date();
  const why = digestWhyLine(frequency);

  const horizon = frequency === 'daily' ? 'next couple of days' : 'week ahead';
  const lede =
    events.length === 1
      ? `One Bengaluru tech event worth your time in the ${horizon}.`
      : `${events.length} Bengaluru tech events worth your time in the ${horizon}.`;

  const subject =
    frequency === 'daily'
      ? `PulseBLR: ${events.length} event${events.length === 1 ? '' : 's'} coming up`
      : `PulseBLR: your week in Bengaluru tech`;

  const eventUrl = (event: DigestEventView) => `${base}/events/${event.id}`;

  /* ── text ── */
  const lines: string[] = [lede, ''];
  for (const event of events) {
    lines.push(`• ${event.title}`);
    lines.push(`  ${whenLabel(event.startDateTime)} · ${whereLabel(event)}`);
    if (event.organizer) lines.push(`  Hosted by ${event.organizer}`);
    lines.push(`  ${event.applyLink || eventUrl(event)}`);
    lines.push('');
  }
  lines.push('-'.repeat(47));
  lines.push(why);
  lines.push(`Everything upcoming: ${base}/`);
  lines.push(`This week, on the web: ${base}/digest`);
  lines.push(`Change the cadence: ${base}/onboarding`);
  lines.push(`Stop these emails: ${unsubscribeUrl}`);
  const text = lines.join('\n');

  /* ── html ── */
  const cards = events
    .map(
      event => `
    <div class="card">
      <div class="title"><a href="${escapeHtml(eventUrl(event))}">${escapeHtml(
        event.title
      )}</a></div>
      <div class="meta">${escapeHtml(whenLabel(event.startDateTime))}</div>
      <div class="meta">${escapeHtml(whereLabel(event))}${
        event.isFree ? ' · Free' : ''
      }</div>${
        event.organizer
          ? `\n      <div class="meta">Hosted by ${escapeHtml(event.organizer)}</div>`
          : ''
      }
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
    <a class="button" href="${escapeHtml(`${base}/`)}">See everything upcoming</a>
  </div>
  <div class="footer">
    <p>${escapeHtml(why)}</p>
    <p><a href="${escapeHtml(
      unsubscribeUrl
    )}">Stop these emails</a> — one tap, no sign-in needed. Or <a href="${escapeHtml(
      `${base}/onboarding`
    )}">change the cadence</a> instead.</p>
    <p>${escapeHtml(dayHeading(now))} · PulseBLR, Bengaluru</p>
  </div>
</body>
</html>`;

  return { subject, html, text };
}
