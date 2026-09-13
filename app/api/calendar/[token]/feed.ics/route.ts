import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongodb';
import User from '@/lib/models/User';
import TrackerEntry from '@/lib/models/TrackerEntry';
import Event from '@/lib/models/Event';
import { rateLimit, clientKey } from '@/lib/security/rate-limit';
import { buildCalendarFeed, icsEtag, type FeedEvent } from '@/lib/calendar/ics';
import { canViewEvent } from '@/lib/events/visibility';
import { REMINDABLE_TRACKER_STATUSES } from '@/lib/notifications/reminder-policy';
import { absoluteUrl } from '@/lib/canonical-origin';

/**
 * PUBLIC — one user's saved events as a subscribable VCALENDAR.
 *
 * This is the "my events show up in my calendar" feature. A calendar client is given this URL
 * once and re-fetches it forever; there is no session, no header and no way to prompt for a
 * credential, so the token in the path is the whole of the authentication. It is deliberately
 * unauthenticated for the same reason `/api/card/[token]` is, and like that route it belongs in
 * `scripts/diag-api-auth.ts`'s MUST_ALLOW list so staying public is a tested decision rather than
 * an oversight.
 *
 * WHAT KEEPS IT SAFE, given there is no session:
 *
 *   · the token is 32 bytes of CSPRNG entropy (43 characters), so it cannot be guessed or
 *     enumerated — twice the card token's, because this exposes a whole saved-events list
 *   · `calendarFeed.enabled` must be true, so a leaked token alone is not sufficient and the
 *     owner has a kill switch that does not break the devices already subscribed
 *   · the body carries only events THIS user saved, and `canViewEvent` is still applied per row
 *   · nothing identifies the user: no id, no email, no name in the payload
 *
 * ── 404, NEVER 403, FOR BOTH FAILURES ────────────────────────────────────────────────────────
 * A wrong token and a switched-off feed return the identical 404. Distinguishing them would leak
 * that a token is real, which is the one bit an enumerator wants. Same rule as
 * `/api/card/[token]` and `findOwnedFolder()`.
 *
 * ── WHY `Cache-Control: private, max-age=0, must-revalidate` AND NOT `no-store` ───────────────
 * `no-store` would forbid the conditional request, and the conditional request is the entire
 * saving here: a subscribed calendar re-fetches this on a fixed schedule whether or not anything
 * changed, and a 304 costs one round trip and no body. `private` is what stops a shared or CDN
 * cache keeping a copy — this is one person's list, the same distinction CLAUDE.md §9 records for
 * the CSV export and the per-event ICS route's conditional header. `max-age=0, must-revalidate`
 * means "you may keep it, you may not use it without asking me first".
 *
 * That only works because the body is BYTE-STABLE when nothing changed, which is why every
 * `DTSTAMP` comes from the row's `updatedAt` and never from the clock. See `FeedEvent.updatedAt`.
 */

/**
 * How far back and forward the feed reaches.
 *
 * BOUNDED BECAUSE AN UNBOUNDED FEED GROWS FOREVER. Every saved event would accumulate in a body
 * that is re-downloaded by every device on every poll, and the cost is paid by the user's phone
 * on mobile data. 30 days back keeps the recent past visible (useful — "what was that meetup
 * called"), 365 forward covers every conference that announces a year out.
 */
const WINDOW_PAST_DAYS = 30;
const WINDOW_FUTURE_DAYS = 365;

/**
 * Don't write `lastPolledAt` more often than this.
 *
 * The field exists so the user can see their subscription is alive, which needs minute-level
 * accuracy at best — and this is a PUBLIC endpoint, so writing on every request would let anyone
 * holding the token turn a read into one database write per hit. The rate limiter caps that at
 * 30/min, but a limiter is documented in its own header as a nuisance filter rather than a
 * control, so the write is coalesced independently of it.
 */
const POLL_WRITE_COALESCE_MS = 5 * 60 * 1000;

