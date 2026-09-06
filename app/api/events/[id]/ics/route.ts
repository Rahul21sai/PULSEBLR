import { NextRequest, NextResponse } from 'next/server';
import mongoose from 'mongoose';
import connectDB from '@/lib/mongodb';
import Event from '@/lib/models/Event';
import { getCurrentUserId } from '@/lib/auth-helpers';
import { canViewEvent } from '@/lib/events/visibility';

/**
 * GET /api/events/[id]/ics — download the event as a calendar file.
 *
 * Serving a real .ics beats a "Add to Google Calendar" deep link: it works with
 * whatever calendar the user actually uses (Apple, Outlook, Google), survives
 * being forwarded, and needs no third-party URL format that can change.
 *
 * THE CACHE HEADER IS CONDITIONAL, and that is the interesting part of this route.
 *
 * A public event is shared-calendar data and `public, max-age=3600` is right for it. A user's own
 * private event is not: the body carries its title, full description, organizer, venue, address,
 * area, city and sourceUrl, and a public cache directive lets any shared or CDN cache along the path
 * keep a copy for an hour — so revoking access would not revoke the cached copy.
 *
 * CLAUDE.md §9 already records this exact distinction for the CSV export: "do not copy the ICS
 * route's `public, max-age=3600`, since that is a shared calendar and this is one person's private
 * list". A private event makes THIS route the second instance of the same mistake, which is why the
 * header is decided per-event rather than being a constant.
 */

/** RFC 5545 requires escaping these characters inside TEXT values. */
function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** UTC timestamp in the basic format ICS expects: 20260822T103000Z */
function toIcsUtc(date: Date): string {
  return `${date.toISOString().replace(/[-:]/g, '').split('.')[0]}Z`;
}

/**
 * Fold lines at 75 octets as the spec requires. Long descriptions otherwise
 * produce single multi-kilobyte lines that some clients (notably Outlook) reject.
 */
function foldLine(line: string): string {
  if (line.length <= 75) return line;
  const parts: string[] = [line.slice(0, 75)];
  let rest = line.slice(75);
  while (rest.length > 74) {
    parts.push(` ${rest.slice(0, 74)}`);
    rest = rest.slice(74);
  }
  if (rest) parts.push(` ${rest}`);
  return parts.join('\r\n');
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await connectDB();
    const { id } = await params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return NextResponse.json({ error: 'Invalid event ID' }, { status: 400 });
    }

    const event = await Event.findById(id).lean();
    if (!event) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 });
    }

    // 404, not 403 — a 403 confirms the row exists. See lib/events/visibility.ts.
    const viewerId = await getCurrentUserId();
    if (!canViewEvent(event, viewerId)) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 });
    }
    const isPublic = !event.visibility || event.visibility === 'public';

    const start = new Date(event.startDateTime);
    // No end time published: assume two hours, the typical meetup length. Emitting
    // a zero-length event makes it render as a sliver users can't click.
    const end = event.endDateTime
      ? new Date(event.endDateTime)
      : new Date(start.getTime() + 2 * 3600 * 1000);

    const location = [event.venue, event.address, event.area, event.city]
      .filter(Boolean)
      .join(', ');

    const descriptionParts = [event.description];
    if (event.organizer) descriptionParts.push(`Host: ${event.organizer}`);
    if (event.onlineLink) descriptionParts.push(`Join: ${event.onlineLink}`);
    descriptionParts.push(`Source: ${event.sourceUrl}`);

    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//PulseBLR//Bengaluru Events//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'BEGIN:VEVENT',
      `UID:${String(event._id)}@pulseblr`,
      `DTSTAMP:${toIcsUtc(new Date())}`,
      `DTSTART:${toIcsUtc(start)}`,
      `DTEND:${toIcsUtc(end)}`,
      `SUMMARY:${escapeIcsText(event.title)}`,
      `DESCRIPTION:${escapeIcsText(descriptionParts.join('\n\n'))}`,
      location ? `LOCATION:${escapeIcsText(location)}` : '',
      `URL:${event.sourceUrl}`,
      event.organizer ? `ORGANIZER;CN=${escapeIcsText(event.organizer)}:MAILTO:noreply@pulseblr.local` : '',
      'STATUS:CONFIRMED',
      'BEGIN:VALARM',
      'TRIGGER:-PT2H',
      'ACTION:DISPLAY',
      `DESCRIPTION:${escapeIcsText(event.title)} starts in 2 hours`,
      'END:VALARM',
      'END:VEVENT',
      'END:VCALENDAR',
    ]
      .filter(Boolean)
      .map(foldLine)
      .join('\r\n');

    const filename = `${(event.slug || 'event').slice(0, 60)}.ics`;

    return new NextResponse(lines, {
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        // See the header: a shared calendar may be cached, one person's private event may not.
        'Cache-Control': isPublic ? 'public, max-age=3600' : 'no-store',
      },
    });
  } catch (error) {
    console.error('Error generating ICS:', error);
    return NextResponse.json({ error: 'Failed to generate calendar file' }, { status: 500 });
  }
}
