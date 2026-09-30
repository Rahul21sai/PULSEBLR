import { NextResponse } from 'next/server';
import connectDB from '@/lib/mongodb';
import Event from '@/lib/models/Event';
import { requireUser } from '@/lib/api-auth';
import { DETAIL_SELECT, notDeletedClause } from '@/lib/events/query';
import { toEventDetail } from '@/lib/events/serialize';
import { loadViewerStates } from '@/lib/events/viewer-state';
import { errorLogLine } from '@/lib/http/errors';

/**
 * GET /api/me/events — the events the signed-in user added by hand, for `/my-events`.
 *
 * Scoped by `createdByUserId` IN THE QUERY, so there is no id to guess and nothing to leak: the
 * only rows this can ever return are the caller's own. Each one goes out through the same
 * `toEventDetail` the event page uses, so the list and the page agree about status, "saved by
 * others" and what Delete would do.
 *
 * SOFT-DELETED ROWS ARE EXCLUDED, including ones an admin removed. `canViewEvent` gives the owner no
 * exemption for a deleted event (the row is kept so an admin can undo, not so it stays readable), and
 * listing it here would contradict the event page's 404.
 *
 * 200 at most, newest start first. A person does not hand-enter more than that; if one ever does,
 * this becomes a paginated list rather than an unbounded one.
 */
export async function GET() {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  try {
    await connectDB();
    const docs = await Event.find({ createdByUserId: gate.userId, ...notDeletedClause() })
      .select(DETAIL_SELECT)
      .sort({ startDateTime: -1 })
      .limit(200)
      .lean();

    const states = await loadViewerStates(docs, gate.userId);
    return NextResponse.json(
      { events: docs.map(doc => toEventDetail(doc, gate.userId, states.get(String(doc._id)))) },
      // A private list. `sw.js` already treats `/api/me/` as network-only.
      { headers: { 'Cache-Control': 'private, no-store' } }
    );
  } catch (error) {
    // No input: always the server's fault. Titles are user text, so the log line is kept inert.
    console.error('Error listing own events:', errorLogLine(error));
    return NextResponse.json({ error: 'Failed to load your events' }, { status: 500 });
  }
}
