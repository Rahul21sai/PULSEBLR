import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongodb';
import Event from '@/lib/models/Event';
import mongoose from 'mongoose';
import { requireAdmin } from '@/lib/api-auth';
import { validateEventUpdate, eventValidationError } from '@/lib/events/admin-validate';

// GET /api/events/[id] - Get a single event
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await connectDB();
    const { id } = await params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return NextResponse.json({ error: 'Invalid event ID' }, { status: 400 });
    }

    const event = await Event.findById(id).lean();

    if (!event) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 });
    }

    // "Similar events" for the detail page: same categories, still upcoming,
    // soonest first. Excludes this event and anything already finished.
    const related = await Event.find({
      _id: { $ne: event._id },
      startDateTime: { $gte: new Date() },
      category: { $in: event.category?.length ? event.category : ['Networking/Meetup'] },
    })
      .select('title startDateTime venue area format imageUrl category isFree price organizer')
      .sort({ startDateTime: 1 })
      .limit(6)
      .lean();

    return NextResponse.json({ event, related });
  } catch (error) {
    console.error('Error fetching event:', error);
    return NextResponse.json({ error: 'Failed to fetch event' }, { status: 500 });
  }
}

// PUT /api/events/[id] - Update an event. ADMIN ONLY: events are global, so an open
// update endpoint lets anyone rewrite any event's title, time or applyLink.
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const gate = await requireAdmin();
  if ('response' in gate) return gate.response;

  const { id } = await params;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return NextResponse.json({ error: 'Invalid event ID' }, { status: 400 });
  }

  /*
   * VALIDATE BEFORE connectDB(), AFTER the guard. A bad request needs no database to refuse, and
   * the guard must answer first so an anonymous caller gets 401 rather than 400 — a 400 would tell
   * a stranger their body parsed far enough to be judged. See the ordering note in CLAUDE.md §6.
   */
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'request body must be valid JSON' }, { status: 400 });
  }

  /*
   * An ALLOWLIST, replacing `{ $set: body }` with only `dedupHash` removed.
   *
   * That was survivable while the only caller sent two booleans and a date; it is not once a real
   * edit form exists. A raw `$set` let a typo rewrite `clusterKey` (identity — the event detaches
   * from its cluster and the next scrape stores a duplicate), `lastSeenAt` (provenance — decides
   * when `pruneStale()` deletes the row), or `connectionScore` / `companies` (derived — the next
   * backfill silently reverts the change, so the admin watches their edit vanish).
   */
  const { update, issues } = validateEventUpdate(body);
  if (issues.length > 0) {
    return NextResponse.json(eventValidationError(issues), { status: 400 });
  }
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: 'no editable fields were supplied' }, { status: 400 });
  }

  try {
    await connectDB();

    const event = await Event.findByIdAndUpdate(
      id,
      { $set: update },
      { new: true, runValidators: true }
    );

    if (!event) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 });
    }

    return NextResponse.json({ event });
  } catch (error) {
    console.error('Error updating event:', error);
    // `details` used to carry `error.message`, which handed back the model name and the schema
    // path — free reconnaissance on the internal shape of the data. Nothing read it; the real
    // wording is in the server log. Unreachable while the validator and the schema agree.
    if (error instanceof mongoose.Error.ValidationError || error instanceof mongoose.Error.CastError) {
      return NextResponse.json({ error: 'Invalid event' }, { status: 400 });
    }
    return NextResponse.json({ error: 'Failed to update event' }, { status: 500 });
  }
}

// DELETE /api/events/[id] - Delete an event. ADMIN ONLY: real ids are handed out by
// the public GET /api/events, so an open delete is a trivially targetable way to
// empty the corpus one curl at a time.
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const gate = await requireAdmin();
  if ('response' in gate) return gate.response;

  try {
    await connectDB();
    const { id } = await params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return NextResponse.json({ error: 'Invalid event ID' }, { status: 400 });
    }

    const event = await Event.findByIdAndDelete(id);

    if (!event) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 });
    }

    return NextResponse.json({ message: 'Event deleted successfully' });
  } catch (error) {
    console.error('Error deleting event:', error);
    return NextResponse.json({ error: 'Failed to delete event' }, { status: 500 });
  }
}
