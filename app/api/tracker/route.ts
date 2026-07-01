import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongodb';
import TrackerEntry from '@/lib/models/TrackerEntry';
import Event from '@/lib/models/Event';
import { getCurrentUserId } from '@/lib/auth-helpers';

// GET /api/tracker — list entries for the signed-in user
export async function GET(request: NextRequest) {
  const userId = await getCurrentUserId();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    await connectDB();

    const filter: any = { userId };
    const status = request.nextUrl.searchParams.get('status');
    if (status) filter.status = { $in: status.split(',') };

    const entries = await TrackerEntry.find(filter)
      .populate('eventId')
      .sort({ updatedAt: -1 })
      .lean();

    return NextResponse.json({ entries });
  } catch (error) {
    console.error('Error fetching tracker entries:', error);
    return NextResponse.json({ error: 'Failed to fetch tracker entries' }, { status: 500 });
  }
}

// POST /api/tracker — create entry for the signed-in user
export async function POST(request: NextRequest) {
  const userId = await getCurrentUserId();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    await connectDB();

    const body = await request.json();

    const event = await Event.findById(body.eventId);
    if (!event) return NextResponse.json({ error: 'Event not found' }, { status: 404 });

    // One entry per user per event
    const existing = await TrackerEntry.findOne({ userId, eventId: body.eventId });
    if (existing) {
      return NextResponse.json(
        { error: 'Already tracking this event', entry: existing },
        { status: 409 }
      );
    }

    const entry = await TrackerEntry.create({ ...body, userId });
    const populated = await TrackerEntry.findById(entry._id).populate('eventId');

    return NextResponse.json(populated, { status: 201 });
  } catch (error: any) {
    console.error('Error creating tracker entry:', error);
    if (error.code === 11000) {
      return NextResponse.json({ error: 'Already tracking this event' }, { status: 409 });
    }
    return NextResponse.json({ error: 'Failed to create tracker entry', details: error.message }, { status: 500 });
  }
}
