import {
  getNewEventsSince,
  getEventsWithDeadlineSoon,
  getUnhealthySources,
  UnhealthySource,
} from '../scrapers/ingestion';
import connectDB from '../mongodb';
import TrackerEntry from '../models/TrackerEntry';
import { IEvent } from '../models/Event';
import { getPendingFollowUps, type PendingFollowUp } from '../helpers/phase6';
// Dates in an email MUST go through here. This digest is sent by a GitHub Actions runner in
// UTC at 8 AM IST (02:30 UTC), so `toLocaleDateString()` on the ambient locale reports the
// PREVIOUS day. lib/format.ts is pinned to Asia/Kolkata.
import { dayLabelIST, fullDateIST } from '../format';

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

  // Get events added in the last 24 hours
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const newEvents = await getNewEventsSince(yesterday);

  // Get events with registration deadline in next 3 days
  const upcomingDeadlines = await getEventsWithDeadlineSoon(3);

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
 * Source names and error strings come from external feeds, so escape them to
 * avoid injecting stray markup into the rendered email.
 */
export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Made with Bob