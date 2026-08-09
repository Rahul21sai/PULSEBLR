import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongodb';
import Event from '@/lib/models/Event';
import { COMPANIES, companySlug } from '@/lib/companies/registry';

/**
 * GET /api/companies — every company with events, plus their counts.
 *
 * Params:
 *   includeEmpty=true   also return registry companies with no current events
 *   sector=<name>       filter to one sector
 *
 * The counts come from the `companies` array on each event, which is resolved at
 * ingest from the host/title (see lib/companies/resolve.ts). Attribution lives on
 * the event rather than being computed here so the browse page is one indexed
 * aggregation rather than ~100 regex queries.
 */
export async function GET(request: NextRequest) {
  try {
    await connectDB();
    const now = new Date();
    const params = request.nextUrl.searchParams;
    const includeEmpty = params.get('includeEmpty') === 'true';
    const sector = params.get('sector');

    const rows = await Event.aggregate([
      { $match: { startDateTime: { $gte: now }, companies: { $ne: [] } } },
      { $unwind: '$companies' },
      {
        $group: {
          _id: '$companies',
          upcoming: { $sum: 1 },
          techEvents: { $sum: { $cond: ['$isTechEvent', 1, 0] } },
          nextEventAt: { $min: '$startDateTime' },
          // A representative image so the browse page isn't a wall of monograms.
          image: { $first: '$imageUrl' },
        },
      },
      { $sort: { upcoming: -1 } },
    ]);

    const counts = new Map(rows.map(r => [r._id as string, r]));

    const companies = COMPANIES
      .filter(company => !sector || company.sector === sector)
      .map(company => {
        const row = counts.get(company.name);
        return {
          name: company.name,
          slug: companySlug(company.name),
          sector: company.sector,
          website: company.website,
          upcoming: row?.upcoming ?? 0,
          techEvents: row?.techEvents ?? 0,
          nextEventAt: row?.nextEventAt ?? null,
          imageUrl: row?.image ?? null,
        };
      })
      .filter(company => includeEmpty || company.upcoming > 0)
      .sort((a, b) => b.upcoming - a.upcoming || a.name.localeCompare(b.name));

    // Hosts that carry events but aren't in the registry yet — the honest signal of
    // what the registry is still missing, surfaced rather than hidden.
    //
    // The unattributed test must cover BOTH shapes. `{ companies: [] }` only matches
    // an explicitly-empty array, so events written before the field existed (where
    // it is absent entirely) were silently excluded and this list came back empty.
    const unmatchedHosts = await Event.aggregate([
      {
        $match: {
          startDateTime: { $gte: now },
          organizer: { $nin: [null, ''] },
          $or: [{ companies: { $size: 0 } }, { companies: { $exists: false } }],
        },
      },
      { $group: { _id: '$organizer', n: { $sum: 1 } } },
      { $sort: { n: -1 } },
      { $limit: 20 },
    ]);

    return NextResponse.json({
      companies,
      totals: {
        withEvents: companies.filter(c => c.upcoming > 0).length,
        inRegistry: COMPANIES.length,
        attributedEvents: rows.reduce((sum, r) => sum + r.upcoming, 0),
      },
      unmatchedHosts: unmatchedHosts.map(h => ({ name: h._id, events: h.n })),
    });
  } catch (error) {
    console.error('Error fetching companies:', error);
    return NextResponse.json({ error: 'Failed to fetch companies' }, { status: 500 });
  }
}
