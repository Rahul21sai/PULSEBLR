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
      spotlit,
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
      // `$type: 'date'` and NOT `$exists`. Unpinning sends an explicit null, because `$set` cannot
      // express `$unset` — under `$exists` that null would be counted as a pin, and the overview
      // would report a Spotlight the home page is not showing.
      Event.countDocuments({ startDateTime: { $gte: now }, spotlightAt: { $type: 'date' } }),
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
    /**
     * PER-KIND HEALTH — the 423 rows that were invisible unless you queried the database.
     *
     * The aggregate buckets above answer "is the scraper working" and hide the thing worth acting on:
     * the health is wildly uneven BY KIND. Measured on this corpus — 86 Luma calendars of which 65
     * produce nothing, 261 Meetup groups of which 97 produce nothing — and one of those is a supply
     * problem while the other is mostly normal (a Meetup group with nothing scheduled this fortnight
     * is not broken). Averaging them into one "producing" number is what made 138 sources with five
     * or more consecutive empty scrapes re-fetched every night with nobody noticing.
     *
     * `dead` uses the SAME >= 6 threshold as the aggregate above, so the two can never disagree.
     * `backoffCandidates` uses >= 5, which is where `loadDiscovered()` would start scheduling a
     * source weekly instead of daily — a different question (what should we stop fetching) from a
     * different answer (what is broken), so it gets its own number rather than a redefinition.
     */
    type KindBucket = {
      kind: string;
      total: number;
      producing: number;
      quiet: number;
      never: number;
      dead: number;
      backoffCandidates: number;
      disabled: number;
      events: number;
    };
    const kinds = new Map<string, KindBucket>();
    for (const s of sources) {
      const key = s.kind ?? 'built-in';
      const b =
        kinds.get(key) ??
        { kind: key, total: 0, producing: 0, quiet: 0, never: 0, dead: 0, backoffCandidates: 0, disabled: 0, events: 0 };
      b.total++;
      b.events += s.lastEventCount || 0;
      if (s.enabled === false) b.disabled++;
      if (!s.lastScrapedAt) b.never++;
      else if ((s.lastEventCount || 0) > 0) b.producing++;
      else b.quiet++;
      if ((s.consecutiveEmptyScrapes || 0) >= 6) b.dead++;
      if ((s.consecutiveEmptyScrapes || 0) >= 5) b.backoffCandidates++;
      kinds.set(key, b);
    }
    const byKind = [...kinds.values()].sort((a, b) => b.total - a.total);
    const backoffCandidates = sources.filter(s => (s.consecutiveEmptyScrapes || 0) >= 5).length;

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
        spotlit,
      },
      categories: byCategory.map(c => ({ name: c._id as string, count: c.n as number })),
      sources: {
        total: sources.length,
        producing,
        quiet,
        never,
        dead,
        backoffCandidates,
        byKind,
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
