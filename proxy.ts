import { NextRequest, NextResponse } from 'next/server';

// Routes that require a signed-in user.
//
// `/settings` belongs here and was missing: it exposes controls that disable event
// sources and trigger a scraper run, so it was operable by anyone who knew the URL.
// The underlying API routes are now gated too (lib/api-auth.ts) — this is the
// don't-even-render-it layer, not the security boundary.
//
// NOTE: the matcher below deliberately excludes `api`, so NOTHING here protects an API
// route. Every /api guard lives in its own handler. See lib/api-auth.ts.
// NOTE ON PREFIX MATCHING: the check below is `pathname.startsWith(p)`, so each entry also
// covers every sibling beginning with those characters. That is why the public pages of the
// scan feature live at deliberately different top-level segments:
//
//   /folders, /scan, /card   PRIVATE — listed here
//   /c/<token>               PUBLIC  — somebody's card, opened from a QR by a stranger
//   /f/<token>               PUBLIC  — "add yourself to this folder"
//
// `'/c/abc'.startsWith('/card')` is false, so `/card` does not accidentally capture `/c/…`.
// Never add a bare `/c` or `/f` here, and never nest a public page under a listed prefix.
const PROTECTED = [
  '/dashboard',
  '/tracker',
  '/add-event',
  '/settings',
  '/admin',
  '/folders',
  '/scan',
  '/card',
];

export default function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  const isProtected = PROTECTED.some(p => pathname.startsWith(p));
  if (isProtected) {
    /*
     * Look for the Auth.js session cookie — and for its CHUNKED form, which this used to miss.
     *
     * `@auth/core/lib/utils/cookie.js` splits the session cookie once the value exceeds
     * ALLOWED_COOKIE_SIZE - ESTIMATED_EMPTY_COOKIE_SIZE = 3936 chars, storing it as
     * `<name>.0`, `<name>.1`, … and then the UNCHUNKED name does not exist at all. Checking
     * only the exact names therefore reads a perfectly valid session as "signed out" and
     * redirects the user to /login from every protected page, while the client's own
     * `/api/auth/session` still works — because Auth.js reassembles the chunks and this did not.
     *
     * Verified against production: `Cookie: __Secure-authjs.session-token=x` answered 200 while
     * `Cookie: __Secure-authjs.session-token.0=x` answered 307 to /login.
     *
     * Today's tokens do not chunk — a real Google session measured 649-883 chars, well under the
     * threshold — so this is latent rather than the cause of a current report. It becomes live the
     * moment a token grows: a longer `picture` URL, a longer name, or one more claim in the `jwt`
     * callback. That is a silent, total sign-out of every protected page, so it is worth closing
     * before it is reached rather than after.
     *
     * DELIBERATELY STILL A PRESENCE CHECK, NOT A VALIDATION. Verifying the JWT here would need the
     * secret in the edge runtime, and getting that wrong locks out every signed-in user at once —
     * the failure mode is the whole app, not one route. The real boundary is `requireUser()` /
     * `requireAdmin()` in each handler (lib/api-auth.ts); this layer only decides whether to
     * bother rendering a shell that will fetch its own data. So it may only ever become MORE
     * permissive, never less.
     */
    const SESSION_COOKIES = ['__Secure-authjs.session-token', 'authjs.session-token'];
    const token = req.cookies
      .getAll()
      .find(c => SESSION_COOKIES.some(n => c.name === n || c.name.startsWith(`${n}.`)))?.value;

    if (!token) {
      const loginUrl = new URL('/login', req.url);
      loginUrl.searchParams.set('callbackUrl', pathname);
      return NextResponse.redirect(loginUrl);
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon\\.ico|icon-192\\.svg|icon-512\\.svg|sw\\.js|manifest\\.json).*)'],
};
