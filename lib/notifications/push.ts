/**
 * Web push reminders: the DB and provider half. The rules live in `./reminder-policy.ts` and are
 * unit-tested there; this file is the part that cannot be tested without a database, so it is kept
 * thin and every decision it makes is delegated.
 *
 * WHY PUSH AND NOT ONLY EMAIL. A reminder email arrives in an inbox somebody opens on their laptop
 * at work; a reminder about a 7 pm meetup in Indiranagar has to reach the phone they are holding at
 * 6. This is the one thing an installed app can do that a website cannot, and it is the reason the
 * app is installable at all.
 *
 * ── CONSENT IS THE EXISTENCE OF A `PushSubscription` ROW, NOT `preferences.remindersEnabled`. ──
 *
 * This file does not read that flag and must not start. The recipient list is derived FROM the
 * subscription collection — `PushSubscription.distinct('userId')` — so "who may be pushed to" is
 * structural rather than a check somebody has to remember to write. A row cannot exist without a
 * click in the app and an OS-level permission grant, which is stronger evidence than a boolean, and
 * it self-revokes when either is withdrawn, which a boolean does not.
 *
 * The flag is EMAIL's consent and gets both directions wrong here: its schema default is `true`, so
 * reusing it would opt in accounts never asked about notifications; and read the other way, tapping
 * "Stop these reminders" in an email would silently kill a channel that email never mentioned. See
 * the header of `./reminder-policy.ts`. `tests/push-policy.test.ts` asserts this file never mentions
 * `remindersEnabled`, because the instinct to reuse it is the whole risk.
 *
 * ── THE ORDER IS NOT NEGOTIABLE, and it is the email path's order. ────────────────────────────
 *
 *   1. refuse to run at all without VAPID credentials
 *   2. consider only users who have a subscription
 *   3. CLAIM a `ReminderLog` row per event — the unique index is the double-send guard
 *   4. only then send, fanning one notification out to every device
 *   5. record the verdict against the row already claimed
 *
 * Step 3 before step 4 trades a possible missed notification for an impossible duplicate one. On
 * push the asymmetry is sharper than on email: a duplicate notification vibrates a phone twice and
 * is the fastest way to have permission revoked, and a revoked permission cannot be asked for again
 * in Chrome without the user digging through site settings.
 */
import crypto from 'crypto';
import type { Types } from 'mongoose';
import webpush, { WebPushError } from 'web-push';
import connectDB from '../mongodb';
import Event from '../models/Event';
import PushSubscription from '../models/PushSubscription';
import ReminderLog from '../models/ReminderLog';
import TrackerEntry from '../models/TrackerEntry';
import User from '../models/User';
import { assertSafeUrl } from '../security/safe-fetch';
import {
  applyReminderCaps,
  DEFAULT_LEAD_HOURS,
  DEFAULT_MAX_EVENTS_PER_PUSH_RUN,
  DEFAULT_MAX_PUSHES_PER_DAY,
  formatPushPayload,
  isReminderDue,
  istDayStart,
  pushEventsThisRun,
  PUSH_REMINDER_KIND,
  REMINDABLE_TRACKER_STATUSES,
  type ReminderEventView,
} from './reminder-policy';

/**
 * The three variables without which nothing can be sent.
 *
 * `VAPID_SUBJECT` is required by the spec and is NOT optional in practice: Mozilla's push service
 * rejects a JWT with no `sub` claim outright, so omitting it means Firefox users silently receive
 * nothing while Chrome works — the worst kind of partial failure, because it looks like a Firefox
 * bug. It must be a `mailto:` or `https:` URL identifying whoever operates the deployment.
 */
export const REQUIRED_PUSH_ENV = ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT'] as const;

