'use client';
// `Link` is gone with the hand-rolled nav below — `DesktopNav` owns the links now.
import { DesktopNav, MobileBottomNav } from '../components/NavBar';

import { useEffect, useState } from 'react';
import { format } from 'date-fns';

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

export default function DashboardPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [followUps, setFollowUps] = useState<FollowUp[]>([]);
  const [repeatConnections, setRepeatConnections] = useState<RepeatConnection[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchData = async () => {
    try {
      setLoading(true);
      const [statsRes, followUpsRes, repeatRes] = await Promise.all([
        fetch('/api/phase6/stats'),
        fetch('/api/phase6/follow-ups'),
        fetch('/api/phase6/repeat-connections'),
      ]);
      if (statsRes.ok) setStats((await statsRes.json()).stats);
      if (followUpsRes.ok) setFollowUps((await followUpsRes.json()).followUps);
      if (repeatRes.ok) setRepeatConnections((await repeatRes.json()).repeatConnections);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  // Deferred by a tick — see the note in app/calendar/page.tsx.
  useEffect(() => {
    const timer = setTimeout(() => { void fetchData(); }, 0);
    return () => clearTimeout(timer);
  }, []);


  /**
   * Complete a follow-up.
   *
   * Prefers `contactId`, which addresses ONE row. The legacy `(trackerEntryId, connectionName)`
   * pair matches the first person with that name inside the entry, so with two people called
   * Rahul the button silently no-ops on the second one forever. Rows still living in
   * `TrackerEntry.connections[]` have no id to use instead, which is why both paths exist until
   * `scripts/migrate-connections-to-contacts.ts` has run.
   */
  const markFollowUpComplete = async (followUp: FollowUp) => {
    await fetch('/api/phase6/follow-ups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        followUp.contactId
          ? { contactId: followUp.contactId }
          : { trackerEntryId: followUp.trackerEntryId, connectionName: followUp.connection.name }
      ),
    });
    fetchData();
  };

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
          {loading ? (
            <div className="flex justify-center items-center py-24">
              <div className="spinner" />
            </div>
          ) : (
            <>
              {/*
                A RULED GRID, not eight cards. The cell borders are one hairline each, collapsed by
                pulling the grid's own right/bottom edge off with a negative margin, so the block
                reads as a table rather than as floating tiles with a shadow that composites to
                nothing anyway (`--lift-1` is `none`).
              */}
              {stats && (
                <div className="mb-[var(--s-8)] grid grid-cols-2 md:grid-cols-4 border-t border-l border-[var(--rule)]">
                  {STAT_CARDS(stats).map(card => (
                    <div
                      key={card.label}
                      className="border-b border-r border-[var(--rule)] p-[var(--s-4)]"
                    >
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
                    <h2 className="ty-section text-[var(--ink)]">Follow-ups</h2>
                    {followUps.length > 0 && (
                      <span className="tnum ml-auto text-[13px] font-semibold text-[var(--accent)]">
                        {followUps.length} due
                      </span>
                    )}
                  </div>

                  {followUps.length === 0 ? (
                    <div className="py-8 text-center">
                      <p className="ty-meta">Nobody is waiting on you.</p>
                    </div>
                  ) : (
                    <ul className="divide-y divide-[var(--rule)]">
                      {followUps.map((fu, idx) => (
                        <li key={idx} className="flex items-start justify-between gap-4 py-[var(--s-3)]">
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
                          <button
                            type="button"
                            onClick={() => markFollowUpComplete(fu)}
                            className="pressable shrink-0 rounded-[var(--r-touch)] bg-[var(--accent)] px-3 py-1.5 text-[11px] font-bold text-[var(--accent-ink)] transition-colors"
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
                    {repeatConnections.length > 0 && (
                      <span className="tnum ml-auto text-[13px] font-semibold text-[var(--ink-2)]">
                        {repeatConnections.length}
                      </span>
                    )}
                  </div>

                  {repeatConnections.length === 0 ? (
                    <div className="py-8 text-center">
                      <p className="ty-meta">Nobody yet — this fills in once you meet the same person twice.</p>
                    </div>
                  ) : (
                    <ul className="divide-y divide-[var(--rule)]">
                      {repeatConnections.slice(0, 8).map((conn, idx) => (
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
                              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
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
            </>
          )}
        </div>
      </main>

      <MobileBottomNav />
    </div>
  );
}
