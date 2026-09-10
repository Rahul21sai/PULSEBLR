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
 * multi-user deployment.
 *
 * THE LAST SENTENCE OF THIS COMMENT USED TO SAY the scheduled cron "still uses USER_EMAIL". It does
 * not, and has not since the digest gained a per-user cadence: `scripts/send-digest.ts` now walks the
 * `User` collection and honours each account's stored `digestFrequency`, and `USER_EMAIL` is read by
 * nothing. It is still true that the cron does not call this route — this one exists so an admin can
 * PREVIEW their own digest, which is why it stays `requireAdmin()` and why it is the remaining caller
 * of the fuller `generateDailyDigest`.
 *
 * That last point is load-bearing rather than incidental. `generateDailyDigest` includes
 * `getUnhealthySources()`, which names every failing source and quotes its `lastError` — fine for the
 * operator previewing their own, a disclosure of scraper internals the moment the audience is "every
 * consenting user". The scheduled mailing therefore uses a narrower formatter. Do not "unify" the two
 * back into one.
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
    /*
     * NO ECHOED MESSAGE. This path reaches Mongoose (the digest reads Event, TrackerEntry,
     * Contact and Source) and the Resend SDK, so the message can name a model and a schema path,
     * or quote the provider's response. The 503 branch above is the counter-example worth
     * keeping: `RESEND_API_KEY is not configured` is a deliberate, hand-written sentence about
     * this endpoint's own configuration, not an exception the caller was handed by accident.
     */
    console.error('Digest API error:', error);
    return NextResponse.json({ success: false, error: 'Failed to send the digest' }, { status: 500 });
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
    // NO ECHOED MESSAGE — and this was the worst of the eight sites, because `requireUser()`
    // means ANY signed-in Google account could read it, where the POST sibling above is
    // admin-only. Logged, not returned.
    console.error('Digest preview error:', error);
    return NextResponse.json({ error: 'Failed to build the digest preview' }, { status: 500 });
  }
}
