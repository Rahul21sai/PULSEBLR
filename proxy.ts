import { NextResponse } from 'next/server';

/**
 * Next 16's middleware equivalent. IT NO LONGER GATES PAGES, AND THAT IS THE FIX.
 *
 * WHAT IT USED TO DO, AND WHY IT HAD TO GO. It redirected `/dashboard`, `/tracker`, `/add-event`,
 * `/settings`, `/admin`, `/folders`, `/scan` and `/card` to `/login` unless it could find an
 * Auth.js session cookie BY NAME. Two independent problems, and neither is fixable at this layer:
 *
 *   1. IT SECURED NOTHING. The edge runtime has no secret to verify a JWT with, so the check
 *      could only ever be "is a cookie with this name present". Measured against production:
 *      `Cookie: __Secure-authjs.session-token=dummy` returned **200** on all eight paths. Any
 *      stranger could walk straight past it by inventing a cookie. Putting the secret in the edge
 *      runtime to make it a real check is the wrong trade too — getting that wrong signs out
 *      every user at once, so the blast radius is the whole app rather than one route.
 *
 *   2. IT LOCKED OUT USERS WHO WERE SIGNED IN. Reported repeatedly, then confirmed from the app's
 *      own screen: `/login?callbackUrl=%2Ffolders` rendered "You're already signed in as
 *      <the user's address>". So the browser held a session that `/api/auth/session` could read
 *      and decode, while this file had just refused the navigation that led there. Only `proxy.ts`
 *      ever writes that URL shape, so the redirect was unambiguously from here.
 *
 * A check that cannot say no to an attacker but does say no to a real user has negative value.
 * Deleting it is the fix, not tuning the cookie names — the previous attempt at that (teaching it
 * about CHUNKED cookies) was a genuine latent defect but not this bug, and it did not help.
 *
 * WHERE THE GATE LIVES NOW.
 *   · Authorisation, unchanged and untouched: `requireUser()` / `requireAdmin()` in every private
 *     API route (`lib/api-auth.ts`), and `/admin`'s own server-side session + allowlist check,
 *     which `redirect()`s a non-admin before any admin markup is generated.
 *   · What to DRAW: `app/components/ProtectedRouteGate.tsx`, which asks `useSession()` — the same
 *     session the API routes see — instead of guessing from a cookie name.
 *
 * WHY THE FILE STILL EXISTS. Removing it entirely is a bigger change than this hotfix wants, and
 * an empty pass-through is the honest intermediate state: it documents the decision at the place
 * someone will look for it. If nothing else claims this layer, delete the file — but do NOT
 * reintroduce cookie-name sniffing here.
 */
export default function proxy() {
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon\\.ico|icon-192\\.svg|icon-512\\.svg|sw\\.js|manifest\\.json).*)'],
};
