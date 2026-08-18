import { NextResponse } from 'next/server';
import connectDB from '@/lib/mongodb';
import Event from '@/lib/models/Event';
import Source from '@/lib/models/Source';
import TrackerEntry from '@/lib/models/TrackerEntry';
import User from '@/lib/models/User';
import { requireAdmin } from '@/lib/api-auth';

/**
 * GET /api/admin/stats — everything the admin dashboard needs, in one round trip.
 *
 * ADMIN ONLY: it reports user counts and source health, and the point of the dashboard
 * is that a regular user never sees the scraping machinery at all.
 *
 * One request rather than six because every number here is a cheap count or a small
 * aggregate, and a dashboard that fires six requests shows six different loading
 * spinners and can render internally inconsistent totals.
 */
export async function GET() {
  const gate = await requireAdmin();
  if ('response' in gate) return gate.response;

  try {
    await connectDB();
    const now = new Date();
    const dayAgo = new Date(now.getTime() - 24 * 3600 * 1000);

    const [
      total,
      upcoming,
      tech,
      addedToday,
      withoutClusterKey,
      byCategory,
      bySource,
      sources,
      trackerEntries,
      users,
      nextEvents,
    ] = await Promise.all([
      Event.countDocuments({}),
      Event.countDocuments({ startDateTime: { $gte: now } }),
      Event.countDocuments({ startDateTime: { $gte: now }, isTechEvent: true }),
      Event.countDocuments({ createdAt: { $gte: dayAgo } }),
      // A non-zero count here means something wrote documents with the old schema —
      // usually the daily cron running an older default branch. Surfacing it is the
      // point: it is invisible otherwise until duplicate cards appear in the feed.
      Event.countDocuments({
        $or: [{ clusterKey: { $exists: false } }, { clusterKey: null }, { clusterKey: '' }],
      }),
      Event.aggregate([
        { $match: { startDateTime: { $gte: now }, isTechEvent: true } },
        { $unwind: '$category' },
        { $group: { _id: '$category', n: { $sum: 1 } } },
        { $sort: { n: -1 } },
        { $limit: 12 },
      ]),
      Event.aggregate([
        { $match: { startDateTime: { $gte: now } } },
        { $group: { _id: '$source', n: { $sum: 1 } } },
        { $sort: { n: -1 } },
      ]),
      Source.find({})
        .select('kind handle name url enabled lastScrapedAt lastEventCount consecutiveEmptyScrapes')
        .sort({ lastEventCount: -1 })
        .lean(),
      TrackerEntry.countDocuments({}),
      User.countDocuments({}),
      Event.find({ startDateTime: { $gte: now }, isTechEvent: true })
        .select('title startDateTime venue organizer connectionScore category')
        .sort({ startDateTime: 1 })
        .limit(5)
        .lean(),
    ]);

    // Health buckets, defined the same way scripts/diag-events.ts reports them so the
    // dashboard and the CLI can never tell different stories.
    const never = sources.filter(s => !s.lastScrapedAt).length;
    const producing = sources.filter(s => (s.lastEventCount || 0) > 0).length;
    const quiet = sources.filter(s => s.lastScrapedAt && (s.lastEventCount || 0) === 0).length;
    const dead = sources.filter(s => (s.consecutiveEmptyScrapes || 0) >= 6).length;
    const lastScrapedAt = sources
      .map(s => s.lastScrapedAt)
      .filter(Boolean)
      .sort((a, b) => new Date(b as Date).getTime() - new Date(a as Date).getTime())[0] ?? null;

    return NextResponse.json({
      events: {
        total,
        upcoming,
        tech,
        nonTech: upcoming - tech,
        addedToday,
        withoutClusterKey,
      },
      categories: byCategory.map(c => ({ name: c._id as string, count: c.n as number })),
      sources: {
        total: sources.length,
        producing,
        quiet,
        never,
        dead,
        lastScrapedAt,
        bySource: bySource.map(s => ({ name: (s._id as string) || 'unknown', count: s.n as number })),
        rows: sources.map(s => ({
          id: String(s._id),
          kind: s.kind ?? null,
          handle: s.handle ?? null,
          name: s.name ?? s.handle ?? s.url ?? 'unnamed',
          url: s.url ?? null,
          enabled: s.enabled !== false,
          lastScrapedAt: s.lastScrapedAt ?? null,
          lastEventCount: s.lastEventCount ?? 0,
          consecutiveEmptyScrapes: s.consecutiveEmptyScrapes ?? 0,
        })),
      },
      users: { total: users, trackerEntries },
      nextUp: nextEvents.map(e => ({
        id: String(e._id),
        title: e.title,
        startDateTime: e.startDateTime,
        venue: e.venue ?? null,
        organizer: e.organizer ?? null,
        connectionScore: e.connectionScore ?? null,
        category: e.category ?? [],
      })),
      admin: { email: gate.email },
    });
  } catch (error) {
    console.error('Admin stats error:', error);
    return NextResponse.json({ error: 'Failed to load admin stats' }, { status: 500 });
  }
}
