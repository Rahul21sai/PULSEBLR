import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongodb';
import User from '@/lib/models/User';
import { requireUser } from '@/lib/api-auth';
import { ensureUser } from '@/lib/user-record';
import { auth } from '@/auth';
import {
  followUpNudgesEnabled,
  parseNudgePreferenceBody,
} from '@/lib/notifications/followup-nudge-policy';
import { errorLogLine, routeFailure } from '@/lib/http/errors';

/**
 * GET /api/me/follow-up-nudges — is the morning-after follow-up push on for me?
 * PUT /api/me/follow-up-nudges — `{ enabled: boolean }`, the switch in Settings → Notifications.
 *
 * Absent on the User row means ON (`followUpNudgesEnabled`); only this route ever writes it. The
 * logic lives in `lib/notifications/followup-nudge-policy.ts` because a route file may export only
 * HTTP methods and segment config (CLAUDE.md §18).
 */

function json(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

export async function GET() {
  // GUARD FIRST.
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  try {
    await connectDB();
    const user = await User.findOne({ googleId: gate.userId }).select('pushFollowUpNudges').lean();
    // No row reads as the default, which is on. Reading must not create one.
    return json({ enabled: followUpNudgesEnabled(user) }, 200);
  } catch (error) {
    console.error('Error reading follow-up nudge preference:', errorLogLine(error));
    return json({ error: 'Could not read your follow-up notification setting.' }, 500);
  }
}

export async function PUT(request: NextRequest) {
  // GUARD FIRST, VALIDATE SECOND. An anonymous caller with a bad body must get 401, not 400.
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  const body = await request.json().catch(() => null);
  const parsed = parseNudgePreferenceBody(body);
  // Refused before `connectDB()`: a bad request needs no database.
  if (!parsed.ok) return json({ error: parsed.error }, 400);

  try {
    await connectDB();
    const session = await auth();
    // The row can legitimately be missing for a valid session (CLAUDE.md §9), and an update that
    // matches nothing would report success and change nothing.
    await ensureUser(gate.userId, session?.user?.email, session?.user?.name);
    await User.updateOne({ googleId: gate.userId }, { $set: { pushFollowUpNudges: parsed.enabled } });
    return json({ enabled: parsed.enabled }, 200);
  } catch (error) {
    console.error('Error saving follow-up nudge preference:', errorLogLine(error));
    // `enabled` is the caller's one field, stored as `pushFollowUpNudges`. A refusal of anything else
    // (`ensureUser` writing the session's own email) is our data, so it stays the 500.
    const failure = routeFailure(error, 'Could not save your follow-up notification setting.', {
      rename: { pushFollowUpNudges: 'enabled' },
      fields: ['enabled'],
    });
    return json(failure.body, failure.status);
  }
}
