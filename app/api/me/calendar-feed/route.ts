import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongodb';
import { newCalendarFeedToken, type IUserCalendarFeed } from '@/lib/models/User';
import { requireUser } from '@/lib/api-auth';
import { ensureUser } from '@/lib/user-record';
import { auth } from '@/auth';
import { absoluteUrl } from '@/lib/canonical-origin';
import { calendarFeedPath, toWebcalUrl } from '@/lib/calendar/ics';

/**
 * The signed-in user's own calendar subscription — reveal it, switch it on or off, rotate it.
 *
 * GET returns it, minting a token on first read so the Settings screen always has a URL to show.
 * PUT takes `{ enabled }` and/or `{ rotate: true }`.
 *
 * THE SHAPE IS `/api/me/card`'s, on purpose. Both manage a plaintext token that appears in a URL a
 * stranger's device fetches with no session, both mint lazily on GET, and both expose rotation as
 * an explicit destructive action the UI has to warn about first. Two surfaces solving the same
 * problem differently is how one of them ends up with the weaker rule.
 *
 * ── ROTATION IS MORE DESTRUCTIVE HERE THAN FOR A CARD, AND THE UI SAYS SO ────────────────────
 * Rotating a card token invalidates printed QR codes — annoying, and the user knows they did it.
 * Rotating THIS token breaks every calendar already subscribed, and the failure is silent on the
 * far side: Google does not surface a 404 on a subscribed URL prominently, it just stops adding
 * events. So `enabled: false` exists as the non-destructive way to stop a feed, and the copy in
 * `app/settings/CalendarFeedSection.tsx` steers to it — the same reasoning as offering Archive
 * above Delete on a folder.
 */

interface CalendarFeedDTO {
  enabled: boolean;
  /** The https URL to paste into Google Calendar. Null only if minting somehow failed. */
  url: string | null;
  /** The same URL as `webcal:`, which opens Apple Calendar's subscribe prompt directly. */
  webcalUrl: string | null;
  createdAt: string | null;
  /** When a calendar client last fetched it — the only evidence the subscription is alive. */
  lastPolledAt: string | null;
}

function toDTO(feed: IUserCalendarFeed | undefined): CalendarFeedDTO {
  if (!feed?.token) {
    return { enabled: false, url: null, webcalUrl: null, createdAt: null, lastPolledAt: null };
  }
  // Built from NEXTAUTH_URL rather than the request Host, because `auth.ts` sets `trustHost: true`
  // and a Host header is therefore attacker-chosen. A subscription URL is long-lived in somebody
  // else's calendar app, so a spoofed origin baked into one keeps working. See lib/canonical-origin.ts.
  const url = absoluteUrl(calendarFeedPath(feed.token));
  return {
    enabled: Boolean(feed.enabled),
    url,
    webcalUrl: toWebcalUrl(url),
    createdAt: feed.createdAt ? new Date(feed.createdAt).toISOString() : null,
    lastPolledAt: feed.lastPolledAt ? new Date(feed.lastPolledAt).toISOString() : null,
  };
}

export async function GET() {
  // GUARD FIRST. Nothing below this line may run for an anonymous caller — a 400 or a 500 where a
  // 401 belongs tells a stranger their request got far enough to be judged.
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  try {
    await connectDB();
    const session = await auth();

    // Created if absent rather than 404: the JWT is the identity and the User row is derived from
    // it, and the sign-in upsert can legitimately have failed. See ensureUser().
    const user = await ensureUser(gate.userId, session?.user?.email, session?.user?.name);

    // Minted lazily, like the card token. A user who never opens Settings never gets one, and the
    // UI never has to render a "no token yet" state. Harmless because `enabled` is false, so the
    // URL exists and returns 404 until they deliberately switch it on.
    if (!user.calendarFeed?.token) {
      user.calendarFeed = {
        token: newCalendarFeedToken(),
        enabled: false,
        createdAt: new Date(),
      } as IUserCalendarFeed;
      user.markModified('calendarFeed');
      await user.save();
    }

    return NextResponse.json({ feed: toDTO(user.calendarFeed) });
  } catch (error) {
    console.error('Error reading calendar feed:', error);
    return NextResponse.json({ error: 'Failed to read your calendar feed' }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  // GUARD FIRST, VALIDATE SECOND — in this order. Parsing the body above the guard is how an
  // anonymous caller receives 400 instead of 401.
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  try {
    const body = await request.json().catch(() => ({}));

    // Validated before `connectDB()`: a bad request needs no database to refuse. Follows
    // `lib/tracker/validate.ts`, and the 400 names the field without quoting any Mongoose wording.
    if ('enabled' in body && typeof body.enabled !== 'boolean') {
      return NextResponse.json({ error: '`enabled` must be true or false' }, { status: 400 });
    }
    if ('rotate' in body && typeof body.rotate !== 'boolean') {
      return NextResponse.json({ error: '`rotate` must be true or false' }, { status: 400 });
    }

    await connectDB();
    const session = await auth();
    const user = await ensureUser(gate.userId, session?.user?.email, session?.user?.name);

    const feed: IUserCalendarFeed =
      user.calendarFeed ??
      ({ token: newCalendarFeedToken(), enabled: false, createdAt: new Date() } as IUserCalendarFeed);
    if (!feed.token) {
      feed.token = newCalendarFeedToken();
      feed.createdAt = new Date();
    }

    if (typeof body.enabled === 'boolean') feed.enabled = body.enabled;

    /*
     * Rotation breaks every subscribed calendar. The UI confirms first.
     *
     * `lastPolledAt` is cleared with the token, because it described the OLD URL: leaving a stale
     * "last checked 5 minutes ago" beside a link nothing has ever fetched would read as the new
     * subscription already working, which is the opposite of true and exactly when the user needs
     * to know to re-subscribe.
     */
    if (body.rotate === true) {
      feed.token = newCalendarFeedToken();
      feed.createdAt = new Date();
      feed.lastPolledAt = undefined;
    }

    user.calendarFeed = feed;
    // Required for a nested path on an existing document — mongoose does not always detect a
    // mutation inside a subdocument object. `/api/me/card` does the same for `card`.
    user.markModified('calendarFeed');
    await user.save();

    return NextResponse.json({ feed: toDTO(user.calendarFeed) });
  } catch (error) {
    /*
     * NO `details` ON THE 500. The message would be a Mongoose ValidationError naming the User
     * model and a `calendarFeed.*` path, an E11000 quoting the `calendarFeed.token` index, or an
     * `absoluteUrl()` throw quoting NEXTAUTH_URL — all of which describe the deployment or the
     * schema rather than the caller's mistake. The real wording is in the server log.
     */
    console.error('Error updating calendar feed:', error);
    return NextResponse.json({ error: 'Failed to update your calendar feed' }, { status: 500 });
  }
}