export async function GET(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  /*
   * Throttled before anything else, because it is unauthenticated.
   *
   * 30/min is GENEROUS ON PURPOSE. A 429 to Google is not a soft failure: it does not retry
   * promptly, it skips the cycle and comes back hours later, so the user sees a calendar that
   * silently stopped updating. The limiter here is to blunt a scraper, and one real client needs
   * a handful of requests a day — an order of magnitude under this.
   */
  const limit = rateLimit(clientKey(request, 'calendar-feed'), { limit: 30, windowMs: 60_000 });
  if (!limit.ok) {
    return NextResponse.json(
      { error: 'Too many requests' },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } }
    );
  }

  try {
    await connectDB();
    const { token } = await params;

    // Cheap shape check before touching the database. A real token is 43 base64url characters;
    // anything materially shorter is a probe, not a typo.
    if (!token || token.length < 32) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const user = await User.findOne({ 'calendarFeed.token': token })
      .select('googleId calendarFeed')
      .lean();

    // Same 404 whether the token is wrong or the feed is switched off. See the header.
    if (!user?.calendarFeed?.enabled) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const now = new Date();
    const from = new Date(now.getTime() - WINDOW_PAST_DAYS * 86400_000);
    const to = new Date(now.getTime() + WINDOW_FUTURE_DAYS * 86400_000);

    /*
     * WHICH STATUSES: `REMINDABLE_TRACKER_STATUSES`, imported rather than re-listed.
     *
     * A second copy of this list is exactly what CLAUDE.md warns about — the `WorthGoing` panel
     * copied `FUNNEL_PATTERN` and fell behind it. Reusing it does mean `Attended` is absent, so an
     * event you have already been to leaves your calendar rather than staying as a record. That is
     * a defensible reading of what a calendar subscription is for (it answers "where do I need to
     * be"), and it is not worth a divergent second list to change. `Skipped` and `Rejected` are
     * excluded for the reason recorded there: the user moved the card to say no.
     */
    const entries = await TrackerEntry.find({
      userId: user.googleId,
      status: { $in: [...REMINDABLE_TRACKER_STATUSES] },
    })
      /*
       * ⚠ `populate` CAN COME BACK NULL, AND NOT RARELY. `pruneStale()` deletes any event more
       * than 7 days past its start on every scrape and touches nothing that references it, so a
       * dangling `eventId` is NORMAL rather than exceptional — `getPendingFollowUps` already 500s
       * on one by reading `entry.eventId.title` with no guard. Filtered below, not hoped about.
       *
       * ⚠ THE SELECT MUST CARRY `visibility`, `createdByUserId` AND `deletedAt`. Every check in
       * `canViewEvent` treats absence as PERMISSIVE, because absence genuinely is the common case
       * across the ~1600 scraped rows — so a projection that omits a field it reads does not throw
       * and does not deny, it silently returns true for everything. `POST /api/folders` shipped
       * exactly that bug. Adding a field to the guard means adding it here.
       */
      .populate({
        path: 'eventId',
        select:
          'title description startDateTime endDateTime venue address area city organizer ' +
          'onlineLink sourceUrl updatedAt visibility createdByUserId deletedAt',
      })
      .lean();

    const events: FeedEvent[] = [];
    for (const entry of entries) {
      // `populate` widens the type to the referenced document; null is the pruned-event case.
      const event = entry.eventId as unknown as
        | (Parameters<typeof canViewEvent>[0] & {
            _id: unknown;
            title?: string;
            description?: string;
            startDateTime?: Date;
            endDateTime?: Date;
            venue?: string;
            address?: string;
            area?: string;
            city?: string;
            organizer?: string;
            onlineLink?: string;
            sourceUrl?: string;
            updatedAt?: Date;
          })
        | null;

      if (!event?.startDateTime || !event.title) continue;

      /*
       * The visibility guard still applies even though the user saved this event themselves.
       * A private event of their own SHOULD be here — that is the point of the feature — but an
       * event an admin has since soft-deleted should not, and `canViewEvent` checks `deletedAt`
       * first for exactly that reason. Without this, junk removed from the corpus would keep
       * appearing in somebody's calendar with no way to get it out.
       */
      if (!canViewEvent(event, user.googleId)) continue;

      const start = new Date(event.startDateTime);
      if (Number.isNaN(start.getTime()) || start < from || start > to) continue;

      const id = String(event._id);
      events.push({
        id,
        title: event.title,
        description: event.description ?? null,
        startDateTime: start,
        endDateTime: event.endDateTime ?? null,
        venue: event.venue ?? null,
        address: event.address ?? null,
        area: event.area ?? null,
        city: event.city ?? null,
        organizer: event.organizer ?? null,
        onlineLink: event.onlineLink ?? null,
        sourceUrl: event.sourceUrl ?? null,
        eventUrl: absoluteUrl(`/events/${id}`),
        /*
         * DTSTAMP's source. The LATER of the two rows, because the body has to change when either
         * side does: editing the event changes `Event.updatedAt`, moving the card between kanban
         * columns changes `TrackerEntry.updatedAt` and nothing on the event. Falling back to the
         * start date keeps it deterministic for a row written before `timestamps` existed — the
         * one thing it must never be is `new Date()`, which would make every poll a fresh 200.
         */
        updatedAt: laterOf(event.updatedAt, entry.updatedAt) ?? start,
      });
    }

    const body = buildCalendarFeed({
      events,
      calendarName: 'PulseBLR — saved events',
      calendarDescription:
        'Events you saved in PulseBLR. Updated when your calendar app next checks this URL.',
    });
    const etag = icsEtag(body);

    /*
     * The conditional response. `If-None-Match` may legitimately carry several validators and a
     * `W/` prefix, so it is split rather than compared whole — a strict `===` here would simply
     * never match and the 304 would never fire, which is the silent way this feature fails.
     */
    const inm = request.headers.get('if-none-match');
    const headers: Record<string, string> = {
      'Content-Type': 'text/calendar; charset=utf-8',
      // Inline, not an attachment: a client following this URL is subscribing, not downloading.
      'Content-Disposition': 'inline; filename="pulseblr.ics"',
      // See the header for why this is not `no-store`.
      'Cache-Control': 'private, max-age=0, must-revalidate',
      ETag: etag,
    };

    // Coalesced, and AFTER the body is built so a write failure can never cost the user their
    // calendar. Fire-and-forget for the same reason.
    void recordPoll(user.googleId, user.calendarFeed.lastPolledAt, now);

    if (inm && inm.split(',').some(candidate => candidate.trim().replace(/^W\//, '') === etag)) {
      return new NextResponse(null, { status: 304, headers });
    }

    return new NextResponse(body, { headers });
  } catch (error) {
    // No `details`: the message here would name the User or Event model and a schema path.
    console.error('Error generating calendar feed:', error);
    return NextResponse.json({ error: 'Failed to generate the calendar feed' }, { status: 500 });
  }
}

/** The later of two optional dates, or null when neither is usable. */
function laterOf(a?: Date | null, b?: Date | null): Date | null {
  const times = [a, b]
    .map(value => (value ? new Date(value).getTime() : NaN))
    .filter(time => !Number.isNaN(time));
  return times.length ? new Date(Math.max(...times)) : null;
}

/**
 * Stamp `lastPolledAt`, at most once every `POLL_WRITE_COALESCE_MS`.
 *
 * Never allowed to fail the request: the user's calendar working matters and this is only the
 * "yes, something is fetching it" indicator in Settings.
 */
async function recordPoll(googleId: string, previous: Date | undefined, now: Date): Promise<void> {
  if (previous && now.getTime() - new Date(previous).getTime() < POLL_WRITE_COALESCE_MS) return;
  try {
    await User.updateOne({ googleId }, { $set: { 'calendarFeed.lastPolledAt': now } });
  } catch (error) {
    console.error('Could not record a calendar-feed poll:', error);
  }
}

// `Event` is imported for its side effect only: `populate('eventId')` resolves the ref through
// mongoose's model registry, and in a cold serverless instance where nothing else has touched the
// Event model that registry is empty — the populate then throws MissingSchemaError. The migration
// script `migrate-connections-to-contacts.ts` hit exactly this, and a dry run over 0 rows hid it.
void Event;
