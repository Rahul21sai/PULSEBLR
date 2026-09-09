import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongodb';
import Folder, { folderSlug } from '@/lib/models/Folder';
import Event from '@/lib/models/Event';
import { requireUser } from '@/lib/api-auth';
import { listFolders, folderToDTO, isValidId } from '@/lib/contacts/service';
import { canViewEvent } from '@/lib/events/visibility';

/**
 * GET  /api/folders — every folder the signed-in user owns, with counts.
 * POST /api/folders — create one.
 *
 * Guarded in the handler, because `proxy.ts`'s matcher excludes `api` as its first
 * negative-lookahead term and therefore protects no endpoint. See lib/api-auth.ts.
 */

export async function GET(request: NextRequest) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  try {
    await connectDB();
    const includeArchived = request.nextUrl.searchParams.get('archived') === 'true';
    const folders = await listFolders(gate.userId, includeArchived);
    return NextResponse.json({ folders });
  } catch (error) {
    console.error('Error listing folders:', error);
    return NextResponse.json({ error: 'Failed to list folders' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  /**
   * Read the body ONCE, into a variable the catch block can also see.
   *
   * `request.clone()` only works BEFORE the body has been consumed, so cloning inside the catch
   * — after `await request.json()` — throws, and the duplicate-name path returned 500 instead of
   * 409. Caught by scripts/diag-contact-flow.ts.
   */
  let body: Record<string, unknown> = {};

  try {
    await connectDB();
    body = await request.json().catch(() => ({}));

    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) {
      return NextResponse.json({ error: 'A folder name is required' }, { status: 400 });
    }

    const doc: Record<string, unknown> = {
      userId: gate.userId,
      name,
      note: typeof body.note === 'string' ? body.note : undefined,
      venue: typeof body.venue === 'string' ? body.venue : undefined,
    };

    if (typeof body.eventDate === 'string' && body.eventDate) {
      const parsed = new Date(body.eventDate);
      if (!Number.isNaN(parsed.getTime())) doc.eventDate = parsed;
    }

    /**
     * Linking to a corpus event copies its title, date and venue ACROSS rather than
     * relying on the reference. `pruneStale()` deletes events 7 days past on every scrape,
     * so a folder that depended on the join would lose its own name a week after the event
     * it is named after.
     */
    /*
     * `isValidId` BEFORE `findById`, and it is not cosmetic. A malformed id reaches Mongoose as a
     * CastError, which the catch-all below answered as a 500 carrying `Cast to ObjectId failed …
     * at path "_id" for model "Event"` — the shortest way in the whole app to make it name a
     * model and a path. Refusing the id here removes that path entirely rather than only
     * censoring the response.
     */
    if (typeof body.eventId === 'string' && body.eventId && isValidId(body.eventId)) {
      const event = await Event.findById(body.eventId).select(
        'title startDateTime venue area visibility createdByUserId'
      );
      /**
       * `canViewEvent` IS THE WHOLE POINT OF THIS BRANCH, and it was missing here while the PATCH
       * sibling in `[id]/route.ts` had it — the same operation, guarded on one route and not the
       * other. This was the "sixth id-addressable path" CLAUDE.md said to assume existed.
       *
       * Without it, any signed-in user POSTs a folder naming a stranger's PRIVATE event by id and
       * reads its date and venue straight back out of the response. A Mongo ObjectId is not a
       * secret — it embeds a timestamp and a counter, so one known id makes its neighbours
       * enumerable. And the copy is DURABLE: `eventDate`/`venue` are denormalised on purpose so the
       * folder survives `pruneStale()`, which means no later access-control change can claw it back.
       *
       * `visibility` and `createdByUserId` had to be added to the `.select()` — without them
       * `canViewEvent` reads two undefined fields and returns true for everything, which is the
       * quiet way to add a guard that does nothing.
       *
       * Silently ignored rather than 404'd, matching both the nonexistent-event case here and the
       * PATCH sibling: `eventId` is one optional field of a create that otherwise succeeds, so
       * refusing the whole request would fail a legitimate folder creation over an unrelated id.
       * The folder is simply created unlinked.
       */
      if (event && canViewEvent(event, gate.userId)) {
        doc.eventId = event._id;
        if (!doc.eventDate) doc.eventDate = event.startDateTime;
        if (!doc.venue) doc.venue = event.venue || event.area || undefined;
      }
    }

    const folder = await Folder.create(doc);
    return NextResponse.json({ folder: folderToDTO(folder.toObject()) }, { status: 201 });
  } catch (error) {
    const err = error as { code?: number; message?: string; keyPattern?: Record<string, unknown> };
    /*
     * CHECK WHICH INDEX COLLIDED. This used to assume every 11000 was the { userId, slug }
     * name clash and answer "You already have a folder with that name" — so when the
     * { userId, clientId } index misfired on `clientId: null`, the message named the only
     * thing that was not wrong, and the real fault (nobody could create a second folder at
     * all) stayed hidden behind a plausible sentence. A duplicate-key handler that guesses
     * its own cause turns a schema bug into a user-error message.
     */
    if (err.code === 11000) {
      if (err.keyPattern && 'slug' in err.keyPattern) {
        // The genuine name clash. Returning the existing folder lets the client simply
        // navigate to it, which is what the user wanted anyway.
        const existing = await Folder.findOne({
          userId: gate.userId,
          slug: folderSlug(String(body.name ?? '')),
        }).lean();
        return NextResponse.json(
          {
            error: 'You already have a folder with that name',
            folder: existing ? folderToDTO(existing) : undefined,
          },
          { status: 409 }
        );
      }
      // Any other unique index: report it as the conflict it is rather than mislabelling it.
      console.error('Error creating folder — unexpected duplicate key:', err.keyPattern, err.message);
      return NextResponse.json(
        { error: 'Could not create that folder. Please try again.' },
        { status: 409 }
      );
    }
    /*
     * NO `details` ON THE 500 — the message here was a Mongoose ValidationError or CastError
     * naming the model and the schema path. It stays in the log, which is where the real wording
     * belongs; see the same removal on the tracker write paths.
     *
     * The duplicate-key branch ABOVE deliberately keeps branching on `err.keyPattern`. That is a
     * different thing from this leak: it is how a genuine name clash gets reported as a name
     * clash. A handler that guesses its own cause once reported a schema bug (every user capped
     * at one folder) as "You already have a folder with that name" — the only thing that was not
     * wrong. Do not collapse the two branches.
     */
    console.error('Error creating folder:', error);
    return NextResponse.json({ error: 'Failed to create folder' }, { status: 500 });
  }
}