export interface SendPushRemindersOptions {
  /** Injectable clock, so a dry run can be reasoned about. Defaults to now. */
  now?: Date;
  /** Decide and report, write nothing, send nothing. */
  dryRun?: boolean;
  leadHours?: number;
  maxPushesPerDay?: number;
  maxEventsPerRun?: number;
  /**
   * Delete this user's `failed`/`pending` PUSH rows for the events currently due, so they can be
   * attempted again. OPERATOR-ONLY and off by default, for the reason `ReminderLog`'s header gives:
   * a client-side failure does not prove non-delivery.
   */
  retryFailed?: boolean;
  /** Restrict the run to one account, by email. The safe way to try this against real data. */
  onlyEmail?: string;
}

export type UserPushOutcome =
  | 'sent'
  | 'failed'
  | 'partial'
  | 'nothing-due'
  | 'already-sent'
  | 'daily-cap'
  | 'no-subscription'
  | 'dry-run';

export interface UserPushReport {
  userId: string;
  /** The account's address. Audit only — nothing is emailed from here. */
  email: string;
  outcome: UserPushOutcome;
  /**
   * Devices STILL LIVE when the run finished, not when it started.
   *
   * Worth stating because the combination looks wrong at a glance: a report reading
   * `devices 0 · claimed 1 · pruned 1` is the correct description of an account whose only endpoint
   * had expired — it was loaded, tried, refused with a 410 and deleted, all within the run.
   * `subscriptions` on the run-level report is the count at load time, so the two deliberately
   * disagree after a prune.
   */
  devices: number;
  /** Events in the lead window and in a remindable tracker status. */
  due: number;
  /** Of those, ones a push `ReminderLog` row already covers. */
  alreadyLogged: number;
  /** Rows claimed in this run — one per notification. */
  claimed: number;
  /** Held back by a cap; a later run picks them up. */
  deferred: number;
  /** Rows a concurrent run claimed first. Non-zero means the unique index earned its keep. */
  raced: number;
  pushesSentToday: number;
  /** Device sends that the push service accepted. */
  delivered: number;
  /** Device sends that failed for a reason other than a dead endpoint. */
  deviceFailures: number;
  /** Endpoints deleted because the push service said 404/410 — they are gone for good. */
  pruned: number;
  error?: string;
}

export interface SendPushRemindersReport {
  notConfigured: string[];
  dryRun: boolean;
  usersWithSubscriptions: number;
  /** Devices LOADED across the run — counted before any pruning, unlike `UserPushReport.devices`. */
  subscriptions: number;
  notificationsSent: number;
  notificationsFailed: number;
  endpointsPruned: number;
  perUser: UserPushReport[];
}

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
 * Configure `web-push` lazily, exactly as `./email.ts` defers constructing the Resend client.
 *
 * `setVapidDetails` VALIDATES and THROWS — on a subject that is neither `mailto:` nor `https:`, and
 * on a key of the wrong length. At module scope that throw would crash the production build's
 * page-data collection for any route that transitively imports this file, for a feature that is
 * optional by design.
 */
let vapidReady = false;
function configureWebPush(): void {
  if (vapidReady) return;
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT as string,
    process.env.VAPID_PUBLIC_KEY as string,
    process.env.VAPID_PRIVATE_KEY as string
  );
  vapidReady = true;
}

/**
 * A dead endpoint, as opposed to a transient failure. Both are non-2xx; only these two are final.
 *
 * MEASURED, NOT ASSUMED — and the measurement matters. A well-formed aes128gcm POST to a
 * syntactically valid but nonexistent `fcm.googleapis.com/fcm/send/…` endpoint answers
 * **410 `push subscription has unsubscribed or expired.`**, NOT 404. So an implementation that
 * pruned on 404 alone would treat every dead Chrome endpoint as a transient failure, retry it every
 * morning forever, and leave the row in the database claiming a consent that no longer exists. 410
 * is the canonical spec answer; 404 is kept because it is what other services return and it costs
 * nothing.
 *
 * Everything else — 429, 5xx, a socket timeout — is transient and must NOT delete a row. A
 * threshold on `failureCount` would silently unsubscribe every device during one push-service
 * outage, which is why `failureCount` records and does not decide.
 */
