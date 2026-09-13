'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Subscribe a real calendar to your saved events.
 *
 * ── THE COPY HERE IS DELIBERATELY LESS IMPRESSIVE THAN THE FEATURE SOUNDS ────────────────────
 * Three things are true about ICS subscriptions, and a UI that glosses over any of them produces
 * a support question the user cannot answer for themselves:
 *
 *   1. GOOGLE POLLS ON ITS OWN SCHEDULE. Commonly a few hours, sometimes closer to 24, and
 *      documented nowhere as a guarantee. `REFRESH-INTERVAL` and `X-PUBLISHED-TTL` are hints and
 *      Google is free to ignore them. So the copy says "checks periodically", never "instantly" —
 *      somebody who saves an event and stares at Google Calendar for two minutes must know that
 *      is expected rather than broken. Apple and Outlook let the user pick an interval.
 *
 *   2. GOOGLE IGNORES `VALARM` ON A SUBSCRIBED CALENDAR ENTIRELY. It applies that calendar's own
 *      notification defaults instead, which for a subscribed calendar is usually "none". The feed
 *      carries a 2-hour alarm and Apple Calendar honours it — so this section must not promise
 *      notifications, because on the most popular client it would be a promise the feed cannot
 *      keep. The reminder emails are the notification mechanism, and the copy says so and points
 *      at the control that governs them.
 *
 *   3. TURNING IT OFF IS NOT THE SAME AS REPLACING THE LINK. Off is reversible and keeps every
 *      subscribed device working the moment it comes back on. Replacing breaks them all, and the
 *      breakage is silent on the calendar's side — Google does not surface a 404 on a subscribed
 *      URL, it just quietly stops adding events. So Off is the primary control and Replace is
 *      below a rule, behind a confirm that says what it costs. Same shape as offering Archive
 *      above Delete on a folder.
 *
 * Self-contained: it owns its own fetch and state and takes no props, so `app/settings/page.tsx`
 * mounts it with no wiring.
 */

interface CalendarFeedDTO {
  enabled: boolean;
  url: string | null;
  webcalUrl: string | null;
  createdAt: string | null;
  lastPolledAt: string | null;
}

