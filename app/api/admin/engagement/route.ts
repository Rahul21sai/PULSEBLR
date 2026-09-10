import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongodb';
import User from '@/lib/models/User';
import TrackerEntry from '@/lib/models/TrackerEntry';
import Contact from '@/lib/models/Contact';
import Folder from '@/lib/models/Folder';
import Event from '@/lib/models/Event';
import { requireAdmin } from '@/lib/api-auth';
import { IST } from '@/lib/format';

/**
 * GET /api/admin/engagement — did anyone use this yesterday.
 *
 * ── WHY THIS MATTERS MORE THAN IT LOOKS ─────────────────────────────────────────────────────
 *
 * `/api/admin/stats` returns `users.total` and `trackerEntries`: two integers with no time in them.
 * So every question worth asking was unanswerable — did the feed change help, did anyone come back,
 * is the scan flow used at all. Two integers cannot falsify anything, which means every decision
 * about the product was being made on impressions. This is the instrument that makes the rest
 * measurable, and it is deliberately built before the panels that need it.
 *
 * ── EVERY BUCKET IS AN IST CALENDAR DAY ─────────────────────────────────────────────────────
 *
 * `$dateToString` with `timezone: IST`, never a UTC day and never the server's clock. Every user is
 * in Bengaluru; a UTC day boundary puts an evening's activity on the wrong date and makes
 * "yesterday" wrong by half a day for exactly the sessions that matter — people use this after work.
 * `lib/format.ts` pins the whole app to Asia/Kolkata for the same reason.
 *
 * ── WHAT COUNTS AS "ACTIVE" ─────────────────────────────────────────────────────────────────
 *
 * A WRITE, in any of the four collections a user can write to: saving an event, scanning a person,
 * making a folder, adding an event by hand. There is no page-view telemetry in this app and this
 * route does not invent any — so "active" here means "did something", which is a higher bar than a
 * visit and is the honest thing to call it. Stated in the response as `activeMeans` so the panel can
 * say so on screen rather than letting a reader assume it counts visits.
 *
 * ── D1 RETURN IS THE ONE NUMBER WITH A DEFINITION WORTH READING ─────────────────────────────
 *
 * "Came back after day 1" = a user whose LATEST activity falls on a later IST day than their signup
 * day. Not "activity within 24-48h" — with three users, a bucketed retention curve is noise, and
 * measuring on a fixed window would report a user who came back on day 9 as churned. The cohort
 * excludes anybody who signed up TODAY, because they have not yet had a second day in which to
 * return and counting them makes the ratio drift down every time somebody signs up.
 */

const IST_DAY = { format: '%Y-%m-%d', timezone: IST } as const;

