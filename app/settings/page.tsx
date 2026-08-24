'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useSession, signOut } from 'next-auth/react';
import { DesktopNav, MobileBottomNav } from '../components/NavBar';
import MyCardSection from './MyCardSection';

/**
 * /settings — the USER's surface: their account, their digest, what the app is.
 *
 * The scraper trigger and the source-health table used to live here, which was the
 * admin/user boundary problem in one page: any signed-in user could open Settings and
 * see machinery they cannot operate — worse, before the endpoints were gated, could
 * actually operate. Those controls now live at /admin behind a server-side allowlist
 * check, and this page links there only for admins.
 *
 * What is left is genuinely per-user, so there is nothing here to hide.
 */
/**
 * Wipe the service worker's caches, then sign out.
 *
 * Sign-out is the only moment the app knows the identity behind an origin-wide cache is about
 * to change. `sw.js` v3 already refuses to cache private API responses, but cached NAVIGATIONS
 * can carry server-rendered private markup, and a device shared between two Google accounts is
 * exactly the case that made this a real leak rather than a theoretical one.
 *
 * Bounded by a short timeout so a wedged worker can never trap somebody signed in.
 */
async function signOutAfterPurgingCaches() {
  try {
    const registration = await navigator.serviceWorker?.getRegistration();
    if (registration?.active) {
      await new Promise<void>(resolve => {
        const done = () => {
          navigator.serviceWorker.removeEventListener('message', onMessage);
          resolve();
        };
        const onMessage = (event: MessageEvent) => {
          if (event.data?.type === 'caches-purged') done();
        };
        navigator.serviceWorker.addEventListener('message', onMessage);
        registration.active!.postMessage({ type: 'purge-caches' });
        setTimeout(done, 1500);
      });
    }
    // Also clear anything the page owns directly. The scan outbox is deliberately NOT cleared:
    // unsynced captures are the user's own data and must survive a sign-out so they can sign
    // back in and upload them.
    if (typeof caches !== 'undefined') {
      const names = await caches.keys();
      await Promise.all(names.map(name => caches.delete(name)));
    }
  } catch {
    // Never block sign-out on cleanup.
  }
  await signOut({ callbackUrl: '/' });
}

