/**
 * The morning-after follow-up nudge: the DB and provider half. Every rule lives in
 * `./followup-nudge-policy.ts` and is unit-tested there; this file loads rows, asks the policy, claims
 * `ReminderLog` rows and sends. Kept as thin as `./push.ts`, whose device plumbing it reuses rather
 * than copies — `sendToDevice` (SSRF check, sanitised errors), `pruneGoneEndpoints` (410 = consent
 * withdrawn) and `configureWebPush` are the one definition of how this app talks to a push service.
 *
 * THE ORDER IS `./push.ts`'s ORDER, and for the same reason:
 *
 *   1. refuse to run without VAPID credentials (a dry run needs none)
 *   2. consider only users with a `PushSubscription` row — consent is structural
 *   3. CLAIM a `ReminderLog` row per subject under `FOLLOWUP_NUDGE_KIND` — the unique index
 *      `{ userId, eventId, kind }` is the double-send guard, so a re-run or a retried Action finds the
 *      row and sends nothing
 *   4. only then send, to every device the account has
 *   5. record the verdict on the row already claimed; a failure is NOT retried automatically
 *
 * IT RUNS AFTER THE REMINDER PASS, in the same process (`scripts/send-push-reminders.ts`). The two
 * share one daily budget per phone (`PUSH_CHANNEL_KINDS`), and a reminder about tonight's event is
 * more time-sensitive than a nudge about last night's, so reminders spend it first.
 */
import crypto from 'crypto';
import mongoose from 'mongoose';
import connectDB from '../mongodb';
import Contact from '../models/Contact';
import Event from '../models/Event';
import Folder from '../models/Folder';
import PushSubscription from '../models/PushSubscription';
import ReminderLog from '../models/ReminderLog';
import User from '../models/User';
import {
  configureWebPush,
  pruneGoneEndpoints,
  REQUIRED_PUSH_ENV,
  sendToDevice,
} from './push';
import {
  DEFAULT_MAX_FOLLOWUP_NUDGES_PER_RUN,
  followUpCandidates,
  followUpNudgesEnabled,
  followUpNudgeTopic,
  formatFollowUpNudgePayload,
  planFollowUpNudges,
  type FollowUpNudge,
  type FollowUpPlanOutcome,
  type NudgeContactRow,
  type NudgeEventRow,
  type NudgeFolderRow,
} from './followup-nudge-policy';
import {
  DEFAULT_MAX_PUSHES_PER_DAY,
  FOLLOWUP_NUDGE_KIND,
  istDayStart,
  PUSH_CHANNEL_KINDS,
} from './reminder-policy';

/**
 * How far back a folder's date may be and still matter. Only YESTERDAY qualifies; the width is for a
 * linked folder, whose `eventDate` is the event's START, so a multi-day event that ended yesterday has
 * a folder dated days earlier. `SPAN_FLOOR_DAYS` (§7) is 14; 40 is comfortably past it. The policy,
 * not this bound, decides — this only keeps the read from growing with a user's whole history.
 */
const FOLDER_LOOKBACK_DAYS = 40;

export interface SendFollowUpNudgesOptions {
  now?: Date;
  /** Decide and report, write nothing, send nothing, load no key material. */
  dryRun?: boolean;
  maxPushesPerDay?: number;
  maxNudgesPerRun?: number;
  /** Operator-only: free this user's failed/pending follow-up rows for today's candidates. */
  retryFailed?: boolean;
  /** Restrict to one account, by email. */
  onlyEmail?: string;
}

export type UserNudgeOutcome = FollowUpPlanOutcome | 'sent' | 'failed' | 'partial' | 'dry-run';

export interface NudgeSummary {
  title: string;
  metCount: number;
  pendingCount: number;
}

export interface UserNudgeReport {
  userId: string;
  email: string;
  outcome: UserNudgeOutcome;
  devices: number;
  candidates: number;
  alreadyLogged: number;
  claimed: number;
  deferred: number;
  raced: number;
  pushesSentToday: number;
  delivered: number;
  deviceFailures: number;
  pruned: number;
  /** What was (or in a dry run, would be) sent. Titles and counts only — never a contact. */
  nudges: NudgeSummary[];
  error?: string;
}

