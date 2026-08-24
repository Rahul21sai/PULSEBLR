import { NextResponse } from 'next/server';
import {
  getPendingFollowUps,
  markFollowUpComplete,
  completeContactFollowUp,
} from '@/lib/helpers/phase6';
import { getCurrentUserId } from '@/lib/auth-helpers';

export async function GET() {
  const userId = await getCurrentUserId();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const followUps = await getPendingFollowUps(userId);
    return NextResponse.json({ followUps });
  } catch (error) {
    console.error('Error fetching follow-ups:', error);
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

  try {
    const body = await request.json();

    if (typeof body.contactId === 'string' && body.contactId) {
      const contact = await completeContactFollowUp(userId, body.contactId);
      return NextResponse.json({ contact });
    }

    const { trackerEntryId, connectionName } = body;
    if (!trackerEntryId || !connectionName) {
      return NextResponse.json(
        { error: 'Missing required fields: contactId, or trackerEntryId and connectionName' },
        { status: 400 }
      );
    }
    const entry = await markFollowUpComplete(trackerEntryId, connectionName, userId);
    return NextResponse.json({ entry });
  } catch (error) {
    console.error('Error marking follow-up complete:', error);
    return NextResponse.json({ error: 'Failed to mark follow-up complete' }, { status: 500 });
  }
}
