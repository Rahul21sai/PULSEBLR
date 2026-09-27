'use client';
// `Link` is gone with the hand-rolled nav below — `DesktopNav` owns the links now.
import { DesktopNav, MobileBottomNav } from '../components/NavBar';
import { Banner, Button, ButtonLink } from '../components/ui';

import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { format } from 'date-fns';
import {
  failureLead,
  fetchJson,
  toRemote,
  type ReadFailure,
  type Remote,
} from '@/lib/fetch-result';

interface Stats {
  totalEvents: number;
  eventsThisMonth: number;
  trackedEvents: number;
  attendedEvents: number;
  totalConnections: number;
  pendingFollowUps: number;
  targetCompanyEvents: number;
}

interface FollowUp {
  eventTitle: string;
  connection: {
    name: string;
    role?: string;
    company?: string;
    followUpAt: string;
  };
  /** Which store this came from. See lib/helpers/phase6.ts. */
  source?: 'contact' | 'tracker';
  /** Present for a Contact row — the precise id to complete. */
  contactId?: string;
  /** Present for a legacy TrackerEntry subdocument. */
  trackerEntryId?: string;
}

/**
 * A follow-up with a key that SURVIVES OPTIMISTIC REMOVAL, and its place in the server's order.
 *
 * The rows were keyed by array index. With the row removed the moment Done is pressed, index keys
 * make React reuse the removed row's DOM node for the next person — so a focused Done button would
 * silently become the NEXT person's Done button, and a second Enter completes somebody the reader
 * never chose. `order` is what a rollback re-inserts by, so a failed completion returns the row to
 * where it was rather than to the bottom.
 */
type ListedFollowUp = FollowUp & { key: string; order: number };

function listFollowUps(list: FollowUp[]): ListedFollowUp[] {
  // Legacy rows have no id, and two legacy rows can share entry + name (the documented two-Rahuls
  // defect), so an occurrence counter keeps the key unique without depending on position.
  const seen = new Map<string, number>();
  return list.map((fu, order) => {
    const base = fu.contactId ? `c:${fu.contactId}` : `t:${fu.trackerEntryId}:${fu.connection.name}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return { ...fu, key: n ? `${base}#${n}` : base, order };
  });
}

interface RepeatConnection {
  name: string;
  details: { role?: string; company?: string; linkedin?: string };
  eventCount: number;
}

/**
 * The eight figures, and what they LOST.
 *
 * Each row used to carry three colour fields — `cardBg`, `iconBg` and `textColor` — drawn from a
 * different Tailwind hue per stat: blue, green, purple, orange, red, teal, pink. Eight tinted
 * grounds, eight filled icon chips and eight coloured numbers, on one screen.
 *
 * That is a categorical scale used as DECORATION, which is the specific thing the direction rules
 * out: there is one accent and it means "you can act on this", everything else is greyscale so that
 * cover images are the only colour in the product. None of the seven hues carried information —
 * "Connections" is not more purple than "Attended" is green — and the palette has no tint layer to
 * express them in even if they had. The icon badges went with them: a filled glyph in a coloured
 * square is the loudest element in a cell whose actual content is a number.
 *
 * What is left is the number, its label and one clause of context, which is all a figure ever said.
 * The cells are hairline-separated on the page ground rather than eight floating cards, so the grid
 * reads as one table — and `tnum` keeps the column of figures from shifting width as it updates.
 */
const STAT_CARDS = (stats: Stats) => [
  { label: 'Total events', value: stats.totalEvents, sub: 'in the corpus' },
  { label: 'This month', value: stats.eventsThisMonth, sub: 'newly scraped' },
  { label: 'Attended', value: stats.attendedEvents, sub: `of ${stats.trackedEvents} tracked` },
  { label: 'Connections', value: stats.totalConnections, sub: 'people recorded' },
  { label: 'Follow-ups', value: stats.pendingFollowUps, sub: 'still owed' },
  { label: 'Target companies', value: stats.targetCompanyEvents, sub: 'events on your list' },
  {
    label: 'Attendance rate',
    value: `${stats.trackedEvents > 0 ? Math.round((stats.attendedEvents / stats.trackedEvents) * 100) : 0}%`,
    sub: 'of what you tracked',
  },
  {
    label: 'Connections per event',
    value: stats.attendedEvents > 0 ? (stats.totalConnections / stats.attendedEvents).toFixed(1) : '0',
    sub: 'averaged over attended',
  },
];