function isGoneForever(status: number): boolean {
  return status === 404 || status === 410;
}

export interface DeviceSendResult {
  endpoint: string;
  ok: boolean;
  status?: number;
  /** The push service said this endpoint is gone; the row has been deleted. */
  gone?: boolean;
  error?: string;
}

/**
 * Send one payload to one device, and translate the outcome into a decision about the row.
 *
 * ── WHY `assertSafeUrl` IS CALLED HERE. ──────────────────────────────────────────────────────
 * `endpoint` is a URL the CALLER supplied to `POST /api/me/push`, and this function POSTs to it from
 * a cron runner with nobody watching — the same shape as the SSRF that `lib/security/safe-fetch.ts`
 * was written to close on `/api/scrape-url`. The structural half (https, no credentials, a real
 * dotted hostname, no IP literal) is already enforced at write time by
 * `validatePushSubscriptionInput`; what needs DNS is the remaining case, a public hostname that
 * RESOLVES to a private or metadata address. That is what this call adds.
 *
 * IT IS CHECK-THEN-USE AND SAYS SO. `web-push` makes its own `https.request`, so the connection
 * cannot be pinned to the address that was validated — a DNS record that answers differently between
 * the two is not defended against, exactly as `safe-fetch.ts`'s own header records for the same
 * reason. Stated rather than papered over: the residual exposure is a POST of an encrypted payload
 * with no response body read, which is a far smaller primitive than the proxy that module was
 * written for.
 *
 * A failed check is treated as a per-DEVICE failure, not a run failure. A transient DNS hiccup must
 * not abort everybody's reminders, and it must not delete a row either — nothing has been proven
 * about the subscription.
 */
async function sendToDevice(
  device: { endpoint: string; p256dh: string; auth: string },
  payload: string,
  topic: string
): Promise<DeviceSendResult> {
  try {
    await assertSafeUrl(device.endpoint);
  } catch (error) {
    return {
      endpoint: device.endpoint,
      ok: false,
      error: `endpoint failed the SSRF check: ${(error as Error).message}`.slice(0, 300),
    };
  }

  try {
    const result = await webpush.sendNotification(
      { endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } },
      payload,
      {
        // A reminder is worthless once the event has started, so there is no point in the push
        // service holding it for the default four weeks. Twelve hours comfortably covers a phone
        // that is off overnight and expires well before the next day's run.
        TTL: 12 * 3600,
        // `high` asks the service to wake the device rather than batch the message with the next
        // convenient wakeup. This is a time-sensitive notification; that is what the field is for.
        urgency: 'high',
        /*
         * Coalescing at the SERVICE, complementing the `tag` that coalesces at the notification
         * layer — two different places a repeat can stack up, and both have to be told. `topic`
         * replaces an UNDELIVERED message still queued for a phone that is off; `tag` replaces an
         * already-DISPLAYED notification on a phone that is on. Constrained by spec to at most 32
         * URL-safe base64 characters, which is why the caller passes the bare 24-char ObjectId hex
         * rather than the `pblr-event-…` tag.
         */
        topic,
      }
    );
    return { endpoint: device.endpoint, ok: true, status: result.statusCode };
  } catch (error) {
    if (error instanceof WebPushError) {
      return {
        endpoint: device.endpoint,
        ok: false,
        status: error.statusCode,
        gone: isGoneForever(error.statusCode),
        // The body is the push service's own wording, not ours, and is never shown to a user.
        error: `${error.statusCode} ${String(error.body ?? '').slice(0, 200)}`,
      };
    }
    return { endpoint: device.endpoint, ok: false, error: String((error as Error).message).slice(0, 300) };
  }
}

/**
 * Send the day's push reminders.
 *
 * Idempotent and safe to re-run: a second run in the same day finds every event already logged
 * under `PUSH_REMINDER_KIND` and sends nothing. Because that kind is distinct from the email one,
 * running this and `send-reminders.ts` on the same morning is correct and expected — they do not
 * suppress each other, and since the daily-cap query is scoped by kind they do not spend each
 * other's budget either.
 */
