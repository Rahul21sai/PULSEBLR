import { NextRequest, NextResponse } from 'next/server';

// Routes that require a signed-in user
const PROTECTED = ['/dashboard', '/tracker', '/add-event'];

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
