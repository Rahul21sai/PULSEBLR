import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongodb';
import Event from '@/lib/models/Event';
import { parseEventParams, buildEventFilter, buildSort, SortKey } from '@/lib/events/query';

/**
 * GET /api/events — the feed.
 *
 * Supported params:
 *   q          free-text search (title/organizer/venue/tags)
 *   when       today | tomorrow | weekend | week | month   (resolved in IST)
 *   from,to    explicit ISO date range
 *   category   comma-separated
 *   area       comma-separated
 *   source     comma-separated
 *   format     online | offline | hybrid
 *   hasFood    yes | no | unknown
 *   isFree     true | false
 *   techOnly   true
 *   sort       soonest | newest | popular | relevance
 *   page,limit pagination (limit capped at 100)
 *   includePast / includeAll   include events that have finished
 *
 * The list projection deliberately omits the full description: it is up to 6 KB
 * per event and the feed only renders a two-line excerpt, so sending it would
 * multiply the payload for nothing. The detail endpoint returns everything.
 */
export async function GET(request: NextRequest) {
  try {
    await connectDB();

    const searchParams = request.nextUrl.searchParams;
    const params = parseEventParams(searchParams);
    const filter = buildEventFilter(params);

    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') || '30', 10) || 30));
    const skip = (page - 1) * limit;

    const sort = (searchParams.get('sort') || (params.q ? 'relevance' : 'soonest')) as SortKey;
    const hasTextSearch = Boolean(filter.$text);

    let query = Event.find(filter)
      .select(
        'title source sourceUrl slug organizer hostAvatarUrl category tags format hasFood ' +
          'isFree price priceMax currency soldOut venue area city lat lng onlineLink imageUrl ' +
          'startDateTime endDateTime applyLink registrationDeadline attendeeCount capacity ' +
          'isTechEvent isTargetCompany recruiterMentioned seenInSources createdAt'
      )
      .sort(buildSort(sort, hasTextSearch))
      .skip(skip)
      .limit(limit);

    if (hasTextSearch) {
      query = query.select({ score: { $meta: 'textScore' } });
    }

    const [events, total] = await Promise.all([
      query.lean(),
      Event.countDocuments(filter),
    ]);

    return NextResponse.json({
      events,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
        hasMore: skip + events.length < total,
      },
    });
  } catch (error) {
    console.error('Error fetching events:', error);
    return NextResponse.json({ error: 'Failed to fetch events' }, { status: 500 });
  }
}

/** POST /api/events — manual event creation. */
export async function POST(request: NextRequest) {
  try {
    await connectDB();
    const body = await request.json();

    if (!body.title || !body.startDateTime) {
      return NextResponse.json(
        { error: 'title and startDateTime are required' },
        { status: 400 }
      );
    }

    const startDateTime = new Date(body.startDateTime);
    if (Number.isNaN(startDateTime.getTime())) {
      return NextResponse.json({ error: 'startDateTime is not a valid date' }, { status: 400 });
    }

    const source = body.source || 'manual';
    const doc = {
      ...body,
      source,
      startDateTime,
      endDateTime: body.endDateTime ? new Date(body.endDateTime) : undefined,
      description: body.description || body.title,
      category: Array.isArray(body.category) && body.category.length > 0
        ? body.category
        : ['Networking/Meetup'],
      format: body.format || 'offline',
      sourceUrl: body.sourceUrl || body.applyLink || 'https://pulseblr.local/manual',
      dedupHash:
        body.dedupHash ||
        Event.generateDedupHash(body.title, startDateTime, body.venue, source),
      clusterKey: Event.generateClusterKey(body.title, startDateTime),
      lastSeenAt: new Date(),
      seenInSources: [source],
    };

    const existing = await Event.findOne({ dedupHash: doc.dedupHash });
    if (existing) {
      return NextResponse.json(
        { error: 'Event already exists', event: existing },
        { status: 409 }
      );
    }

    const event = await Event.create(doc);
    return NextResponse.json(event, { status: 201 });
  } catch (error) {
    const err = error as { code?: number; message?: string };
    console.error('Error creating event:', error);
    if (err.code === 11000) {
      return NextResponse.json({ error: 'Duplicate event detected' }, { status: 409 });
    }
    return NextResponse.json(
      { error: 'Failed to create event', details: err.message },
      { status: 500 }
    );
  }
}
