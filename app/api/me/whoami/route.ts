/**
 * GET /api/me/whoami — what the SERVER sees about your session.
 *
 * WHY THIS EXISTS. A user reported being signed in on the home page (the nav drew their
 * avatar) while `/tracker`, `/folders` and `/add-event` all sent them back to the sign-in
 * screen — reproduced on several accounts and devices. That combination is not explainable
 * from the code alone, because the two halves disagree about the same request:
 *
 *   · `NavBar` draws the avatar when `session.user` is TRUTHY (`useSession()`).
 *   · `getCurrentUserId()` returns `session?.user?.id ?? null`, and every `requireUser()`
 *     route answers 401 on null.
 *
 * So a session whose `user.id` is missing looks signed in and behaves signed out, and no
 * existing diagnostic could tell those apart from outside the browser. Worse, every
 * `scripts/diag-*.ts` signs in through the DEV_LOGIN provider, which sets `token.sub`
 * explicitly — so the GOOGLE path's `token.sub` is the one thing in this app's auth that
 * nothing ever exercised.
 *
 * WHAT IT IS SAFE TO RETURN. This route is deliberately NOT behind `requireUser()`: it has to
 * work precisely when the session is broken, which is when a guard would refuse it. THAT PART IS
 * CORRECT AND MUST STAY. It is safe only because every field is derived from the CALLER'S OWN
 * cookies — an anonymous request gets all-false and learns nothing, and a signed-in request
 * learns only about itself. It returns cookie NAMES, never cookie VALUES, so the session token
 * cannot be read back out; `userId` is truncated because its presence is the diagnostic, not its
 * value.
 *
 * WHAT WAS REMOVED, AND WHY IT DID NOT BELONG. The response also carried `nodeEnv`,
 * `nextAuthUrlSet`, `nextAuthUrlHost`, `requestHost`, `adminEmailsConfigured` and the raw
 * `auth()` exception message — to ANY anonymous caller. None of that derives from the caller, so
 * it fell outside the sentence above that justifies the route being open. It is reconnaissance on
 * the deployment: `nextAuthUrlSet: false` is this app's documented cause of total auth failure,
 * `nextAuthUrlHost` versus `requestHost` says whether the canonical origin matches the host being
 * served, and `adminEmailsConfigured: false` tells a stranger every admin route is currently
 * answering 503 — a "come back later" signal about a window when the operator has locked
 * themselves out.
 *
 * The deployment block is now gated on `session !== null`, which costs the diagnostic nothing:
 * its whole purpose is to let a user comparing "looks signed in" with "is signed in" read the
 * session fields correctly, and that person has a session by definition. `authError`'s message is
 * never returned at all — a throw from `auth()` leaves no session to gate on, so gating it would
 * make it dead weight; the boolean `authThrew` carries the signal and the wording goes to the
 * server log, where an operator can read it.
 *
 * `no-store`, because a cached answer here would be worse than no answer.
 */
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
// `auth` is overloaded (it doubles as middleware), so ReturnType<typeof auth> resolves to
// NextMiddleware rather than the session. Name the session type directly.
import type { Session } from 'next-auth';

const NO_STORE = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
} as const;

export async function GET(request: NextRequest) {
  // Names only. This is the load-bearing half: it distinguishes "the browser sent no session
  // cookie" (a cookie/domain/expiry problem) from "it sent one and the server still has no
  // user" (a token-shape problem). Those two have completely different fixes.
  const authCookieNames = request.cookies
    .getAll()
    .map(c => c.name)
    .filter(n => n.includes('authjs'))
    .sort();

  const sessionCookieNames = authCookieNames.filter(n => n.includes('session-token'));

  let session: Session | null = null;
  let authThrew = false;
  try {
    session = await auth();
  } catch (error) {
    /*
     * If `auth()` itself throws, every protected route is 401 and nothing else in the app says so
     * out loud — so the FACT is worth reporting. The MESSAGE is not: it can quote NEXTAUTH_SECRET
     * handling, the configured origin, or a provider's response, and it was going to anonymous
     * callers. It goes to the log instead, which is where an operator can act on it.
     */
    authThrew = true;
    console.error('whoami: auth() threw', error);
  }

  const userId = session?.user?.id ?? null;

  return NextResponse.json(
    {
      // ── what the browser sent ──────────────────────────────────────────────────────
      sentAnyAuthCookie: authCookieNames.length > 0,
      sentSessionCookie: sessionCookieNames.length > 0,
      sessionCookieIsChunked: sessionCookieNames.some(n => /\.\d+$/.test(n)),
      authCookieNames,

      // ── what auth() made of it ────────────────────────────────────────────────────
      authThrew,
      hasSession: session !== null,
      hasSessionUser: Boolean(session?.user),

      /*
       * THE DECIDING FIELD. `hasSessionUser: true` with `hasUserId: false` is exactly the
       * reported symptom — the avatar renders and every requireUser route 401s. If both are
       * true, the session is healthy and the redirect came from somewhere else.
       */
      hasUserId: userId !== null,
      userIdPrefix: userId ? `${userId.slice(0, 6)}…` : null,
      email: session?.user?.email ?? null,
      isAdmin: session?.user?.isAdmin === true,

      /*
       * ── deployment facts, FOR A SIGNED-IN CALLER ONLY ────────────────────────────
       *
       * A missing NEXTAUTH_URL in production is the documented cause of auth failures on
       * non-Vercel hosts, and a mismatched one breaks cookies on the host actually served — so
       * these belong in the diagnostic. They do not belong in an ANONYMOUS response: none of
       * them derives from the caller, which is the property that makes this route safe to leave
       * unguarded. Spread conditionally so the keys are simply absent rather than present-and-
       * null, which would still confirm which questions the route can answer.
       */
      ...(session
        ? {
            nodeEnv: process.env.NODE_ENV,
            nextAuthUrlSet: Boolean(process.env.NEXTAUTH_URL),
            nextAuthUrlHost: (() => {
              try {
                return process.env.NEXTAUTH_URL ? new URL(process.env.NEXTAUTH_URL).host : null;
              } catch {
                return 'UNPARSEABLE';
              }
            })(),
            requestHost: request.headers.get('host'),
            adminEmailsConfigured: Boolean((process.env.ADMIN_EMAILS || '').trim()),
          }
        : {}),
    },
    { headers: NO_STORE }
  );
}
