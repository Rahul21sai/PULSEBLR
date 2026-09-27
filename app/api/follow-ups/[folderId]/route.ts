import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongodb';
import Contact from '@/lib/models/Contact';
import Folder from '@/lib/models/Folder';
import { requireUser } from '@/lib/api-auth';
import { isObjectIdLike } from '@/lib/person-types';
import { buildFollowUpLanding } from '@/lib/notifications/followup-landing';

/**
 * GET /api/follow-ups/[folderId] — the people to follow up with from one event, for the screen the
 * morning-after push opens (`app/follow-ups/[folderId]`).
 *
 * THE ID IN THE URL IS NEVER TRUSTED. It arrived in a notification payload, so it is re-authorised
 * here against the SESSION: the folder is looked up with `userId` in the filter, and anything else —
 * another user's folder, a malformed id, a deleted one — is the same 404. Never 403: a 403 confirms
 * the row exists, and ObjectIds are enumerable.
 *
 * A LINKED FOLDER BRINGS ITS SIBLINGS. The nudge is once per EVENT, and its count sums every
 * non-archived folder of this user linked to that event (`followUpCandidates`), so this screen lists
 * the same set — otherwise the notification could say 5 and the screen show 3.
 *
 * What goes back is `buildFollowUpLanding`'s allowlist: no phone, no note, no tags, no raw QR payload.
 * The note reaches the screen only through `GET /api/people/[id]/draft`, the one definition of what a
 * draft is written from.
 */

function json(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ folderId: string }> }
) {
  // GUARD FIRST — before the id is even read, so an anonymous request learns nothing about it.
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  try {
    const { folderId } = await params;
    if (!isObjectIdLike(folderId)) return json({ error: 'Not found' }, 404);

    await connectDB();
    const folder = await Folder.findOne({ _id: folderId, userId: gate.userId })
      .select('name eventId eventDate venue')
      .lean();
    if (!folder) return json({ error: 'Not found' }, 404);

    const folderIds = [folder._id];
    if (folder.eventId) {
      const siblings = await Folder.find({
        userId: gate.userId,
        eventId: folder.eventId,
        archivedAt: null,
        _id: { $ne: folder._id },
      })
        .select('_id')
        .lean();
      folderIds.push(...siblings.map(s => s._id));
    }

    const contacts = await Contact.find({ userId: gate.userId, folderId: { $in: folderIds } })
      .select('folderId personId name role company linkedin linkedinSlug email followedUp scannedAt')
      .lean();

    return json(buildFollowUpLanding(folder, contacts), 200);
  } catch (error) {
    console.error('Error loading follow-ups:', error);
    return json({ error: 'Could not load the people from this event.' }, 500);
  }
}
