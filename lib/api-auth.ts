// Auth guards for API route handlers.
//
// WHY THESE EXIST AT THE HANDLER LEVEL and not in proxy.ts: the proxy's matcher is
// `'/((?!api|_next/static|...).*)'` — `api` is the first negative-lookahead term, so
// the proxy NEVER runs for an API route. Any protection for /api must live in the
// handler itself. Six endpoints were reachable with no credentials at all because of
// this: POST /api/events, PUT+DELETE /api/events/[id], POST /api/sources,
// PUT+DELETE /api/sources/[id], POST+GET /api/scrape, POST /api/scrape-url and
// POST+GET /api/notifications/send-digest.
//
// WHY ADMIN IS A SEPARATE TIER: Google sign-in is open to anybody with a Google
// account, so "signed in" is not a meaningful bar for operations that affect everyone.
// A stranger could sign in and delete the whole event corpus, wipe the Source
// discovery state that makes coverage compound, or trigger a scrape loop that burns
// the owner's LLM quota and gets the deployment IP banned by Meetup and Luma.
//
// Neither cron calls these routes — daily-scrape.yml and daily-digest.yml run
// `npm run scrape` and `npm run send-digest` directly — so there is deliberately no
// shared-secret bypass to maintain or leak.

import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { isAdminConfigured, isAdminEmail } from '@/lib/admin';

/** JSON 401, in the shape the existing tracker routes already return. */
function unauthorized() {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

/**
 * Require any signed-in user. Returns the user id, or a response to return as-is.
 *
 * Usage mirrors the existing `getCurrentUserId()` pattern:
 *
 *   const gate = await requireUser();
 *   if ('response' in gate) return gate.response;
 *   // gate.userId is available here
 */
export async function requireUser(): Promise<{ userId: string } | { response: NextResponse }> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return { response: unauthorized() };
  return { userId };
}

/**
 * Require an admin, identified by email against the ADMIN_EMAILS allowlist.
 *
 * FAILS CLOSED. With ADMIN_EMAILS unset, every admin route returns 503 rather than
 * falling back to "any signed-in user". Fail-open here would mean shipping the exact
 * hole this file exists to close, and a misconfigured deploy that refuses to scrape is
 * far cheaper than one where a stranger can empty the database. The error message names
 * the variable so the fix is obvious.
 */
export async function requireAdmin(): Promise<{ userId: string; email: string } | { response: NextResponse }> {
  if (!isAdminConfigured()) {
    console.error(
      'ADMIN_EMAILS is not set, so every admin API route is refusing requests. ' +
        'Set it to a comma-separated list of Google account emails allowed to run the ' +
        'scraper and edit events/sources.'
    );
    return {
      response: NextResponse.json(
        {
          error: 'Admin access is not configured',
          detail: 'Set the ADMIN_EMAILS environment variable to enable this endpoint.',
        },
        { status: 503 }
      ),
    };
  }

  const session = await auth();
  const userId = session?.user?.id;
  const email = session?.user?.email?.toLowerCase();
  if (!userId || !email) return { response: unauthorized() };

  if (!isAdminEmail(email)) {
    // 403, not 401: the caller is authenticated, they are simply not permitted. The
    // email is deliberately not echoed back.
    return { response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }

  return { userId, email };
}
