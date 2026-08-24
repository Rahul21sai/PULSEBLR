import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongodb';
import Contact from '@/lib/models/Contact';
import Event from '@/lib/models/Event';
import { requireUser } from '@/lib/api-auth';
import { findOwnedFolder, folderToDTO, contactToDTO, isValidId } from '@/lib/contacts/service';

/**
 * One folder: read it with its contacts, rename it, archive it, or delete it.
 *
 * `params` is a Promise in Next 16.2.9 and must be awaited. The inline type is used rather
 * than the generated `RouteContext<'/api/folders/[id]'>` helper, because that helper indexes
 * a union in `.next/types/routes.d.ts` which only lists routes present at the last build —
 * so a brand-new route does not typecheck until typegen re-runs.
 */

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  try {
    await connectDB();
    const { id } = await params;
    const folder = await findOwnedFolder(gate.userId, id);
    // Same 404 for "not yours" as for "does not exist", so ownership is not observable.
    if (!folder) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const contacts = await Contact.find({ userId: gate.userId, folderId: folder._id })
      .sort({ scannedAt: -1 })
      .lean();

    return NextResponse.json({
      folder: folderToDTO(folder.toObject(), { contactCount: contacts.length }),
      contacts: contacts.map(contactToDTO),
    });
  } catch (error) {
    console.error('Error fetching folder:', error);
    return NextResponse.json({ error: 'Failed to fetch folder' }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  try {
    await connectDB();
    const { id } = await params;
    const folder = await findOwnedFolder(gate.userId, id);
    if (!folder) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const body = await request.json().catch(() => ({}));

    // `userId` is never assignable — ownership cannot be transferred by a request body.
    if (typeof body.name === 'string' && body.name.trim()) folder.name = body.name.trim();
    if (typeof body.note === 'string') folder.note = body.note;
    if (typeof body.venue === 'string') folder.venue = body.venue;

    if (typeof body.eventDate === 'string') {
      const parsed = new Date(body.eventDate);
      if (!Number.isNaN(parsed.getTime())) folder.eventDate = parsed;
    }

    if (typeof body.eventId === 'string') {
      if (!body.eventId) {
        folder.eventId = undefined;
      } else if (isValidId(body.eventId)) {
        const event = await Event.findById(body.eventId).select('startDateTime venue area');
        if (event) {
          folder.eventId = event._id;
          if (!folder.eventDate) folder.eventDate = event.startDateTime;
          if (!folder.venue) folder.venue = event.venue || event.area || undefined;
        }
      }
    }

    if (typeof body.archived === 'boolean') {
      folder.archivedAt = body.archived ? new Date() : undefined;
    }

    // `.save()` so the slug-deriving `pre('validate')` hook runs on a rename.
    await folder.save();
    return NextResponse.json({ folder: folderToDTO(folder.toObject()) });
  } catch (error) {
    const err = error as { code?: number; message?: string };
    if (err.code === 11000) {
      return NextResponse.json(
        { error: 'You already have a folder with that name' },
        { status: 409 }
      );
    }
    console.error('Error updating folder:', error);
    return NextResponse.json({ error: 'Failed to update folder' }, { status: 500 });
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  try {
    await connectDB();
    const { id } = await params;
    const folder = await findOwnedFolder(gate.userId, id);
    if (!folder) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    // Contacts are deleted with their folder. They are meaningless without it — a contact
    // records "who I met at this event" — and leaving them behind would make them
    // unreachable rather than preserved. Scoped by userId as well as folderId on principle.
    const removed = await Contact.deleteMany({ userId: gate.userId, folderId: folder._id });
    await folder.deleteOne();

    return NextResponse.json({ message: 'Deleted', contactsDeleted: removed.deletedCount ?? 0 });
  } catch (error) {
    console.error('Error deleting folder:', error);
    return NextResponse.json({ error: 'Failed to delete folder' }, { status: 500 });
  }
}
