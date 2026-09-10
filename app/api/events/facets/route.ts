import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongodb';
import Event from '@/lib/models/Event';
import { parseEventParams, buildEventFilter } from '@/lib/events/query';
import { getCurrentUserId } from '@/lib/auth-helpers';

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

    /**
     * A NULLABLE session read, deliberately NOT `requireUser()`.
     *
     * The feed and its counts must stay readable signed-out — that is the product ("browse events
     * without an account") and `scripts/diag-api-auth.ts` asserts this route answers 200 to an
     * un-authenticated caller. So the viewer is identified when there is one and the filter simply
     * falls back to the two public arms when there is not.
     *
     * Without this the route could not identify the caller at all, so it could not pass a viewerId
     * — and the counts beside the filters would have been computed over every user's private
     * events, disagreeing with the list right next to them. The facet numbers alone would disclose
     * how many private events exist per category, area, source, format and company.
     */
    const viewerId = await getCurrentUserId();

    // Each dimension is counted with its OWN selection removed.
    const categoryFilter = buildEventFilter({ ...params, category: undefined }, viewerId);
    const areaFilter = buildEventFilter({ ...params, area: undefined }, viewerId);
    const sourceFilter = buildEventFilter({ ...params, source: undefined }, viewerId);
    const formatFilter = buildEventFilter({ ...params, format: undefined }, viewerId);
    const companyFilter = buildEventFilter({ ...params, company: undefined }, viewerId);
    /*
     * CARD METADATA — and every one of these three counts ZERO today.
     *
     * Measured 2026-09-10 against the live corpus: `audience`, `perks` and `tier` are not merely
     * empty, the KEYS ARE ABSENT on all 1616 documents — the schema landed in `b7620ad` and no
     * scrape or backfill has run since, so not even the `default: []` has been applied. So these
     * three aggregations return no rows, `toMap` gives `{}`, and `FilterRail` renders no group.
     *
     * THAT IS THE DESIGN, NOT AN OVERSIGHT. CLAUDE.md records the "Everything else" category group
     * being deleted precisely because it could only ever render empty, and the events spec refuses
     * "Filling up fast" on the same ground — a control that cannot match anything reads as broken.
     * The rule those two cases establish is about what a READER is offered, not about what the
     * server computes: counting here is three `$group` stages over a filter that is already being
     * run five other ways in this same `Promise.all`, while the rail gates on a non-empty map. The
     * facets light up the moment the tagger populates the fields, with no second deployment and no
     * coordination between whoever writes the tagger and whoever owns this route.
     *
     * If these are still zero long after the tagger work lands, the fault is upstream of here —
     * check `scripts/diag-recent-writes.ts` before touching this file.
     */
    const audienceFilter = buildEventFilter({ ...params, audience: undefined }, viewerId);
    const perksFilter = buildEventFilter({ ...params, perks: undefined }, viewerId);
    const tierFilter = buildEventFilter({ ...params, tier: undefined }, viewerId);
    const baseFilter = buildEventFilter(params, viewerId);

    const [categories, areas, sources, formats, companies, audience, perks, tier, totals] = await Promise.all([
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
        { $match: { ...companyFilter, companies: { $ne: [] } } },
        { $unwind: '$companies' },
        { $group: { _id: '$companies', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      // `$ne: []` mirrors the company facet above rather than using `$exists`: it excludes both an
      // empty array and an absent key in one predicate, which is what the ~1500 documents
      // predating these fields need. `$unwind` on an absent path emits nothing, so a document
      // without the key cannot reach the `$group` and cannot invent a bucket.
      Event.aggregate([
        { $match: { ...audienceFilter, audience: { $ne: [] } } },
        { $unwind: '$audience' },
        { $group: { _id: '$audience', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      Event.aggregate([
        { $match: { ...perksFilter, perks: { $ne: [] } } },
        { $unwind: '$perks' },
        { $group: { _id: '$perks', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      // A scalar, so no `$unwind`. `$nin: [null, '']` is the `area` facet's guard, for the same
      // reason: an empty string passes `$type: 'string'` and would render a nameless chip.
      Event.aggregate([
        { $match: { ...tierFilter, tier: { $nin: [null, ''] } } },
        { $group: { _id: '$tier', count: { $sum: 1 } } },
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
      companies: toMap(companies),
      audience: toMap(audience),
      perks: toMap(perks),
      tier: toMap(tier),
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