export default function SettingsPage() {
  const { data: session } = useSession();
  const isAdmin = session?.user?.isAdmin === true;

  // Public counts, so a normal user still gets a sense of the corpus without being shown
  // source health or the scraper.
  const [counts, setCounts] = useState<{ upcoming: number; tech: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [all, tech] = await Promise.all([
          fetch('/api/events?limit=1').then(r => r.json()),
          fetch('/api/events?limit=1&techOnly=true').then(r => r.json()),
        ]);
        if (!cancelled) {
          setCounts({
            upcoming: all?.pagination?.total ?? 0,
            tech: tech?.pagination?.total ?? 0,
          });
        }
      } catch {
        // Counts are decoration here — a failure should not produce an error banner on
        // a settings page.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="min-h-screen bg-[#F5F5F7]">
      <DesktopNav />

      <header className="md:hidden fixed top-0 w-full h-14 bg-white/96 glass-nav z-50 border-b border-black/5 flex items-center justify-between px-5">
        <Link href="/" className="text-lg font-bold tracking-tight text-[#1D1D1F]">
          PulseBLR
        </Link>
        <span className="text-[#86868B] text-label-md font-semibold">Settings</span>
      </header>

      <main className="pt-14 pb-24 md:pb-10">
        <div className="max-w-[820px] mx-auto px-4 md:px-8 pt-6 space-y-5">
          <div>
            <h1 className="text-[24px] md:text-[30px] font-bold tracking-[-0.025em] text-[#1D1D1F]">
              Settings
            </h1>
            <p className="text-[13.5px] text-[#6E6E73] mt-0.5">
              Your account and how events reach you.
            </p>
          </div>

          {/* ── Account ─────────────────────────────────────────────────── */}
          <section className="bg-white rounded-2xl card-shadow p-5">
            <div className="flex items-center gap-4">
              {session?.user?.image ? (
                // eslint-disable-next-line @next/next/no-img-element -- Google avatar CDN
                <img
                  src={session.user.image}
                  alt=""
                  className="w-12 h-12 rounded-full object-cover shrink-0"
                />
              ) : (
                <div className="w-12 h-12 rounded-full bg-[#f3f3f5] flex items-center justify-center shrink-0">
                  <span className="material-symbols-outlined text-[#86868B] text-[26px]">person</span>
                </div>
              )}
              <div className="flex-1 min-w-0">
                {session?.user ? (
                  <>
                    <p className="text-[15px] font-semibold text-[#1D1D1F] truncate flex items-center gap-2">
                      {session.user.name || 'Signed in'}
                      {isAdmin && (
                        <span className="shrink-0 rounded-full bg-[#1D1D1F] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white">
                          Admin
                        </span>
                      )}
                    </p>
                    <p className="text-[13px] text-[#6E6E73] truncate">{session.user.email}</p>
                  </>
                ) : (
                  <>
                    <p className="text-[15px] font-semibold text-[#1D1D1F]">Not signed in</p>
                    <p className="text-[13px] text-[#6E6E73]">
                      Sign in to track events and log who you met.
                    </p>
                  </>
                )}
              </div>
              {session?.user ? (
                <button
                  type="button"
                  onClick={() => void signOutAfterPurgingCaches()}
                  className="shrink-0 px-4 py-2 rounded-full text-[12.5px] font-semibold text-[#FF3B30] bg-red-50 hover:bg-red-100 transition-colors"
                >
                  Sign out
                </button>
              ) : (
                <Link
                  href="/login"
                  className="shrink-0 px-4 py-2 rounded-full text-[12.5px] font-semibold text-white bg-[#0071E3] hover:bg-blue-600 transition-colors"
                >
                  Sign in
                </Link>
              )}
            </div>
          </section>

          {/* ── My card ─────────────────────────────────────────────────── */}
          {session?.user && <MyCardSection />}

          {/* ── What you can do ─────────────────────────────────────────── */}
          <section className="bg-white rounded-2xl card-shadow p-5">
            <h2 className="text-[16px] font-bold text-[#1D1D1F]">Your permissions</h2>
            <p className="text-[13px] text-[#6E6E73] mt-0.5">
              {isAdmin
                ? 'You administer this deployment as well as using it.'
                : 'Everything you need to find events and track the people you meet.'}
            </p>
            <ul className="mt-3 space-y-2">
              <Permission icon="explore" granted title="Browse and search events" detail="Filter by topic, area, format and date." />
              <Permission icon="bookmarks" granted title="Track events" detail="Save events, move them through your board, and log who you met." />
              <Permission icon="event_available" granted title="Apply and follow up" detail="Keep application links and follow-up reminders in one place." />
              <Permission
                icon="sync"
                granted={isAdmin}
                title="Run the scraper"
                detail={isAdmin ? 'Trigger a fast or full run from Admin.' : 'Handled automatically every morning at 8 AM IST.'}
              />
              <Permission
                icon="tune"
                granted={isAdmin}
                title="Manage sources and events"
                detail={isAdmin ? 'Enable, disable or delete sources and fix mis-tagged events.' : 'Reserved for the administrator.'}
              />
            </ul>

            {isAdmin && (
              <Link
                href="/admin"
                className="mt-4 inline-flex items-center gap-1.5 rounded-full bg-[#1D1D1F] px-4 py-2 text-[12.5px] font-semibold text-white hover:bg-black transition-colors"
              >
                <span className="material-symbols-outlined text-[15px]">shield_person</span>
                Open Admin
              </Link>
            )}
          </section>

          {/* ── Digest ──────────────────────────────────────────────────── */}
          <section className="bg-white rounded-2xl card-shadow p-5">
            <h2 className="text-[16px] font-bold text-[#1D1D1F]">Daily digest</h2>
            <p className="text-[13px] text-[#6E6E73] mt-1">
              A summary of new events, deadlines and follow-ups goes out at 8 AM IST via a
              scheduled GitHub Action.
            </p>
            {/*
              Honest about where this is configured. An earlier version offered an email
              field that only wrote to localStorage, so changing it appeared to work while
              the digest kept using the server's USER_EMAIL.
            */}
            <div className="mt-3 bg-[#f9f9fb] rounded-xl p-4 text-[12.5px] text-[#3a3a3c] space-y-1.5">
              <p>
                Recipient is set by the <code className="font-mono text-[11.5px]">USER_EMAIL</code>{' '}
                environment variable, and sending needs{' '}
                <code className="font-mono text-[11.5px]">RESEND_API_KEY</code>.
              </p>
              {session?.user ? (
                <p className="text-[#86868B]">
                  Preview your own digest:{' '}
                  <a
                    href="/api/notifications/send-digest"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-semibold text-[#0071E3] hover:underline"
                  >
                    open preview
                  </a>{' '}
                  — it is scoped to your tracker, so it shows only your data.
                </p>
              ) : (
                <p className="text-[#86868B]">Sign in to preview your digest.</p>
              )}
            </div>
          </section>

          {/* ── About ───────────────────────────────────────────────────── */}
          <section className="bg-white rounded-2xl card-shadow p-5">
            <h2 className="text-[16px] font-bold text-[#1D1D1F]">About</h2>
            <dl className="mt-3 text-[13px] text-[#3a3a3c] space-y-2">
              <div className="flex justify-between gap-4">
                <dt className="text-[#86868B]">Upcoming events</dt>
                <dd className="tnum font-semibold">
                  {counts ? counts.upcoming.toLocaleString('en-IN') : '—'}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-[#86868B]">Tech events</dt>
                <dd className="tnum font-semibold">
                  {counts ? counts.tech.toLocaleString('en-IN') : '—'}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-[#86868B]">Stack</dt>
                <dd className="font-semibold text-right">Next.js 16 · MongoDB · NVIDIA NIM</dd>
              </div>
            </dl>
          </section>
        </div>
      </main>

      <MobileBottomNav />
    </div>
  );
}

/** One row in the permissions list: what you can do, and what you cannot. */
function Permission({
  icon,
  granted,
  title,
  detail,
}: {
  icon: string;
  granted: boolean;
  title: string;
  detail: string;
}) {
  return (
    <li className="flex items-start gap-3">
      <span
        aria-hidden="true"
        className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
          granted ? 'bg-[#e8f3ff] text-[#0071E3]' : 'bg-[#f3f3f5] text-[#a1a1a6]'
        }`}
      >
        <span className="material-symbols-outlined text-[16px]">{icon}</span>
      </span>
      <div className="min-w-0">
        <p className={`text-[13.5px] font-semibold ${granted ? 'text-[#1D1D1F]' : 'text-[#86868B]'}`}>
          {title}
          {!granted && (
            <span className="ml-2 rounded bg-[#f3f3f5] px-1.5 py-0.5 text-[10.5px] font-bold uppercase tracking-wide text-[#86868B]">
              admin only
            </span>
          )}
        </p>
        <p className="text-[12.5px] text-[#6E6E73]">{detail}</p>
      </div>
    </li>
  );
}
