import {
  getNewEventsSince,
  getEventsWithDeadlineSoon,
  getUnhealthySources,
  UnhealthySource,
} from '../scrapers/ingestion';
import type { PipelineStage } from 'mongoose';
import connectDB from '../mongodb';
import TrackerEntry from '../models/TrackerEntry';
import Event, { IEvent } from '../models/Event';
import User from '../models/User';
import DigestLog from '../models/DigestLog';
import { getPendingFollowUps, type PendingFollowUp } from '../helpers/phase6';
import { buildEventFilter, buildForYouPipeline, buildSort, FEED_SELECT } from '../events/query';
import { readPreferences } from '../events/relevance';
import { toFeedEvents } from '../events/serialize';
import type { FeedEvent } from '../event-types';
import { sendDigestEmail } from './email';
import type { UserPreferencesLike } from './reminder-policy';
import {
  applyDigestCap,
  buildDigestUnsubscribeUrl,
  digestDecision,
  digestWindow,
  DIGEST_EVENT_COUNT,
  DIGEST_KIND,
  formatDigestEmail,
  istDayStart,
  WEEKLY_WINDOW_DAYS,
  type DigestEventView,
  type DigestFrequency,
} from './digest-schedule';
// Dates in an email MUST go through here. This digest is sent by a GitHub Actions runner in
// UTC at 8 AM IST (02:30 UTC), so `toLocaleDateString()` on the ambient locale reports the
// PREVIOUS day. lib/format.ts is pinned to Asia/Kolkata.
import { dayLabelIST, fullDateIST } from '../format';
import { escapeHtml } from './html';

/** A tracker entry with its event populated, as the digest queries it. */
interface DigestTrackerEntry {
  status: string;
  notes?: string;
  updatedAt?: Date | string;
  eventId: { title: string };
}

// Base URL for links in the digest. In production this must be the deployed
// origin (set NEXTAUTH_URL); falls back to localhost for local runs.
const APP_URL = (process.env.NEXTAUTH_URL || 'http://localhost:3000').replace(/\/$/, '');

export interface DigestData {
  newEvents: IEvent[];
  upcomingDeadlines: IEvent[];
  trackerUpdates: DigestTrackerEntry[];
  /**
   * People who need following up — overdue, plus the next three days.
   *
   * Now a unified `PendingFollowUp[]` from `lib/helpers/phase6.ts` rather than a list of
   * TrackerEntry documents, so it covers BOTH the `Contact` collection and the legacy
   * `TrackerEntry.connections[]` subdocuments in one shape.
   *
   * The query it replaces had three defects: it lacked `$elemMatch`, so two DIFFERENT array
   * elements could each satisfy one bound and an entry matched with nothing actually in window;
   * it did not filter `followedUp`, so completed items were re-emailed forever; and its window
   * was future-only, so an OVERDUE follow-up reached the dashboard but never the inbox.
   */
  followUpReminders: PendingFollowUp[];
  unhealthySources: UnhealthySource[];
}

/**
 * Generate daily digest data.
 *
 * `userId` SCOPES THE PERSONAL HALF and is required. Both TrackerEntry queries below
 * previously ran with no user predicate, so the digest returned every user's tracked
 * events, their contacts' names, companies and roles, and the user's private notes —
 * and `GET /api/notifications/send-digest` served that object to anonymous callers.
 * The event half (new events, deadlines, source health) is global by nature and stays
 * global.
 *
 * Typed as required rather than optional on purpose: an optional parameter would let a
 * caller silently reintroduce the leak by forgetting it, and TypeScript would say
 * nothing.
 */
