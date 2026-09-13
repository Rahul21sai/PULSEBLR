'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useSession, signOut } from 'next-auth/react';
import { DesktopNav, MobileBottomNav } from '../components/NavBar';
import MyCardSection from './MyCardSection';
import CalendarFeedSection from './CalendarFeedSection';
import PushSection from './PushSection';

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
 * Release this device's push subscription and wipe the service worker's caches, then sign out.
 *
 * Sign-out is the only moment the app knows the identity behind an origin-wide cache is about
 * to change. `sw.js` v3 already refuses to cache private API responses, but cached NAVIGATIONS
 * can carry server-rendered private markup, and a device shared between two Google accounts is
 * exactly the case that made this a real leak rather than a theoretical one.
 *
 * THE PUSH SUBSCRIPTION IS THE SAME PROBLEM WITH A LOUDER FAILURE, and it is why this function
 * grew a second job. A push endpoint identifies a BROWSER PROFILE, not an account — which is why
 * `PushSubscription`'s unique index is on `endpoint` alone. So when a shared phone changes hands,
 * the row still points at the previous account until the new one happens to open Settings, and
 * until then that account's saved-event reminders keep arriving on somebody else's lock screen.
 * A cache leak needs the other person to go looking; this one walks up and taps them on the
 * shoulder.
 *
 * Order matters: release the subscription while the session cookie is still valid, because
 * `DELETE /api/me/push` is behind `requireUser()` and answers 401 the moment it is gone.
 *
 * Bounded by a short timeout so a wedged worker can never trap somebody signed in.
 */