export interface SendFollowUpNudgesReport {
  notConfigured: string[];
  dryRun: boolean;
  usersWithSubscriptions: number;
  optedOut: number;
  notificationsSent: number;
  notificationsFailed: number;
  endpointsPruned: number;
  perUser: UserNudgeReport[];
}

function isDuplicateKey(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: number }).code === 11000);
}

const summary = (nudge: FollowUpNudge): NudgeSummary => ({
  title: nudge.title,
  metCount: nudge.metCount,
  pendingCount: nudge.pendingCount,
});

/**
 * Everything the policy needs for one user, read with `userId` in EVERY filter.
 *
 * Exported so `scripts/diag-followup-nudge.ts` runs exactly the loader the sender runs — a diagnostic
 * with its own queries would measure a second definition of "who qualifies".
 */
export async function loadNudgeRows(userId: string, now: Date) {
  const since = new Date(now.getTime() - FOLDER_LOOKBACK_DAYS * 24 * 3600_000);

  const folderDocs = await Folder.find({
    userId,
    // `null` matches both an absent field and an explicit null, which is how unarchiving can leave it.
    archivedAt: null,
    $or: [{ eventDate: { $gte: since } }, { eventDate: null, eventId: { $ne: null } }],
  })
    .select('userId name eventId eventDate archivedAt createdAt')
    .lean();

  const folders: NudgeFolderRow[] = folderDocs.map(doc => ({
    id: String(doc._id),
    userId: String(doc.userId),
    name: String(doc.name ?? ''),
    eventId: doc.eventId ? String(doc.eventId) : null,
    eventDate: doc.eventDate ?? null,
    archivedAt: doc.archivedAt ?? null,
    createdAt: doc.createdAt ?? null,
  }));

  const eventIds = [...new Set(folders.map(f => f.eventId).filter((id): id is string => Boolean(id)))];
  const eventDocs = eventIds.length
    ? await Event.find({ _id: { $in: eventIds } }).select('startDateTime endDateTime').lean()
    : [];
  const events: NudgeEventRow[] = eventDocs.map(doc => ({
    id: String(doc._id),
    startDateTime: doc.startDateTime ?? null,
    endDateTime: doc.endDateTime ?? null,
  }));

  const contactDocs = folders.length
    ? await Contact.find({ userId, folderId: { $in: folders.map(f => f.id) } })
        // Counting only. No name, note or channel is read into this process at all.
        .select('userId folderId followedUp')
        .lean()
    : [];
  const contacts: NudgeContactRow[] = contactDocs.map(doc => ({
    userId: String(doc.userId),
    folderId: String(doc.folderId),
    followedUp: doc.followedUp === true,
  }));

  return { folders, events, contacts };
}