export async function generateDailyDigest(userId: string): Promise<DigestData> {
  await connectDB();

  if (!userId) throw new Error('generateDailyDigest requires a userId');

  /*
   * BOTH EVENT QUERIES ARE SCOPED TO THIS USER'S VIEW, and that is not cosmetic. They used to be
   * unscoped `Event.find()` calls, so this function — served to any signed-in caller by
   * `GET /api/notifications/send-digest` — returned every event ANY user had created in the last
   * 24 hours, including ones marked `private` and submissions still `pending` review.
   *
   * The tracker queries below were scoped from the start; the event queries were the half nobody
   * revisited when §12 introduced `visibility`.
   */
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const newEvents = await getNewEventsSince(userId, yesterday);

  // Get events with registration deadline in next 3 days
  const upcomingDeadlines = await getEventsWithDeadlineSoon(userId, 3);

  // Get THIS USER'S tracker entries updated in last 24 hours
  const trackerUpdates = await TrackerEntry.find({
    userId,
    updatedAt: { $gte: yesterday },
  })
    .populate('eventId')
    .sort({ updatedAt: -1 })
    .lean();

  // People to follow up with: overdue AND the next three days, from both stores. One call, so
  // the dashboard and the inbox can no longer disagree about what "due" means.
  const followUpReminders = await getPendingFollowUps(userId, { includeUpcomingDays: 3 });

  // Sources that have gone quiet or errored — so scraper breakage is visible
  // instead of silently shrinking the event feed.
  const unhealthySources = await getUnhealthySources();

  return {
    newEvents,
    upcomingDeadlines,
    // Both queries .populate('eventId'), so at runtime eventId is the full event
    // document even though the schema types the field as an ObjectId reference.
    trackerUpdates: trackerUpdates as unknown as DigestTrackerEntry[],
    followUpReminders,
    unhealthySources,
  };
}

/**
 * Format digest as plain text (for email)
 */
export function formatDigestAsText(digest: DigestData): string {
  const lines: string[] = [];

  lines.push('═══════════════════════════════════════════');
  lines.push('PulseBLR Daily Digest');
  lines.push(fullDateIST(new Date()));
  lines.push('═══════════════════════════════════════════');
  lines.push('');

  // New Events
  if (digest.newEvents.length > 0) {
    lines.push(`🆕 NEW EVENTS (${digest.newEvents.length})`);
    lines.push('─'.repeat(47));
    
    // Group by category
    const byCategory: Record<string, IEvent[]> = {};
    digest.newEvents.forEach(event => {
      event.category.forEach((cat: string) => {
        if (!byCategory[cat]) byCategory[cat] = [];
        byCategory[cat].push(event);
      });
    });

    Object.entries(byCategory).forEach(([category, events]) => {
      lines.push(`\n${category}:`);
      events.forEach(event => {
        const date = dayLabelIST(event.startDateTime);
        const location = event.format === 'online' ? '🌐 Online' : 
                        event.area ? `📍 ${event.area}` : '📍 Bangalore';
        const food = event.hasFood === 'yes' ? ' 🍕' : '';
        lines.push(`  • ${event.title}`);
        lines.push(`    ${date} • ${location}${food}`);
      });
    });
    lines.push('');
  }

  // Upcoming Deadlines
  if (digest.upcomingDeadlines.length > 0) {
    lines.push(`⏰ REGISTRATION DEADLINES (${digest.upcomingDeadlines.length})`);
    lines.push('─'.repeat(47));
    digest.upcomingDeadlines.forEach(event => {
      // The query filters on registrationDeadline existing, so this is always set.
      const deadline = dayLabelIST(event.registrationDeadline!);
      lines.push(`  • ${event.title}`);
      lines.push(`    Deadline: ${deadline}`);
    });
    lines.push('');
  }

  // Tracker Updates
  if (digest.trackerUpdates.length > 0) {
    lines.push(`📊 YOUR TRACKER UPDATES (${digest.trackerUpdates.length})`);
    lines.push('─'.repeat(47));
    digest.trackerUpdates.forEach((entry: DigestTrackerEntry) => {
      lines.push(`  • ${entry.eventId.title}`);
      lines.push(`    Status: ${entry.status}`);
      if (entry.notes) {
        lines.push(`    Note: ${entry.notes.substring(0, 60)}...`);
      }
    });
    lines.push('');
  }

  // Follow-up Reminders
  if (digest.followUpReminders.length > 0) {
    lines.push(`👥 PEOPLE TO FOLLOW UP (${digest.followUpReminders.length})`);
    lines.push('─'.repeat(47));
    digest.followUpReminders.forEach(followUp => {
      const where = followUp.eventTitle ? ` (${followUp.eventTitle})` : '';
      lines.push(`  • ${followUp.connection.name}${where}${followUp.overdue ? '  ← OVERDUE' : ''}`);
      if (followUp.connection.company) lines.push(`    ${followUp.connection.company}`);
      if (followUp.connection.context) {
        lines.push(`    ${followUp.connection.context.substring(0, 80)}`);
      }
      // IST, via lib/format.ts. A UTC GitHub Actions runner formatting with the ambient locale
      // puts this on the wrong day — the digest is sent at 8 AM IST, i.e. 02:30 UTC.
      lines.push(`    Follow up: ${dayLabelIST(followUp.connection.followUpAt)}`);
      if (followUp.connection.linkedin) lines.push(`    ${followUp.connection.linkedin}`);
    });
    lines.push('');
  }

  // Source Health Alerts (only shown when something is wrong)
  if (digest.unhealthySources.length > 0) {
    lines.push(`⚠️  SOURCE HEALTH (${digest.unhealthySources.length})`);
    lines.push('─'.repeat(47));
    digest.unhealthySources.forEach((source: UnhealthySource) => {
      const reason = source.lastError
        ? `error: ${String(source.lastError).substring(0, 80)}`
        : `${source.consecutiveEmptyScrapes} empty scrapes in a row`;
      lines.push(`  • ${source.name}`);
      lines.push(`    ${reason}`);
    });
    lines.push('');
  }

  // Footer
  lines.push('─'.repeat(47));
  lines.push(`View full details: ${APP_URL}`);
  lines.push(`Manage tracker: ${APP_URL}/tracker`);
  lines.push('');

  return lines.join('\n');
}

