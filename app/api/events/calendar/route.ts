import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongodb';
import Event from '@/lib/models/Event';
import { IST } from '@/lib/format';

/**
 * GET /api/events/calendar?month=YYYY-MM[&techOnly=true]
 *
 * Per-day event COUNTS for one month, plus that month's total.
 *
 * WHY THIS EXISTS rather than reusing /api/events: a calendar needs to know which days
 * have events, not what those events are. The calendar page used to call `/api/events`
 * bare, which returns a page capped at 100 rows sorted soonest-first — so for a month
 * with 714 events it received 100 that all landed on four consecutive days, and drew
 * four dots on a 31-day grid. Raising the limit cannot fix that: the cap is deliberate,
 * and shipping 714 full event documents to render dots would be absurd anyway.
 *
 * An aggregation returns ~31 rows regardless of how busy the month is.
 *
 * Days are bucketed in IST, not UTC, for the same reason clusterKey is: a 9 PM IST event
 * is 15:30 UTC the same day, but a 1 AM IST event is the PREVIOUS day in UTC, so
 * UTC bucketing would scatter late-night events onto the wrong square.
 */
export async function GET(request: NextRequest) {
  try {
    await connectDB();

    const monthParam = request.nextUrl.searchParams.get('month');
    const techOnly = request.nextUrl.searchParams.get('techOnly') === 'true';

    // Accept YYYY-MM; fall back to the current IST month.
    const match = /^(\d{4})-(\d{2})$/.exec(monthParam || '');
    const now = new Date();
    const year = match ? Number(match[1]) : Number(
      new Intl.DateTimeFormat('en-CA', { timeZone: IST, year: 'numeric' }).format(now)
    );
    const month = match ? Number(match[2]) : Number(
      new Intl.DateTimeFormat('en-CA', { timeZone: IST, month: '2-digit' }).format(now)
    );

    if (month < 1 || month > 12 || year < 2000 || year > 2100) {
      return NextResponse.json({ error: 'month must be YYYY-MM' }, { status: 400 });
    }

    // IST is UTC+5:30 with no DST, so the month's IST boundaries are a fixed offset —
    // no timezone library needed, and no ambiguity to get wrong.
    const IST_OFFSET_MS = 5.5 * 3600 * 1000;
    const from = new Date(Date.UTC(year, month - 1, 1) - IST_OFFSET_MS);
    const to = new Date(Date.UTC(month === 12 ? year + 1 : year, month % 12, 1) - IST_OFFSET_MS);

    const filter: Record<string, unknown> = { startDateTime: { $gte: from, $lt: to } };
    if (techOnly) filter.isTechEvent = true;

    const rows = await Event.aggregate<{ _id: string; n: number }>([
      { $match: filter },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%d', date: '$startDateTime', timezone: IST },
          },
          n: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    const days: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      days[r._id] = r.n;
      total += r.n;
    }

    return NextResponse.json({
      month: `${year}-${String(month).padStart(2, '0')}`,
      days,
      total,
      daysWithEvents: rows.length,
    });
  } catch (error) {
    console.error('Calendar counts error:', error);
    return NextResponse.json({ error: 'Failed to load calendar' }, { status: 500 });
  }
}
