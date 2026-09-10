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

    /*
     * RECOMPUTE THE PERSON. This route was the odd one out, and the asymmetry was doing damage.
     *
     * `DELETE` below already calls `onContactDeleted`, and the bulk path recomputes too — so editing
     * one contact was the ONLY write that left its Person behind. `Person.tags` is derived as
     * `canonicaliseTags(captureTags ∪ ownTags)` and `nextActionAt` as the soonest outstanding
     * follow-up across captures, so a tag added here never reached the `/people` facet rail and a
     * follow-up date set here never moved the person's "next action". The row looked saved, the
     * contact WAS saved, and the surface built to find people by tag simply did not know.
     *
     * Non-fatal and after the fact, matching the delete path: the write the user asked for has
     * committed, so a failure here is a consistency problem to log and repair with `recomputePerson`
     * — not a reason to tell them their edit failed when it did not.
     *
     * Lazily imported so this route does not pull the whole people service (and every model it
     * registers) into its module graph for a request that may not touch a Person at all.
     */
    if (contact.personId) {
      try {
        const { recomputePerson } = await import('@/lib/people/service');
        await recomputePerson(gate.userId, contact.personId);
      } catch (err) {
        console.error('Contact updated but the person spine was not recomputed:', err);
      }
    }

    return NextResponse.json({ contact: contactToDTO(contact.toObject()) });
  } catch (error) {
    /*
     * NO `details` ON THE 500. It used to return `error.message`, which on this route is a
     * Mongoose ValidationError or CastError naming the model and the schema path — the same
     * reconnaissance `lib/tracker/validate.ts` exists to stop handing out, and for the same
     * two reasons: a client error reported as a server fault tells the caller to retry when
     * retrying can never work, and the wording describes the internal shape of the data.
     * The real message is in the server log, which is where it is useful.
     *
     * A malformed `id` is already a 404 rather than a crash — `updateOwnedContact` and the
     * folder-move branch both run `isValidId` first — so this branch is a genuine fault.
     */
    console.error('Error updating contact:', error);
    return NextResponse.json({ error: 'Failed to update contact' }, { status: 500 });
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

    /*
     * CLEAN UP THE SPINE, and do it after the delete has actually happened.
     *
     * Without this the capture is gone while its `met` Interaction still points at it and the
     * Person's counters still count it — so `/people` would show "met 3×" for someone you have two
     * encounters with, and the timeline would carry a row referencing nothing. `onContactDeleted`
     * removes the interactions for this contact, recomputes the Person, and deletes the Person
     * outright if that was its last contact, because an empty Person is a ghost row that appears in
     * the list with no history behind it.
     *
     * Non-fatal on purpose: the delete the user asked for has already committed, so a failure here
     * is a consistency problem to log and repair with `recomputePerson`, not a reason to tell them
     * their delete failed when it did not.
     */
    try {
      const { onContactDeleted } = await import('@/lib/people/service');
      await onContactDeleted(gate.userId, contact.personId, contact._id);
    } catch (err) {
      console.error('Contact deleted but the person spine was not updated:', err);
    }

    return NextResponse.json({ message: 'Deleted' });
  } catch (error) {
    console.error('Error deleting contact:', error);
    return NextResponse.json({ error: 'Failed to delete contact' }, { status: 500 });
  }
}