/** Fill the gaps in a sparse daily series so a chart has one point per day. */
function densify(rows: Array<{ _id: string; n: number }>, days: number): Array<{ day: string; count: number }> {
  const byDay = new Map(rows.map(r => [r._id, r.n]));
  const out: Array<{ day: string; count: number }> = [];
  for (let i = days - 1; i >= 0; i--) {
    // Bucketed in IST by Mongo, so the labels must be generated in IST too or the last day is
    // missing and an extra one appears at the front.
    const d = new Date(Date.now() - i * 86400_000);
    const day = new Intl.DateTimeFormat('en-CA', {
      timeZone: IST,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d);
    out.push({ day, count: byDay.get(day) ?? 0 });
  }
  return out;
}

export async function GET(request: NextRequest) {
  const gate = await requireAdmin();
  if ('response' in gate) return gate.response;

  try {
    await connectDB();

    const windowDays = Math.min(90, Math.max(7, Number(request.nextUrl.searchParams.get('days')) || 30));
    const since = new Date(Date.now() - windowDays * 86400_000);
    const week = new Date(Date.now() - 7 * 86400_000);
    const fourWeeks = new Date(Date.now() - 28 * 86400_000);

    const dailySignups = [
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: { $dateToString: { ...IST_DAY, date: '$createdAt' } }, n: { $sum: 1 } } },
    ];

    const [
      usersTotal,
      usersThisWeek,
      signupSeries,
      trackerTotal,
      trackerThisWeek,
      trackerSeries,
      trackerByStatus,
      contactsTotal,
      contactsThisWeek,
      contactSeries,
      foldersTotal,
      manualEvents,
      // The four activity streams, each reduced to (userId → last write). Unioned in memory because
      // they live in four collections with no join key Mongo can follow, and the row counts here are
      // tiny — a $unionWith pipeline would be more code for the same answer.
      trackerActivity,
      contactActivity,
      folderActivity,
      manualActivity,
      users,
    ] = await Promise.all([
      User.countDocuments({}),
      User.countDocuments({ createdAt: { $gte: week } }),
      User.aggregate<{ _id: string; n: number }>(dailySignups),

      TrackerEntry.countDocuments({}),
      TrackerEntry.countDocuments({ createdAt: { $gte: week } }),
      TrackerEntry.aggregate<{ _id: string; n: number }>([
        { $match: { createdAt: { $gte: since } } },
        { $group: { _id: { $dateToString: { ...IST_DAY, date: '$createdAt' } }, n: { $sum: 1 } } },
      ]),
      TrackerEntry.aggregate<{ _id: string; n: number }>([
        { $group: { _id: '$status', n: { $sum: 1 } } },
        { $sort: { n: -1 } },
      ]),

      Contact.countDocuments({}),
      Contact.countDocuments({ createdAt: { $gte: week } }),
      Contact.aggregate<{ _id: string; n: number }>([
        { $match: { createdAt: { $gte: since } } },
        { $group: { _id: { $dateToString: { ...IST_DAY, date: '$createdAt' } }, n: { $sum: 1 } } },
      ]),

      Folder.countDocuments({}),
      Event.countDocuments({ createdByUserId: { $exists: true } }),

      TrackerEntry.aggregate<{ _id: string; last: Date; n: number }>([
        { $group: { _id: '$userId', last: { $max: '$updatedAt' }, n: { $sum: 1 } } },
      ]),
      Contact.aggregate<{ _id: string; last: Date; n: number }>([
        { $group: { _id: '$userId', last: { $max: '$createdAt' }, n: { $sum: 1 } } },
      ]),
      Folder.aggregate<{ _id: string; last: Date; n: number }>([
        { $group: { _id: '$userId', last: { $max: '$updatedAt' }, n: { $sum: 1 } } },
      ]),
      Event.aggregate<{ _id: string; last: Date; n: number }>([
        { $match: { createdByUserId: { $exists: true } } },
        { $group: { _id: '$createdByUserId', last: { $max: '$createdAt' }, n: { $sum: 1 } } },
      ]),

      // Small on purpose: this deployment has single-digit users, and a per-user table is by far the
      // most informative thing an operator can look at at this scale. Capped so it stays a table.
      User.find({}).select('googleId email name createdAt').sort({ createdAt: -1 }).limit(200).lean(),
    ]);

    /** userId → { last write, per-collection counts }. */
    type Activity = { last: Date | null; tracked: number; contacts: number; folders: number; added: number };
    const activity = new Map<string, Activity>();
    const bump = (userId: string, last: Date | null, key: keyof Omit<Activity, 'last'>, n: number) => {
      const cur =
        activity.get(userId) ?? { last: null, tracked: 0, contacts: 0, folders: 0, added: 0 };
      cur[key] += n;
      if (last && (!cur.last || last > cur.last)) cur.last = last;
      activity.set(userId, cur);
    };
    for (const r of trackerActivity) bump(String(r._id), r.last, 'tracked', r.n);
    for (const r of contactActivity) bump(String(r._id), r.last, 'contacts', r.n);
    for (const r of folderActivity) bump(String(r._id), r.last, 'folders', r.n);
    for (const r of manualActivity) bump(String(r._id), r.last, 'added', r.n);

    const activeSince = (cutoff: Date) =>
      [...activity.values()].filter(a => a.last && a.last >= cutoff).length;

    /**
     * D1 return. Compared on IST DAY KEYS, not on elapsed milliseconds — "came back the next day"
     * is a calendar question, and a user who signs up at 11pm and returns at 1am has come back.
     */
    const istDay = (d: Date) =>
      new Intl.DateTimeFormat('en-CA', {
        timeZone: IST,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(d);
    const today = istDay(new Date());

    let cohort = 0;
    let returned = 0;
    for (const u of users) {
      const signupDay = istDay(new Date(u.createdAt));
      // Excluded: they have not had a second day yet, so counting them can only drag the ratio down.
      if (signupDay === today) continue;
      cohort++;
      const last = activity.get(u.googleId)?.last;
      if (last && istDay(new Date(last)) > signupDay) returned++;
    }

    return NextResponse.json({
      window: { days: windowDays },
      activeMeans:
        'a write — saving an event, scanning a person, creating a folder, or adding an event by hand. ' +
        'There is no page-view telemetry in this app, so this is a higher bar than a visit.',
      users: {
        total: usersTotal,
        newThisWeek: usersThisWeek,
        signupSeries: densify(signupSeries, windowDays),
        weeklyActive: activeSince(week),
        monthlyActive: activeSince(fourWeeks),
        // Named `neverActive` rather than "inactive": with three accounts, the number that matters is
        // how many signed up and then did nothing at all.
        neverActive: usersTotal - [...activity.values()].filter(a => a.last).length,
        d1: { cohort, returned, rate: cohort > 0 ? Math.round((returned / cohort) * 100) : null },
      },
      eventsSaved: {
        total: trackerTotal,
        thisWeek: trackerThisWeek,
        series: densify(trackerSeries, windowDays),
        byStatus: trackerByStatus.map(s => ({ status: s._id ?? 'unknown', count: s.n })),
      },
      contacts: {
        total: contactsTotal,
        thisWeek: contactsThisWeek,
        series: densify(contactSeries, windowDays),
        folders: foldersTotal,
      },
      userAdded: { events: manualEvents },
      perUser: users
        .map(u => {
          const a = activity.get(u.googleId);
          return {
            email: u.email,
            name: u.name,
            signedUpAt: u.createdAt,
            lastActiveAt: a?.last ?? null,
            tracked: a?.tracked ?? 0,
            contacts: a?.contacts ?? 0,
            folders: a?.folders ?? 0,
            added: a?.added ?? 0,
          };
        })
        // Most recently active first, then the never-active — which is the order an operator reads
        // this in: who is using it, then who signed up and vanished.
        .sort((x, y) => (y.lastActiveAt?.getTime() ?? 0) - (x.lastActiveAt?.getTime() ?? 0)),
    });
  } catch (error) {
    console.error('Engagement stats failed:', error);
    return NextResponse.json({ error: 'Failed to load engagement stats' }, { status: 500 });
  }
}
