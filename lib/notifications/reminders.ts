/**
 * Event reminders: the DB and provider half. The rules live in `./reminder-policy.ts` and are
 * unit-tested there; this file is the part that cannot be tested without a database, so it is
 * kept as thin as possible and every decision it makes is delegated.
 *
 * WHY THIS FEATURE EXISTS AT ALL. Saving an event does nothing afterwards, so there is no reason
 * to reopen the app between the save and the event. This is the cheapest retention mechanic
 * available and it is also the one most likely to be experienced as spam, which is why the
 * ordering below is not negotiable:
 *
 *   1. refuse to run at all if the environment cannot produce a working unsubscribe link
 *   2. skip every user whose preference is not explicitly on
 *   3. CLAIM a `ReminderLog` row per event — the unique index is the double-send guard
 *   4. only then send, one email per user covering everything due
 *   5. record the provider's verdict against the rows already claimed
 *
 * Step 3 before step 4 trades a possible missed email for an impossible duplicate one. See the
 * header of `lib/models/ReminderLog.ts`.
 */
import crypto from 'crypto';
import type { Types } from 'mongoose';
import connectDB from '../mongodb';
import Event from '../models/Event';
import ReminderLog from '../models/ReminderLog';
import TrackerEntry from '../models/TrackerEntry';
import User from '../models/User';
import { sendReminderEmail } from './email';
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
  type ReminderEventView,
  type UserPreferencesLike,
} from './reminder-policy';

/**
 * Base URL for every link in the email, including the unsubscribe one.
 *
 * `NEXTAUTH_URL` is already required in production for auth to work at all (see CLAUDE.md under
 * Environment), so this reuses it rather than inventing a second variable that can disagree with
 * it. A localhost fallback is fine for a local dry run and is why `--dry` exists.
 */
const APP_URL = (process.env.NEXTAUTH_URL || 'http://localhost:3000').replace(/\/+$/, '');

export interface SendRemindersOptions {
  /** Injectable clock, so a dry run can be reasoned about. Defaults to now. */
  now?: Date;
  /** Decide and report, write nothing, send nothing. */
  dryRun?: boolean;
  leadHours?: number;
  maxEmailsPerDay?: number;
  maxEventsPerEmail?: number;
  /**
   * Delete this user's `failed`/`pending` rows for the events currently due, so they can be
   * attempted again. OPERATOR-ONLY and off by default — see `ReminderLog`'s header for why an
   * automatic retry would reintroduce the double send.
   */
  retryFailed?: boolean;
  /** Restrict the run to one address. The safe way to try this against real data. */
  onlyEmail?: string;
}

export type UserReminderOutcome =
  | 'sent'
  | 'failed'
  | 'nothing-due'
  | 'already-sent'
  | 'daily-cap'
  | 'no-email'
  | 'dry-run';

export interface UserReminderReport {
  userId: string;
  email: string;
  outcome: UserReminderOutcome;
  /** Events in the lead window and in a remindable tracker status. */
  due: number;
  /** Of those, ones a `ReminderLog` row already covers. */
  alreadyLogged: number;
  /** Rows actually claimed in this run — the number of events in the email. */
  claimed: number;
  /** Held back by a cap; a later run picks them up. */
  deferred: number;
  /** Rows a concurrent run claimed first. Non-zero here means the index earned its keep. */
  raced: number;
  emailsSentToday: number;
  error?: string;
}

export interface SendRemindersReport {
  /** Env vars that must be set before anything can be sent. Non-empty means nothing ran. */
  notConfigured: string[];
  dryRun: boolean;
  usersConsidered: number;
  usersOptedIn: number;
  /** Consent absent because the user has never been asked. Expected until onboarding ships. */
  neverAsked: number;
  /** Asked, and said no. */
  optedOut: number;
  emailsSent: number;
  emailsFailed: number;
  eventsReminded: number;
  perUser: UserReminderReport[];
}

/** A `User` row as this module reads it. `preferences` may legitimately be absent. */
type UserRow = UserPreferencesLike & {
  googleId?: string;
  email?: string;
  name?: string;
};

/**
 * `_id` is typed `Types.ObjectId` rather than `unknown` because it is passed straight back into a
 * `$in` and into `ReminderLog.create`. Mongoose's query types reject `unknown` there — which is
 * the type system doing its job: an id that has lost its type is an id that can be compared
 * against the wrong thing.
 */