async function signOutAfterPurgingCaches() {
  try {
    // Best-effort and deliberately not awaited into the failure path: if this 401s, times out or
    // the user is offline, the row is repaired by the self-heal on next sign-in. Losing a
    // notification is the acceptable failure; blocking sign-out is not.
    await fetch('/api/me/push?all=true', { method: 'DELETE', cache: 'no-store' }).catch(() => {});
    // Drop the browser-side subscription too, so the next account starts clean rather than
    // re-POSTing an endpoint the server has just forgotten.
    const reg = await navigator.serviceWorker?.getRegistration();
    const existing = await reg?.pushManager?.getSubscription();
    await existing?.unsubscribe().catch(() => {});
  } catch {
    // Never block sign-out on cleanup.
  }

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
    <div className="min-h-screen bg-[var(--paper)]">
      <DesktopNav />

      <header className="md:hidden fixed top-0 w-full h-14 bg-[var(--surface)]/96 glass-nav z-50 border-b border-[var(--rule)] flex items-center justify-between px-5">
        <Link href="/" className="text-lg font-bold tracking-tight text-[var(--ink)]">
          PulseBLR
        </Link>
        <span className="text-[var(--ink-2)] text-label-md font-semibold">Settings</span>
      </header>

      <main className="pt-14 pb-24 md:pb-10">
        <div className="max-w-[820px] mx-auto px-4 md:px-8 pt-6 space-y-5">
          {/* The ruled header every surface now shares. Note the `<h1>` was NOT carrying a type
              class and was still serif: globals.css sets `h1, h2, h3 { font-family: var(--font-display) }`
              unlayered, so a Tailwind `font-*` utility cannot reach it. `.ty-section` can, because it
              is unlayered too and more specific. */}
          <div className="rule-b pb-[var(--s-4)]">
            <h1 className="ty-section text-[var(--ink)]">Settings</h1>
            <p className="ty-meta mt-[var(--s-1)]">Your account, and how events reach you.</p>
          </div>

          {/* ── Account ─────────────────────────────────────────────────── */}
          <section className="rounded-[var(--r-flat)] border border-[var(--rule)] p-5">
            <div className="flex items-center gap-4">
              {session?.user?.image ? (
                // eslint-disable-next-line @next/next/no-img-element -- Google avatar CDN
                <img
                  src={session.user.image}
                  alt=""
                  className="w-12 h-12 rounded-full object-cover shrink-0"
                />
              ) : (
                <div className="w-12 h-12 rounded-full bg-[var(--paper)] flex items-center justify-center shrink-0">
                  <span aria-hidden="true" className="material-symbols-outlined text-[var(--ink-3)] text-[26px]">person</span>
                </div>
              )}
              <div className="flex-1 min-w-0">
                {session?.user ? (
                  <>
                    <p className="text-[15px] font-semibold text-[var(--ink)] truncate flex items-center gap-2">
                      {session.user.name || 'Signed in'}
                      {isAdmin && (
                        <span className="shrink-0 rounded-full bg-[var(--ink)] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[var(--accent-ink)]">
                          Admin
                        </span>
                      )}
                    </p>
                    <p className="text-[13px] text-[var(--ink-2)] truncate">{session.user.email}</p>
                  </>
                ) : (
                  <>
                    <p className="text-[15px] font-semibold text-[var(--ink)]">Not signed in</p>
                    <p className="text-[13px] text-[var(--ink-2)]">
                      Sign in to track events and log who you met.
                    </p>
                  </>
                )}
              </div>
              {session?.user ? (
                <button
                  type="button"
                  onClick={() => void signOutAfterPurgingCaches()}
                  className="shrink-0 px-4 py-2 rounded-full text-[12.5px] font-semibold text-[var(--live)] bg-[var(--paper)] hover:bg-[var(--paper)] transition-colors"
                >
                  Sign out
                </button>
              ) : (
                <Link
                  href="/login"
                  className="shrink-0 px-4 py-2 rounded-full text-[12.5px] font-semibold text-[var(--accent-ink)] bg-[var(--accent)] hover:bg-[var(--accent)] transition-colors"
                >
                  Sign in
                </Link>
              )}
            </div>
          </section>

          {/* ── Your feed ───────────────────────────────────────────────────
              A LINK TO `/onboarding`, NOT A SECOND COPY OF THE CONTROLS.

              The three cards are already a screen with sixteen topic chips, twenty-eight area chips,
              a format group, seven day chips and the two email preferences. Rebuilding that here
              would be the `/people` filter rail mistake exactly — two implementations of one control
              set, drifting apart, and the reason the two pages stopped feeling like one app.
              `?from=settings` changes the copy and returns here on save.

              It is offered to signed-out visitors too, as a description rather than a control: it
              names something the product does, and the sign-in prompt is directly above. */}
          {session?.user && (
            <section className="rounded-[var(--r-flat)] border border-[var(--rule)] p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="text-[16px] font-bold text-[var(--ink)]">Your feed</h2>
                  <p className="mt-0.5 text-[13px] leading-relaxed text-[var(--ink-2)]">
                    Topics, the areas you can reach, which evenings work, and how often we email you.
                    The <span className="font-semibold text-[var(--ink)]">For you</span> tab on the feed
                    ranks by these — it never hides anything, and{' '}
                    <span className="font-semibold text-[var(--ink)]">Everything</span> is always one tap
                    away.
                  </p>
                </div>
                <Link
                  href="/onboarding?from=settings"
                  className="pressable inline-flex h-10 shrink-0 items-center rounded-full bg-[var(--ink)] px-5 text-[13px] font-semibold text-[var(--accent-ink)] hover:bg-[var(--ink)]"
                >
                  Edit preferences
                </Link>
              </div>
            </section>
          )}

          {/* ── My card ─────────────────────────────────────────────────── */}
          {session?.user && <MyCardSection />}

          {/* ── Calendar subscription ───────────────────────────────────────
              Placed here rather than beside the digest on purpose: this is a
              one-time setup that hands the user a URL, closer in kind to their
              card than to a recurring message. The digest and push sections
              below are the two things that actually arrive. */}
          {session?.user && <CalendarFeedSection />}

          {/* ── Assistant access (MCP tokens) ───────────────────────────── */}
          {session?.user && <McpTokensSection />}

          {/* ── What you can do ─────────────────────────────────────────── */}
          <section className="rounded-[var(--r-flat)] border border-[var(--rule)] p-5">
            <h2 className="text-[16px] font-bold text-[var(--ink)]">Your permissions</h2>
            <p className="text-[13px] text-[var(--ink-2)] mt-0.5">
              {isAdmin
                ? 'You administer this deployment as well as using it.'
                : 'Everything you need to find events and track the people you meet.'}
            </p>
            <ul className="mt-3 space-y-2">
              <Permission icon="explore" granted title="Browse and search events" detail="Filter by topic, area, format and date." />
              <Permission icon="bookmarks" granted title="Track events" detail="Save events, move them through your board, and log who you met." />
              <Permission icon="event_available" granted title="Apply and follow up" detail="Keep application links and follow-up reminders in one place." />
              <Permission
                icon="smart_toy"
                granted
                title="Connect an assistant"
                detail="Mint a read-only token above so Claude, Cursor or Copilot can read your people and saved events."
              />
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
                className="mt-4 inline-flex items-center gap-1.5 rounded-full bg-[var(--ink)] px-4 py-2 text-[12.5px] font-semibold text-[var(--accent-ink)] hover:bg-[var(--ink)] transition-colors"
              >
                <span aria-hidden="true" className="material-symbols-outlined text-[15px]">shield_person</span>
                Open Admin
              </Link>
            )}
          </section>

          {/* ── Digest ──────────────────────────────────────────────────── */}
          <section className="rounded-[var(--r-flat)] border border-[var(--rule)] p-5">
            <h2 className="text-[16px] font-bold text-[var(--ink)]">Email digest</h2>
            <p className="text-[13px] text-[var(--ink-2)] mt-1">
              A short list of events worth your time, sent Monday mornings at 8 AM IST. You can
              switch it to daily or turn it off.
            </p>
            {/*
              THIS SECTION USED TO BE FACTUALLY WRONG, AND THAT IS WHY IT NOW LINKS RATHER THAN
              DESCRIBES.

              It told the reader "Recipient is set by the USER_EMAIL environment variable". That
              stopped being true when the digest gained a per-user cadence: recipients now come from
              the `User` collection and each account's own stored `digestFrequency`, and `USER_EMAIL`
              is no longer read by anything — a grep finds it only in comments recording its removal.
              An earlier version of this block had an email field that only wrote to localStorage, so
              changing it appeared to work while the digest ignored it. Both failures are the same
              one: a settings screen describing a mechanism instead of driving it.

              The cadence control itself lives in the onboarding flow, which doubles as its editor,
              so this links there. A second copy of the radio group here is how the two would drift.
            */}
            <div className="mt-3 bg-[var(--paper)] rounded-xl p-4 text-[12.5px] text-[var(--ink-2)] space-y-1.5">
              <p>
                Choose weekly, daily or off in{' '}
                <Link
                  href="/onboarding?from=settings"
                  className="font-semibold text-[var(--accent)] hover:underline"
                >
                  your feed preferences
                </Link>
                . Every digest carries its own unsubscribe link, and this week&apos;s is public at{' '}
                <Link href="/digest" className="font-semibold text-[var(--accent)] hover:underline">
                  /digest
                </Link>
                .
              </p>
              {session?.user ? (
                <p className="text-[var(--ink-2)]">
                  Preview your own digest:{' '}
                  <a
                    href="/api/notifications/send-digest"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-semibold text-[var(--accent)] hover:underline"
                  >
                    open preview
                  </a>{' '}
                  — it is scoped to your tracker, so it shows only your data.
                </p>
              ) : (
                <p className="text-[var(--ink-2)]">Sign in to preview your digest.</p>
              )}
            </div>
          </section>

          {/* ── Push notifications ──────────────────────────────────────────
              Directly after the digest because they are the same question asked
              twice — how should we reach you — and a reader deciding about one is
              deciding about the other. They are NOT one setting: the digest is
              gated on `preferences.remindersEnabled`, while for push the existence
              of a PushSubscription row IS the consent, since it took a click and an
              OS permission grant. Turning off email must not silence push, and
              vice versa. */}
          {session?.user && <PushSection />}

          {/* ── About ───────────────────────────────────────────────────── */}
          <section className="rounded-[var(--r-flat)] border border-[var(--rule)] p-5">
            <h2 className="text-[16px] font-bold text-[var(--ink)]">About</h2>
            <dl className="mt-3 text-[13px] text-[var(--ink-2)] space-y-2">
              <div className="flex justify-between gap-4">
                <dt className="text-[var(--ink-2)]">Upcoming events</dt>
                <dd className="tnum font-semibold">
                  {counts ? counts.upcoming.toLocaleString('en-IN') : '—'}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-[var(--ink-2)]">Tech events</dt>
                <dd className="tnum font-semibold">
                  {counts ? counts.tech.toLocaleString('en-IN') : '—'}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-[var(--ink-2)]">Stack</dt>
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

