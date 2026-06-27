import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongodb';
import Event from '@/lib/models/Event';

// GET /api/events - List all events with optional filters
export async function GET(request: NextRequest) {
  try {
    await connectDB();

    const searchParams = request.nextUrl.searchParams;
    
    // Build filter object
    const filter: any = {};
    
    // Category filter (can be multiple)
    const category = searchParams.get('category');
    if (category) {
      filter.category = { $in: category.split(',') };
    }
    
    // Format filter
    const format = searchParams.get('format');
    if (format) {
      filter.format = format;
    }
    
    // Food filter
    const hasFood = searchParams.get('hasFood');
    if (hasFood) {
      filter.hasFood = hasFood;
    }
    
    // Free/Paid filter
    const isFree = searchParams.get('isFree');
    if (isFree !== null) {
      filter.isFree = isFree === 'true';
    }
    
    // Area filter
    const area = searchParams.get('area');
    if (area) {
      filter.area = area;
    }
    
    // Source filter
    const source = searchParams.get('source');
    if (source) {
      filter.source = source;
    }
    
    // Date range filter - upcoming events only by default
    const includeAll = searchParams.get('includeAll');
    if (includeAll !== 'true') {
      filter.startDateTime = { $gte: new Date() };
    }
    
    // Pagination
    const page = parseInt(searchParams.get('page') || '1');
    const limit = parseInt(searchParams.get('limit') || '50');
    const skip = (page - 1) * limit;
    
    // Sort by start date (ascending for upcoming events)
    const events = await Event.find(filter)
      .sort({ startDateTime: 1 })
      .skip(skip)
      .limit(limit)
      .lean();
    
    const total = await Event.countDocuments(filter);
    
    return NextResponse.json({
      events,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('Error fetching events:', error);
    return NextResponse.json(
      { error: 'Failed to fetch events' },
      { status: 500 }
    );
  }
}

// POST /api/events - Create a new event (manual entry)
export async function POST(request: NextRequest) {
  try {
    await connectDB();
    
    const body = await request.json();
    
    // Generate dedupHash if not provided
    if (!body.dedupHash) {
      body.dedupHash = (Event as any).generateDedupHash(
        body.title,
        new Date(body.startDateTime),
        body.venue,
        body.source || 'manual'
      );
    }
    
    // Check for duplicates
    const existing = await Event.findOne({ dedupHash: body.dedupHash });
    if (existing) {
      return NextResponse.json(
        { error: 'Event already exists', event: existing },
        { status: 409 }
      );
    }
    
    const event = await Event.create(body);
    
    return NextResponse.json(event, { status: 201 });
  } catch (error: any) {
    console.error('Error creating event:', error);
    
    if (error.code === 11000) {
      return NextResponse.json(
        { error: 'Duplicate event detected' },
        { status: 409 }
      );
    }
    
    return NextResponse.json(
      { error: 'Failed to create event', details: error.message },
      { status: 500 }
    );
  }
}

// Made with Bob