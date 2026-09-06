import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongodb';
import Contact from '@/lib/models/Contact';
import { requireUser } from '@/lib/api-auth';
import {
  attachFolderNames,
  contactKeyEventCounts,
  contactToDTO,
  findOwnedFolder,
  isValidId,
  upsertContact,
} from '@/lib/contacts/service';
import {
  buildContactFilter,
  buildContactSort,
  repeatKeys,
  parseContactQuery,
  type ContactSort,
} from '@/lib/contacts/query';
import { ITEM_REFUSALS } from '@/lib/scan/failure';
import type { ContactDTO, ContactInput } from '@/lib/contacts/types';

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

/** One page of the People list. Small enough to render fast, large enough to scroll into. */
const PAGE_SIZE = 60;
const MAX_PAGE_SIZE = 200;

export async function GET(request: NextRequest) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  try {
    await connectDB();
    const search = request.nextUrl.searchParams;
    const params = parseContactQuery(search);

    if (params.folderId && !isValidId(params.folderId)) {
      return NextResponse.json({ error: 'Invalid folder id' }, { status: 400 });
    }

    // `pendingFollowUp` is the OLD param name and is still honoured: `app/dashboard` and the
    // digest preview send it, and renaming a query param is not worth breaking a caller over.
    if (search.get('pendingFollowUp') === 'true') params.followUpDue = true;

    const filter = buildContactFilter(gate.userId, params);
    const sort = buildContactSort((search.get('sort') as ContactSort) ?? 'recent');

    /**
     * `repeatOnly` RESOLVES TO A REAL QUERY FILTER, in two stages.
     *
     * It cannot be one predicate, because "have I met this person before" is a property of a GROUP
     * of documents sharing a `contactKey`, not a field on any of them — see the note in
     * `lib/contacts/query.ts`. So the keys are resolved first and then matched with `$in`.
     *
     * THE FIRST ATTEMPT FILTERED THE PAGE AFTER THE QUERY, and it was wrong in a way only visible
     * on screen: the row list narrowed correctly to two rows while the count beside it still read
     * "6 people", because `countDocuments` had run against the unfiltered filter. It also broke
     * pagination — a page of 60 could return three rows with more matches further down, and
     * "load more" would have no idea. Two stages costs one extra aggregate on a toggle nobody
     * holds on permanently, and everything downstream is then simply correct.
     *
     * `$in: []` when nobody qualifies matches nothing, which is the right answer rather than an
     * edge case to special-case.
     */
    let repeatCounts: Map<string, number> | null = null;
    if (params.repeatOnly) {
      repeatCounts = await contactKeyEventCounts(gate.userId);
      filter.contactKey = { $in: repeatKeys(repeatCounts) };
    }

    const limit = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, Number(search.get('limit')) || PAGE_SIZE)
    );
    const skip = Math.max(0, Number(search.get('skip')) || 0);

    /**
     * `countDocuments` alongside the page, so the UI can say "1 of 340" and offer a real
     * "load more" rather than guessing from whether the page came back full. It runs against the
     * SAME filter object, which is the property `lib/contacts/query.ts` exists to guarantee.
     */
    const [rows, total, counts] = await Promise.all([
      Contact.find(filter).sort(sort).skip(skip).limit(limit).lean(),
      Contact.countDocuments(filter),
      // Only when it will be used, and reusing the map the repeat filter already built rather
      // than running the same aggregate twice. It is a full pass over the user's contacts, so it
      // is not worth running at all for a folder table with no "met N times" badge.
      repeatCounts
        ? Promise.resolve(repeatCounts)
        : search.get('withMetCount') === 'true'
          ? contactKeyEventCounts(gate.userId)
          : Promise.resolve(new Map<string, number>()),
    ]);

    let contacts: ContactDTO[] = rows.map(contactToDTO).map(c => {
      const metCount = counts.get(c.contactKey);
      // Spread conditionally rather than assigning `undefined`: `metCount` is optional on the DTO,
      // and writing the key with an undefined value makes the object a different (wider) type and
      // puts a null in the JSON for every row when the count was not requested.
      return metCount === undefined ? c : { ...c, metCount };
    });

    // Folder names only for the cross-folder view. A folder table already knows its own name, and
    // this is an extra query.
    if (!params.folderId) contacts = await attachFolderNames(contacts);

    return NextResponse.json({
      contacts,
      total,
      hasMore: skip + rows.length < total,
      nextSkip: skip + rows.length,
    });
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
      return NextResponse.json(
        { error: ITEM_REFUSALS['missing-client-id'], refusal: 'missing-client-id' },
        { status: 400 }
      );
    }
    if (typeof body.name !== 'string' || !body.name.trim()) {
      return NextResponse.json(
        { error: ITEM_REFUSALS['missing-name'], refusal: 'missing-name' },
        { status: 400 }
      );
    }

    const folderId = typeof body.folderId === 'string' ? body.folderId : '';
    const folder = await findOwnedFolder(gate.userId, folderId);
    if (!folder) {
      return NextResponse.json(
        {
          error: ITEM_REFUSALS[folderId ? 'folder-not-found' : 'no-folder'],
          refusal: folderId ? 'folder-not-found' : 'no-folder',
        },
        { status: 404 }
      );
    }

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
    // No `details`. It carried `err.message`, which on a Mongoose error names the model and the
    // schema path — the leak the tracker write paths had to stop, and this route is on the
    // capture hot path so the string reaches a phone at an event. `saveContact` never read it
    // (it reads `error`/`refusal`), and a 500 is classified transient regardless, so nothing
    // anywhere depended on it. The real wording is in the log line above.
    return NextResponse.json({ error: 'Failed to save contact' }, { status: 500 });
  }
}
