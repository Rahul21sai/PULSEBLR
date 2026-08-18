import { NextResponse } from 'next/server';
import { sendDailyDigestEmail } from '@/lib/notifications/email';
import { generateDailyDigest, formatDigestAsText } from '@/lib/notifications/digest';
import { requireAdmin, requireUser } from '@/lib/api-auth';

/**
 * POST /api/notifications/send-digest — send the digest email now. ADMIN ONLY.
 *
 * Was unauthenticated, which let anyone on the internet drain the Resend quota and
 * spam the configured inbox on demand.
 *
 * It also used to send to a hardcoded `process.env.USER_EMAIL` regardless of who
 * asked. It now sends to the requesting admin's own address and builds the personal
 * half of the digest from their own tracker data, so the endpoint is correct in a
 * multi-user deployment. The scheduled cron still uses USER_EMAIL via
 * `npm run send-digest`; it does not call this route.
 */
export async function POST() {
  const gate = await requireAdmin();
  if ('response' in gate) return gate.response;

  try {
    console.log(`📧 Sending daily digest to ${gate.email} via API…`);

    const success = await sendDailyDigestEmail({
      to: gate.email,
      userId: gate.userId,
    });

    if (success) {
      return NextResponse.json({
        success: true,
        message: 'Daily digest sent successfully',
        to: gate.email,
      });
    }

    // sendDailyDigestEmail returns false when RESEND_API_KEY is unset, which is a
    // configuration state rather than a crash — say which it is.
    return NextResponse.json(
      {
        error: 'Digest not sent',
        detail: process.env.RESEND_API_KEY
          ? 'The email provider rejected the send; check the server logs.'
          : 'RESEND_API_KEY is not configured.',
      },
      { status: process.env.RESEND_API_KEY ? 500 : 503 }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Digest API error:', error);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

/**
 * GET /api/notifications/send-digest — preview the digest without sending.
 *
 * Any signed-in user may preview THEIR OWN digest. This was the worst of the open
 * endpoints: it returned the full digest object to anonymous callers, and
 * generateDailyDigest had no user filter, so the payload contained every user's
 * tracked events, their contacts' names, companies and roles, their follow-up dates
 * and the user's private notes. Verified open before the fix: HTTP 200, 387 KB, no
 * cookie. Now it requires a session and is scoped to that session's user.
 */
export async function GET() {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  try {
    const digest = await generateDailyDigest(gate.userId);
    const preview = formatDigestAsText(digest);

    return NextResponse.json({
      digest,
      preview,
      stats: {
        newEvents: digest.newEvents.length,
        upcomingDeadlines: digest.upcomingDeadlines.length,
        trackerUpdates: digest.trackerUpdates.length,
        followUpReminders: digest.followUpReminders.length,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Digest preview error:', error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