/**
 * Format digest as HTML (for rich email)
 */
export function formatDigestAsHTML(digest: DigestData): string {
  const html: string[] = [];

  html.push(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; border-radius: 10px; margin-bottom: 30px; }
    .header h1 { margin: 0; font-size: 28px; }
    .header p { margin: 5px 0 0 0; opacity: 0.9; }
    .section { margin-bottom: 30px; }
    .section-title { font-size: 18px; font-weight: 600; color: #667eea; margin-bottom: 15px; border-bottom: 2px solid #667eea; padding-bottom: 5px; }
    .event-card { background: #f7fafc; border-left: 4px solid #667eea; padding: 15px; margin-bottom: 15px; border-radius: 5px; }
    .event-title { font-weight: 600; color: #2d3748; margin-bottom: 5px; }
    .event-meta { font-size: 14px; color: #718096; }
    .category-group { margin-bottom: 20px; }
    .category-name { font-weight: 600; color: #4a5568; margin-bottom: 10px; }
    .footer { text-align: center; padding: 20px; color: #718096; font-size: 14px; border-top: 1px solid #e2e8f0; margin-top: 30px; }
    .button { display: inline-block; background: #667eea; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; margin: 10px 5px; }
  </style>
</head>
<body>
  <div class="header">
    <h1>🎯 PulseBLR Daily Digest</h1>
    <p>${escapeHtml(fullDateIST(new Date()))}</p>
  </div>
`);

  // New Events
  if (digest.newEvents.length > 0) {
    html.push(`
  <div class="section">
    <div class="section-title">🆕 New Events (${digest.newEvents.length})</div>
`);

    const byCategory: Record<string, IEvent[]> = {};
    digest.newEvents.forEach(event => {
      event.category.forEach((cat: string) => {
        if (!byCategory[cat]) byCategory[cat] = [];
        byCategory[cat].push(event);
      });
    });

    Object.entries(byCategory).forEach(([category, events]) => {
      html.push(`<div class="category-group"><div class="category-name">${category}</div>`);
      events.forEach(event => {
        const date = dayLabelIST(event.startDateTime);
        const location = event.format === 'online' ? '🌐 Online' : event.area ? `📍 ${event.area}` : '📍 Bangalore';
        const food = event.hasFood === 'yes' ? ' 🍕' : '';
        html.push(`
        <div class="event-card">
          <div class="event-title">${event.title}</div>
          <div class="event-meta">${date} • ${location}${food}</div>
        </div>
`);
      });
      html.push(`</div>`);
    });

    html.push(`</div>`);
  }

  // Upcoming Deadlines
  if (digest.upcomingDeadlines.length > 0) {
    html.push(`
  <div class="section">
    <div class="section-title">⏰ Registration Deadlines (${digest.upcomingDeadlines.length})</div>
`);
    digest.upcomingDeadlines.forEach(event => {
      // The query filters on registrationDeadline existing, so this is always set.
      const deadline = dayLabelIST(event.registrationDeadline!);
      html.push(`
    <div class="event-card">
      <div class="event-title">${event.title}</div>
      <div class="event-meta">Deadline: ${deadline}</div>
    </div>
`);
    });
    html.push(`</div>`);
  }

  /**
   * People to follow up.
   *
   * THIS SECTION WAS MISSING ENTIRELY. `email.ts`'s `hasContent` counted
   * `followUpReminders.length` when deciding whether to send, while this formatter rendered
   * nothing for it — so a digest whose only content was follow-ups sent an effectively empty
   * email. Adding the data was not enough; the section had to exist.
   *
   * EVERY value here is escaped. Names, companies and "how we met" notes originate in a QR code
   * somebody else generated or in free text, and they are interpolated straight into HTML.
   */
  if (digest.followUpReminders.length > 0) {
    html.push(`
  <div class="section">
    <div class="section-title">👥 People to follow up (${digest.followUpReminders.length})</div>
`);
    digest.followUpReminders.forEach(followUp => {
      const meta = [
        followUp.connection.company,
        followUp.eventTitle,
        `follow up ${dayLabelIST(followUp.connection.followUpAt)}`,
      ]
        .filter(Boolean)
        .map(part => escapeHtml(String(part)))
        .join(' · ');

      const overdue = followUp.overdue
        ? ' style="border-left-color: #dd6b20; background: #fffaf0;"'
        : '';

      html.push(`
    <div class="event-card"${overdue}>
      <div class="event-title">${escapeHtml(followUp.connection.name)}${
        followUp.overdue ? ' — overdue' : ''
      }</div>
      <div class="event-meta">${meta}</div>${
        followUp.connection.context
          ? `\n      <div class="event-meta">${escapeHtml(
              followUp.connection.context.substring(0, 140)
            )}</div>`
          : ''
      }${
        followUp.connection.linkedin
          ? `\n      <div class="event-meta"><a href="${escapeHtml(
              followUp.connection.linkedin
            )}">Open LinkedIn</a></div>`
          : ''
      }
    </div>
`);
    });
    html.push(`</div>`);
  }

  // Source Health Alerts (only rendered when something is wrong)
  if (digest.unhealthySources.length > 0) {
    html.push(`
  <div class="section">
    <div class="section-title" style="color: #c05621; border-bottom-color: #c05621;">⚠️ Source Health (${digest.unhealthySources.length})</div>
`);
    digest.unhealthySources.forEach((source: UnhealthySource) => {
      const reason = source.lastError
        ? `Error: ${escapeHtml(String(source.lastError).substring(0, 120))}`
        : `${source.consecutiveEmptyScrapes} empty scrapes in a row`;
      html.push(`
    <div class="event-card" style="border-left-color: #dd6b20; background: #fffaf0;">
      <div class="event-title">${escapeHtml(source.name)}</div>
      <div class="event-meta">${reason}</div>
    </div>
`);
    });
    html.push(`</div>`);
  }

  // Footer
  html.push(`
  <div class="footer">
    <a href="${APP_URL}" class="button">View All Events</a>
    <a href="${APP_URL}/tracker" class="button">Manage Tracker</a>
    <p>You're receiving this because you're using PulseBLR</p>
  </div>
</body>
</html>
`);

  return html.join('');
}

/**
 * Minimal HTML escaping for values interpolated into the digest email.
 *
 * MOVED to `./html` and re-exported here so every existing importer keeps working. It had to
 * move because `reminder-policy.ts` needs it and must stay free of mongoose — this file is
 * not (it imports `connectDB`, `TrackerEntry` and the phase6 helpers), so importing the
 * escaper from here would drag the entire model graph into a pure-function test.
 */
export { escapeHtml } from './html';

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE SCHEDULED, PREFERENCE-DRIVEN DIGEST — the DB and provider half.
 *
 * The rules live in `./digest-schedule.ts` and are unit-tested there; this is the part that cannot
 * be tested without a database, so it is kept thin and every decision it makes is delegated.
 *
 * WHAT WAS WRONG BEFORE. `DIGEST_FREQUENCIES` and `User.preferences.digestFrequency` existed and
 * NOTHING READ THEM. `scripts/send-digest.ts` resolved one hardcoded `USER_EMAIL`, built
 * `generateDailyDigest` for that one account and mailed it every single morning — so the preference
 * was a control with no wire behind it, and the cadence a user picked had no effect whatsoever.
 *
 * THE ORDERING BELOW IS NOT NEGOTIABLE, and it is the reminders stream's ordering on purpose:
 *
 *   1. refuse to run at all if the environment cannot produce a working unsubscribe link
 *   2. skip every user who has not been ASKED, and every user whose cadence says no or not-today
 *   3. CLAIM a `DigestLog` row for (user, kind, period) — the unique index is the double-send guard
 *   4. only then send
 *   5. record the provider's verdict against the row already claimed
 *
 * Step 3 before step 4 trades a possible missed digest for an impossible duplicate one. See the
 * header of `lib/models/DigestLog.ts`.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * Base URL for every link in the email, including the unsubscribe one.
 *
 * Reuses `APP_URL` above, which reads `NEXTAUTH_URL` — already required in production for auth to
 * work at all, so this does not invent a second variable that can disagree with it.
 */

/** A `User` row as the digest sender reads it. `preferences` may legitimately be absent. */
type DigestUserRow = UserPreferencesLike & {
  googleId?: string;
  email?: string;
  name?: string;
  targetCompanies?: string[];
};

export interface SendDigestOptions {
  /** Injectable clock, so a dry run can be reasoned about. Defaults to now. */
  now?: Date;
  /** Decide and report, write nothing, send nothing. */
  dryRun?: boolean;
  /** Restrict the run to one address. The safe way to try this against real data. */
  onlyEmail?: string;
  /** Events per email. Defaults to `DIGEST_EVENT_COUNT`. */
  maxEvents?: number;
  /** Digest emails per user per IST day. Defaults to `MAX_DIGESTS_PER_IST_DAY`. */
  maxPerDay?: number;
  /**
   * Delete this user's `failed`/`pending` row for the CURRENT period so it can be attempted again.
   * OPERATOR-ONLY and off by default — see `DigestLog`'s header for why an automatic retry would
   * reintroduce the double send.
   */
  retryFailed?: boolean;
}

export type DigestUserOutcome =
  | 'sent'
  | 'failed'
  | 'never-asked'
  | 'no-frequency'
  | 'off'
  | 'not-due'
  | 'nothing-to-say'
  | 'already-sent'
  | 'daily-cap'
  | 'no-email'
  | 'dry-run';

export interface DigestUserReport {
  userId: string;
  email: string;
  outcome: DigestUserOutcome;
  frequency: DigestFrequency | null;
  /** `weekly:<IST Monday>` / `daily:<IST day>`, when the user was due. */
  periodKey: string | null;
  /** Events that would go in the email. */
  events: number;
  /** Digest rows already written for this user since IST midnight. */
  sentToday: number;
  /** True when a concurrent run claimed this period first. The index earning its keep. */
  raced?: boolean;
  error?: string;
}

export interface SendDigestReport {
  /** Env vars that must be set before anything can be sent. Non-empty means nothing ran. */
  notConfigured: string[];
  dryRun: boolean;
  usersConsidered: number;
  /** Consented AND due today. */
  usersDue: number;
  /** Never shown the choice. Expected until onboarding has reached everybody. */
  neverAsked: number;
  /** Asked, and said `off`. */
  optedOut: number;
  /** Consented to a cadence whose day this is not — a weekly subscriber on a Tuesday. */
  notDue: number;
  emailsSent: number;
  emailsFailed: number;
  eventsMailed: number;
  perUser: DigestUserReport[];
}

function isDuplicateKey(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: number }).code === 11000);
}

/**
 * The events one digest talks about, ranked for THIS user.
 *
 * THROUGH `buildEventFilter`, NEVER A HAND-ROLLED `$match`. That function is the one definition of
 * "an event this viewer may see", and it is where `notDeletedClause()` and the three-armed
 * `visibilityClause` live — including the `{ visibility: { $exists: false } }` arm that admits the
 * ~1500 documents predating the field. Hand-rolling it here would either leak somebody else's
 * private submission into an email or, far more likely, silently mail an EMPTY digest forever.
 *
 * `viewerId` is the recipient's own id rather than `null`, because this is their feed: an event they
 * hand-entered themselves belongs in their own digest, and the visibility clause is what makes that
 * safe. There is no direction in which this can show them somebody else's private row.
 *
 * Ranked by `buildForYouPipeline`, i.e. `connectionScore × relevanceScore` — the same ranking the
 * default feed uses. `readPreferences()` IS correct here and deliberately so: this is RANKING, where
 * coercing an absent preference block into the defaults is the right behaviour (an unconfigured user
 * gets the unpersonalised ranking, not an empty digest). It is the CONSENT question that must never
 * go through it, and that question is answered by `digestDecision()` before this is ever called.
 */
async function selectDigestEvents(
  user: DigestUserRow,
  userId: string,
  frequency: DigestFrequency,
  now: Date,
  limit: number
): Promise<DigestEventView[]> {
  const window = digestWindow(frequency, now);
  const filter = buildEventFilter(
    { techOnly: true, from: window.from, to: window.to, includeOngoing: false },
    userId
  );

  /*
   * The cast is unavoidable and is confined to this line — the same one `app/api/events/route.ts`
   * carries, for the same reason. `buildForYouPipeline` lives in `lib/events/query.ts`, which
   * `app/page.tsx` imports, so that module must stay free of mongoose or its types would land in the
   * browser bundle. It therefore returns plain records, and mongoose's `PipelineStage` is a
   * discriminated union a plain record cannot structurally satisfy. The stages themselves are
   * asserted by `tests/relevance.test.ts`, which evaluates the expression they carry.
   */
  const docs = await Event.aggregate<Record<string, unknown>>(
    buildForYouPipeline(
      filter,
      {
        preferences: readPreferences(user.preferences),
        targetCompanies: user.targetCompanies ?? [],
      },
      { skip: 0, limit }
    ) as unknown as PipelineStage[]
  );

  return docs.map(toDigestEventView);
}

function toDigestEventView(doc: Record<string, unknown>): DigestEventView {
  return {
    id: String(doc._id),
    title: (doc.title as string) ?? 'An event in Bengaluru',
    startDateTime: doc.startDateTime as Date,
    venue: (doc.venue as string) ?? null,
    area: (doc.area as string) ?? null,
    city: (doc.city as string) ?? null,
    format: (doc.format as string) ?? null,
    organizer: (doc.organizer as string) ?? null,
    isFree: (doc.isFree as boolean) ?? null,
    applyLink: (doc.applyLink as string) ?? null,
  };
}

/**
 * Send today's digests, to exactly the people whose stored cadence says today.
 *
 * Idempotent and safe to re-run: a second run in the same period finds the row already claimed and
 * sends nothing. That property is what lets the workflow retry and lets an operator run it by hand
 * without checking first.
 */
export async function sendScheduledDigests(
  options: SendDigestOptions = {}
): Promise<SendDigestReport> {
  const now = options.now ?? new Date();
  const dryRun = options.dryRun === true;
  const maxEvents = options.maxEvents ?? DIGEST_EVENT_COUNT;

  const report: SendDigestReport = {
    notConfigured: [],
    dryRun,
    usersConsidered: 0,
    usersDue: 0,
    neverAsked: 0,
    optedOut: 0,
    notDue: 0,
    emailsSent: 0,
    emailsFailed: 0,
    eventsMailed: 0,
    perUser: [],
  };

  /*
   * PREFLIGHT, and `NEXTAUTH_SECRET` is in it for a reason that is easy to miss: it signs the
   * unsubscribe token. Without it `buildDigestUnsubscribeUrl` throws, and an email that reached an
   * inbox with no working way off the list is the failure this whole design is arranged to prevent.
   * Checked here, before a single row is claimed, rather than discovered per-user mid-run.
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
   * query — the same choice `reminders.ts` records and for the same reason. A
   * `{ 'preferences.digestFrequency': { $ne: 'off' } }` filter cannot express the other half of the
   * rule (`onboardedAt` being set), so a query-side filter plus a JS check means two definitions of
   * consent and whichever is stricter on the day decides. `digestDecision()` is the single
   * definition and it needs the document.
   *
   * Affordable because this is a per-user mailing, not a feed query: ten accounts today, and even at
   * a thousand this is one lean read per daily run. `select` keeps `card` (and its token) out of
   * memory.
   */
  const userFilter: Record<string, unknown> = {};
  if (options.onlyEmail) userFilter.email = options.onlyEmail.toLowerCase();

  const users = (await User.find(userFilter)
    .select('googleId email name preferences targetCompanies')
    .lean()) as unknown as DigestUserRow[];

  report.usersConsidered = users.length;

  for (const user of users) {
    const decision = digestDecision(user, now);

    if (decision.outcome !== 'due') {
      // Counted separately because they mean different things to an operator. "Never asked" is the
      // onboarding flow not having reached them; "off" is a decision this run must respect;
      // "not due" is a weekly subscriber on a Wednesday, i.e. the feature working.
      if (decision.outcome === 'never-asked' || decision.outcome === 'no-frequency') {
        report.neverAsked += 1;
      } else if (decision.outcome === 'off') {
        report.optedOut += 1;
      } else {
        report.notDue += 1;
      }
      report.perUser.push({
        userId: user.googleId ?? '',
        email: user.email ?? '',
        outcome: decision.outcome,
        frequency: decision.frequency,
        periodKey: null,
        events: 0,
        sentToday: 0,
      });
      continue;
    }

    report.usersDue += 1;

    const userId = user.googleId;
    const email = user.email;
    const frequency = decision.frequency as DigestFrequency;
    const periodKey = decision.periodKey as string;
    if (!userId) continue;

    const perUser: DigestUserReport = {
      userId,
      email: email ?? '',
      outcome: 'nothing-to-say',
      frequency,
      periodKey,
      events: 0,
      sentToday: 0,
    };

    if (!email) {
      // `User.email` is required by the schema, so this is defensive rather than expected.
      perUser.outcome = 'no-email';
      report.perUser.push(perUser);
      continue;
    }

    /*
     * An explicit, operator-invoked retry. The ONLY thing that frees a claimed row, and off by
     * default because "the send failed" cannot be established from this side: a timeout after Resend
     * accepted the message is indistinguishable from one before.
     */
    if (options.retryFailed && !dryRun) {
      await DigestLog.deleteMany({
        userId,
        kind: DIGEST_KIND,
        periodKey,
        status: { $in: ['failed', 'pending'] },
      });
    }

    /*
     * A pre-read, for the REPORT and to avoid a pointless insert attempt. It is NOT the guard — the
     * guard is the unique index below, because between this read and that insert another run can do
     * the same thing.
     */
    const existing = await DigestLog.findOne({ userId, kind: DIGEST_KIND, periodKey })
      .select('_id status')
      .lean();
    if (existing) {
      perUser.outcome = 'already-sent';
      report.perUser.push(perUser);
      continue;
    }

    /* The per-IST-day cap. Counts ROWS since IST midnight — one row is one email here, unlike
       `ReminderLog` where a batch of events shares one message and needs a `batchId`. */
    const sentToday = await DigestLog.countDocuments({
      userId,
      sentAt: { $gte: istDayStart(now) },
    });
    perUser.sentToday = sentToday;

    const cap = applyDigestCap({ digestsSentToday: sentToday, maxPerDay: options.maxPerDay });
    if (!cap.send) {
      perUser.outcome = 'daily-cap';
      report.perUser.push(perUser);
      continue;
    }

    const events = await selectDigestEvents(user, userId, frequency, now, maxEvents);
    perUser.events = events.length;

    /*
     * NOTHING TO SAY MEANS NOTHING IS SENT, and no row is claimed either.
     *
     * Not claiming is the deliberate half: an empty week is a supply state, not a send, so the
     * period must stay open in case a scrape later today finds something. The opposite — claiming a
     * row for an empty digest — would mean a quiet Monday morning permanently consumed that week's
     * one email.
     */
    if (events.length === 0) {
      perUser.outcome = 'nothing-to-say';
      report.perUser.push(perUser);
      continue;
    }

    if (dryRun) {
      perUser.outcome = 'dry-run';
      report.perUser.push(perUser);
      continue;
    }

    /* ── CLAIM FIRST. A duplicate key means a concurrent run beat us to this period. ── */
    let claimed = false;
    try {
      await DigestLog.create({
        userId,
        kind: DIGEST_KIND,
        periodKey,
        frequency,
        email,
        eventCount: events.length,
        eventIds: events.map(event => event.id),
        status: 'pending',
        sentAt: now,
      });
      claimed = true;
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      perUser.outcome = 'already-sent';
      perUser.raced = true;
      report.perUser.push(perUser);
    }
    if (!claimed) continue;

    const unsubscribeUrl = buildDigestUnsubscribeUrl(APP_URL, userId, secret);
    const { subject, html, text } = formatDigestEmail({
      events,
      frequency,
      unsubscribeUrl,
      appUrl: APP_URL,
      now,
    });

    const result = await sendDigestEmail({ to: email, subject, html, text, unsubscribeUrl });

    if (result.ok) {
      await DigestLog.updateOne(
        { userId, kind: DIGEST_KIND, periodKey },
        { $set: { status: 'sent', providerId: result.id } }
      );
      perUser.outcome = 'sent';
      report.emailsSent += 1;
      report.eventsMailed += events.length;
    } else {
      /*
       * The row STAYS, marked failed. Not deleted, because a failure reported here does not prove
       * the message was undelivered — and re-sending on a false negative is exactly the duplicate
       * this design refuses. `--retry-failed` is the deliberate way out.
       */
      await DigestLog.updateOne(
        { userId, kind: DIGEST_KIND, periodKey },
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
 * Turn this user's digest off. Backs `POST /api/digest/unsubscribe`.
 *
 * WRITES `preferences.digestFrequency = 'off'`, the path the schema actually declares. Mongoose's
 * default `strict: true` DROPS an update to an unknown path — no error, `modifiedCount: 0`, an
 * unsubscribe that reports success and changes nothing — so the path being the real one is
 * load-bearing rather than tidy.
 *
 * IT WRITES THAT ONE FIELD AND NOTHING ELSE. In particular it does not stamp `onboardedAt`:
 * consent already reads false the moment the cadence is `off`, so it would buy nothing, and that
 * field gates another stream's onboarding prompt (`null` is the only state that shows it), so
 * setting it here would silently suppress onboarding for anybody who taps unsubscribe. It also does
 * not touch `remindersEnabled` — a digest opt-out is not a reminder opt-out, which is precisely why
 * the two links carry differently-scoped tokens.
 *
 * Idempotent: unsubscribing twice is the same as once, which matters because a mail client may POST
 * the one-click URL more than once.
 *
 * Returns whether a user row matched, so the route can tell "done" from "that link points at
 * nobody" — while deliberately telling the READER the same thing either way.
 */
export async function disableDigestFor(userId: string): Promise<{ matched: boolean }> {
  await connectDB();
  const result = await User.updateOne(
    { googleId: userId },
    { $set: { 'preferences.digestFrequency': 'off' } }
  );
  return { matched: (result.matchedCount ?? 0) > 0 };
}

/* ── The public weekly summary behind `/digest` ─────────────────────────────── */

export interface PublicDigestWeek {
  /** Inclusive start of the window — right now, in practice. */
  from: Date;
  /** Exclusive end of the window. */
  to: Date;
  /** Total events a signed-out visitor can see in the window, NOT `events.length`. */
  total: number;
  /** Of those, how many are in person. */
  inPerson: number;
  /** Of those, how many are free. */
  free: number;
  /** The ranked highlights the page renders. */
  events: FeedEvent[];
}

/**
 * The week ahead, for the PUBLIC page — no user, no personalisation, nothing signed-in.
 *
 * `buildEventFilter(params, null)` with an explicit `null` viewer is the whole safety argument: the
 * anonymous visibility clause admits `visibility: 'public'` and the documents predating the field,
 * and nothing else. Passing a real viewer id here, or hand-rolling the `$match`, is how a private
 * event ends up on an indexable page — the same reasoning `app/sitemap.ts` records.
 *
 * IT THROWS ON A DATABASE FAILURE, deliberately, and does not return an empty week. "No events" and
 * "we could not ask" are different facts and the page must not print the first when it means the
 * second — CLAUDE.md's calendar note records what that costs ("No events this month" for a 500 is
 * the most alarming failure reading as the most reassuring answer).
 */
export async function getPublicDigestWeek(options?: {
  now?: Date;
  limit?: number;
}): Promise<PublicDigestWeek> {
  const now = options?.now ?? new Date();
  const limit = options?.limit ?? 12;
  const to = new Date(now.getTime() + WEEKLY_WINDOW_DAYS * 24 * 3600_000);

  await connectDB();

  const filter = buildEventFilter(
    { techOnly: true, from: now, to, includeOngoing: false },
    null
  );

  const [docs, total, inPerson, free] = await Promise.all([
    Event.find(filter)
      .select(FEED_SELECT)
      // `connections`, not `soonest`. The whole product thesis is that the ranking is the value, and
      // a chronological list of the next twelve things is what every other listings site already is.
      .sort(buildSort('connections', false))
      .limit(limit)
      .lean(),
    Event.countDocuments(filter),
    Event.countDocuments({ ...filter, format: { $ne: 'online' } }),
    Event.countDocuments({ ...filter, isFree: true }),
  ]);

  return { from: now, to, total, inPerson, free, events: toFeedEvents(docs) };
}

// Made with Bob