export async function sendPushReminders(
  options: SendPushRemindersOptions = {}
): Promise<SendPushRemindersReport> {
  const now = options.now ?? new Date();
  const dryRun = options.dryRun === true;
  const leadHours = options.leadHours ?? DEFAULT_LEAD_HOURS;
  const maxPushesPerDay = options.maxPushesPerDay ?? DEFAULT_MAX_PUSHES_PER_DAY;
  const maxEventsPerRun = options.maxEventsPerRun ?? DEFAULT_MAX_EVENTS_PER_PUSH_RUN;

  const report: SendPushRemindersReport = {
    notConfigured: [],
    dryRun,
    usersWithSubscriptions: 0,
    subscriptions: 0,
    notificationsSent: 0,
    notificationsFailed: 0,
    endpointsPruned: 0,
    perUser: [],
  };

  /*
   * PREFLIGHT. A dry run needs no credentials at all, which is what makes `--dry` usable on a laptop
   * that has never had VAPID keys — and what lets CI reason about the run without them.
   */
  if (!dryRun) {
    for (const name of REQUIRED_PUSH_ENV) {
      if (!process.env[name]) report.notConfigured.push(name);
    }
    if (report.notConfigured.length > 0) return report;
    configureWebPush();
  }

  await connectDB();

  /*
   * THE RECIPIENT LIST COMES FROM THE SUBSCRIPTION COLLECTION, NOT FROM `User`.
   *
   * This is the consent rule expressed as a query rather than as a check: a user with no row is not
   * skipped, they are never considered. It is also far leaner than the email path's "fetch every user
   * and decide in JS" — that shape exists there because consent needs two fields off the document,
   * and here it needs none.
   */
  const userIds = (await PushSubscription.distinct('userId')) as string[];

  /*
   * `--only` is by EMAIL because that is what an operator knows, and the id here is a Google `sub`.
   * Resolved once, up front, rather than inside the loop.
   */
  let allowedUserIds: Set<string> | null = null;
  if (options.onlyEmail) {
    const match = await User.findOne({ email: options.onlyEmail.toLowerCase() })
      .select('googleId')
      .lean();
    allowedUserIds = new Set(match?.googleId ? [String(match.googleId)] : []);
  }

  const targets = allowedUserIds ? userIds.filter(id => allowedUserIds.has(id)) : userIds;
  report.usersWithSubscriptions = targets.length;

  for (const userId of targets) {
    /*
     * The address is captured onto every `ReminderLog` row because `email` is `required` there and
     * the field means "the account this went to" — an audit row that cannot say which account it
     * belongs to is not an audit row. A push has no address of its own, so the account's is the
     * honest answer, and relaxing `required` on a shared model to accommodate this channel would
     * weaken the email path's audit guarantee for nothing.
     *
     * `ensureUser()` is deliberately NOT used: it CREATES a row, and a background sender must not
     * manufacture accounts. A missing `User` row is possible for a valid session (CLAUDE.md §9 — the
     * unique-email E11000 leaves none), so the fallback is the same `@placeholder.invalid` sentinel
     * `ensureUser` itself writes. It is never mailed; it exists so a valid subscription is never
     * dropped for want of a bookkeeping field.
     */
    const account = await User.findOne({ googleId: userId }).select('email').lean();
    const email = account?.email || `${userId}@placeholder.invalid`;

    const perUser: UserPushReport = {
      userId,
      email,
      outcome: 'nothing-due',
      devices: 0,
      due: 0,
      alreadyLogged: 0,
      claimed: 0,
      deferred: 0,
      raced: 0,
      pushesSentToday: 0,
      delivered: 0,
      deviceFailures: 0,
      pruned: 0,
    };

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

    if (options.retryFailed && !dryRun) {
      await ReminderLog.deleteMany({
        userId,
        kind: PUSH_REMINDER_KIND,
        eventId: { $in: dueIds },
        status: { $in: ['failed', 'pending'] },
      });
    }

    /*
     * A pre-read of the log, for the REPORT and to avoid pointless insert attempts. It is not the
     * guard — the guard is the unique index below, because between this read and that insert another
     * run can do the same thing. SCOPED BY `kind`, so an email already sent for an event does not
     * suppress the push for it: two channels, two at-most-once guarantees.
     */
    const logged = await ReminderLog.find({
      userId,
      kind: PUSH_REMINDER_KIND,
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
     * THE FREQUENCY CAP, AND `kind` IS THE WHOLE POINT OF THIS FILTER. Without it this count would
     * include the email channel's batches and every push would spend one of the two daily EMAIL
     * slots — which is the bug that was fixed in `reminders.ts` in the same change that added this
     * file. One batch per notification here (see below), so this counts notifications exactly.
     */
    const batchIds = await ReminderLog.distinct('batchId', {
      userId,
      kind: PUSH_REMINDER_KIND,
      sentAt: { $gte: istDayStart(now) },
    });
    perUser.pushesSentToday = batchIds.length;

    const capped = applyReminderCaps({
      candidates,
      emailsSentToday: batchIds.length,
      maxEmailsPerDay: maxPushesPerDay,
      // Clamped to what is LEFT of the day, because for push the per-run and per-day limits are one
      // budget rather than two — see `pushEventsThisRun`, which owns that arithmetic.
      maxEventsPerEmail: pushEventsThisRun({
        pushesSentToday: batchIds.length,
        maxPushesPerDay,
        maxEventsPerRun,
      }),
    });
    perUser.deferred = capped.deferred.length;

    if (capped.send.length === 0) {
      perUser.outcome = capped.blockedBy === 'daily-cap' ? 'daily-cap' : 'nothing-due';
      report.perUser.push(perUser);
      continue;
    }

    /* ── Which devices? Loaded AFTER the cap, so a dry run needs no key material in memory. ── */
    const devices = dryRun
      ? await PushSubscription.find({ userId }).select('endpoint').lean()
      : await PushSubscription.find({ userId }).select('endpoint p256dh auth').lean();
    perUser.devices = devices.length;
    report.subscriptions += devices.length;

    if (dryRun) {
      perUser.outcome = 'dry-run';
      perUser.claimed = capped.send.length;
      report.perUser.push(perUser);
      continue;
    }

    if (devices.length === 0) {
      // `distinct` said this user had one. A race with `DELETE /api/me/push` is the ordinary cause,
      // and it is not an error — the user turned notifications off between the two queries.
      perUser.outcome = 'no-subscription';
      report.perUser.push(perUser);
      continue;
    }

    let anySent = false;
    let anyFailed = false;

    for (const event of capped.send) {
      /*
       * ONE `batchId` PER NOTIFICATION, WHERE THE EMAIL PATH USES ONE PER MESSAGE — and it is the
       * same rule, not a different one. `batchId` exists so the frequency cap counts what a
       * recipient would count. An email covering three events is one thing in an inbox, so it is one
       * batch; a push is about ONE event, so three events is three notifications and three batches.
       * Identical reasoning, opposite arithmetic, because the unit of delivery differs.
       */
      const batchId = crypto.randomUUID();

      /* ── CLAIM FIRST. A duplicate key means a concurrent run beat us to this event. ── */
      try {
        await ReminderLog.create({
          userId,
          eventId: event._id,
          kind: PUSH_REMINDER_KIND,
          batchId,
          email,
          eventTitle: event.title,
          eventStartDateTime: event.startDateTime,
          status: 'pending',
          sentAt: now,
        });
      } catch (error) {
        if (isDuplicateKey(error)) {
          perUser.raced += 1;
          continue;
        }
        throw error;
      }
      perUser.claimed += 1;

      const view: ReminderEventView = {
        id: String(event._id),
        title: event.title ?? 'A saved event',
        startDateTime: event.startDateTime as Date,
        venue: event.venue ?? null,
        area: event.area ?? null,
        city: event.city ?? null,
        format: event.format ?? null,
        applyLink: event.applyLink ?? null,
      };
      const payload = JSON.stringify(formatPushPayload(view, now));

      /* ── FAN OUT. One event, every device this account has agreed on. ── */
      const results = await Promise.all(
        devices.map(device =>
          sendToDevice(
            {
              endpoint: String(device.endpoint),
              p256dh: String(device.p256dh),
              auth: String(device.auth),
            },
            payload,
            // The bare ObjectId hex: 24 chars, inside the spec's 32-char URL-safe limit.
            String(event._id)
          )
        )
      );

      const goneEndpoints = results.filter(r => r.gone).map(r => r.endpoint);
      if (goneEndpoints.length > 0) {
        /*
         * A HARD DELETE, deliberately — the opposite of the soft delete events get. A stale event row
         * is a listing nobody clicks; a stale push endpoint is a row the sender retries forever, and
         * 410 is the push service telling us definitively that the user withdrew it. Keeping it would
         * mean holding a consent record for consent that has been revoked.
         */
        const removed = await PushSubscription.deleteMany({ endpoint: { $in: goneEndpoints } });
        perUser.pruned += removed.deletedCount ?? 0;
        report.endpointsPruned += removed.deletedCount ?? 0;
      }

      const liveFailures = results.filter(r => !r.ok && !r.gone);
      const okResults = results.filter(r => r.ok);
      perUser.delivered += okResults.length;
      perUser.deviceFailures += liveFailures.length;

      if (liveFailures.length > 0) {
        await PushSubscription.updateMany(
          { endpoint: { $in: liveFailures.map(r => r.endpoint) } },
          { $inc: { failureCount: 1 } }
        );
      }
      if (okResults.length > 0) {
        await PushSubscription.updateMany(
          { endpoint: { $in: okResults.map(r => r.endpoint) } },
          { $set: { lastSeenAt: new Date(), failureCount: 0 } }
        );
      }

      /*
       * THE ROW'S VERDICT IS "DID THIS REMINDER REACH THIS PERSON AT ALL", not per device. One
       * accepted endpoint is a delivered reminder; every endpoint failing is a failed one. The rows
       * of a failed send STAY, marked failed, for the reason `ReminderLog`'s header gives — a
       * client-side failure does not prove non-delivery, and re-sending on a false negative is the
       * duplicate this design refuses. `--retry-failed` is the deliberate way out.
       */
      if (okResults.length > 0) {
        await ReminderLog.updateMany({ userId, batchId }, { $set: { status: 'sent' } });
        report.notificationsSent += 1;
        anySent = true;
      } else {
        const firstError = results.find(r => r.error)?.error ?? 'unknown';
        await ReminderLog.updateMany(
          { userId, batchId },
          { $set: { status: 'failed', error: firstError.slice(0, 500) } }
        );
        report.notificationsFailed += 1;
        anyFailed = true;
        perUser.error = perUser.error ?? firstError;
      }

      // Devices pruned mid-loop must not be retried for the next event in the same run.
      if (goneEndpoints.length > 0) {
        const gone = new Set(goneEndpoints);
        for (let i = devices.length - 1; i >= 0; i -= 1) {
          if (gone.has(String(devices[i].endpoint))) devices.splice(i, 1);
        }
        perUser.devices = devices.length;
        if (devices.length === 0) break;
      }
    }

    if (perUser.claimed === 0) perUser.outcome = 'already-sent';
    else if (anySent && anyFailed) perUser.outcome = 'partial';
    else if (anySent) perUser.outcome = 'sent';
    else if (anyFailed) perUser.outcome = 'failed';

    report.perUser.push(perUser);
  }

  return report;
}