/* ══════════════════════════════════════════════════════════════════════════════════════════
   Assistant access — the MCP personal access tokens
   ══════════════════════════════════════════════════════════════════════════════════════════ */

interface McpTokenRow {
  id: string;
  name: string;
  hint: string;
  scope: string;
  createdAt: string;
  expiresAt: string;
  expired: boolean;
  lastUsedAt: string | null;
}

/**
 * Mint, list and revoke the tokens that let an assistant read your own PulseBLR data.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS LIVES IN `/settings` AND NOT ON `/mcp`. `/mcp` is public, statically rendered and in the
 * sitemap — it is the page a developer finds from a README. A credential belongs behind a session, so
 * `/mcp` documents the feature and links here, and this section is the only place a token is ever
 * produced. `/settings` is already in `PROTECTED_PATHS`, so the gate is inherited rather than invented.
 *
 * THE TOKEN IS SHOWN EXACTLY ONCE, and the UI has to be honest about that BEFORE the user navigates
 * away — hence the panel that stays until dismissed, the copy button, and the wording that says it
 * cannot be shown again. The server stores only a hash, so "show it to me again" is not a feature
 * somebody can add later without changing that.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */
function McpTokensSection() {
  const [tokens, setTokens] = useState<McpTokenRow[] | null>(null);
  const [max, setMax] = useState(10);
  const [name, setName] = useState('');
  const [days, setDays] = useState(90);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The one-time plaintext. Held in component state only, and never persisted anywhere. */
  const [fresh, setFresh] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);

  async function load() {
    try {
      const response = await fetch('/api/me/mcp-tokens');
      if (!response.ok) throw new Error(String(response.status));
      const data = await response.json();
      setTokens(data.tokens ?? []);
      if (typeof data.max === 'number') setMax(data.max);
    } catch {
      setError('Could not load your access tokens.');
      setTokens([]);
    }
  }

  /**
   * The list is fetched from the CLICK, not from an effect.
   *
   * An effect that calls `setState` synchronously is the `react-hooks/set-state-in-effect` error, and
   * the rule is right here rather than merely strict: opening a panel is a user event, so fetching in
   * response to it is synchronising with an external system at the moment the user asked. Deriving it
   * from an effect on `open` would re-run on every state change that touches the dependency and needs a
   * `tokens === null` guard to stop looping — a guard that exists only to undo the wrong trigger.
   */
  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && tokens === null) void load();
  }

  async function create() {
    setCreating(true);
    setError(null);
    try {
      const response = await fetch('/api/me/mcp-tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), expiresInDays: days }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data?.error ?? 'Could not create that token.');
        return;
      }
      setFresh(data.token);
      setCopied(false);
      setName('');
      await load();
    } catch {
      setError('Could not create that token.');
    } finally {
      setCreating(false);
    }
  }

  async function revoke(token: McpTokenRow) {
    // A confirm, because this is irreversible AND it breaks something the user has configured
    // elsewhere. Naming the token means they cannot revoke the wrong one by muscle memory.
    const ok = window.confirm(
      `Revoke "${token.name}"? Any assistant configured with it stops being able to read your ` +
        'people and saved events immediately. This cannot be undone — you would mint a new token and ' +
        'update that client.'
    );
    if (!ok) return;

    setError(null);
    try {
      const response = await fetch(`/api/me/mcp-tokens?id=${encodeURIComponent(token.id)}`, {
        method: 'DELETE',
      });
      if (!response.ok) {
        setError('Could not revoke that token.');
        return;
      }
      await load();
    } catch {
      setError('Could not revoke that token.');
    }
  }

  const live = (tokens ?? []).filter(t => !t.expired).length;

  return (
    <section className="rounded-[var(--r-flat)] border border-[var(--rule)] p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[16px] font-bold text-[var(--ink)]">Assistant access</h2>
          <p className="mt-0.5 text-[13px] leading-relaxed text-[var(--ink-2)]">
            Let Claude, Cursor or Copilot read <span className="font-semibold text-[var(--ink)]">your</span>{' '}
            PulseBLR data — the people you have met, who you know at a company, what is on your tracker
            and which follow-ups are overdue. Read-only, and revocable here.{' '}
            <Link href="/mcp" className="font-semibold text-[var(--accent)] hover:underline">
              Setup instructions
            </Link>
            .
          </p>
        </div>
        <button
          type="button"
          onClick={toggle}
          className="pressable inline-flex h-10 shrink-0 items-center rounded-full bg-[var(--ink)] px-5 text-[13px] font-semibold text-[var(--accent-ink)] hover:bg-[var(--ink)]"
          aria-expanded={open}
        >
          {open ? 'Hide' : 'Manage tokens'}
        </button>
      </div>

      {open && (
        <div className="mt-4 border-t border-[color:var(--hairline)] pt-4">
          {/* The one-time reveal. Deliberately loud, and it does not disappear on its own. */}
          {fresh && (
            <div className="mb-4 rounded-xl border border-[var(--accent)]/30 bg-[var(--paper)] p-4">
              <p className="text-[13px] font-semibold text-[var(--ink)]">
                Copy this now — it cannot be shown again.
              </p>
              <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--ink-2)]">
                Only a hash is stored, so there is no way to look it up later. If you lose it, revoke it
                and mint another.
              </p>
              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                <code className="min-w-0 flex-1 break-all rounded-[var(--r-flat)] border border-[var(--rule)] bg-[var(--surface)] px-3 py-2 font-mono text-[12px] text-[var(--ink)]">
                  {fresh}
                </code>
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard?.writeText(fresh).then(
                      () => setCopied(true),
                      () => setError('Could not copy — select the token and copy it manually.')
                    );
                  }}
                  className="pressable h-10 shrink-0 rounded-full bg-[var(--accent)] px-4 text-[12.5px] font-semibold text-[var(--accent-ink)] hover:bg-[var(--accent)]"
                >
                  {copied ? 'Copied' : 'Copy'}
                </button>
                <button
                  type="button"
                  onClick={() => setFresh(null)}
                  className="pressable h-10 shrink-0 rounded-full bg-[var(--surface)] px-4 text-[12.5px] font-semibold text-[var(--ink-2)] hover:bg-[var(--paper)]"
                >
                  Done
                </button>
              </div>
            </div>
          )}

          {error && (
            <p className="mb-3 rounded-lg bg-[var(--paper)] px-3 py-2 text-[12.5px] font-medium text-[var(--live)]">
              {error}
            </p>
          )}

          {/* ── Mint ─────────────────────────────────────────────────── */}
          <div className="flex flex-wrap items-end gap-2">
            <label className="min-w-[180px] flex-1">
              <span className="block text-[11.5px] font-semibold uppercase tracking-wide text-[var(--ink-2)]">
                Name
              </span>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                maxLength={80}
                placeholder="Claude Code on my laptop"
                className="mt-1 h-10 w-full rounded-[var(--r-touch)] border border-[color:var(--hairline)] bg-[var(--paper)] px-3 text-[13px] text-[var(--ink)] outline-none focus:border-[var(--accent)]"
              />
            </label>
            <label>
              <span className="block text-[11.5px] font-semibold uppercase tracking-wide text-[var(--ink-2)]">
                Expires
              </span>
              <select
                value={days}
                onChange={e => setDays(Number(e.target.value))}
                className="mt-1 h-10 rounded-[var(--r-touch)] border border-[color:var(--hairline)] bg-[var(--paper)] px-3 text-[13px] text-[var(--ink)] outline-none focus:border-[var(--accent)]"
              >
                {/* There is no "never" option on purpose — a credential with no end date is one you
                    forget you issued. The server clamps to 365 days regardless of what is sent. */}
                <option value={30}>in 30 days</option>
                <option value={90}>in 90 days</option>
                <option value={365}>in a year</option>
              </select>
            </label>
            <button
              type="button"
              onClick={() => void create()}
              disabled={creating || name.trim().length === 0 || live >= max}
              className="pressable h-10 shrink-0 rounded-full bg-[var(--accent)] px-5 text-[13px] font-semibold text-[var(--accent-ink)] hover:bg-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {creating ? 'Creating…' : 'Create token'}
            </button>
          </div>
          {live >= max && (
            <p className="mt-2 text-[12.5px] text-[var(--ink-2)]">
              You have {max} active tokens, which is the limit. Revoke one you no longer use.
            </p>
          )}

          {/* ── List ─────────────────────────────────────────────────── */}
          <div className="mt-4">
            {tokens === null ? (
              <p className="text-[12.5px] text-[var(--ink-2)]">Loading…</p>
            ) : tokens.length === 0 ? (
              <p className="text-[12.5px] leading-relaxed text-[var(--ink-2)]">
                No tokens yet. Without one, an assistant connected to PulseBLR can still search public
                events — it just cannot see anything of yours.
              </p>
            ) : (
              <ul className="flex flex-col">
                {tokens.map(token => (
                  <li
                    key={token.id}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-[color:var(--hairline)] py-2.5 first:border-0 first:pt-0"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-2 text-[13.5px] font-semibold text-[var(--ink)]">
                        <span className="truncate">{token.name}</span>
                        <code className="font-mono text-[11.5px] font-normal text-[var(--ink-2)]">
                          pblr_…{token.hint}
                        </code>
                        {token.expired && (
                          <span className="rounded bg-[var(--paper)] px-1.5 py-0.5 text-[10.5px] font-bold uppercase tracking-wide text-[var(--ink-2)]">
                            expired
                          </span>
                        )}
                      </p>
                      <p className="text-[12px] text-[var(--ink-2)]">
                        {token.scope} ·{' '}
                        {token.expired
                          ? `expired ${shortDate(token.expiresAt)}`
                          : `expires ${shortDate(token.expiresAt)}`}
                        {' · '}
                        {/* "Never used" is worth saying explicitly: it is the signal that a config was
                            pasted wrong, which is otherwise indistinguishable from a working setup. */}
                        {token.lastUsedAt ? `last used ${shortDate(token.lastUsedAt)}` : 'never used'}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void revoke(token)}
                      className="pressable shrink-0 rounded-full bg-[var(--paper)] px-4 py-2 text-[12.5px] font-semibold text-[var(--live)] hover:bg-[var(--paper)]"
                    >
                      Revoke
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <p className="mt-3 text-[12px] leading-relaxed text-[var(--ink-2)]">
            A token is a password, not a share link. It can only read, never write — nothing with one
            can save an event, record a person or complete a follow-up. It cannot mint or revoke another
            token either; that needs this page.
          </p>
        </div>
      )}
    </section>
  );
}

/**
 * A short IST date. Uses `Asia/Kolkata` explicitly rather than the browser locale, for the reason
 * `lib/format.ts` exists: this is a Bengaluru product and a phone set to another zone would otherwise
 * show a token expiring on the wrong day. Not imported from `lib/format.ts` because that module's
 * helpers are shaped for event instants, and this is a plain calendar date.
 */
function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
  });
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
          granted ? 'bg-[var(--paper)] text-[var(--accent)]' : 'bg-[var(--paper)] text-[var(--ink-3)]'
        }`}
      >
        <span aria-hidden="true" className="material-symbols-outlined text-[16px]">{icon}</span>
      </span>
      <div className="min-w-0">
        <p className={`text-[13.5px] font-semibold ${granted ? 'text-[var(--ink)]' : 'text-[var(--ink-2)]'}`}>
          {title}
          {!granted && (
            <span className="ml-2 rounded bg-[var(--paper)] px-1.5 py-0.5 text-[10.5px] font-bold uppercase tracking-wide text-[var(--ink-2)]">
              admin only
            </span>
          )}
        </p>
        <p className="text-[12.5px] text-[var(--ink-2)]">{detail}</p>
      </div>
    </li>
  );
}