type EventRow = {
  _id: Types.ObjectId;
  title?: string;
  startDateTime?: Date;
  venue?: string | null;
  area?: string | null;
  city?: string | null;
  format?: string | null;
  applyLink?: string | null;
};

function isDuplicateKey(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: number }).code === 11000);
}

/**
 * Send the day's event reminders.
 *
 * Idempotent and safe to re-run: a second run in the same day finds every event already logged
 * and sends nothing. That property is what lets the workflow retry and lets an operator run it
 * by hand without checking first.
 */
export async function sendEventReminders(
  options: SendRemindersOptions = {}
): Promise<SendRemindersReport> {
  const now = options.now ?? new Date();
  const dryRun = options.dryRun === true;
  const leadHours = options.leadHours ?? DEFAULT_LEAD_HOURS;
  const maxEmailsPerDay = options.maxEmailsPerDay ?? DEFAULT_MAX_EMAILS_PER_DAY;
  const maxEventsPerEmail = options.maxEventsPerEmail ?? DEFAULT_MAX_EVENTS_PER_EMAIL;

  const report: SendRemindersReport = {
    notConfigured: [],
    dryRun,
    usersConsidered: 0,
    usersOptedIn: 0,
    neverAsked: 0,
    optedOut: 0,
    emailsSent: 0,
    emailsFailed: 0,
    eventsReminded: 0,
    perUser: [],
  };

  /*
   * PREFLIGHT, and `NEXTAUTH_SECRET` is in it for a reason that is easy to miss: it signs the
   * unsubscribe token. Without it `buildUnsubscribeUrl` throws, and an email that reached an
   * inbox with no working way off the list is the one failure mode this whole design is arranged
   * to prevent. So it is checked here, before a single row is claimed, rather than being
   * discovered per-user halfway through a run.
   *
   * A dry run needs neither, which is what makes `--dry` usable on a laptop.
   */
  const secret = process.env.NEXTAUTH_SECRET || '';
  if (!dryRun) {
    if (!process.env.RESEND_API_KEY) report.notConfigured.push('RESEND_API_KEY');
    if (!secret) report.notConfigured.push('NEXTAUTH_SECRET');
    if (report.notConfigured.length > 0) return report;
  }

  await connectDB();

  /*
   * EVERY USER IS FETCHED AND CONSENT IS DECIDED IN JS, deliberately, rather than filtered in the
   * query.
   *
   * A `{ 'preferences.remindersEnabled': true }` filter would look tighter and would be WRONG in a
   * way that is invisible: it cannot express the second half of the consent rule (`onboardedAt`
   * being set, i.e. the user was actually asked — see `remindersEnabled()`), so a query-side filter
   * plus a JS check means two definitions of consent, and the one that decides is whichever is
   * stricter on the day. `remindersEnabled()` is the single definition, and it needs the document.
   *
   * Affordable because this is a per-user mailing, not a feed query: there are three accounts, and
   * even at a thousand this is one lean read per daily run. `select` keeps `card` (and its token)
   * out of memory.
   */
  const userFilter: Record<string, unknown> = {};
  if (options.onlyEmail) userFilter.email = options.onlyEmail.toLowerCase();

  const users = (await User.find(userFilter)
    .select('googleId email name preferences')
    .lean()) as unknown as UserRow[];

  report.usersConsidered = users.length;

  for (const user of users) {
    if (!remindersEnabled(user)) {
      // Separated in the report because they mean opposite things to an operator: "never asked"
      // is the onboarding flow not having reached them yet, and is expected right now; "opted out"
      // is a decision this run must respect. Reporting them as one number is how "nothing sent"
      // becomes a mystery.
      if (hasBeenAsked(user)) report.optedOut += 1;
      else report.neverAsked += 1;
      continue;
    }
    report.usersOptedIn += 1;

    const userId = user.googleId;
    const email = user.email;
    if (!userId) continue;

    const perUser: UserReminderReport = {
      userId,
      email: email ?? '',
      outcome: 'nothing-due',
      due: 0,
      alreadyLogged: 0,
      claimed: 0,
      deferred: 0,
      raced: 0,
      emailsSentToday: 0,
    };

    if (!email) {
      // `User.email` is required by the schema, so this is defensive rather than expected.
      perUser.outcome = 'no-email';
      report.perUser.push(perUser);
      continue;
    }

    /* ── What has this user saved that is about to happen? ── */
    const entries = await TrackerEntry.find({
      userId,
      status: { $in: [...REMINDABLE_TRACKER_STATUSES] },
    })
      .select('eventId')
      .lean();

    const eventIds = entries.map(entry => entry.eventId).filter(Boolean);
    if (eventIds.length === 0) {
      report.perUser.push(perUser);
      continue;
    }

    const events = (await Event.find({ _id: { $in: eventIds } })
      .select('title startDateTime venue area city format applyLink')
      .lean()) as unknown as EventRow[];

    const due = events
      .filter(event => isReminderDue(event.startDateTime, now, leadHours))
      // Soonest first, so a cap keeps the most urgent rather than whatever Mongo returned first.
      .sort(
        (a, b) =>
          new Date(a.startDateTime as Date).getTime() - new Date(b.startDateTime as Date).getTime()
      );
    perUser.due = due.length;
    if (due.length === 0) {
      report.perUser.push(perUser);
      continue;
    }

    const dueIds = due.map(event => event._id);

    /*
     * An explicit, operator-invoked retry. This is the ONLY thing that frees a claimed row, and
     * it is off by default because "the send failed" cannot be established from this side: a
     * timeout after Resend accepted the message is indistinguishable from one before.
     */
    if (options.retryFailed && !dryRun) {
      await ReminderLog.deleteMany({
        userId,
        kind: REMINDER_KIND,
        eventId: { $in: dueIds },
        status: { $in: ['failed', 'pending'] },
      });
    }

    /*
     * A pre-read of the log, for the REPORT and to avoid pointless insert attempts. It is not the
     * guard — the guard is the unique index below, because between this read and that insert
     * another run can do the same thing.
     */
    const logged = await ReminderLog.find({
      userId,
      kind: REMINDER_KIND,
      eventId: { $in: dueIds },
    })
      .select('eventId')
      .lean();
    const loggedIds = new Set(logged.map(row => String(row.eventId)));
    perUser.alreadyLogged = loggedIds.size;

    const candidates = due.filter(event => !loggedIds.has(String(event._id)));
    if (candidates.length === 0) {
      perUser.outcome = 'already-sent';
      report.perUser.push(perUser);
      continue;
    }

    /*
     * The frequency cap counts EMAILS, not rows, which is why every row carries a `batchId`.
     * Counting rows would over-count by however many events happened to be due together, and the
     * cap would fire on the first morning somebody had a busy week.
     *
     * `kind` IS IN THIS FILTER AND MUST STAY. It was missing, and the omission was invisible for
     * exactly as long as this was the only kind of reminder in the collection. The lookup nine
     * lines above scopes by `kind: REMINDER_KIND`; this count did not — so the moment web push
     * began writing `ReminderLog` rows under `PUSH_REMINDER_KIND`, every push consumed one of
     * this user's two daily EMAIL slots and every email consumed one of their push slots. Two
     * channels, one budget, silently: `DEFAULT_MAX_EMAILS_PER_DAY` is 2, so one morning's push
     * run would have taken the email cap to 2 and the email path would have reported `daily-cap`
     * with nothing in the inbox and nothing in the log to explain it.
     *
     * `ReminderLog`'s own header says `kind` is in the unique key so "a second sort of reminder
     * added later gets its own at-most-once guarantee instead of being silently suppressed by
     * this one". The same argument applies to the frequency cap, and the index alone does not
     * enforce it — a `distinct` has to ask.
     */
    const batchIds = await ReminderLog.distinct('batchId', {
      userId,
      kind: REMINDER_KIND,
      sentAt: { $gte: istDayStart(now) },
    });
    perUser.emailsSentToday = batchIds.length;

    const capped = applyReminderCaps({
      candidates,
      emailsSentToday: batchIds.length,
      maxEmailsPerDay,
      maxEventsPerEmail,
    });
    perUser.deferred = capped.deferred.length;

    if (capped.send.length === 0) {
      perUser.outcome = capped.blockedBy === 'daily-cap' ? 'daily-cap' : 'nothing-due';
      report.perUser.push(perUser);
      continue;
    }

    if (dryRun) {
      perUser.outcome = 'dry-run';
      perUser.claimed = capped.send.length;
      report.perUser.push(perUser);
      continue;
    }

    /* ── CLAIM FIRST. One row per event, and a duplicate key means somebody beat us to it. ── */
    const batchId = crypto.randomUUID();
    const claimed: EventRow[] = [];
    for (const event of capped.send) {
      try {
        await ReminderLog.create({
          userId,
          eventId: event._id,
          kind: REMINDER_KIND,
          batchId,
          email,
          eventTitle: event.title,
          eventStartDateTime: event.startDateTime,
          status: 'pending',
          sentAt: now,
        });
        claimed.push(event);
      } catch (error) {
        if (isDuplicateKey(error)) {
          perUser.raced += 1;
          continue;
        }
        throw error;
      }
    }

    perUser.claimed = claimed.length;
    if (claimed.length === 0) {
      // Everything was claimed by a concurrent run. Nothing to send, and nothing went wrong.
      perUser.outcome = 'already-sent';
      report.perUser.push(perUser);
      continue;
    }

    const views: ReminderEventView[] = claimed.map(event => ({
      id: String(event._id),
      title: event.title ?? 'A saved event',
      startDateTime: event.startDateTime as Date,
      venue: event.venue ?? null,
      area: event.area ?? null,
      city: event.city ?? null,
      format: event.format ?? null,
      applyLink: event.applyLink ?? null,
    }));

    const unsubscribeUrl = buildUnsubscribeUrl(APP_URL, userId, secret);
    const { subject, html, text } = formatReminderEmail({
      events: views,
      unsubscribeUrl,
      appUrl: APP_URL,
      now,
    });

    const result = await sendReminderEmail({ to: email, subject, html, text, unsubscribeUrl });

    if (result.ok) {
      await ReminderLog.updateMany(
        { userId, batchId },
        { $set: { status: 'sent', providerId: result.id } }
      );
      perUser.outcome = 'sent';
      report.emailsSent += 1;
      report.eventsReminded += claimed.length;
    } else {
      /*
       * The rows STAY, marked failed. They are not deleted, because a failure reported here does
       * not prove the message was not delivered — and re-sending on a false negative is exactly
       * the duplicate this design refuses. `--retry-failed` is the deliberate way out.
       */
      await ReminderLog.updateMany(
        { userId, batchId },
        { $set: { status: 'failed', error: (result.error ?? 'unknown').slice(0, 500) } }
      );
      perUser.outcome = 'failed';
      perUser.error = result.error;
      report.emailsFailed += 1;
    }

    report.perUser.push(perUser);
  }

  return report;
}

