import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongodb';
import Event from '@/lib/models/Event';
import mongoose from 'mongoose';
import { requireAdmin } from '@/lib/api-auth';

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

  try {
    await connectDB();
    const { id } = await params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return NextResponse.json({ error: 'Invalid event ID' }, { status: 400 });
    }

    const body = await request.json();
    delete body.dedupHash;

    const event = await Event.findByIdAndUpdate(
      id,
      { $set: body },
      { new: true, runValidators: true }
    );

    if (!event) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 });
    }

    return NextResponse.json({ event });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Error updating event:', error);
    return NextResponse.json(
      { error: 'Failed to update event', details: message },
      { status: 500 }
    );
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
