'use client';

import Link from 'next/link';
import { signIn, useSession } from 'next-auth/react';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { safeCallbackUrl } from '@/lib/auth-callback-url';

/**
 * Sign-in.
 *
 * The old version was a centred card that sold "curated tech events feed" and
 * "calendar view with dot indicators". Both were wrong in the same way: BROWSING NEEDS
 * NO ACCOUNT. The feed, search, filters, company directory and event pages are all
 * public, so promising access to them in exchange for signing in is asking for
 * something and offering nothing.
 *
 * What an account actually buys is the second half of the product: a record of the
 * people you met. So that is what this page says, and the "keep looking" escape hatch
 * is a real link rather than a dead end. It also drops the two `href="#"` Terms and
 * Privacy links, which pointed nowhere — a fake legal link is worse than none.
 */
/**
 * `useSearchParams()` suspends, so the page body is split out and wrapped in a Suspense
 * boundary by the default export below. Without that, a statically rendered route that reads
 * search params fails the build.
 */
function LoginBody() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchParams = useSearchParams();
  const { data: session, status } = useSession();

  /*
   * WHERE TO GO AFTER SIGNING IN.
   *
   * This used to be a hard-coded `'/'`, which silently discarded the `?callbackUrl=` that
   * `proxy.ts` attaches when it bounces someone off a protected page. The effect: tap
   * "Tracker", sign in, and land on the HOME page — which is indistinguishable from the
   * sign-in having failed, and is why this was reported as "clicking the tracker just sends
   * me to the sign-in page".
   *
   * `safeCallbackUrl` is not decoration: the value comes from the URL, so forwarding it
   * unchecked would be an open redirect. See `lib/auth-callback-url.ts`.
   */
  const callbackUrl = safeCallbackUrl(searchParams.get('callbackUrl'));

  async function handleGoogleSignIn() {
    setLoading(true);
    setError(null);
    try {
      await signIn('google', { callbackUrl });
    } catch {
      // signIn normally navigates away, so reaching here means it never got started.
      setError('Could not reach Google. Check your connection and try again.');
      setLoading(false);
    }
  }

  /*
   * ALREADY SIGNED IN — show that, rather than a sign-in form.
   *
   * Reaching this page with a live session is not a hypothetical: `proxy.ts` decides on the
   * presence of the session COOKIE, while this component reads the session through
   * `/api/auth/session`. When those two disagree the user is bounced here holding a perfectly
   * good session and shown a "Sign in" button, which reads as the app having forgotten them.
   *
   * Deliberately a BUTTON, not an automatic redirect. If the proxy is going to bounce this
   * navigation again, an auto-redirect turns one confusing screen into an infinite loop — a
   * strictly worse failure. A button makes the state legible and leaves the user in control,
   * and naming the account they are signed in as is what turns "it keeps asking me to sign in"
   * into something diagnosable from the screen alone.
   */
  const signedIn = status === 'authenticated' && Boolean(session?.user);

  return (
    <div className="min-h-screen bg-[#F5F5F7] px-5 py-12 md:py-0 md:grid md:min-h-screen md:place-items-center">
      <div className="mx-auto w-full max-w-[880px] md:grid md:grid-cols-[1.15fr_1fr] md:items-center md:gap-14">
        {/* ── The thesis ──────────────────────────────────────────────────────
            Stated as the job the product does, not as a feature list. */}
        <div className="mb-10 md:mb-0">
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-[15px] font-bold tracking-[-0.02em] text-[#1D1D1F]"
            style={{ fontFamily: 'var(--font-display)' }}
          >
            <span className="grid h-6 w-6 place-items-center rounded-[7px] bg-[#1D1D1F] text-[11px] font-bold text-white">
              P
            </span>
            PulseBLR
          </Link>

          <h1 className="t-display mt-7 text-[#1D1D1F]">
            Remember who
            <br />
            you met.
          </h1>

          <p className="mt-4 max-w-[42ch] text-[15px] leading-relaxed text-[#6E6E73]">
            Bengaluru runs a few hundred tech events a month. Finding them is the easy
            part — the value is walking out with names, and still having them next week.
          </p>

          <ul className="mt-7 space-y-3.5">
            {[
              {
                icon: 'bookmarks',
                title: 'Track what you are going to',
                body: 'A board of interested, going and attended.',
              },
              {
                icon: 'group',
                title: 'Log the people, not just the event',
                body: 'Name, role, company, and what you actually talked about.',
              },
              {
                icon: 'alarm',
                title: 'Get nudged to follow up',
                body: 'Before the conversation goes cold.',
              },
            ].map(item => (
              <li key={item.icon} className="flex items-start gap-3">
                <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-white shadow-[inset_0_0_0_1px_var(--hairline)]">
                  <span aria-hidden="true" className="material-symbols-outlined text-[16px] text-[#0071E3]">
                    {item.icon}
                  </span>
                </span>
                <div className="min-w-0">
                  <p className="text-[13.5px] font-semibold text-[#1D1D1F]">{item.title}</p>
                  <p className="text-[13px] text-[#6E6E73] tracking-[0]">{item.body}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>

        {/* ── The action ─────────────────────────────────────────────────── */}
        <div className="rounded-[22px] bg-white card-shadow-lg p-7 md:p-8">
          <h2 className="t-head text-[#1D1D1F]">
            {signedIn ? 'You’re already signed in' : 'Sign in'}
          </h2>
          <p className="mt-1 text-[13.5px] leading-relaxed text-[#6E6E73]">
            {signedIn ? (
              <>
                as{' '}
                <span className="font-semibold text-[#1D1D1F]">
                  {session?.user?.email || session?.user?.name}
                </span>
                . If you were sent here from another page, continue below.
              </>
            ) : (
              'One tap with Google. No password to remember.'
            )}
          </p>

          {/* Signed in already: offer the way onward instead of a second sign-in. A plain link,
              so it is a fresh navigation the proxy re-evaluates — and if it bounces back here,
              the loop is visible to the user rather than spinning invisibly. */}
          {signedIn && (
            <Link
              href={callbackUrl}
              className="pressable mt-6 flex h-12 w-full items-center justify-center gap-2 rounded-full bg-[#0071E3] px-6 text-[14.5px] font-semibold text-white hover:bg-blue-600"
            >
              Continue
              <span aria-hidden="true" className="material-symbols-outlined text-[18px]">
                arrow_forward
              </span>
            </Link>
          )}

          {!signedIn && (
          <button
            type="button"
            onClick={handleGoogleSignIn}
            disabled={loading}
            className="pressable mt-6 flex h-12 w-full items-center justify-center gap-3 rounded-full bg-[#1D1D1F] px-6 text-[14.5px] font-semibold text-white hover:bg-black disabled:opacity-50"
          >
            {loading ? (
              <>
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                Opening Google…
              </>
            ) : (
              <>
                <span className="grid h-5 w-5 place-items-center rounded-full bg-white">
                  <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
                    <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                    <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05" />
                    <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
                  </svg>
                </span>
                Continue with Google
              </>
            )}
          </button>
          )}

          {error && (
            <p className="mt-3 rounded-xl bg-[#FFF1F0] px-3.5 py-2.5 text-[12.5px] text-[#C7362D]" role="alert">
              {error}
            </p>
          )}

          <div className="mt-6 flex items-center gap-3">
            <span aria-hidden="true" className="h-px flex-1 bg-[color:var(--hairline)]" />
            <span className="t-label text-[#8E8E93]">or</span>
            <span aria-hidden="true" className="h-px flex-1 bg-[color:var(--hairline)]" />
          </div>

          {/* The honest escape hatch: the whole feed is public. */}
          <Link
            href="/"
            className="pressable mt-6 flex h-11 w-full items-center justify-center gap-1.5 rounded-full bg-white text-[13.5px] font-semibold text-[#1D1D1F] shadow-[inset_0_0_0_1px_var(--hairline-strong)] hover:bg-[#F7F7F9]"
          >
            Browse events without an account
            <span aria-hidden="true" className="material-symbols-outlined text-[16px]">arrow_forward</span>
          </Link>

          <p className="mt-5 text-[12px] leading-relaxed text-[#8E8E93]">
            We store your name, email and profile picture from Google, and the events and
            contacts you choose to save. Nothing else.
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * The Suspense boundary `useSearchParams()` requires.
 *
 * The fallback is the page background rather than a spinner: this route resolves in a tick, and
 * a flash of loading chrome on the sign-in screen reads as a failure to a user who has already
 * been told twice that they need to sign in.
 */
export default function LoginPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-[#F5F5F7]" />}>
      <LoginBody />
    </Suspense>
  );
}
