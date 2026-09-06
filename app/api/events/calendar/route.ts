import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongodb';
import Event from '@/lib/models/Event';
import { IST } from '@/lib/format';
import { buildEventFilter, SPAN_FLOOR_DAYS } from '@/lib/events/query';
import { getCurrentUserId } from '@/lib/auth-helpers';

/**
 * The most days one event may occupy, and the `+ 1` is not a fudge — it is measured.
 *
 * `SPAN_FLOOR_DAYS` is a LOOKBACK: `buildEventFilter`'s spanning branch admits an event to day D if
 * it started on or after `D - SPAN_FLOOR_DAYS`. So an event starting on S appears in the day panel
 * for S through S + SPAN_FLOOR_DAYS — that is 15 days, inclusive, not 14. Capping the expansion here
 * at 14 made this route one day SHORTER than the panel it has to agree with.
 *
 * Measured across all 30 days of September 2026 against the live corpus, dot count versus panel
 * total: 29 days agreed and 20 September did not — dot 4, panel 5. The one event responsible was
 * `AI Agents Workshop`, dated 2026-09-06 → 2026-10-06, a 31-day range that only the cap keeps off
 * the entire grid. With the `+ 1` all 30 days agree.
 *
 * Derived from the shared constant rather than written as `15`, so raising the lookback cannot
 * silently reintroduce the gap.
 */
const MAX_SPAN_DAYS = SPAN_FLOOR_DAYS + 1;

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
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE `$match` COMES FROM `buildEventFilter()`, NOT FROM A LOCAL OBJECT. That is the whole fix.
 *
 * It used to be `{ startDateTime: { $gte: from, $lt: to } }` plus an optional `isTechEvent`, built
 * by hand — and a hand-built filter drifts from the one every other read path uses. It had drifted
 * in two ways at once, and each was invisible from the other side of the page:
 *
 *   1. NO VISIBILITY PREDICATE. The counts included every user's `private` and `pending` events. A
 *      count IS disclosure at this granularity: one row per IST day tells an anonymous caller
 *      exactly how many hidden events sit on each date, and polling across months reveals when
 *      they appear. `/api/events/facets` already carries a note saying the same thing about facet
 *      numbers; this was that leak, per day, with no session read at all.
 *
 *      Worse, it made the PAGE an existence oracle. The day panel calls `/api/events`, which IS
 *      filtered — so a square whose only events were a stranger's private ones drew a dot and then
 *      said "Nothing scheduled this day." Dot-with-empty-panel confirmed the row exists while
 *      refusing to show it, which is exactly what `canViewEvent`'s always-404-never-403 rule exists
 *      to prevent.
 *
 *   2. NO `techOnly` REACHING IT. The parameter was advertised in this docblock and implemented,
 *      and the page never sent it. Measured 1158 upcoming events against 297 tech, so the grid
 *      counted roughly four times the volume the product exists to surface.
 *
 * Sharing the builder means the dots and the day panel now answer the same question by
 * construction, on every dimension — the arrangement `lib/events/query.ts` already has with
 * `/api/events` and `/api/events/facets`.
 *
 * The session read is NULLABLE (`getCurrentUserId`, not `requireUser`): the calendar is a public
 * page and must keep working signed out, exactly as the facets route does. A signed-out caller gets
 * the two public visibility arms and nothing else.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
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

    const viewerId = await getCurrentUserId();

    /**
     * `includePast: true` because a calendar shows days that have already gone — without it the
     * builder would floor the window at `now` and blank every square before today.
     * `includeOngoing: false` because `spanning` below is the calendar's version of that idea and
     * the two branches are mutually exclusive in the builder.
     */
    const filter = buildEventFilter(
      { from, to, techOnly, includePast: true, includeOngoing: false, spanning: true },
      viewerId
    );

    const rows = await Event.aggregate<{ _id: string; n: number }>([
      { $match: filter },

      /**
       * ── MULTI-DAY EVENTS OCCUPY EVERY DAY THEY RUN ──────────────────────────────────────────
       *
       * Grouping on `startDateTime` alone put a three-day conference on one square and nothing on
       * the other two. On a calendar, of all surfaces: GIDS, droidCon and IndiaFOSS — the marquee
       * events `diag-flagship-events.ts` exists to protect — showed a dot on day 1 and vanished.
       *
       * So each event is expanded into one row per IST day it covers, then grouped. Three bounds
       * make that safe:
       *
       *   · `_end` falls back to `startDateTime` and is clamped up to it, so a missing or inverted
       *     end date yields exactly one day rather than a negative range.
       *   · The span is CLIPPED TO THE REQUESTED MONTH, so an event running from August into
       *     September contributes only its September days here.
       *   · The day count is capped at `MAX_SPAN_DAYS`, which is derived from the same
       *     `SPAN_FLOOR_DAYS` the day-panel query bounds itself by — see the note on that constant
       *     above for why it is that value plus one, and for the day the mismatch showed up on.
       *     Without a cap an evergreen listing dated 2015→2030 would land on every square of every
       *     month and make the whole grid look full — the same failure the feed's `ongoingFloor`
       *     exists to prevent. Sharing the constant is what stops a dot appearing on a day whose
       *     panel comes back empty, and what stops the panel listing an event the dot never counted.
       */
      {
        $addFields: {
          _end: {
            $let: {
              vars: { e: { $ifNull: ['$endDateTime', '$startDateTime'] } },
              in: { $cond: [{ $lt: ['$$e', '$startDateTime'] }, '$startDateTime', '$$e'] },
            },
          },
        },
      },
      {
        $addFields: {
          // Clip to the month window so out-of-month days are never generated.
          _spanStart: { $max: ['$startDateTime', from] },
          _spanEnd: { $min: ['$_end', new Date(to.getTime() - 1)] },
        },
      },
      {
        $addFields: {
          _dayCount: {
            $min: [
              MAX_SPAN_DAYS,
              {
                $max: [
                  1,
                  {
                    $add: [
                      1,
                      {
                        $dateDiff: {
                          startDate: '$_spanStart',
                          endDate: '$_spanEnd',
                          unit: 'day',
                          timezone: IST,
                        },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        },
      },
      {
        $addFields: {
          _days: {
            $map: {
              input: { $range: [0, '$_dayCount'] },
              as: 'i',
              in: {
                $dateAdd: {
                  startDate: '$_spanStart',
                  unit: 'day',
                  amount: '$$i',
                  timezone: IST,
                },
              },
            },
          },
        },
      },
      { $unwind: '$_days' },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%d', date: '$_days', timezone: IST },
          },
          n: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    const days: Record<string, number> = {};
    for (const r of rows) days[r._id] = r.n;

    /**
     * `total` is the number of DISTINCT EVENTS in the month, counted separately — not the sum of
     * the day buckets.
     *
     * Summing them would double-count every multi-day event now that one event produces several
     * rows, so a month with one three-day conference would report three events. The header says
     * "N events across M days", and those two numbers must be able to differ.
     */
    const total = await Event.countDocuments(filter);

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
