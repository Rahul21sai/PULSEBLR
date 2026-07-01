import { auth } from '@/auth';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// Routes that require a signed-in user
const PROTECTED = ['/dashboard', '/tracker', '/add-event'];

export default auth((req: NextRequest & { auth: any }) => {
  const { pathname } = req.nextUrl;

  const isProtected = PROTECTED.some(p => pathname.startsWith(p));
  if (isProtected && !req.auth) {
    const loginUrl = new URL('/login', req.url);
    loginUrl.searchParams.set('callbackUrl', pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
});

export const config = {
  // Run middleware on app pages only — skip static files and API routes
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|icon-192.svg|icon-512.svg|sw.js|manifest.json).*)'],
};