/** "3 minutes ago" — the only evidence available that a subscription is actually alive. */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'recently';
  const minutes = Math.round((Date.now() - then) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export default function CalendarFeedSection() {
  const [feed, setFeed] = useState<CalendarFeedDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/me/calendar-feed');
      if (!res.ok) throw new Error();
      const data = await res.json();
      setFeed(data.feed);
    } catch {
      setStatus('Could not load your calendar link.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(load, 0);
    return () => clearTimeout(timer);
  }, [load]);

  async function patch(body: Record<string, unknown>, message?: string) {
    setSaving(true);
    setStatus(null);
    try {
      const res = await fetch('/api/me/calendar-feed', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error();
      const data = await res.json();
      setFeed(data.feed);
      if (message) {
        setStatus(message);
        setTimeout(() => setStatus(null), 3000);
      }
    } catch {
      setStatus('Could not save that.');
    } finally {
      setSaving(false);
      setConfirmRotate(false);
    }
  }

  async function copyUrl() {
    if (!feed?.url) return;
    try {
      await navigator.clipboard.writeText(feed.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be refused (an insecure origin, or a permission prompt declined).
      // The URL is on screen and selectable, so this is a missing convenience, not a dead end.
      setStatus('Could not copy — select the link and copy it by hand.');
    }
  }

  if (loading) {
    return (
      <section id="calendar-feed" className="rounded-[var(--r-flat)] border border-[var(--rule)] p-5">
        <div className="h-4 w-1/3 rounded bg-[var(--paper)]" />
        <div className="mt-3 h-3 w-1/2 rounded bg-[var(--paper)]" />
      </section>
    );
  }

  return (
    <section id="calendar-feed" className="rounded-[var(--r-flat)] border border-[var(--rule)] p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[16px] font-bold text-[var(--ink)]">Add to my calendar</h2>
          <p className="mt-0.5 text-[13px] text-[var(--ink-2)]">
            Subscribe once and every event you save shows up in Google Calendar, Apple Calendar or
            Outlook. Your calendar app checks the link periodically on its own schedule — usually a
            few hours, sometimes up to a day.
          </p>
        </div>
        <label
          className="toggle-wrap shrink-0"
          title={feed?.enabled ? 'Subscription is on' : 'Subscription is off'}
        >
          <input
            type="checkbox"
            checked={Boolean(feed?.enabled)}
            disabled={saving}
            onChange={e => void patch({ enabled: e.target.checked })}
          />
          <span className="toggle-track" />
        </label>
      </div>

      {status && (
        <p
          className="mt-3 rounded-xl border-l-2 border-l-[var(--accent)] bg-[var(--paper)] px-4 py-2.5 text-[12.5px] text-[var(--accent)]"
          role="status"
        >
          {status}
        </p>
      )}

      {!feed?.enabled ? (
        <p className="mt-4 rounded-xl bg-[var(--paper)] p-4 text-[12.5px] leading-relaxed text-[var(--ink-2)]">
          Your calendar link is off, so it returns nothing. Switch it on to get a private URL you
          can subscribe to.
        </p>
      ) : (
        feed.url && (
          <div className="mt-4 rounded-xl bg-[var(--paper)] p-4">
            <p className="text-[12px] font-semibold text-[var(--ink-2)]">
              Your private calendar link
            </p>
            <code className="mt-1.5 block break-all text-[11px] leading-relaxed text-[var(--ink)]">
              {feed.url}
            </code>

            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void copyUrl()}
                className="inline-flex h-9 items-center rounded-[var(--r-touch)] bg-[var(--ink)] px-4 text-[12.5px] font-semibold text-[var(--accent-ink)]"
              >
                {copied ? 'Copied' : 'Copy link'}
              </button>
              {feed.webcalUrl && (
                // `webcal:` hands the URL straight to the OS calendar with a subscribe prompt, which
                // on iOS and macOS turns a three-screen copy-paste into one tap. It fetches over
                // http(s) exactly the same way — only the scheme differs.
                <a
                  href={feed.webcalUrl}
                  className="inline-flex h-9 items-center rounded-[var(--r-touch)] bg-[var(--surface)] px-4 text-[12.5px] font-semibold text-[var(--ink)] shadow-[inset_0_0_0_1px_var(--hairline-strong)]"
                >
                  Open in Calendar
                </a>
              )}
            </div>

            <p className="mt-3 text-[12px] leading-relaxed text-[var(--ink-2)]">
              <span className="font-semibold text-[var(--ink)]">Google Calendar:</span> Other
              calendars → From URL → paste the link.{' '}
              <span className="font-semibold text-[var(--ink)]">Apple:</span> use Open in Calendar
              above.{' '}
              <span className="font-semibold text-[var(--ink)]">Outlook:</span> Add calendar →
              Subscribe from web.
            </p>

            <p className="mt-2 text-[11.5px] text-[var(--ink-3)]">
              {feed.lastPolledAt ? (
                <>Last checked by a calendar app {relativeTime(feed.lastPolledAt)}.</>
              ) : (
                <>
                  Nothing has fetched this link yet. It can take a few hours after you subscribe
                  before your calendar first checks in.
                </>
              )}
            </p>
          </div>
        )
      )}

      {/* The honesty paragraph. See the file header for why each clause is here — none of this is
          hedging, all three are things that otherwise generate an unanswerable support question. */}
      <div className="mt-4 rounded-xl bg-[var(--paper)] p-4">
        <p className="text-[12px] leading-relaxed text-[var(--ink-2)]">
          <span className="font-semibold text-[var(--ink)]">
            This puts events in your calendar. It does not send notifications.
          </span>{' '}
          The feed carries a 2-hour alarm and Apple Calendar honours it, but Google ignores alarms
          on subscribed calendars and uses that calendar&apos;s own defaults instead. For an actual
          nudge before an event, use the reminder emails below — that is what they are for.
        </p>
        <p className="mt-2 text-[12px] leading-relaxed text-[var(--ink-2)]">
          Events you&apos;ve saved appear while they are upcoming, plus the last month. Anything you
          mark Skipped or Attended drops out.
        </p>
        <p className="mt-2 text-[12px] leading-relaxed text-[var(--ink-2)]">
          Treat the link like a password. Anyone who has it can read your saved events without
          signing in — that is the only way a calendar app can read it at all.
        </p>
      </div>

      {feed?.url && (
        <div className="mt-5 border-t border-[color:var(--hairline)] pt-4">
          {confirmRotate ? (
            <div className="flex flex-wrap items-center gap-2">
              <p className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-[var(--live)]">
                This gives you a new link and breaks every calendar already subscribed — they stop
                updating without saying why, and you&apos;ll need to subscribe again on each device.
                To stop the feed temporarily, switch it off instead.
              </p>
              <button
                type="button"
                disabled={saving}
                onClick={() => void patch({ rotate: true }, 'New link created. Re-subscribe your devices.')}
                className="h-9 shrink-0 rounded-[var(--r-touch)] bg-[var(--paper)] px-4 text-[12.5px] font-semibold text-[var(--live)]"
              >
                Replace it
              </button>
              <button
                type="button"
                onClick={() => setConfirmRotate(false)}
                className="h-9 shrink-0 rounded-[var(--r-touch)] px-3 text-[12.5px] font-semibold text-[var(--ink-2)]"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmRotate(true)}
              className="text-[12.5px] font-semibold text-[var(--accent)] hover:underline"
            >
              Replace my calendar link
            </button>
          )}
        </div>
      )}
    </section>
  );
}
