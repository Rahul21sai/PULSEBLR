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
const PROTECTED = ['/dashboard', '/tracker', '/add-event', '/settings', '/admin'];

export default function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  const isProtected = PROTECTED.some(p => pathname.startsWith(p));
  if (isProtected) {
    // Check for the next-auth session token cookie (works with JWT strategy)
    const token =
      req.cookies.get('__Secure-authjs.session-token')?.value ||
      req.cookies.get('authjs.session-token')?.value;

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
