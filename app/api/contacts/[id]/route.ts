import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongodb';
import Contact from '@/lib/models/Contact';
import { requireUser } from '@/lib/api-auth';
import {
  contactToDTO,
  findOwnedFolder,
  isValidId,
  updateOwnedContact,
} from '@/lib/contacts/service';

/** Edit or delete one contact. Ownership is enforced by putting `userId` in the filter. */

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  try {
    await connectDB();
    const { id } = await params;
    const body = await request.json().catch(() => ({}));

    // Moving a contact to another folder must verify the DESTINATION is also the user's,
    // or a contact could be pushed into a folder somebody else owns.
    if (typeof body.folderId === 'string' && body.folderId) {
      const destination = await findOwnedFolder(gate.userId, body.folderId);
      if (!destination) return NextResponse.json({ error: 'Folder not found' }, { status: 404 });
      const moved = await Contact.findOne({ _id: isValidId(id) ? id : null, userId: gate.userId });
      if (!moved) return NextResponse.json({ error: 'Not found' }, { status: 404 });
      moved.folderId = destination._id;
      await moved.save();
    }

    const contact = await updateOwnedContact(gate.userId, id, body);
    if (!contact) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    return NextResponse.json({ contact: contactToDTO(contact.toObject()) });
  } catch (error) {
    console.error('Error updating contact:', error);
    return NextResponse.json(
      {
        error: 'Failed to update contact',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
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
    if (!isValidId(id)) return NextResponse.json({ error: 'Invalid ID' }, { status: 400 });

    const contact = await Contact.findOneAndDelete({ _id: id, userId: gate.userId });
    if (!contact) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    return NextResponse.json({ message: 'Deleted' });
  } catch (error) {
    console.error('Error deleting contact:', error);
    return NextResponse.json({ error: 'Failed to delete contact' }, { status: 500 });
  }
}
