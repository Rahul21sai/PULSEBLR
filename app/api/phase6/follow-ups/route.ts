import { NextResponse } from 'next/server';
import {
  getPendingFollowUps,
  markFollowUpComplete,
  completeContactFollowUp,
} from '@/lib/helpers/phase6';
import { getCurrentUserId } from '@/lib/auth-helpers';
import { errorLogLine, routeFailure } from '@/lib/http/errors';

export async function GET() {
  const userId = await getCurrentUserId();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const followUps = await getPendingFollowUps(userId);
    return NextResponse.json({ followUps });
  } catch (error) {
    // No input: always the server's fault. Follow-ups carry people's names, so the line is inert.
    console.error('Error fetching follow-ups:', errorLogLine(error));
    return NextResponse.json({ error: 'Failed to fetch follow-ups' }, { status: 500 });
  }
}

/**
 * Mark a follow-up done.
 *
 * Accepts EITHER shape:
 *   { contactId }                        — the precise path, addressing one row
 *   { trackerEntryId, connectionName }   — legacy, for rows not yet migrated
 *
 * Both are supported because a user's follow-ups can span both sources until
 * `scripts/migrate-connections-to-contacts.ts` has run. `scripts/diag-tracker-flow.ts` posts
 * the legacy shape and must keep passing.
 */
export async function POST(request: Request) {
  const userId = await getCurrentUserId();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // `request.json()` THROWS on a malformed body, and it used to do so inside the try below, so a
  // caller's broken JSON was a 500. Read after the guard, as every route here does; a JSON value that
  // is not an object is read as an empty body and refused by the field check below.
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return NextResponse.json({ error: 'request body must be valid JSON' }, { status: 400 });
  }

  try {
    if (typeof body.contactId === 'string' && body.contactId) {
      const contact = await completeContactFollowUp(userId, body.contactId);
      if (!contact) return NextResponse.json({ error: 'Not found' }, { status: 404 });
      return NextResponse.json({ contact });
    }

    const { trackerEntryId, connectionName } = body;
    if (!trackerEntryId || !connectionName) {
      return NextResponse.json(
        { error: 'Missing required fields: contactId, or trackerEntryId and connectionName' },
        { status: 400 }
      );
    }
    // Asserted, not coerced: what this route accepts is unchanged by the body now being typed.
    const entry = await markFollowUpComplete(trackerEntryId as string, connectionName as string, userId);
    return NextResponse.json({ entry });
  } catch (error) {
    console.error('Error marking follow-up complete:', errorLogLine(error));
    // `completeContactFollowUp` refuses a malformed id itself; `markFollowUpComplete` hands
    // `trackerEntryId` straight to `findOne({ _id })`, so a CastError on `_id` is that field's.
    const failure = routeFailure(error, 'Failed to mark follow-up complete', {
      rename: { _id: 'trackerEntryId' },
      fields: ['trackerEntryId'],
    });
    return NextResponse.json(failure.body, { status: failure.status });
  }
}
