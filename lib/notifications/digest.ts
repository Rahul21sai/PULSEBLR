import {
  getNewEventsSince,
  getEventsWithDeadlineSoon,
  getUnhealthySources,
  UnhealthySource,
} from '../scrapers/ingestion';
import connectDB from '../mongodb';
import TrackerEntry from '../models/TrackerEntry';
import { IEvent } from '../models/Event';

/** A connection as stored on a tracker entry. */
interface DigestConnection {
  name: string;
  company?: string;
  role?: string;
  followUpAt?: Date | string;
  followedUp?: boolean;
}

/** A tracker entry with its event populated, as the digest queries it. */
interface DigestTrackerEntry {
  status: string;
  notes?: string;
  updatedAt?: Date | string;
  eventId: { title: string };
  connections: DigestConnection[];
}

// Base URL for links in the digest. In production this must be the deployed
// origin (set NEXTAUTH_URL); falls back to localhost for local runs.
const APP_URL = (process.env.NEXTAUTH_URL || 'http://localhost:3000').replace(/\/$/, '');

export interface DigestData {
  newEvents: IEvent[];
  upcomingDeadlines: IEvent[];
  trackerUpdates: DigestTrackerEntry[];
  followUpReminders: DigestTrackerEntry[];
  unhealthySources: UnhealthySource[];
}

/**
 * Generate daily digest data
 * Called once per day to compile what's new and what needs attention
 */
export async function generateDailyDigest(): Promise<DigestData> {
  await connectDB();

  // Get events added in the last 24 hours
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const newEvents = await getNewEventsSince(yesterday);

  // Get events with registration deadline in next 3 days
  const upcomingDeadlines = await getEventsWithDeadlineSoon(3);

  // Get tracker entries updated in last 24 hours
  const trackerUpdates = await TrackerEntry.find({
    updatedAt: { $gte: yesterday },
  })
    .populate('eventId')
    .sort({ updatedAt: -1 })
    .lean();

  // Get connections with follow-up dates in next 3 days
  const threeDaysFromNow = new Date();
  threeDaysFromNow.setDate(threeDaysFromNow.getDate() + 3);

  const followUpReminders = await TrackerEntry.find({
    'connections.followUpAt': {
      $gte: new Date(),
      $lte: threeDaysFromNow,
    },
  })
    .populate('eventId')
    .lean();

  // Sources that have gone quiet or errored — so scraper breakage is visible
  // instead of silently shrinking the event feed.
  const unhealthySources = await getUnhealthySources();

  return {
    newEvents,
    upcomingDeadlines,
    // Both queries .populate('eventId'), so at runtime eventId is the full event
    // document even though the schema types the field as an ObjectId reference.
    trackerUpdates: trackerUpdates as unknown as DigestTrackerEntry[],
    followUpReminders: followUpReminders as unknown as DigestTrackerEntry[],
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
  lines.push(new Date().toLocaleDateString('en-IN', { 
    weekday: 'long', 
    year: 'numeric', 
    month: 'long', 
    day: 'numeric' 
  }));
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
        const date = new Date(event.startDateTime).toLocaleDateString('en-IN', {
          month: 'short',
          day: 'numeric',
        });
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
      const deadline = new Date(event.registrationDeadline!).toLocaleDateString('en-IN', {
        month: 'short',
        day: 'numeric',
      });
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
    lines.push(`👥 FOLLOW-UP REMINDERS (${digest.followUpReminders.length})`);
    lines.push('─'.repeat(47));
    digest.followUpReminders.forEach((entry: DigestTrackerEntry) => {
      entry.connections.forEach((conn: DigestConnection) => {
        if (conn.followUpAt) {
          const followUpDate = new Date(conn.followUpAt);
          const today = new Date();
          if (followUpDate >= today) {
            lines.push(`  • ${conn.name} (${entry.eventId.title})`);
            if (conn.company) lines.push(`    ${conn.company}`);
            lines.push(`    Follow up: ${followUpDate.toLocaleDateString('en-IN')}`);
          }
        }
      });
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
    <p>${new Date().toLocaleDateString('en-IN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</p>
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
        const date = new Date(event.startDateTime).toLocaleDateString('en-IN', { month: 'short', day: 'numeric' });
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
      const deadline = new Date(event.registrationDeadline!).toLocaleDateString('en-IN', { month: 'short', day: 'numeric' });
      html.push(`
    <div class="event-card">
      <div class="event-title">${event.title}</div>
      <div class="event-meta">Deadline: ${deadline}</div>
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
function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Made with Bob