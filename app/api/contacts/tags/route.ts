import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongodb';
import Contact from '@/lib/models/Contact';
import { requireUser } from '@/lib/api-auth';
import {
  addContactTags,
  canonicaliseTagVocabulary,
  getContactTags,
  isValidId,
  removeContactTag,
} from '@/lib/contacts/service';
import { errorLogLine, routeFailure } from '@/lib/http/errors';

/**
 * The user's tag vocabulary, and bulk application of it.
 *
 *   GET    — every tag they can pick from (stored vocabulary ∪ what is on their contacts).
 *   POST   — create tags, and optionally apply them to a set of contacts in one request.
 *   DELETE — remove a tag from the vocabulary AND from every contact carrying it.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY BULK APPLY IS PART OF THIS AND NOT A NICE-TO-HAVE. The feature is "tag the people I met so I
 * can find who works where". A user comes back from a conference with forty scans. Tagging them one
 * edit sheet at a time is forty sheets, and the feature would be technically complete and never
 * used. One request that applies a tag to a selection is the difference.
 *
 * GUARD FIRST, VALIDATE SECOND — `requireUser()` runs before the body is read, so an anonymous
 * caller with a malformed payload gets 401 and not 400. A 400 would tell a stranger their body
 * parsed and validated far enough to be judged, and it breaks the contract
 * `scripts/diag-api-auth.ts` asserts.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */

/** Enough for a very busy conference; past this something is being scripted. */
const MAX_BULK_CONTACTS = 500;

export async function GET() {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  try {
    await connectDB();
    return NextResponse.json({ tags: await getContactTags(gate.userId) });
  } catch (error) {
    // No input, so always the server's fault; logged as one inert line.
    console.error('Error listing contact tags:', errorLogLine(error));
    return NextResponse.json({ error: 'Failed to list tags' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  try {
    await connectDB();
    const body = (await request.json().catch(() => ({}))) as {
      tags?: unknown;
      contactIds?: unknown;
    };

    const tags = canonicaliseTagVocabulary(body.tags);
    if (!tags.length) {
      return NextResponse.json(
        { error: 'Give at least one tag. A tag is up to 40 characters.' },
        { status: 400 }
      );
    }

    const ids = Array.isArray(body.contactIds)
      ? body.contactIds.filter((id): id is string => typeof id === 'string' && isValidId(id))
      : [];
    if (ids.length > MAX_BULK_CONTACTS) {
      return NextResponse.json(
        { error: `Too many people in one go (max ${MAX_BULK_CONTACTS}).` },
        { status: 400 }
      );
    }

    const vocabulary = await addContactTags(gate.userId, tags);

    let tagged = 0;
    if (ids.length) {
      /**
       * `$addToSet` with `updateMany`, which SKIPS document middleware — normally forbidden on
       * Contact, because the `contactKey` hook lives in `pre('validate')` and
       * `findOneAndUpdate`/`updateMany` do not run it.
       *
       * Safe here, and only here, for a specific reason: `contactKey` derives from
       * `linkedinSlug`, `email`, `phone` and `name`, and adding a tag cannot touch any of them, so
       * there is nothing for the hook to recompute. And `companies` no longer derives from `tags`
       * at all (see the warning in `deriveContactMeta`) — which is what makes this a pure array
       * append rather than something that has to re-run derivation. Before that fix this update
       * would have left `companies` stale.
       *
       * `userId` is in the filter, so a caller cannot tag somebody else's contacts by id.
       */
      const result = await Contact.updateMany(
        { userId: gate.userId, _id: { $in: ids } },
        { $addToSet: { tags: { $each: tags } } }
      );
      tagged = result.modifiedCount ?? 0;
    }

    return NextResponse.json({ tags: vocabulary, tagged }, { status: 201 });
  } catch (error) {
    console.error('Error creating contact tags:', errorLogLine(error));
    // The vocabulary is stored as `User.contactTags` and applied as `Contact.tags`; the ids query
    // `_id`. Named by what the caller sent, and nothing else on the User row is theirs to be told.
    const failure = routeFailure(error, 'Failed to save tags', {
      rename: { contactTags: 'tags', _id: 'contactIds' },
      fields: ['tags', 'contactIds'],
      collapseIndices: true,
    });
    return NextResponse.json(failure.body, { status: failure.status });
  }
}

export async function DELETE(request: NextRequest) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  try {
    await connectDB();
    const tag = request.nextUrl.searchParams.get('tag');
    if (!tag?.trim()) {
      return NextResponse.json({ error: 'Name the tag to remove.' }, { status: 400 });
    }

    await removeContactTag(gate.userId, tag);
    return NextResponse.json({ tags: await getContactTags(gate.userId) });
  } catch (error) {
    console.error('Error removing contact tag:', errorLogLine(error));
    const failure = routeFailure(error, 'Failed to remove tag', {
      rename: { contactTags: 'tag', tags: 'tag' },
      fields: ['tag'],
      collapseIndices: true,
    });
    return NextResponse.json(failure.body, { status: failure.status });
  }
}