/**
 * A section whose request failed: what happened, and the one thing that fixes it.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THIS PAGE USED TO TURN EVERY FAILURE INTO REASSURANCE. `fetchData` did `if (statsRes.ok)` per
 * response and only logged the catch, so a failed request left the initial empty array in place: the
 * follow-ups panel said "Nobody is waiting on you.", the repeat panel said "Nobody yet", and the stats
 * grid disappeared without a word. Offline, or with an expired session, the dashboard told the reader
 * they owed nobody anything — the most comforting possible claim, from a request that never came
 * back. Each section now has three states and the empty copy is drawn only from `ready`.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * A 401 offers SIGN IN, not Try again: `getCurrentUserId()` returning null is a session problem that
 * no retry can fix, and a button that cannot work is worse than none. Retry paints 44px with
 * `min-h-11` (`Button`'s `md` is 40px) rather than an overlay.
 */
function SectionFailure({
  what,
  failure,
  onRetry,
}: {
  what: string;
  failure: ReadFailure;
  onRetry: () => void;
}) {
  return (
    <Banner tone="error" className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <p className="min-w-[11rem] flex-1">
        {what} didn’t load. {failureLead(failure)}
        {failure === 'offline' && ' Reconnect, then try again.'}
      </p>
      {failure === 'signed-out' ? (
        <ButtonLink tone="quiet" href="/login?callbackUrl=%2Fdashboard" className="min-h-11">
          Sign in again
        </ButtonLink>
      ) : (
        <Button tone="quiet" className="min-h-11" onClick={onRetry}>
          Try again
        </Button>
      )}
    </Banner>
  );
}

/** Rows in the shape of the panel rows, so the page does not jump when they land. Never a spinner. */
function RowsSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div aria-hidden="true" className="divide-y divide-[var(--rule)]">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex flex-col gap-[var(--s-2)] py-[var(--s-3)]">
          <div className="skeleton h-5 w-1/2" />
          <div className="skeleton h-3.5 w-3/4" />
        </div>
      ))}
    </div>
  );
}