/**
 * Turn this user's reminders off. Backs the unsubscribe route.
 *
 * WRITES `preferences.remindersEnabled`, the path the schema actually declares — not the
 * `preferences.notifications.remindersEnabled` shape the brief for this work named. Writing the
 * brief's path would have been silently useless in BOTH directions: Mongoose's default
 * `strict: true` drops an update to an unknown path (no error, `modifiedCount: 0`, an unsubscribe
 * that reports success and changes nothing — the same class of silent-write failure CLAUDE.md
 * opens with), and had it been written it would have sat somewhere the API and the onboarding
 * screen never read.
 *
 * IT WRITES THE FLAG AND NOTHING ELSE. Stamping `onboardedAt` here was tried and reverted:
 * consent already reads false the moment the flag is false, so it buys nothing — and that field
 * gates ANOTHER stream's onboarding prompt (`null` is the only state that shows it), so setting it
 * would silently suppress onboarding for anybody who taps unsubscribe. A notification opt-out must
 * not decide whether a different screen appears.
 *
 * Idempotent: unsubscribing twice is the same as once, which matters because a mail client may
 * POST the one-click URL more than once.
 *
 * Returns whether a user row matched, so the route can tell "done" from "that link points at
 * nobody" — while deliberately telling the READER the same thing either way.
 */
export async function disableRemindersFor(userId: string): Promise<{ matched: boolean }> {
  await connectDB();
  const result = await User.updateOne(
    { googleId: userId },
    { $set: { 'preferences.remindersEnabled': false } }
  );
  return { matched: (result.matchedCount ?? 0) > 0 };
}
