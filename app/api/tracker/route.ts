import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongodb';
import TrackerEntry from '@/lib/models/TrackerEntry';
import Event from '@/lib/models/Event';
import { getCurrentUserId } from '@/lib/auth-helpers';
import {
  validateTrackerInput,
  trackerValidationError,
  isSchemaRejection,
} from '@/lib/tracker/validate';

// GET /api/tracker — list entries for the signed-in user
export async function GET(request: NextRequest) {
  const userId = await getCurrentUserId();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    await connectDB();

    // Assembled from query params, so a plain record is the honest type.
    const filter: Record<string, unknown> = { userId };
    const status = request.nextUrl.searchParams.get('status');
    if (status) filter.status = { $in: status.split(',') };

    const entries = await TrackerEntry.find(filter)
      .populate('eventId')
      .sort({ updatedAt: -1 })
      .lean();

    return NextResponse.json({ entries });
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

    const event = await Event.findById(eventId);
    if (!event) return NextResponse.json({ error: 'Event not found' }, { status: 404 });

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
    const populated = await TrackerEntry.findById(entry._id).populate('eventId');

    return NextResponse.json(populated, { status: 201 });
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
