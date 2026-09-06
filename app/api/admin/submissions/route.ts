import { NextRequest, NextResponse } from 'next/server';
import mongoose from 'mongoose';
import connectDB from '@/lib/mongodb';
import Event from '@/lib/models/Event';
import User from '@/lib/models/User';
import { requireAdmin } from '@/lib/api-auth';

/**
 * The review queue for events users have submitted to the shared feed.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS ROUTE HAS TO EXIST, rather than reviewing through the normal events list.
 *
 * `/admin`'s events panel lists through `GET /api/events`, and that route now scopes to the caller:
 * `visibility: 'public'` OR no visibility key OR `createdByUserId === me`. A pending submission
 * belongs to somebody else, so it matches none of those arms — which means the moment user
 * submissions existed, they became invisible to the very person meant to approve them. Offering
 * "add for everyone" with no review surface is offering a queue that silently goes nowhere.
 *
 * It is a SEPARATE ENDPOINT rather than a `pending=true` flag on the feed, because it asks a
 * different question with different permissions. The feed's job is "what may this viewer see";
 * this one's is "what is waiting for a decision", and it is `requireAdmin()` throughout. Adding an
 * admin escape hatch to `buildEventFilter` would put a privilege branch inside the one function
 * every public read path depends on — the last place it belongs.
 *
 * WHY IT SHOWS THE SUBMITTER'S EMAIL. A reviewer is being asked to publish a stranger's `applyLink`
 * to everybody, which is the phishing vector the admin guard exists to close. Knowing who is asking
 * is part of that judgement. It is looked up per page rather than denormalised onto the event, so
 * nothing has to be kept in sync.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */

export async function GET(request: NextRequest) {
  const gate = await requireAdmin();
  if ('response' in gate) return gate.response;

  try {
    await connectDB();
    const includeDecided = request.nextUrl.searchParams.get('includeDecided') === 'true';

    const events = await Event.find(
      includeDecided
        ? { createdByUserId: { $exists: true } }
        : { visibility: 'pending' }
    )
      .select(
        'title description organizer venue address area city format startDateTime endDateTime ' +
          'category isFree price applyLink sourceUrl imageUrl visibility createdByUserId createdAt ' +
          'isTechEvent'
      )
      // Oldest first: a review queue is worked front to back, and the person who has been waiting
      // longest should not be at the bottom.
      .sort({ createdAt: 1 })
      .limit(200)
      .lean();

    // One lookup for the whole page, then an in-memory join — the discipline `listFolders` uses.
    const ownerIds = [...new Set(events.map(e => e.createdByUserId).filter(Boolean))] as string[];
    const users = await User.find({ googleId: { $in: ownerIds } })
      .select('googleId email name')
      .lean();
    const byId = new Map(users.map(u => [u.googleId, u]));

    return NextResponse.json({
      submissions: events.map(e => ({
        ...e,
        _id: String(e._id),
        submitter: byId.get(e.createdByUserId as string)
          ? {
              email: byId.get(e.createdByUserId as string)!.email,
              name: byId.get(e.createdByUserId as string)!.name,
            }
          : // A valid session can legitimately have no User row (the E11000 case that made
            // /api/me/card 404), so a missing submitter is reported rather than hiding the event.
            null,
      })),
    });
  } catch (error) {
    console.error('Error listing submissions:', error);
    return NextResponse.json({ error: 'Failed to list submissions' }, { status: 500 });
  }
}

/**
 * Approve or reject one submission.
 *
 * APPROVE clears `visibility` rather than setting `'public'`, so the row ends up in exactly the
 * shape every scraped document has — absent means public, and that is the state ~1500 existing
 * documents are in. Setting the string instead would create a second representation of "public"
 * that every filter would then have to handle, forever.
 *
 * `createdByUserId` is KEPT on an approved event. It is provenance — it records that a person
 * added this rather than a scraper — and it is what keeps the row out of `pruneStale()`, which
 * would otherwise delete it a week after it happened with no upstream to re-create it from.
 *
 * REJECT sets `'private'` rather than deleting. The user typed it in; it is theirs. Rejecting a
 * submission is a decision about the SHARED feed, not permission to destroy somebody's own record —
 * so it simply goes back to being their private event, and they keep whatever they tracked or
 * scanned against it.
 */
export async function PATCH(request: NextRequest) {
  const gate = await requireAdmin();
  if ('response' in gate) return gate.response;

  try {
    await connectDB();
    const body = (await request.json().catch(() => ({}))) as { id?: string; decision?: string };

    if (typeof body.id !== 'string' || !mongoose.Types.ObjectId.isValid(body.id)) {
      return NextResponse.json({ error: 'A valid event id is required.' }, { status: 400 });
    }
    if (body.decision !== 'approve' && body.decision !== 'reject') {
      return NextResponse.json(
        { error: "decision must be 'approve' or 'reject'." },
        { status: 400 }
      );
    }

    /**
     * Scoped to `visibility: 'pending'` in the FILTER, not checked afterwards.
     *
     * So this route can only ever act on something actually awaiting review — it cannot be used to
     * flip an unrelated event public, or to re-decide one that has already been decided. A miss is
     * a 404 with no distinction between "already handled" and "never existed".
     */
    const event = await Event.findOne({ _id: body.id, visibility: 'pending' });
    if (!event) {
      return NextResponse.json({ error: 'No submission waiting on that id.' }, { status: 404 });
    }

    if (body.decision === 'approve') {
      // `set(path, undefined)` on a document, which Mongoose turns into `$unset` on save. Written
      // explicitly rather than `event.visibility = undefined` so the intent is unmistakable: the
      // key must be REMOVED, not stored as null. A stored null would fail the
      // `{ visibility: { $exists: false } }` arm every visibility filter relies on and leave the
      // approved event invisible — the same trap CLAUDE.md records for `spotlightAt`, where
      // unpinning has to send an explicit null because a plain `$set` cannot express `$unset`.
      event.set('visibility', undefined);
    } else {
      event.visibility = 'private';
    }
    // `.save()` rather than `findOneAndUpdate`, so the `pre('validate')` key hooks run. They are
    // no-ops here — both keys already exist and neither derives from `visibility` — but the rule
    // that every Event write goes through document middleware is worth not breaking for one route.
    await event.save();

    return NextResponse.json({ id: String(event._id), decision: body.decision });
  } catch (error) {
    console.error('Error deciding submission:', error);
    return NextResponse.json({ error: 'Failed to record that decision' }, { status: 500 });
  }
}
