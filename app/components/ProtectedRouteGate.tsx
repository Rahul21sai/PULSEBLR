'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { currentPageTarget, loginHref } from '@/lib/auth-callback-url';
import { isAdminOnlyPath, isProtectedPath } from '@/lib/protected-routes';

/**
 * Shown to a signed-in user who is not an admin. Deliberately explains WHY rather than just
 * refusing: "adding events is an operator task" is actionable information, "403" is not.
 */
function AdminOnlyNotice() {
  return (
    <div className="min-h-screen bg-[var(--paper)]">
      <div className="mx-auto max-w-[520px] px-5 pt-24 text-center">
        <span
          aria-hidden="true"
          className="material-symbols-outlined mb-3 block text-[48px] text-[var(--ink-3)]"
        >
          shield_person
        </span>
        <h1 className="t-head text-[var(--ink)]">Admins only</h1>
        <p className="mt-2 text-[14px] leading-relaxed text-[var(--ink-2)]">
          Adding events by hand changes what everyone sees, so it is limited to this
          deployment&apos;s operators. Everything else in your account is unaffected.
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/"
            className="pressable inline-flex h-11 items-center justify-center rounded-full bg-[var(--accent)] px-6 text-[13.5px] font-semibold text-[var(--accent-ink)] hover:bg-[var(--accent)]"
          >
            Back to events
          </Link>
          <Link
            href="/tracker"
            className="pressable inline-flex h-11 items-center justify-center rounded-full bg-[var(--surface)] px-6 text-[13.5px] font-semibold text-[var(--ink)] shadow-[inset_0_0_0_1px_var(--hairline-strong)] hover:bg-[var(--paper)]"
          >
            Your tracker
          </Link>
        </div>
      </div>
    </div>
  );
}

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
  const { data: session, status } = useSession();

  if (!isProtectedPath(pathname)) return <>{children}</>;

  /*
   * ADMIN-ONLY PAGES: refuse a signed-in NON-admin here rather than at submit time.
   *
   * `/add-event` used to be offered to everyone while `POST /api/events` is gated by
   * `requireAdmin()` — so a regular user could fill in the entire form and only learn on submit
   * that the write was refused. Saying so up front is the difference between a boundary and a
   * trap. `/admin` does not rely on this (it re-checks server-side and redirects), so this is
   * belt-and-braces there.
   *
   * Checked only once the session is SETTLED and authenticated: during `loading`, `isAdmin` is
   * simply absent, and treating that as "not an admin" would flash this panel at an admin on
   * every hard navigation — the same false-negative bug that made the proxy gate unusable.
   */
  if (status === 'authenticated' && isAdminOnlyPath(pathname) && !session?.user?.isAdmin) {
    return <AdminOnlyNotice />;
  }

  if (status !== 'unauthenticated') return <>{children}</>;

  /*
   * CARRY THE QUERY STRING, NOT JUST THE PATH, so signing in returns to the page actually asked for.
   *
   * This used to encode `pathname` alone, and the query is sometimes the whole payload. The PWA's
   * share target (`public/manifest.json`) opens `/add-event?title=…&text=…&url=…`, and `/add-event`
   * is protected — so sharing a link into the installed app while signed out went: sign-in wall →
   * Google → a bare `/add-event`, with the shared title, text and link gone. Nothing on screen said
   * anything had been lost.
   *
   * `window.location`, not `useSearchParams()`: that hook here would need a Suspense boundary
   * around the gate, which wraps every page. Reading the location is safe because this branch never
   * renders on the server — `SessionProvider` gets no `session` prop, so `status` is `loading` for
   * the server render and for hydration, and only a later client render can reach this line. The
   * `typeof window` test is there so that stays true if that ever changes, rather than crashing.
   *
   * `currentPageTarget` also compares the location against the router's `pathname`, because during
   * a client-side navigation Next renders the new route BEFORE it updates the address bar; the
   * query of the page being left must not be carried onto this one. `loginHref` then runs the
   * target through the same `safeCallbackUrl` the login page applies, so the link written here is
   * always one the login page will honour byte for byte — see `lib/auth-callback-url.ts`.
   */
  const signInHref = loginHref(
    currentPageTarget(typeof window === 'undefined' ? undefined : window.location, pathname)
  );

  return (
    <div className="min-h-screen bg-[var(--paper)]">
      <div className="mx-auto max-w-[520px] px-5 pt-24 text-center">
        <span
          aria-hidden="true"
          className="material-symbols-outlined mb-3 block text-[48px] text-[var(--ink-3)]"
        >
          lock
        </span>
        <h1 className="t-head text-[var(--ink)]">Sign in to continue</h1>
        <p className="mt-2 text-[14px] leading-relaxed text-[var(--ink-2)]">
          This page is private to your account — the events you saved, the people you met, and
          when to follow up.
        </p>

        {/* `hover:bg-[var(--accent)]` — a no-op hover, as `ui.tsx`'s Button tones do. It was
            `hover:bg-blue-600`, a Tailwind palette blue that flashed over the canopy-green accent
            on every desktop hover: not one of the nine palette values. */}
        <Link
          href={signInHref}
          className="pressable mt-6 inline-flex h-11 items-center justify-center rounded-full bg-[var(--accent)] px-6 text-[13.5px] font-semibold text-[var(--accent-ink)] hover:bg-[var(--accent)]"
        >
          Sign in with Google
        </Link>

        {/* The feed, search, filters and company directory are all public, so this is a real
            alternative rather than a dead end. */}
        <p className="mt-5 text-[13px] text-[var(--ink-2)]">
          or{' '}
          <Link href="/" className="font-semibold text-[var(--accent)] hover:underline">
            browse events without an account
          </Link>
        </p>
      </div>
    </div>
  );
}
