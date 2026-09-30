import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongodb';
import TrackerEntry from '@/lib/models/TrackerEntry';
import Event from '@/lib/models/Event';
import Folder from '@/lib/models/Folder';
import { getCurrentUserId } from '@/lib/auth-helpers';
import {
  validateTrackerInput,
  trackerValidationError,
  isSchemaRejection,
} from '@/lib/tracker/validate';
import { canViewEvent } from '@/lib/events/visibility';
import {
  TRACKER_EVENT_SELECT,
  TRACKER_FOLDER_SELECT,
  shapeTrackerEntries,
  shapeTrackerEntry,
} from '@/lib/tracker/entry-view';

/**
 * GET /api/tracker — list entries for the signed-in user.
 *
 * AN EXPLICIT JOIN, NOT `.populate('eventId')`, and the difference is what lets a lost event keep
 * its name. `populate` replaces a missing ref with `null` and the id goes with it; here the raw id is
 * still in hand, so an entry whose event is gone can be matched to the user's own folder for that
 * event, which remembers the title (`lastKnown`). Same two queries `populate` issues underneath, plus
 * one more for the user's folders.
 *
 * THE FOLDER QUERY COVERS EVERY ENTRY, not only the ones whose event is gone, because each entry with
 * a folder now carries `folderId` — what an Attended card links "Follow up" to. Still ONE query for
 * the whole list, never one per entry, and user-scoped in the filter (with `shapeTrackerEntries`
 * checking `userId` again behind it).
 *
 * Every event goes out through `shapeTrackerEntries`: nine fields, visibility re-decided on this read,
 * `createdByUserId` never sent. See lib/tracker/entry-view.ts.
 */
export async function GET(request: NextRequest) {
  const userId = await getCurrentUserId();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    await connectDB();

    // Assembled from query params, so a plain record is the honest type.
    const filter: Record<string, unknown> = { userId };
    const status = request.nextUrl.searchParams.get('status');
    if (status) filter.status = { $in: status.split(',') };

    const entries = await TrackerEntry.find(filter).sort({ updatedAt: -1 }).lean();

    const eventIds = [...new Set(entries.map(entry => String(entry.eventId)))];
    const events = eventIds.length
      ? await Event.find({ _id: { $in: eventIds } }).select(TRACKER_EVENT_SELECT).lean()
      : [];

    const folders = eventIds.length
      ? await Folder.find({ userId, eventId: { $in: eventIds } })
          .select(TRACKER_FOLDER_SELECT)
          .sort({ updatedAt: -1 })
          .lean()
      : [];

    return NextResponse.json({ entries: shapeTrackerEntries(entries, events, folders, userId) });
  } catch (error) {
    console.error('Error fetching tracker entries:', error);
    return NextResponse.json({ error: 'Failed to fetch tracker entries' }, { status: 500 });
  }
}

/**
 * POST /api/tracker — create entry for the signed-in user.
 *
 * The body is parsed and validated BEFORE `connectDB()`, because a malformed request needs
 * no database to refuse. Both steps used to fall through to the catch-all and be reported
 * as 500 with `details: err.message` — see lib/tracker/validate.ts for why that was two
 * defects rather than one.
 */
export async function POST(request: NextRequest) {
  const userId = await getCurrentUserId();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // request.json() THROWS on a malformed body — the same 500-for-a-client-error one layer up.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'request body must be valid JSON' }, { status: 400 });
  }

  const issues = validateTrackerInput(body, { requireEventId: true });
  if (issues.length > 0) {
    return NextResponse.json(trackerValidationError(issues), { status: 400 });
  }
  // Validated above, so eventId is present and is a well-formed 24-hex id.
  const input = body as Record<string, unknown>;
  const eventId = input.eventId as string;

  try {
    await connectDB();

    // TRACKER_EVENT_SELECT carries `visibility`, `createdByUserId` and `deletedAt` — the three fields
    // `canViewEvent` reads. Drop one and the guard below admits every event it was meant to refuse.
    const event = await Event.findById(eventId).select(TRACKER_EVENT_SELECT).lean();
    if (!event) return NextResponse.json({ error: 'Event not found' }, { status: 404 });

    /**
     * A PRIVATE EVENT YOU DO NOT OWN CANNOT BE TRACKED, and this is the most important of the
     * four id-addressable guards — it is the one that turns id-guessing into a DURABLE read.
     *
     * Without it, any signed-in user could track another user's private event by id and get the
     * fully populated document back in the 201 body, then keep re-reading it forever through
     * `GET /api/tracker`, which re-populates on every call. It survives fixing
     * `GET /api/events/[id]` because it is a different route.
     *
     * Worse downstream: moving that entry to Confirmed or Attended calls `ensureFolderForEvent()`,
     * which copies the private event's title, date and venue into a `Folder` the tracker owns —
     * a denormalised copy that no later access-control change can claw back.
     *
     * Same 404 and the same message as a genuinely missing event, so existence is not observable.
     * After the guard and the validator, keeping the CLAUDE.md §6 ordering intact.
     */
    if (!canViewEvent(event, userId)) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 });
    }

    // One entry per user per event
    const existing = await TrackerEntry.findOne({ userId, eventId });
    if (existing) {
      return NextResponse.json(
        { error: 'Already tracking this event', entry: existing },
        { status: 409 }
      );
    }

    // userId last: a body cannot claim someone else's entry by supplying its own.
    const entry = await TrackerEntry.create({ ...input, userId });

    // Shaped from the event already in hand, which saves the re-read-and-populate this used to do —
    // and that populate sent the whole event document back, `createdByUserId` included.
    return NextResponse.json(shapeTrackerEntry(entry.toObject(), event, userId), { status: 201 });
  } catch (error) {
    const err = error as { code?: number };
    console.error('Error creating tracker entry:', error);
    if (err.code === 11000) {
      return NextResponse.json({ error: 'Already tracking this event' }, { status: 409 });
    }
    // Unreachable while the validator and the schema agree. If they ever drift, this stays a
    // 400 rather than reverting to a 500 — and the real wording stays in the server log.
    if (isSchemaRejection(error)) {
      return NextResponse.json({ error: 'Invalid tracker entry' }, { status: 400 });
    }
    // No `details`: the only thing it ever carried was the Mongoose message this fix exists
    // to stop leaking. Nothing reads it — verified across app/ and scripts/.
    return NextResponse.json({ error: 'Failed to create tracker entry' }, { status: 500 });
  }
}