export default function DashboardPage() {
  const [stats, setStats] = useState<Remote<Stats>>({ status: 'loading' });
  const [followUps, setFollowUps] = useState<Remote<ListedFollowUp[]>>({ status: 'loading' });
  const [repeats, setRepeats] = useState<Remote<RepeatConnection[]>>({ status: 'loading' });
  /** The last completion the server refused, shown above the list the row was put back into. */
  const [completeError, setCompleteError] = useState<{ name: string; failure: ReadFailure } | null>(
    null
  );
  const followUpsHeadingRef = useRef<HTMLHeadingElement | null>(null);

  /*
   * ONE LOADER PER SECTION, so each can be retried alone. The old single `fetchData` put the whole
   * page behind one spinner, and re-running it after every Done flashed that spinner over data that
   * had not changed. `toRemote` requires the field each section renders: a 2xx without it is a
   * failure, not an empty panel.
   */
  const loadStats = useCallback(async (signal?: AbortSignal) => {
    setStats({ status: 'loading' });
    const next = toRemote(
      await fetchJson<{ stats?: Stats }>('/api/phase6/stats', { signal }),
      data => data.stats ?? undefined
    );
    if (next) setStats(next);
  }, []);

  const loadFollowUps = useCallback(async (signal?: AbortSignal) => {
    setFollowUps({ status: 'loading' });
    setCompleteError(null);
    const next = toRemote(
      await fetchJson<{ followUps?: unknown }>('/api/phase6/follow-ups', { signal }),
      data => (Array.isArray(data.followUps) ? listFollowUps(data.followUps as FollowUp[]) : undefined)
    );
    if (next) setFollowUps(next);
  }, []);

  const loadRepeats = useCallback(async (signal?: AbortSignal) => {
    setRepeats({ status: 'loading' });
    const next = toRemote(
      await fetchJson<{ repeatConnections?: unknown }>('/api/phase6/repeat-connections', { signal }),
      data =>
        Array.isArray(data.repeatConnections)
          ? (data.repeatConnections as RepeatConnection[])
          : undefined
    );
    if (next) setRepeats(next);
  }, []);

  // Deferred by a tick — see the note in app/calendar/page.tsx. Aborted on unmount, so a slow answer
  // is not downloaded for a page that has gone.
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void loadStats(controller.signal);
      void loadFollowUps(controller.signal);
      void loadRepeats(controller.signal);
    }, 0);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [loadStats, loadFollowUps, loadRepeats]);

  /**
   * Complete a follow-up — OPTIMISTICALLY, with a rollback the reader can see.
   *
   * Prefers `contactId`, which addresses ONE row. The legacy `(trackerEntryId, connectionName)`
   * pair matches the first person with that name inside the entry, so with two people called
   * Rahul the button silently no-ops on the second one forever. Rows still living in
   * `TrackerEntry.connections[]` have no id to use instead, which is why both paths exist until
   * `scripts/migrate-connections-to-contacts.ts` has run.
   *
   * It used to `await fetch(...)` and ignore the result entirely, then re-run the whole page load:
   * a refused POST looked exactly like a successful one for as long as the spinner lasted, and then
   * the row reappeared with no explanation. Now the row goes at once; if the server refuses, it is put
   * back in its original place and a notice above the list names the person and the reason.
   *
   * No refetch on success. The "Follow-ups" figure in the grid is derived from this list whenever the
   * list is loaded (see the grid), so it moves with the row — and `getStats` computes that figure as
   * `getPendingFollowUps(userId).length`, the same query this list is, so the two cannot disagree.
   *
   * FOCUS goes to the panel heading when the pressed button had it, because that button is about to
   * be removed and focus would otherwise fall to `<body>`. The heading, not the next row's Done: there
   * is no undo, and a second Enter landing on the next person would complete somebody unchosen.
   * `preventScroll`, so a touch user deep in a long list is not thrown back to the top.
   */
  const markFollowUpComplete = async (item: ListedFollowUp, event: MouseEvent<HTMLButtonElement>) => {
    const hadFocus = event.currentTarget === document.activeElement;
    setCompleteError(null);
    setFollowUps(prev =>
      prev.status === 'ready'
        ? { status: 'ready', data: prev.data.filter(f => f.key !== item.key) }
        : prev
    );
    if (hadFocus) followUpsHeadingRef.current?.focus({ preventScroll: true });

    const result = await fetchJson<unknown>('/api/phase6/follow-ups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        item.contactId
          ? { contactId: item.contactId }
          : { trackerEntryId: item.trackerEntryId, connectionName: item.connection.name }
      ),
    });
    if (result.kind === 'ok') return;

    setFollowUps(prev =>
      prev.status === 'ready' && !prev.data.some(f => f.key === item.key)
        ? { status: 'ready', data: [...prev.data, item].sort((a, b) => a.order - b.order) }
        : prev
    );
    setCompleteError({
      name: item.connection.name,
      failure: result.kind === 'failed' ? result.failure : 'error',
    });
  };

  const dueCount = followUps.status === 'ready' ? followUps.data.length : 0;

  return (
    <div className="min-h-screen bg-[var(--paper)]">
      {/* Material Symbols is loaded once in app/layout.tsx — a per-page <link>
          here duplicated the request on every dashboard visit. */}

      {/*
        THE SHARED NAV, not a copy.

        This page used to hand-roll its own desktop nav, mobile header and bottom bar from a local
        NAV_LINKS array — and that array had gone stale: it offered "Feed", "Calendar", "Tracker",
        "Add" and "Settings", missing Companies, People and Dashboard itself. So opening the
        dashboard visibly changed the whole chrome and dropped links the rest of the app has,
        which is what "the total UI is getting changed" was describing. A second copy of the nav
        cannot stay in step with the first; the fix is to not have one.
      */}
      <DesktopNav />

      <main className="pt-14 pb-24 md:pb-8">
        {/*
          Page header, on the app's own surface rather than a full-bleed BLACK band.

          globals.css rations colour deliberately — greyscale everywhere so that cover images are
          the only colourful thing, and one accent that means "you can act on this". A solid black
          hero is the loudest possible element and it appeared on exactly one page, which is why
          this screen read as belonging to a different product.
        */}
        <header className="rule-b px-5 md:px-8 pt-[var(--s-8)] pb-[var(--s-4)]">
          <div className="max-w-[1200px] mx-auto">
            <h1 className="ty-section text-[var(--ink)]">Dashboard</h1>
            <p className="ty-meta mt-[var(--s-1)]">Who you have met, and who you still owe a reply.</p>
          </div>
        </header>

        <div className="max-w-[1200px] mx-auto px-5 md:px-8 py-[var(--s-8)]">
          {/*
            A RULED GRID, not eight cards. The cell borders are one hairline each, collapsed by
            pulling the grid's own right/bottom edge off with a negative margin, so the block
            reads as a table rather than as floating tiles with a shadow that composites to
            nothing anyway (`--lift-1` is `none`).

            Loading draws the same eight cells as skeletons, so the panels below do not jump when
            the figures land; a failure draws a notice in the grid's place instead of nothing — the
            grid used to vanish silently.
          */}
          <div className="mb-[var(--s-8)]">
            {stats.status === 'failed' ? (
              <SectionFailure what="Your figures" failure={stats.failure} onRetry={() => void loadStats()} />
            ) : (
              <div className="grid grid-cols-2 md:grid-cols-4 border-t border-l border-[var(--rule)]">
                {stats.status === 'loading'
                  ? Array.from({ length: 8 }, (_, i) => (
                      <div key={i} aria-hidden="true" className="border-b border-r border-[var(--rule)] p-[var(--s-4)]">
                        <div className="skeleton h-3.5 w-2/3" />
                        <div className="skeleton mt-[var(--s-2)] h-7 w-12" />
                        <div className="skeleton mt-[var(--s-1)] h-3 w-1/2" />
                      </div>
                    ))
                  : STAT_CARDS({
                      ...stats.data,
                      // Derived from the list when it is loaded, so an optimistic Done moves this
                      // figure with the row. See `markFollowUpComplete`.
                      pendingFollowUps:
                        followUps.status === 'ready' ? followUps.data.length : stats.data.pendingFollowUps,
                    }).map(card => (
                      <div key={card.label} className="border-b border-r border-[var(--rule)] p-[var(--s-4)]">
                        <p className="ty-meta">{card.label}</p>
                        <p className="tnum mt-[var(--s-2)] text-[28px] font-semibold leading-none tracking-[-0.02em] text-[var(--ink)]">
                          {card.value}
                        </p>
                        {/* NOT `.ty-meta` plus a size utility. `globals.css` is UNLAYERED, so its
                            classes outrank every Tailwind utility regardless of source order —
                            `ty-meta text-[12px]` silently renders at 13px. Measured, not assumed. */}
                        <p className="mt-[var(--s-1)] text-[12px] leading-snug text-[var(--ink-2)]">{card.sub}</p>
                      </div>
                    ))}
              </div>
            )}
          </div>

          {/* Two-column panels */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/*
              Pending follow-ups.

              The orange goes to `--accent`, which is the recorded decision for this exact signal:
              `#FF9500` on the tracker's follow-ups strip was taken to `--accent` rather than
              `--ink-2` (which erases the one thing the strip exists to say) or `--live` (which
              spends the loudest colour in the palette on a permanent fixture, and is how an
              accent stops meaning anything). `--accent` means "you can act on this", and a due
              follow-up is precisely that.

              The filled icon glyph is gone. A `'FILL' 1` symbol in a hue beside a heading that
              already says "Pending follow-ups" is decoration competing with the count.

              Person names take the SERIF (`.ty-row-title`) — a person is a thing in the world,
              the same side of the split as an event title or a venue. Everything the app is
              saying about them — the role line, the due date, the count — is sans.
            */}
            <section className="rounded-[var(--r-flat)] border border-[var(--rule)] p-6">
              <div className="flex items-baseline gap-2 mb-5">
                {/* `tabIndex={-1}`: focusable by script only, as the landing spot when a completed
                    row's Done button is removed from under the reader's focus. */}
                <h2 ref={followUpsHeadingRef} tabIndex={-1} className="ty-section text-[var(--ink)]">
                  Follow-ups
                </h2>
                {dueCount > 0 && (
                  <span className="tnum ml-auto text-[13px] font-semibold text-[var(--accent)]">
                    {dueCount} due
                  </span>
                )}
              </div>

              {completeError && (
                <Banner tone="error" className="mb-[var(--s-3)]">
                  Couldn’t mark <span className="font-semibold">{completeError.name}</span> as done.{' '}
                  {failureLead(completeError.failure)} They’re back on the list
                  {completeError.failure === 'signed-out' ? ' — sign in again to finish.' : ', so try again.'}
                </Banner>
              )}

              {followUps.status === 'loading' ? (
                <RowsSkeleton />
              ) : followUps.status === 'failed' ? (
                <SectionFailure
                  what="Your follow-ups"
                  failure={followUps.failure}
                  onRetry={() => void loadFollowUps()}
                />
              ) : followUps.data.length === 0 ? (
                <div className="py-8 text-center">
                  <p className="ty-meta">Nobody is waiting on you.</p>
                </div>
              ) : (
                <ul className="divide-y divide-[var(--rule)]">
                  {followUps.data.map(fu => (
                    <li key={fu.key} className="flex items-start justify-between gap-4 py-[var(--s-3)]">
                      <div className="min-w-0 flex-1">
                        <p className="ty-row-title text-[var(--ink)]">{fu.connection.name}</p>
                        {fu.connection.role && (
                          <p className="ty-meta mt-[var(--s-1)]">
                            {fu.connection.role}{fu.connection.company ? ` · ${fu.connection.company}` : ''}
                          </p>
                        )}
                        <p className="ty-meta">
                          {fu.eventTitle} · due {format(new Date(fu.connection.followUpAt), 'd MMM yyyy')}
                        </p>
                      </div>
                      {/* `min-h-11`: `py-1.5` on 11px text painted ~28px against the 44px floor. The
                          name makes the target unambiguous to a screen reader, where a list of
                          identical "Done" buttons is not. */}
                      <button
                        type="button"
                        onClick={event => void markFollowUpComplete(fu, event)}
                        aria-label={`Mark ${fu.connection.name} as done`}
                        className="pressable shrink-0 min-h-11 rounded-[var(--r-touch)] bg-[var(--accent)] px-3 py-1.5 text-[11px] font-bold text-[var(--accent-ink)] transition-colors"
                      >
                        Done
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/*
              Repeat connections — the same treatment, so the two panels read as one system.

              Purple had no home in nine values and, unlike the orange above, was not even
              standing for a state: it was the panel's decorative hue. The count that matters
              ("met at 3 events") is the information, so it is `--ink` and tabular rather than a
              coloured chip — this is the app's one genuine repeat-connection signal, and a purple
              pill made it look like a category tag.
            */}
            <section className="rounded-[var(--r-flat)] border border-[var(--rule)] p-6">
              <div className="flex items-baseline gap-2 mb-5">
                <h2 className="ty-section text-[var(--ink)]">Met more than once</h2>
                {repeats.status === 'ready' && repeats.data.length > 0 && (
                  <span className="tnum ml-auto text-[13px] font-semibold text-[var(--ink-2)]">
                    {repeats.data.length}
                  </span>
                )}
              </div>

              {repeats.status === 'loading' ? (
                <RowsSkeleton />
              ) : repeats.status === 'failed' ? (
                <SectionFailure what="This list" failure={repeats.failure} onRetry={() => void loadRepeats()} />
              ) : repeats.data.length === 0 ? (
                <div className="py-8 text-center">
                  <p className="ty-meta">Nobody yet — this fills in once you meet the same person twice.</p>
                </div>
              ) : (
                <ul className="divide-y divide-[var(--rule)]">
                  {repeats.data.slice(0, 8).map((conn, idx) => (
                    <li key={idx} className="flex items-center justify-between gap-4 py-[var(--s-3)]">
                      <div className="min-w-0">
                        <p className="ty-row-title text-[var(--ink)]">{conn.name}</p>
                        {conn.details.role && (
                          <p className="ty-meta mt-[var(--s-1)]">
                            {conn.details.role}{conn.details.company ? ` · ${conn.details.company}` : ''}
                          </p>
                        )}
                        <p className="ty-meta">
                          <span className="font-semibold text-[var(--ink)]">{conn.eventCount}</span> events
                        </p>
                      </div>
                      {conn.details.linkedin && (
                        <a href={conn.details.linkedin} target="_blank" rel="noopener noreferrer"
                          aria-label={`${conn.name} on LinkedIn`}
                          className="shrink-0 text-[var(--accent)] ml-4">
                          <svg aria-hidden="true" className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                            <path d="M19 0h-14c-2.761 0-5 2.239-5 5v14c0 2.761 2.239 5 5 5h14c2.762 0 5-2.239 5-5v-14c0-2.761-2.238-5-5-5zm-11 19h-3v-11h3v11zm-1.5-12.268c-.966 0-1.75-.79-1.75-1.764s.784-1.764 1.75-1.764 1.75.79 1.75 1.764-.783 1.764-1.75 1.764zm13.5 12.268h-3v-5.604c0-3.368-4-3.113-4 0v5.604h-3v-11h3v1.765c1.396-2.586 7-2.777 7 2.476v6.759z" />
                          </svg>
                        </a>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </div>
      </main>

      <MobileBottomNav />
    </div>
  );
}
