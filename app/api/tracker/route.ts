import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongodb';
import TrackerEntry from '@/lib/models/TrackerEntry';
import Event from '@/lib/models/Event';

// GET /api/tracker - List all tracker entries with populated event data
export async function GET(request: NextRequest) {
  try {
    await connectDB();

    const searchParams = request.nextUrl.searchParams;
    
    // Build filter object
    const filter: any = {};
    
    // Status filter (can be multiple)
    const status = searchParams.get('status');
    if (status) {
      filter.status = { $in: status.split(',') };
    }
    
    // Sort by updated date (most recent first)
    const entries = await TrackerEntry.find(filter)
      .populate('eventId')
      .sort({ updatedAt: -1 })
      .lean();
    
    return NextResponse.json({ entries });
  } catch (error) {
    console.error('Error fetching tracker entries:', error);
    return NextResponse.json(
      { error: 'Failed to fetch tracker entries' },
      { status: 500 }
    );
  }
}

// POST /api/tracker - Create a new tracker entry
export async function POST(request: NextRequest) {
  try {
    await connectDB();
    
    const body = await request.json();
    
    // Verify event exists
    const event = await Event.findById(body.eventId);
    if (!event) {
      return NextResponse.json(
        { error: 'Event not found' },
        { status: 404 }
      );
    }
    
    // Check if tracker entry already exists for this event
    const existing = await TrackerEntry.findOne({ eventId: body.eventId });
    if (existing) {
      return NextResponse.json(
        { error: 'Tracker entry already exists for this event', entry: existing },
        { status: 409 }
      );
    }
    
    const entry = await TrackerEntry.create(body);
    const populated = await TrackerEntry.findById(entry._id).populate('eventId');
    
    return NextResponse.json(populated, { status: 201 });
  } catch (error: any) {
    console.error('Error creating tracker entry:', error);
    
    if (error.code === 11000) {
      return NextResponse.json(
        { error: 'Tracker entry already exists for this event' },
        { status: 409 }
      );
    }
    
    return NextResponse.json(
      { error: 'Failed to create tracker entry', details: error.message },
      { status: 500 }
    );
  }
}

// Made with Bob