import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongodb';
import Contact from '@/lib/models/Contact';
import { requireUser } from '@/lib/api-auth';
import { contactToDTO, findOwnedFolder, isValidId, upsertContact } from '@/lib/contacts/service';
import type { ContactInput } from '@/lib/contacts/types';

/**
 * GET  /api/contacts?folderId=… — list, optionally scoped to one folder.
 * POST /api/contacts            — create one, IDEMPOTENTLY on `clientId`.
 *
 * The idempotency is the whole point of the POST. The scanner writes to IndexedDB first and
 * posts afterwards, possibly several times over a saturated conference network. A duplicate
 * `clientId` therefore answers **200 with the existing document**, not 409: treating a
 * replay as a conflict would either duplicate the person or convince the client its write
 * failed and needed retrying forever.
 */

export async function GET(request: NextRequest) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  try {
    await connectDB();
    const filter: Record<string, unknown> = { userId: gate.userId };

    const folderId = request.nextUrl.searchParams.get('folderId');
    if (folderId) {
      if (!isValidId(folderId)) {
        return NextResponse.json({ error: 'Invalid folder id' }, { status: 400 });
      }
      filter.folderId = folderId;
    }

    if (request.nextUrl.searchParams.get('pendingFollowUp') === 'true') {
      filter.followUpAt = { $ne: null };
      filter.followedUp = { $ne: true };
    }

    const contacts = await Contact.find(filter).sort({ scannedAt: -1 }).limit(2000).lean();
    return NextResponse.json({ contacts: contacts.map(contactToDTO) });
  } catch (error) {
    console.error('Error listing contacts:', error);
    return NextResponse.json({ error: 'Failed to list contacts' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  // Read once, into a variable the catch block can see too: `request.clone()` only works before
  // the body has been consumed, so cloning after `await request.json()` throws.
  let body: Record<string, unknown> = {};

  try {
    await connectDB();
    body = await request.json().catch(() => ({}));

    const clientId = typeof body.clientId === 'string' ? body.clientId.trim() : '';
    if (!clientId) {
      // Without it there is no idempotency key, and a retry would duplicate the person.
      return NextResponse.json({ error: 'clientId is required' }, { status: 400 });
    }
    if (typeof body.name !== 'string' || !body.name.trim()) {
      return NextResponse.json({ error: 'A name is required' }, { status: 400 });
    }

    const folderId = typeof body.folderId === 'string' ? body.folderId : '';
    const folder = await findOwnedFolder(gate.userId, folderId);
    if (!folder) return NextResponse.json({ error: 'Folder not found' }, { status: 404 });

    // `body` is untrusted `Record<string, unknown>`; the cast is safe because `upsertContact`
    // passes everything through `pickWritable`, which coerces each field to the type the schema
    // expects and drops anything not on the allow-list. `name` and `clientId` are checked above.
    const { contact, created } = await upsertContact(gate.userId, folder._id, {
      ...body,
      clientId,
    } as unknown as ContactInput);

    return NextResponse.json(
      { contact: contactToDTO(contact.toObject()), created },
      { status: created ? 201 : 200 }
    );
  } catch (error) {
    const err = error as { code?: number; message?: string };
    if (err.code === 11000) {
      // Lost a race with a concurrent replay of the same clientId. The unique index did its
      // job; read the winner back and answer as if this request had been the replay.
      const existing = await Contact.findOne({
        userId: gate.userId,
        clientId: String(body.clientId ?? ''),
      }).lean();
      if (existing) {
        return NextResponse.json({ contact: contactToDTO(existing), created: false });
      }
    }
    console.error('Error creating contact:', error);
    return NextResponse.json(
      { error: 'Failed to save contact', details: err.message ?? String(error) },
      { status: 500 }
    );
  }
}
