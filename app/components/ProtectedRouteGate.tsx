'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { isProtectedPath } from '@/lib/protected-routes';

/**
 * The signed-in gate for private pages, replacing the cookie-name check in `proxy.ts`.
 *
 * THE BUG THIS FIXES. The proxy decided "are you signed in" by looking for a session cookie by
 * name in the edge runtime. It had no secret to verify a token with, so the check was only ever
 * "is a cookie present" — worth nothing as security (a made-up cookie returned 200 on every
 * protected page) — and it produced false negatives on real sessions, which is a total lockout.
 * Confirmed from the app's own screen: `/login?callbackUrl=%2Ffolders` reported "You're already
 * signed in as <address>", meaning `/api/auth/session` could read a valid session while the
 * proxy had just refused the navigation that led there.
 *
 * This asks `useSession()` instead — the same session the API routes see through `auth()`, so
 * the page and its data can no longer disagree about whether you are signed in.
 *
 * THREE STATES, and `loading` is the one that matters. `useSession()` starts as `loading` on
 * every fresh document load, and treating that as signed-out would flash a sign-in wall at a
 * signed-in user on every hard navigation — the same false-negative class of bug, just moved to
 * the client. So loading RENDERS THE PAGE: the pages fetch their own data and already tolerate a
 * request that lands before the session resolves, and a brief empty state is much cheaper than a
 * wrongly-shown login prompt. Only a settled `unauthenticated` gates.
 *
 * IT IS NOT A SECURITY BOUNDARY AND MUST NOT BE MISTAKEN FOR ONE. It runs in the browser, so it
 * can be bypassed with devtools. That is fine, and unchanged from before: every private API route
 * enforces `requireUser()` / `requireAdmin()`, and `/admin` re-checks the session and the
 * allowlist in a server component before emitting any admin markup. This decides what to DRAW.
 */
export default function ProtectedRouteGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { status } = useSession();

  if (!isProtectedPath(pathname)) return <>{children}</>;
  if (status !== 'unauthenticated') return <>{children}</>;

  // Carry the current path so signing in returns here rather than the home page — the whole
  // point of `lib/auth-callback-url.ts`, which validates it on the way back out.
  const callbackUrl = `/login?callbackUrl=${encodeURIComponent(pathname || '/')}`;

  return (
    <div className="min-h-screen bg-[#F5F5F7]">
      <div className="mx-auto max-w-[520px] px-5 pt-24 text-center">
        <span
          aria-hidden="true"
          className="material-symbols-outlined mb-3 block text-[48px] text-[#d5d5da]"
        >
          lock
        </span>
        <h1 className="t-head text-[#1D1D1F]">Sign in to continue</h1>
        <p className="mt-2 text-[14px] leading-relaxed text-[#6E6E73]">
          This page is private to your account — the events you saved, the people you met, and
          when to follow up.
        </p>

        <Link
          href={callbackUrl}
          className="pressable mt-6 inline-flex h-11 items-center justify-center rounded-full bg-[#0071E3] px-6 text-[13.5px] font-semibold text-white hover:bg-blue-600"
        >
          Sign in with Google
        </Link>

        {/* The feed, search, filters and company directory are all public, so this is a real
            alternative rather than a dead end. */}
        <p className="mt-5 text-[13px] text-[#8E8E93]">
          or{' '}
          <Link href="/" className="font-semibold text-[#0071E3] hover:underline">
            browse events without an account
          </Link>
        </p>
      </div>
    </div>
  );
}
