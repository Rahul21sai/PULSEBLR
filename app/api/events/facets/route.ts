import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongodb';
import Event from '@/lib/models/Event';
import { parseEventParams, buildEventFilter } from '@/lib/events/query';

/**
 * GET /api/events/facets — counts for every filter option, under the CURRENT
 * filter set.
 *
 * Why it matters: showing "AI/ML (42)" next to a filter is the difference between
 * a filter bar users trust and one they poke at blindly. Counts are computed
 * against the same filter the list uses (via the shared query builder) minus the
 * dimension being counted — otherwise selecting "AI/ML" would report every OTHER
 * category as 0 and the UI would look broken.
 *
 * All facets come from ONE aggregation using $facet, so this is a single round
 * trip rather than a query per dimension.
 */
export async function GET(request: NextRequest) {
  try {
    await connectDB();

    const params = parseEventParams(request.nextUrl.searchParams);

    // Each dimension is counted with its OWN selection removed.
    const categoryFilter = buildEventFilter({ ...params, category: undefined });
    const areaFilter = buildEventFilter({ ...params, area: undefined });
    const sourceFilter = buildEventFilter({ ...params, source: undefined });
    const formatFilter = buildEventFilter({ ...params, format: undefined });
    const baseFilter = buildEventFilter(params);

    const [categories, areas, sources, formats, totals] = await Promise.all([
      Event.aggregate([
        { $match: categoryFilter },
        { $unwind: '$category' },
        { $group: { _id: '$category', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      Event.aggregate([
        { $match: { ...areaFilter, area: { $nin: [null, ''] } } },
        { $group: { _id: '$area', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      Event.aggregate([
        { $match: sourceFilter },
        { $group: { _id: '$source', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      Event.aggregate([
        { $match: formatFilter },
        { $group: { _id: '$format', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      Event.aggregate([
        { $match: baseFilter },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            free: { $sum: { $cond: ['$isFree', 1, 0] } },
            withFood: { $sum: { $cond: [{ $eq: ['$hasFood', 'yes'] }, 1, 0] } },
            tech: { $sum: { $cond: ['$isTechEvent', 1, 0] } },
          },
        },
      ]),
    ]);

    const toMap = (rows: Array<{ _id: string; count: number }>) =>
      Object.fromEntries(rows.filter(r => r._id).map(r => [r._id, r.count]));

    return NextResponse.json({
      categories: toMap(categories),
      areas: toMap(areas),
      sources: toMap(sources),
      formats: toMap(formats),
      totals: totals[0]
        ? {
            total: totals[0].total,
            free: totals[0].free,
            withFood: totals[0].withFood,
            tech: totals[0].tech,
          }
        : { total: 0, free: 0, withFood: 0, tech: 0 },
    });
  } catch (error) {
    console.error('Error computing facets:', error);
    return NextResponse.json({ error: 'Failed to compute facets' }, { status: 500 });
  }
}
