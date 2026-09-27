import { NextRequest, NextResponse } from 'next/server';
import mongoose from 'mongoose';
import connectDB from '@/lib/mongodb';
import Event from '@/lib/models/Event';
import { getCurrentUserId } from '@/lib/auth-helpers';
import { canViewEvent } from '@/lib/events/visibility';
import { buildEventIcs } from '@/lib/calendar/ics';

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
 *
 * ── `escapeIcsText`, `toIcsUtc` AND `foldLine` NOW LIVE IN `lib/calendar/ics.ts`. ─────────────
 * They were defined inline here until the subscription feed needed all three, and a second copy of
 * a line-folding function is the duplication this repo has already paid for twice (the
 * `WorthGoing` panel's copy of `FUNNEL_PATTERN` fell behind the original). They were moved
 * VERBATIM, and `foldLine` was then FIXED there — it folded on UTF-16 code units rather than
 * octets, so an em-dash title produced a 91-octet line and a fold could split a surrogate pair
 * into two lone halves that become U+FFFD on the wire. Both were live in this route, since event
 * titles are scraped from third-party pages. See that module's header for the measurements.
 *
 * `METHOD:PUBLISH` STAYS. It marks the body as an iTIP message (RFC 5546), which is exactly
 * right for a one-shot download — and exactly wrong for the feed, where Outlook then offers to
 * import once rather than treating the URL as a living calendar. The feed omits it deliberately.
 * The `UID` shape is shared, so a user who both subscribes and downloads gets a merge.
 *
 * ── THE CONTENT LINES NOW COME FROM `buildEventIcs` IN THE SAME MODULE (CWE-93). ─────────────
 * They were built inline here, and three line-injection sinks were among them. `URL:${sourceUrl}`
 * was raw, so a scraped source URL carrying CR or LF began new content lines, up to and including a
 * second VEVENT. The organiser went into `ORGANIZER;CN=` through TEXT escaping, which is the wrong
 * rule for a parameter: it let a lone CR through, split a name at every comma, and ended the
 * parameter at a colon. And `escapeIcsText` itself stopped at `\r?\n`. None of that could be
 * tested here, because this route needs mongoose and a session. So the lines moved to a pure
 * function, and `tests/calendar-ics.test.ts` feeds hostile input through both producers. This file
 * keeps what really is the route's: the lookup, the visibility guard and the headers.
 */

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

    // Every content line, and every sanitiser that guards one, lives in `buildEventIcs`. See the
    // header. `new Date()` is the DTSTAMP: this is a one-shot download, not a feed with an ETag.
    const lines = buildEventIcs(
      {
        id: String(event._id),
        title: event.title,
        description: event.description,
        startDateTime: event.startDateTime,
        endDateTime: event.endDateTime,
        venue: event.venue,
        address: event.address,
        area: event.area,
        city: event.city,
        organizer: event.organizer,
        onlineLink: event.onlineLink,
        sourceUrl: event.sourceUrl,
      },
      new Date()
    );

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