export async function sendFollowUpNudges(
  options: SendFollowUpNudgesOptions = {}
): Promise<SendFollowUpNudgesReport> {
  const now = options.now ?? new Date();
  const dryRun = options.dryRun === true;
  const maxPushesPerDay = options.maxPushesPerDay ?? DEFAULT_MAX_PUSHES_PER_DAY;
  const maxNudgesPerRun = options.maxNudgesPerRun ?? DEFAULT_MAX_FOLLOWUP_NUDGES_PER_RUN;

  const report: SendFollowUpNudgesReport = {
    notConfigured: [],
    dryRun,
    usersWithSubscriptions: 0,
    optedOut: 0,
    notificationsSent: 0,
    notificationsFailed: 0,
    endpointsPruned: 0,
    perUser: [],
  };

  if (!dryRun) {
    for (const name of REQUIRED_PUSH_ENV) {
      if (!process.env[name]) report.notConfigured.push(name);
    }
    if (report.notConfigured.length > 0) return report;
    configureWebPush();
  }

  await connectDB();

  // Consent as a query: a user with no subscription row is never considered.
  const userIds = (await PushSubscription.distinct('userId')) as string[];

  let targets = userIds;
  if (options.onlyEmail) {
    const match = await User.findOne({ email: options.onlyEmail.toLowerCase() }).select('googleId').lean();
    const allowed = match?.googleId ? String(match.googleId) : null;
    targets = userIds.filter(id => id === allowed);
  }
  report.usersWithSubscriptions = targets.length;

  for (const userId of targets) {
    // `email` because `ReminderLog.email` is required — the same placeholder `./push.ts` records.
    const account = await User.findOne({ googleId: userId }).select('email pushFollowUpNudges').lean();
    const email = account?.email || `${userId}@placeholder.invalid`;

    const perUser: UserNudgeReport = {
      userId,
      email,
      outcome: 'nothing-due',
      devices: 0,
      candidates: 0,
      alreadyLogged: 0,
      claimed: 0,
      deferred: 0,
      raced: 0,
      pushesSentToday: 0,
      delivered: 0,
      deviceFailures: 0,
      pruned: 0,
      nudges: [],
    };

    const preference = { pushFollowUpNudges: account?.pushFollowUpNudges };

    // Opt-out is decided before any of this user's folders or contacts are read.
    if (!followUpNudgesEnabled(preference)) {
      perUser.outcome = 'opted-out';
      report.optedOut += 1;
      report.perUser.push(perUser);
      continue;
    }

    const rows = await loadNudgeRows(userId, now);
    const candidates = followUpCandidates({ userId, now, ...rows });
    perUser.candidates = candidates.length;
    if (candidates.length === 0) {
      report.perUser.push(perUser);
      continue;
    }
    const subjectIds = candidates.map(c => c.subjectId);

    if (options.retryFailed && !dryRun) {
      await ReminderLog.deleteMany({
        userId,
        kind: FOLLOWUP_NUDGE_KIND,
        eventId: { $in: subjectIds },
        status: { $in: ['failed', 'pending'] },
      });
    }

    // A pre-read for the report. The guard is the unique index at claim time.
    const logged = await ReminderLog.find({ userId, kind: FOLLOWUP_NUDGE_KIND, eventId: { $in: subjectIds } })
      .select('eventId')
      .lean();

    // EVERY push kind, since IST midnight: the reminder pass that ran a moment ago spends this budget.
    const batchIds = await ReminderLog.distinct('batchId', {
      userId,
      kind: { $in: [...PUSH_CHANNEL_KINDS] },
      sentAt: { $gte: istDayStart(now) },
    });
    perUser.pushesSentToday = batchIds.length;

    const plan = planFollowUpNudges({
      userId,
      now,
      hasSubscription: true,
      preference,
      ...rows,
      claimedSubjectIds: logged.map(row => String(row.eventId)),
      pushesSentToday: batchIds.length,
      maxPushesPerDay,
      maxNudgesPerRun,
    });
    perUser.alreadyLogged = plan.alreadyClaimed;
    perUser.deferred = plan.deferred.length;

    if (plan.outcome !== 'send') {
      perUser.outcome = plan.outcome;
      report.perUser.push(perUser);
      continue;
    }

    const devices = dryRun
      ? await PushSubscription.find({ userId }).select('endpoint').lean()
      : await PushSubscription.find({ userId }).select('endpoint p256dh auth').lean();
    perUser.devices = devices.length;

    if (dryRun) {
      perUser.outcome = 'dry-run';
      perUser.claimed = plan.send.length;
      perUser.nudges = plan.send.map(summary);
      report.perUser.push(perUser);
      continue;
    }
    if (devices.length === 0) {
      perUser.outcome = 'no-subscription';
      report.perUser.push(perUser);
      continue;
    }

    let anySent = false;
    let anyFailed = false;

    for (const nudge of plan.send) {
      const batchId = crypto.randomUUID();
      try {
        await ReminderLog.create({
          userId,
          eventId: new mongoose.Types.ObjectId(nudge.subjectId),
          kind: FOLLOWUP_NUDGE_KIND,
          batchId,
          email,
          // The user's own folder name, and when it ended. No contact is recorded on this row.
          eventTitle: nudge.title,
          eventStartDateTime: nudge.endedAt,
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
      perUser.nudges.push(summary(nudge));

      const payload = JSON.stringify(formatFollowUpNudgePayload(nudge));
      const results = await Promise.all(
        devices.map(device =>
          sendToDevice(
            { endpoint: String(device.endpoint), p256dh: String(device.p256dh), auth: String(device.auth) },
            payload,
            followUpNudgeTopic(nudge.subjectId)
          )
        )
      );

      const goneEndpoints = results.filter(r => r.gone).map(r => r.endpoint);
      const prunedNow = await pruneGoneEndpoints(results);
      perUser.pruned += prunedNow;
      report.endpointsPruned += prunedNow;

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
