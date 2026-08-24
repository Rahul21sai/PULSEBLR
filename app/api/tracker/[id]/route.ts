import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongodb';
import TrackerEntry from '@/lib/models/TrackerEntry';
import mongoose from 'mongoose';
import { getCurrentUserId } from '@/lib/auth-helpers';
import {
  validateTrackerInput,
  trackerValidationError,
  isSchemaRejection,
} from '@/lib/tracker/validate';
import { ensureFolderForEvent, FOLDER_ON_TRACKER_STATUS } from '@/lib/contacts/service';

// GET /api/tracker/[id]
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await getCurrentUserId();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    await connectDB();
    const { id } = await params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return NextResponse.json({ error: 'Invalid ID' }, { status: 400 });
    }
    const entry = await TrackerEntry.findOne({ _id: id, userId }).populate('eventId');
    if (!entry) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json(entry);
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: 'Failed to fetch tracker entry' }, { status: 500 });
  }
}

/**
 * PUT /api/tracker/[id]
 *
 * Had the same defect as POST, by a different route: `{ $set: body }` with
 * `runValidators: true` means a bad `status` is rejected by Mongoose's update validators, and
 * the catch-all reported that as 500 with `details: error.message`. This is the endpoint a
 * kanban drag calls, so the enum was reachable from a drag with a stale column id.
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await getCurrentUserId();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return NextResponse.json({ error: 'Invalid ID' }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'request body must be valid JSON' }, { status: 400 });
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: 'request body must be a JSON object' }, { status: 400 });
  }

  const update = body as Record<string, unknown>;
  delete update.eventId;
  delete update.userId; // cannot change ownership

  // No requireEventId: a PUT sends only the fields being changed, and eventId is stripped above.
  const issues = validateTrackerInput(update);
  if (issues.length > 0) {
    return NextResponse.json(trackerValidationError(issues), { status: 400 });
  }

  try {
    await connectDB();

    const entry = await TrackerEntry.findOneAndUpdate(
      { _id: id, userId },
      { $set: update },
      { new: true, runValidators: true }
    ).populate('eventId');

    if (!entry) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    /*
     * Confirming an event gets you a folder to scan people into.
     *
     * Before this, folders were manual only — you confirmed an event here, then created the
     * folder by hand at the door. It also does something no other path did: it SETS
     * `Folder.eventId`. Every folder in the product had that null, which made the
     * `folder.eventId ?? folder._id` branch in `detectRepeatConnections()` unreachable and
     * counted two folders for one event as two events.
     *
     * `Attended` as well as `Confirmed`, because jumping straight there is a real path — you
     * went, and now you want to record who you met. `ensureFolderForEvent` is idempotent, so
     * moving Confirmed -> Attended -> Confirmed makes exactly one folder.
     *
     * NON-FATAL BY DESIGN. The status change is what the user asked for and it has already
     * committed; the folder is a convenience on top. So a failure here is logged rather than
     * turned into a 500 that makes a successful move look broken.
     */
    let folder: { _id: string; name: string; outcome: string } | undefined;
    const nextStatus = typeof update.status === 'string' ? update.status : undefined;
    if (
      nextStatus &&
      (FOLDER_ON_TRACKER_STATUS as readonly string[]).includes(nextStatus) &&
      entry.eventId
    ) {
      try {
        const event = entry.eventId as unknown as {
          _id: mongoose.Types.ObjectId;
          title?: string;
          startDateTime?: Date;
          venue?: string | null;
          area?: string | null;
        };
        const result = await ensureFolderForEvent(userId, event);
        folder = {
          _id: String(result.folder._id),
          name: result.folder.name,
          outcome: result.outcome,
        };
      } catch (folderError) {
        console.error('Tracker status changed but folder creation failed:', folderError);
      }
    }

    // `folder` is present only when one was ensured, so the client can link straight to it.
    return NextResponse.json(folder ? { ...entry.toObject(), folder } : entry);
  } catch (error) {
    console.error('Error updating tracker entry:', error);
    // Unreachable while the validator and the schema agree; a 400 rather than a 500 if they
    // ever drift, with the real wording left in the server log instead of the response.
    if (isSchemaRejection(error)) {
      return NextResponse.json({ error: 'Invalid tracker entry' }, { status: 400 });
    }
    return NextResponse.json({ error: 'Failed to update tracker entry' }, { status: 500 });
  }
}

// DELETE /api/tracker/[id]
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await getCurrentUserId();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    await connectDB();
    const { id } = await params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return NextResponse.json({ error: 'Invalid ID' }, { status: 400 });
    }
    const entry = await TrackerEntry.findOneAndDelete({ _id: id, userId });
    if (!entry) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ message: 'Deleted' });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: 'Failed to delete tracker entry' }, { status: 500 });
  }
}
