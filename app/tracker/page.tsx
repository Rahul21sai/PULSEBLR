'use client';

import Link from 'next/link';

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useModalDialog } from '../components/useModalDialog';
import EditTrackerModal from './components/EditTrackerModal';
import { DesktopNav, MobileBottomNav } from '../components/NavBar';
import EventCover from '../components/EventCover';
import { Banner, Button, ButtonLink } from '../components/ui';
import {
  dayLabelIST,
  timeIST,
  relativeTime,
  categoryAccent,
  locationLabel,
  shortDateIST,
} from '@/lib/format';
// From the PURE validator module, not lib/contacts/service.ts — this is a client component and
// service.ts imports mongoose.
import { FOLDER_ON_TRACKER_STATUS } from '@/lib/tracker/validate';
import { loginHref } from '@/lib/auth-callback-url';

interface Connection {
  name: string;
  role?: string;
  company?: string;
  linkedin?: string;
  context?: string;
  followUpAt?: string;
  followedUp?: boolean;
}

/**
 * Exactly the event fields `/api/tracker` sends — `TRACKER_EVENT_FIELDS` in
 * lib/tracker/entry-view.ts. Reading a field that is not in that list gets `undefined`, silently, so a
 * new one belongs there first.
 */
interface TrackedEvent {
  _id: string;
  title: string;
  startDateTime: string;
  venue?: string;
  area?: string;
  city?: string;
  format: string;
  category: string[];
  imageUrl?: string;
}

/** What the user's own folder still says about an event PulseBLR no longer lists. */
interface LastKnownEvent {
  title: string;
  startDateTime?: string;
  folderId: string;
}

interface TrackerEntry {
  _id: string;
  /**
   * NULL WHEN THE EVENT IS NO LONGER LISTED — deleted from the corpus, or no longer visible to this
   * user. The entry itself is still the user's: its status, notes and people are real, and are drawn
   * by `OrphanCard` / `OrphanRow` instead of being dropped.
   */
  eventId: TrackedEvent | null;
  /** Only on an entry whose `eventId` is null, and only when the user has a folder for that event. */
  lastKnown?: LastKnownEvent;
  /**
   * The user's own folder for this entry's event — listed or not — and ABSENT when there is none.
   * From `GET /api/tracker`, or from the PUT that just moved the entry into a folder-making column.
   */
  folderId?: string;
  status: string;
  notes?: string;
  appliedAt?: string;
  outcome?: string;
  connections: Connection[];
  updatedAt: string;
  createdAt?: string;
}

/**
 * The pipeline. Ordered as a genuine progression so "move forward" always means
 * the same thing, with the two terminal outcomes kept at the end.
 */
const COLUMNS = [
  { id: 'New', label: 'New', tint: '#8E8E93' },
  { id: 'Interested', label: 'Interested', tint: '#0071E3' },
  { id: 'Applied', label: 'Applied', tint: '#FF9500' },
  { id: 'Shortlisted', label: 'Shortlisted', tint: '#AF52DE' },
  { id: 'Confirmed', label: 'Confirmed', tint: '#34C759' },
  { id: 'Attended', label: 'Attended', tint: '#30B0C7' },
  { id: 'Skipped', label: 'Skipped', tint: '#C7C7CC' },
] as const;

const COLUMN_IDS = COLUMNS.map(c => c.id) as readonly string[];

/**
 * Which columns create a folder to scan people into.
 *
 * Imported from `lib/contacts/service.ts`, NOT retyped — the label on the board and the branch on
 * the server have to be the same list, and a hardcoded copy here would eventually claim a folder
 * that never gets made (or stay silent about one that does).
 *
 * IT IS LABELLED AT ALL because of a real report: an event was moved to `Shortlisted` and no folder
 * appeared, which is correct behaviour and completely undiscoverable. Nothing on this board said
 * that `Confirmed` is the step that gets you somewhere to put the people you meet, so the only way
 * to find out was to guess the right column.
 */
const FOLDER_COLUMNS = new Set<string>(FOLDER_ON_TRACKER_STATUS);

/** The event's start in ms, or null for an entry whose event is no longer listed. */
function startMs(entry: TrackerEntry): number | null {
  return entry.eventId ? new Date(entry.eventId.startDateTime).getTime() : null;
}

/**
 * Soonest first, and every entry whose event is no longer listed AFTER every dated one, most
 * recently touched first. They have no start to sort by, and putting them last leaves the dated
 * entries exactly where they always were.
 */
function byEventStart(a: TrackerEntry, b: TrackerEntry): number {
  const aStart = startMs(a);
  const bStart = startMs(b);
  if (aStart !== null && bStart !== null) return aStart - bStart;
  if (aStart !== null) return -1;
  if (bStart !== null) return 1;
  return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
}

/** The heading for an entry whose event is gone: its name from the user's folder, when there is one. */
function orphanTitle(entry: TrackerEntry): string {
  return entry.lastKnown?.title ?? 'This event is no longer listed';
}

/**
 * The line under that heading. When the name came from a folder, the heading no longer says the
 * event is gone, so this line has to; otherwise the heading says it and this dates the entry.
 */
function orphanMeta(entry: TrackerEntry): string {
  if (entry.lastKnown) {
    // No "was": an event an admin removed before it happened still has its date ahead of it.
    const when = entry.lastKnown.startDateTime;
    return when ? `No longer listed · ${dayLabelIST(when)}` : 'No longer listed';
  }
  return entry.createdAt ? `Saved ${shortDateIST(entry.createdAt)}` : 'Your status and notes are kept';
}

/** For sentences like "Met at …". */
function eventName(entry: TrackerEntry): string {
  return entry.eventId?.title ?? entry.lastKnown?.title ?? 'an event that is no longer listed';
}

/** The column whose cards offer "Follow up". */
const FOLLOW_UP_COLUMN = 'Attended';

/**
 * Where an entry's "Follow up" goes — the morning-after screen for its folder — or null when there is
 * nothing to offer.
 *
 * ATTENDED ONLY, AND ONLY WITH A FOLDER. That screen lists the people in the folder (and in its
 * siblings for the same event), so with no folder there is nobody to follow up with, and before the
 * event there is nobody yet. Offered for an entry whose event is no longer listed too: the folder,
 * and the people in it, outlive the listing.
 *
 * The same path `followUpLandingPath()` builds for the push notification, `encodeURIComponent`
 * included. Not imported from there, because `lib/notifications/followup-nudge-policy.ts` imports
 * `reminder-policy.ts`, which imports Node's `crypto`, and this is a client component.
 */
function followUpHref(entry: TrackerEntry): string | null {
  if (entry.status !== FOLLOW_UP_COLUMN || !entry.folderId) return null;
  return `/follow-ups/${encodeURIComponent(entry.folderId)}`;
}

type ViewMode = 'board' | 'list';

export default function TrackerPage() {
  const [entries, setEntries] = useState<TrackerEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [unauthorized, setUnauthorized] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Set when moving an entry to Confirmed/Attended produced a folder, so the move is
   * ACKNOWLEDGED rather than silent. Something appearing under People without explanation is
   * worse than nothing appearing: the user has to work out where it came from.
   */
  const [folderNote, setFolderNote] = useState<{ id: string; name: string; adopted: boolean } | null>(
    null
  );
  /**
   * THE BOARD IS THE WRONG DEFAULT ON A PHONE, and the numbers are not marginal.
   *
   * Measured at 390x844: the kanban scroller lays out 2126px wide — 5.45 screens of horizontal
   * scroll — and the only column fully on screen is `New`, which by construction holds ZERO cards
   * (nothing is ever saved into it; `SaveButton` writes `Interested`). So opening the tracker on a
   * phone showed a correct "22 Tracked" stat block above an empty column captioned "Drop here",
   * with all 22 events off the right edge and nothing saying so. Drag-and-drop, the board's primary
   * interaction, is not viable across 5.4 screens either.
   *
   * List view already exists and shows every entry with its own `Move` control, so the fix is a
   * default rather than a new surface.
   *
   * WHY AN EFFECT AND NOT AN INITIALISER. `window` does not exist during the server render, and
   * seeding this from `matchMedia` in `useState` would make the client's first render disagree with
   * the server's HTML — a hydration mismatch. It runs once, so a user who then taps `Board` keeps
   * it; and it costs no visible flash, because `loading` is still true at this point and the
   * skeleton is the same either way.
   *
   * Deferred by a tick, which is this repo's established shape for exactly this (see the load
   * effects in `app/page.tsx`): React's compiler rules reject a setState called synchronously in an
   * effect body, and `react-hooks/set-state-in-effect` fails the lint on it.
   */
  const [view, setView] = useState<ViewMode>('board');
  useEffect(() => {
    // Below Tailwind's `md` (768px), i.e. exactly the widths where the board does not fit.
    const timer = setTimeout(() => {
      if (window.matchMedia('(max-width: 767px)').matches) setView('list');
    }, 0);
    return () => clearTimeout(timer);
  }, []);
  const [selected, setSelected] = useState<TrackerEntry | null>(null);
  // The detail sheet had no dialog semantics at all — no role, no Escape, no trap, and focus left
  // behind on the board — so it gets the same contract as every `Sheet`. Keyed on OPEN, not on
  // `selected`: the status select replaces `selected` with a new object, and that must not re-run
  // the focus-in and yank focus off the select the user is operating.
  const detailRef = useRef<HTMLDivElement>(null);
  const closeDetail = useCallback(() => setSelected(null), []);
  useModalDialog(detailRef, selected !== null, closeDetail);
  const [editing, setEditing] = useState<TrackerEntry | null>(null);
  /** `${entryId}:${connectionName}` while a follow-up completion is in flight. */
  const [completing, setCompleting] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overColumn, setOverColumn] = useState<string | null>(null);

  const fetchEntries = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/tracker');
      if (res.status === 401) {
        setUnauthorized(true);
        return;
      }
      if (!res.ok) throw new Error('Could not load your tracker');
      const data = await res.json();
      /*
       * EVERY ENTRY IS KEPT, including those whose event is gone.
       *
       * This used to drop any entry whose `eventId` came back null, to avoid crashing on
       * `entry.eventId.title`. But a null event is the normal result of the event leaving the
       * corpus — the nightly pruner deleted tracked events a week after they happened — and the
       * entry is the only place the user's status, notes and people for it exist. Measured
       * 2026-09-27: 12 of 16 tracker entries were in that state, so the board showed a quarter of
       * what people had saved, with nothing to say the rest existed. They are now drawn as "no
       * longer listed" rows, and every read of `eventId` below is null-safe.
       */
      setEntries(data.entries || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Mark one follow-up done straight from the strip, without opening a modal.
   *
   * Uses POST /api/phase6/follow-ups, which was already the ONLY writer for `followedUp`
   * anywhere in the repo — it was just unreachable from the screen most people use. The
   * strip offered only "Log it", which opened a modal that had no followedUp control at
   * all, and the one screen that could complete a follow-up (/dashboard) is absent from
   * the mobile nav. On a phone the due count could therefore only ever go up.
   */
  const completeFollowUp = useCallback(
    async (entryId: string, connectionName: string) => {
      setCompleting(`${entryId}:${connectionName}`);
      try {
        const res = await fetch('/api/phase6/follow-ups', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ trackerEntryId: entryId, connectionName }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        // Refetch rather than patching local state: the strip is derived from entries and
        // only the server knows what is still due.
        await fetchEntries();
      } catch {
        setError('Could not mark that follow-up done. Try again.');
      } finally {
        setCompleting(null);
      }
    },
    [fetchEntries]
  );

  // Deferred so the effect doesn't setState synchronously (see the same pattern
  // in the feed page).
  useEffect(() => {
    const timer = setTimeout(fetchEntries, 0);
    return () => clearTimeout(timer);
  }, [fetchEntries]);

  /**
   * "Now" captured once per page load rather than read during render.
   * Calling Date.now() inside a useMemo makes render impure — the same inputs
   * would produce different output — which React's compiler rules flag. A tracker
   * view doesn't need a live-ticking clock; it needs a stable reference point.
   */
  const [now] = useState(() => Date.now());

  /**
   * Move an entry, optimistically. The card lands in the new column immediately
   * and only rolls back if the server rejects it — a spinner between drop and
   * confirmation makes a board feel broken.
   */
  const moveTo = useCallback(
    async (entryId: string, status: string) => {
      const previous = entries;
      setEntries(current =>
        current.map(entry => (entry._id === entryId ? { ...entry, status } : entry))
      );
      try {
        const res = await fetch(`/api/tracker/${entryId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status }),
        });
        if (!res.ok) throw new Error('rejected');
        // The route returns `folder` only when it ensured one — Confirmed or Attended, and
        // `outcome: 'linked'` means it already existed, which is not news worth a banner.
        const data = await res.json().catch(() => null);
        /*
         * THE FOLDER'S ID GOES ONTO THE ENTRY, whatever the outcome. Otherwise a card moved into
         * Attended would arrive without the "Follow up" it is meant to have until the next full
         * reload: `folderId` is otherwise only ever set by `GET /api/tracker`. `linked` counts here
         * even though it earns no banner — an existing folder is still the one to follow up from.
         */
        const folderId = data?.folder?._id ? String(data.folder._id) : null;
        if (folderId) {
          setEntries(current =>
            current.map(entry => (entry._id === entryId ? { ...entry, folderId } : entry))
          );
        }
        if (data?.folder && data.folder.outcome !== 'linked') {
          setFolderNote({
            id: String(data.folder._id),
            name: String(data.folder.name),
            adopted: data.folder.outcome === 'adopted',
          });
        }
      } catch {
        setEntries(previous);
        setError('Couldn’t save that change. Please try again.');
        setTimeout(() => setError(null), 4000);
      }
    },
    [entries]
  );

  /**
   * AFTER "Move to …" ON THE BOARD, FOLLOW THE CARD.
   *
   * Measured at 390x844: every column is 290px, so moving a card sends it into the NEXT column,
   * which is off the right edge. The button the user just pressed unmounts with the card, so the
   * screen shows the column it left - often now empty - and keyboard focus falls to <body>. Two
   * frames, because the optimistic `setEntries` has to commit before the card exists in its new
   * column. Focus goes to the card's own next "Move to" (or its opener at the last column), so a
   * keyboard user can keep advancing it without hunting for where it went.
   */
  const revealEntry = useCallback((entryId: string) => {
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const card = document.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(entryId)}"]`);
        if (!card) return;
        const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        card.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
        const target =
          card.querySelector<HTMLElement>(':scope > button') ?? card.querySelector<HTMLElement>('[role="button"]');
        target?.focus({ preventScroll: true });
      })
    );
  }, []);

  const remove = useCallback(async (entryId: string) => {
    const previous = entries;
    setEntries(current => current.filter(entry => entry._id !== entryId));
    setSelected(null);
    try {
      const res = await fetch(`/api/tracker/${entryId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('rejected');
    } catch {
      setEntries(previous);
      setError('Couldn’t remove that event.');
      setTimeout(() => setError(null), 4000);
    }
  }, [entries]);

  const byColumn = useMemo(() => {
    const groups: Record<string, TrackerEntry[]> = {};
    for (const column of COLUMNS) groups[column.id] = [];
    for (const entry of entries) {
      // An unrecognised status must still be reachable, so it lands in New.
      (groups[entry.status] ?? groups.New).push(entry);
    }
    for (const key of Object.keys(groups)) groups[key].sort(byEventStart);
    return groups;
  }, [entries]);

  /** Follow-ups whose date has arrived and that aren't marked done. */
  const dueFollowUps = useMemo(() => {
    // `followUpAt` is carried out separately so the render below needs no non-null assertion.
    const due: Array<{ entry: TrackerEntry; connection: Connection; followUpAt: string }> = [];
    for (const entry of entries) {
      for (const connection of entry.connections || []) {
        const followUpAt = connection.followUpAt;
        if (followUpAt && !connection.followedUp && new Date(followUpAt).getTime() <= now) {
          due.push({ entry, connection, followUpAt });
        }
      }
    }
    return due;
  }, [entries, now]);

  const totals = useMemo(() => {
    const connections = entries.reduce((sum, e) => sum + (e.connections?.length || 0), 0);
    // An entry whose event is no longer listed has no date, so it is never "still upcoming".
    const upcoming = entries.filter(e => {
      const start = startMs(e);
      return start !== null && start > now;
    }).length;
    return {
      tracked: entries.length,
      upcoming,
      attended: byColumn.Attended?.length || 0,
      connections,
    };
  }, [entries, byColumn, now]);

  if (unauthorized) {
    return (
      <Shell>
        <div className="max-w-[520px] mx-auto px-4 pt-24 text-center" data-pulseblr-route="tracker">
          <span aria-hidden="true" className="material-symbols-outlined text-[48px] text-[var(--ink-3)] block mb-3">
            lock
          </span>
          <h1 className="text-[22px] font-bold text-[var(--ink)]">Sign in to use your tracker</h1>
          <p className="text-[14px] text-[var(--ink-2)] mt-2">
            Your tracker keeps the events you saved, who you met, and when to follow up. It’s
            private to your account.
          </p>
          <Link
            href={loginHref('/tracker')}
            className="inline-block mt-6 px-6 py-2.5 rounded-full bg-[var(--accent)] text-[var(--accent-ink)] text-label-md font-semibold hover:bg-[var(--accent)] transition-colors"
          >
            Sign in with Google
          </Link>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="max-w-[1400px] mx-auto px-4 md:px-8 pt-4" data-pulseblr-route="tracker">
        {/* Header — ruled, sans, same as every other surface. */}
        <div className="rule-b flex flex-wrap items-end justify-between gap-4 mb-5 pb-[var(--s-4)]">
          <div>
            <h1 className="ty-section text-[var(--ink)]">Your tracker</h1>
            <p className="ty-meta mt-[var(--s-1)]">Events you saved, and what happened next.</p>
          </div>

          <div className="flex items-center gap-2">
            {/* 44px TOUCH TARGET OVER A 32px PILL. Measured at 64x32 and 50x32, both under the
                WCAG 2.5.5 floor. The height is grown with an `::after` overlay so the painted pill
                and its type scale are untouched (CLAUDE.md section 7, rule 1), and `gap-1` becomes
                `gap-0` so the two overlays are contiguous rather than separated by a 4px dead
                strip. Width is already 50-64px, so height was the only failing axis. */}
            <div className="flex items-center gap-0 bg-[var(--surface)] border border-[var(--rule)] rounded-full p-0.5">
              {(['board', 'list'] as const).map(mode => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setView(mode)}
                  aria-pressed={view === mode}
                  className={`relative px-3.5 h-8 rounded-full text-[12.5px] font-semibold transition-colors after:absolute after:inset-x-0 after:-inset-y-1.5 after:content-[''] ${
                    view === mode ? 'bg-[var(--paper)] text-[var(--ink)]' : 'text-[var(--ink-2)] hover:text-[var(--ink)]'
                  }`}
                >
                  {mode === 'board' ? 'Board' : 'List'}
                </button>
              ))}
            </div>
            <Link
              href="/"
              className="h-9 px-4 rounded-full bg-[var(--ink)] text-[var(--accent-ink)] text-[12.5px] font-semibold flex items-center hover:bg-[var(--ink)] transition-colors"
            >
              Find events
            </Link>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
          {/* `loading` passes through so the blocks do not print "0 Tracked" above the board
              skeleton - on a phone network that is a seconds-long false statement about the
              user's own data. */}
          <Stat label="Tracked" value={totals.tracked} loading={loading} />
          <Stat label="Still upcoming" value={totals.upcoming} loading={loading} />
          <Stat label="Attended" value={totals.attended} loading={loading} />
          <Stat label="People met" value={totals.connections} loading={loading} />
        </div>

        {error && (
          <div className="mb-4 bg-[var(--paper)] border border-[var(--live)] rounded-xl px-4 py-3 text-[13px] text-[var(--live)]">
            {error}
          </div>
        )}

        {/* No auto-dismiss, unlike the error above. This one carries a LINK, and a banner that
            vanishes after four seconds takes the link with it — the whole point is that you can
            go straight to the folder and start scanning. Dismissed by hand instead. */}
        {folderNote && (
          <div className="mb-4 flex items-center gap-3 rounded-xl border-l-2 border-l-[var(--accent)] bg-[var(--paper)] px-4 py-3 text-[13px] text-[var(--accent)]">
            <span aria-hidden="true" className="material-symbols-outlined text-[18px]">
              folder_check
            </span>
            <p className="min-w-0 flex-1">
              {folderNote.adopted ? 'Linked to your folder ' : 'Folder ready for '}
              <Link
                href={`/folders/${folderNote.id}`}
                className="font-semibold underline hover:no-underline"
              >
                {folderNote.name}
              </Link>
              {' '}— scan people straight into it.
            </p>
            <button
              type="button"
              onClick={() => setFolderNote(null)}
              aria-label="Dismiss folder notice"
              // The painted glyph was the whole target: 18x18, under the 24px floor (2.5.8). The
              // overlay makes it 40x44 without moving a pixel of the banner, and it contests nothing:
              // 11px sideways stays inside the 12px gap to the paragraph and the 16px padding.
              className="relative shrink-0 text-[var(--accent)]/60 hover:text-[var(--accent)] after:absolute after:-inset-x-[11px] after:-inset-y-[13px] after:content-['']"
            >
              <span aria-hidden="true" className="material-symbols-outlined text-[18px]">close</span>
            </button>
          </div>
        )}

        {/* Follow-ups due — the tracker's reason to exist, so it leads. */}
        {dueFollowUps.length > 0 && (
          <section className="mb-5 rounded-[var(--r-flat)] border border-[var(--rule)] overflow-hidden">
            <div className="h-1 bg-[var(--accent)]" />
            <div className="p-4 md:p-5">
              <h2 className="text-[15px] font-bold text-[var(--ink)] flex items-center gap-1.5 mb-3">
                <span aria-hidden="true" className="material-symbols-outlined text-[18px] text-[var(--accent)]">
                  notifications_active
                </span>
                {dueFollowUps.length} follow-up{dueFollowUps.length === 1 ? '' : 's'} due
              </h2>
              <div className="flex flex-col gap-2">
                {dueFollowUps.slice(0, 5).map(({ entry, connection, followUpAt }, index) => (
                  <div
                    key={`${entry._id}-${connection.name}-${index}`}
                    className="flex items-center gap-3 bg-[var(--paper)] rounded-xl px-3 py-2.5"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-[13.5px] font-semibold text-[var(--ink)] truncate">
                        {connection.name}
                        {connection.company && (
                          <span className="font-normal text-[var(--ink-2)]"> · {connection.company}</span>
                        )}
                      </p>
                      <p className="text-[12px] text-[var(--ink-2)] truncate">
                        Met at {eventName(entry)} · due {relativeTime(followUpAt)}
                      </p>
                    </div>
                    {connection.linkedin && (
                      <a
                        href={connection.linkedin}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="shrink-0 text-[12px] font-semibold text-[var(--accent)] hover:underline"
                      >
                        LinkedIn
                      </a>
                    )}
                    {/* Complete the follow-up right here.
                        This strip previously offered only "Log it", which opened the edit
                        modal — and that modal had no followedUp control at all. The single
                        writer for `followedUp` was POST /api/phase6/follow-ups, reachable
                        only from /dashboard, which is absent from the mobile nav. So on a
                        phone a follow-up could become due and never be cleared: the count
                        only ever went up. */}
                    <button
                      type="button"
                      onClick={() => completeFollowUp(entry._id, connection.name)}
                      disabled={completing === `${entry._id}:${connection.name}`}
                      // 32px painted; the overlay grows the target to 44px VERTICALLY only, so the
                      // two buttons cannot contest the 12px gap between them.
                      className="pressable relative shrink-0 h-8 px-3 rounded-full bg-[var(--ink)] text-[12px] font-semibold text-[var(--accent-ink)] hover:bg-[var(--ink)] disabled:opacity-50 after:absolute after:inset-x-0 after:top-1/2 after:h-11 after:-translate-y-1/2 after:content-['']"
                    >
                      {completing === `${entry._id}:${connection.name}` ? 'Saving…' : 'Done'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditing(entry)}
                      className="pressable relative after:absolute after:inset-x-0 after:top-1/2 after:h-11 after:-translate-y-1/2 after:content-[''] shrink-0 h-8 px-3 rounded-full bg-[var(--surface)] text-[12px] font-semibold text-[var(--ink)] shadow-[inset_0_0_0_1px_var(--hairline-strong)] hover:bg-[var(--paper)]"
                    >
                      Edit
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </section>
        )}

        {/* Body */}
        {loading ? (
          <BoardSkeleton />
        ) : entries.length === 0 ? (
          <div className="rounded-[var(--r-flat)] border border-[var(--rule)] py-20 px-6 text-center">
            <span aria-hidden="true" className="material-symbols-outlined text-[44px] text-[var(--ink-3)] block mb-3">
              bookmarks
            </span>
            <p className="text-[17px] font-semibold text-[var(--ink)]">Nothing tracked yet</p>
            <p className="text-[14px] text-[var(--ink-2)] mt-1.5 max-w-sm mx-auto">
              Save an event from the feed and it lands here, ready to move through your pipeline.
            </p>
            <Link
              href="/"
              className="inline-block mt-6 px-6 py-2.5 rounded-full bg-[var(--ink)] text-[var(--accent-ink)] text-label-md font-semibold hover:bg-[var(--ink)] transition-colors"
            >
              Browse events
            </Link>
          </div>
        ) : view === 'list' ? (
          <ListView entries={entries} onOpen={setSelected} onMove={moveTo} />
        ) : (
          <div className="overflow-x-auto no-scrollbar pb-6">
            <div className="flex gap-4" style={{ minWidth: 'max-content' }}>
              {COLUMNS.map(column => (
                <div
                  key={column.id}
                  data-over={overColumn === column.id}
                  onDragOver={e => {
                    e.preventDefault();
                    setOverColumn(column.id);
                  }}
                  onDragLeave={() => setOverColumn(prev => (prev === column.id ? null : prev))}
                  onDrop={e => {
                    e.preventDefault();
                    setOverColumn(null);
                    const id = dragId || e.dataTransfer.getData('text/plain');
                    if (id) moveTo(id, column.id);
                    setDragId(null);
                  }}
                  className="kanban-col w-[290px] shrink-0 rounded-[var(--r-flat)] border border-[var(--rule)] flex flex-col transition-colors"
                >
                  <div className="px-3.5 py-3 flex items-center justify-between sticky top-0">
                    <span className="flex items-center gap-2 text-[13px] font-bold text-[var(--ink)]">
                      <span
                        className="w-2 h-2 rounded-full"
                        style={{ background: column.tint }}
                        aria-hidden="true"
                      />
                      {column.label}
                      {FOLDER_COLUMNS.has(column.id) && (
                        <span
                          title="Moving an event here creates a folder under People, ready to scan people into"
                          className="inline-flex items-center gap-0.5 rounded-full bg-[var(--surface)] px-1.5 py-0.5 text-[10px] font-bold text-[var(--ink-2)]"
                        >
                          <span aria-hidden="true" className="material-symbols-outlined text-[11px]">
                            folder
                          </span>
                          folder
                        </span>
                      )}
                    </span>
                    <span className="tnum text-[11.5px] font-semibold text-[var(--ink-2)] bg-[var(--surface)] rounded-full px-2 py-0.5">
                      {byColumn[column.id]?.length || 0}
                    </span>
                  </div>

                  <div className="flex flex-col gap-2 px-2.5 pb-2.5 min-h-[140px]">
                    {byColumn[column.id]?.map(entry => {
                      // One set of drag handlers for both card kinds, so an entry whose event is
                      // gone can still be moved between columns like any other.
                      const drag = {
                        dragging: dragId === entry._id,
                        onDragStart: (e: React.DragEvent) => {
                          setDragId(entry._id);
                          e.dataTransfer.setData('text/plain', entry._id);
                          e.dataTransfer.effectAllowed = 'move';
                        },
                        onDragEnd: () => {
                          setDragId(null);
                          setOverColumn(null);
                        },
                        onOpen: () => setSelected(entry),
                      };
                      return entry.eventId ? (
                        <TrackerCard
                          key={entry._id}
                          entry={entry}
                          event={entry.eventId}
                          now={now}
                          {...drag}
                          onMove={status => {
                            void moveTo(entry._id, status);
                            revealEntry(entry._id);
                          }}
                        />
                      ) : (
                        <OrphanCard key={entry._id} entry={entry} {...drag} />
                      );
                    })}

                    {(byColumn[column.id]?.length || 0) === 0 && (
                      <div className="flex items-center justify-center h-[110px] text-[12px] text-[var(--ink-2)]">
                        {/* HTML5 drag-and-drop does not fire from a touch, so on a phone "Drop here"
                            names an interaction the screen cannot perform. */}
                        <span className="pointer-coarse:hidden">Drop here</span>
                        <span className="hidden pointer-coarse:inline">Nothing here yet</span>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Detail sheet. Opens for an entry whose event is no longer listed as well — this sheet is
          where such an entry's notes and people are read, and where it is removed. */}
      {selected && (
        <div className="fixed inset-0 z-[60] flex items-end md:items-center justify-center">
          <button
            type="button"
            aria-label="Close"
            onClick={() => setSelected(null)}
            // Pointer-only; the header's Close is the named control. See Sheet.tsx.
            tabIndex={-1}
            aria-hidden="true"
            className="absolute inset-0 bg-black/45 backdrop-blur-sm"
          />
          <div
            ref={detailRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="tracker-detail-title"
            className="relative bg-[var(--surface)] w-full md:max-w-lg rounded-[var(--r-flat)] md:rounded-[var(--r-flat)] max-h-[88vh] overflow-y-auto"
          >
            <div className="flex justify-center pt-3 pb-1 md:hidden">
              <div className="w-10 h-1 bg-[var(--rule)] rounded-full" />
            </div>
            {/* The sheet is flush with the bottom edge on a phone, so its last row (Remove) sat
                under the iOS home indicator - Sheet.tsx pads for the inset, this hand-built one did
                not. */}
            <div className="p-5 md:p-6" style={{ paddingBottom: 'max(1.25rem, env(safe-area-inset-bottom))' }}>
              <div className="flex items-start justify-between gap-3 mb-4">
                <h2 id="tracker-detail-title" className="text-[19px] font-bold leading-snug tracking-[-0.01em] text-[var(--ink)]">
                  {selected.eventId ? selected.eventId.title : orphanTitle(selected)}
                </h2>
                <button
                  type="button"
                  onClick={() => setSelected(null)}
                  aria-label="Close"
                  // 32px painted, 44px target via the overlay, as Sheet.tsx's close button does.
                  className="relative shrink-0 w-8 h-8 rounded-full bg-[var(--paper)] flex items-center justify-center transition-colors after:absolute after:-inset-1.5 after:content-['']"
                >
                  <span aria-hidden="true" className="material-symbols-outlined text-[18px]">close</span>
                </button>
              </div>

              {!selected.eventId && (
                <Banner tone="warn" className="mb-5">
                  PulseBLR no longer lists this event, so its details are gone
                  {selected.lastKnown ? ' — the name above comes from your folder for it' : ''}. Your
                  status, notes and the people you met are kept here.
                </Banner>
              )}

              <label
                htmlFor="tracker-detail-status"
                className="block text-label-sm uppercase tracking-widest text-[var(--ink-2)] mb-2"
              >
                Status
              </label>
              <select
                id="tracker-detail-status"
                value={selected.status}
                onChange={e => {
                  moveTo(selected._id, e.target.value);
                  setSelected({ ...selected, status: e.target.value });
                }}
                className="w-full px-4 py-2.5 border border-[var(--rule)] rounded-xl text-label-md text-[var(--ink)] focus:outline-none focus:border-[var(--accent)] bg-[var(--surface)] mb-5"
              >
                {COLUMNS.map(column => (
                  <option key={column.id} value={column.id}>
                    {column.label}
                  </option>
                ))}
              </select>

              {selected.eventId ? (
                <div className="bg-[var(--paper)] rounded-xl p-4 mb-5 flex flex-col gap-2 text-[13.5px] text-[var(--ink-2)]">
                  <span className="flex items-center gap-2">
                    <span aria-hidden="true" className="material-symbols-outlined text-[16px] text-[var(--ink-2)]">
                      calendar_month
                    </span>
                    <span className="tnum">
                      {dayLabelIST(selected.eventId.startDateTime)} ·{' '}
                      {timeIST(selected.eventId.startDateTime)}
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    <span aria-hidden="true" className="material-symbols-outlined text-[16px] text-[var(--ink-2)]">
                      location_on
                    </span>
                    {locationLabel(selected.eventId)}
                  </span>
                </div>
              ) : selected.lastKnown?.startDateTime ? (
                // `lastKnown` carries the folder's date and nothing about the venue, so the date alone.
                // No "Was": an event an admin removed before it happened has a date still ahead.
                <div className="bg-[var(--paper)] rounded-xl p-4 mb-5 flex items-center gap-2 text-[13.5px] text-[var(--ink-2)]">
                  <span aria-hidden="true" className="material-symbols-outlined text-[16px] text-[var(--ink-2)]">
                    calendar_month
                  </span>
                  <span className="tnum">
                    {dayLabelIST(selected.lastKnown.startDateTime)} ·{' '}
                    {timeIST(selected.lastKnown.startDateTime)}
                  </span>
                </div>
              ) : null}

              {selected.notes && (
                <div className="mb-5">
                  <p className="text-label-sm uppercase tracking-widest text-[var(--ink-2)] mb-2">
                    Notes
                  </p>
                  <p className="text-[13.5px] text-[var(--ink)] bg-[var(--paper)] rounded-xl p-4 whitespace-pre-line">
                    {selected.notes}
                  </p>
                </div>
              )}

              {selected.connections.length > 0 && (
                <div className="mb-5">
                  <p className="text-label-sm uppercase tracking-widest text-[var(--ink-2)] mb-2">
                    People met ({selected.connections.length})
                  </p>
                  <div className="flex flex-col gap-2">
                    {selected.connections.map((connection, index) => (
                      <div key={index} className="bg-[var(--paper)] rounded-xl p-3">
                        <p className="text-[13.5px] font-semibold text-[var(--ink)]">
                          {connection.name}
                        </p>
                        {(connection.role || connection.company) && (
                          <p className="text-[12.5px] text-[var(--ink-2)]">
                            {connection.role}
                            {connection.role && connection.company ? ' @ ' : ''}
                            {connection.company}
                          </p>
                        )}
                        {connection.followUpAt && (
                          <p className="text-[12px] text-[var(--accent)] font-semibold mt-1">
                            Follow up {relativeTime(connection.followUpAt)}
                            {connection.followedUp && ' · done'}
                          </p>
                        )}
                        {connection.linkedin && (
                          <a
                            href={connection.linkedin}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[12px] font-semibold text-[var(--accent)] hover:underline mt-1 inline-block"
                          >
                            LinkedIn
                          </a>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {selected.eventId ? (
                <div className="flex flex-wrap gap-2">
                  <Link
                    href={`/events/${selected.eventId._id}`}
                    className="flex-1 min-w-[120px] text-center bg-[var(--ink)] text-[var(--accent-ink)] text-label-md font-semibold py-3 rounded-full hover:bg-[var(--ink)] transition-colors"
                  >
                    View event
                  </Link>
                  <button
                    type="button"
                    onClick={() => {
                      setEditing(selected);
                      setSelected(null);
                    }}
                    className="flex-1 min-w-[120px] bg-[var(--paper)] text-[var(--ink)] text-label-md font-semibold py-3 rounded-full transition-colors"
                  >
                    Edit notes & people
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(selected._id)}
                    className="px-5 py-3 rounded-full text-label-md font-semibold text-[var(--live)] bg-[var(--paper)] hover:bg-[var(--paper)] transition-colors"
                  >
                    Remove
                  </button>
                </div>
              ) : (
                <>
                  {/* No "View event": there is no event page to go to. The folder, when there is
                      one, is where the people scanned there live. `lg` is 48px, over the 44px floor,
                      and `gap-2` is safe because none of these grows its target with an overlay. */}
                  <div className="flex flex-wrap gap-2">
                    {selected.lastKnown && (
                      <ButtonLink
                        href={`/folders/${selected.lastKnown.folderId}`}
                        tone="primary"
                        size="lg"
                        icon="folder"
                        className="flex-1 min-w-[120px]"
                      >
                        Open folder
                      </ButtonLink>
                    )}
                    <Button
                      tone="quiet"
                      size="lg"
                      className="flex-1 min-w-[120px]"
                      onClick={() => {
                        setEditing(selected);
                        setSelected(null);
                      }}
                    >
                      Edit notes & people
                    </Button>
                    <Button tone="danger" size="lg" onClick={() => remove(selected._id)}>
                      Remove from tracker
                    </Button>
                  </div>
                  {(selected.notes || selected.connections.length > 0) && (
                    <p className="mt-3 text-[12.5px] text-[var(--ink-2)]">
                      Removing it also deletes the notes and people above.
                    </p>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {editing && (
        <EditTrackerModal
          entryId={editing._id}
          eventTitle={editing.eventId?.title ?? editing.lastKnown?.title}
          currentNotes={editing.notes}
          currentConnections={editing.connections}
          onClose={() => setEditing(null)}
          onSave={() => {
            setEditing(null);
            fetchEntries();
          }}
        />
      )}
    </Shell>
  );
}

function TrackerCard({
  entry,
  event,
  now,
  dragging,
  onDragStart,
  onDragEnd,
  onOpen,
  onMove,
}: {
  entry: TrackerEntry;
  /** `entry.eventId`, already known to be present — an entry without one renders `OrphanCard`. */
  event: TrackedEvent;
  /** Passed in rather than read here, so rendering stays a pure function of props. */
  now: number;
  dragging: boolean;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onOpen: () => void;
  onMove: (status: string) => void;
}) {
  const accent = categoryAccent(event.category?.[0]);
  const currentIndex = COLUMN_IDS.indexOf(entry.status);
  const next = currentIndex >= 0 ? COLUMNS[currentIndex + 1] : undefined;
  const isPast = new Date(event.startDateTime).getTime() < now;
  const followUp = followUpHref(entry);

  return (
    /*
      THE OPENER IS AN INNER ELEMENT, NOT THE CARD, because the card also holds "Move to …".
      The whole card used to be `role="button"` with that button nested inside it, which failed
      twice. A button's children are presentational, so a screen reader was handed one "button"
      whose name ran the title, the date and "Move to Applied →" together; and the card's own
      Enter/Space handler caught the keydown BUBBLING up from the nested button and called
      `preventDefault()` on it — so pressing Enter on "Move to …" opened the sheet instead, and the
      one keyboard alternative to dragging a card did not work from the keyboard.

      The mouse behaviour is unchanged: the card is still the drag source and a click anywhere on
      it (bar the move button, which stops propagation) still opens the entry. Only the keyboard
      and accessibility-tree target moved inward, beside the move button rather than around it.

      "Follow up", on an Attended card with a folder, is the THIRD sibling of the same kind: a direct
      child of the card, after the opener and before "Move to", and never inside the opener. It is
      an `<a>`, so `revealEntry`'s `:scope > button` still lands focus on "Move to" after a move.
    */
    <div
      draggable
      data-dragging={dragging}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      data-entry-id={entry._id}
      className="kanban-card bg-[var(--surface)] rounded-[var(--r-flat)] p-3 shadow-[inset_0_0_0_1px_var(--rule)]"
      style={{ borderLeft: `3px solid ${accent}` }}
    >
      <div
        role="button"
        tabIndex={0}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onOpen();
          }
        }}
      >
      <div className="flex gap-2.5">
        <EventCover
          src={event.imageUrl}
          title={event.title}
          category={event.category?.[0]}
          className="w-11 h-11 rounded-lg shrink-0"
          monogramSize="text-[11px]"
        />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold leading-snug text-[var(--ink)] line-clamp-2">
            {event.title}
          </p>
          {/*
            PAST vs UPCOMING, CARRIED BY A WORD INSTEAD OF A COLOUR.

            This was `#b0b0b5` for a past date against `--ink-2` for an upcoming one. Both strings are
            READ, so neither may take `--ink-3` — 3.09:1 is never body text, and this is an 11.5px
            string — which left both on `--ink-2` and the distinction carried by nothing at all: the
            ternary was `isPast ? --ink-2 : --ink-2`, two identical branches.

            A tenth value is not the fix. The signal is now LEXICAL: a past card says "Was Thu 4 Sep",
            an upcoming one prints the date bare. That is strictly better than the colour it replaces,
            because it survives greyscale, low contrast and a screen reader, none of which a 4% grey
            shift does — and on a board whose columns include `Attended` and `Skipped`, "did this
            already happen" is a question the card should answer in words.
          */}
          <p className="text-[11.5px] tnum mt-0.5 text-[var(--ink-2)]">
            {isPast && <span className="font-semibold">Was </span>}
            {dayLabelIST(event.startDateTime)} · {timeIST(event.startDateTime)}
          </p>
        </div>
      </div>

      <EntryTraces entry={entry} />
      </div>

      {followUp && <FollowUpCardLink href={followUp} title={eventName(entry)} />}

      {next && (
        <button
          type="button"
          onClick={e => {
            e.stopPropagation();
            onMove(next.id);
          }}
          /* 44px TALL, and the label has not moved. Measured at 243x28 — the smallest primary
             action in the app, on the surface most likely to be used one-handed at an event.
             `min-h-11` with `flex items-start` reserves the height BELOW the text rather than
             centring it, so the hairline rule and the label stay exactly where they were; the card
             simply grows by ~16px. An `::after` overlay was the alternative and is wrong here: the
             card itself carries the "open" `onClick`, so an overlay reaching into the
             card's padding would silently convert "open this entry" taps into status changes. */
          className="flex w-full items-start min-h-11 mt-2.5 pt-2.5 border-t border-[var(--rule)] text-[11.5px] font-semibold text-[var(--accent)] transition-colors text-left"
        >
          Move to {next.label} →
        </button>
      )}
    </div>
  );
}

/** The people and notes an entry carries, as the two small marks under a board card. */
function EntryTraces({ entry }: { entry: TrackerEntry }) {
  if (!(entry.connections.length > 0 || entry.notes)) return null;
  return (
    <div className="flex items-center gap-3 mt-2 text-[11px] text-[var(--ink-2)]">
      {entry.connections.length > 0 && (
        <span className="inline-flex items-center gap-1 text-[var(--accent)] font-semibold">
          <span aria-hidden="true" className="material-symbols-outlined text-[13px]">group</span>
          {entry.connections.length}
        </span>
      )}
      {entry.notes && (
        <span className="inline-flex items-center gap-1">
          <span aria-hidden="true" className="material-symbols-outlined text-[13px]">notes</span>
          Notes
        </span>
      )}
    </div>
  );
}

/**
 * "Follow up" on a board card — see `followUpHref` for when it is offered.
 *
 * THE SAME 44px ROW AS "Move to", for the reason given there: `min-h-11` paints the height instead of
 * growing the target with an `::after` overlay, because the CARD carries the "open" click and an
 * overlay reaching into its padding would silently turn "open this entry" taps into navigation.
 * `stopPropagation` so the tap navigates without also opening the sheet behind it; `draggable={false}`
 * so pressing here and dragging moves the card, not a copy of the URL. The visually hidden tail names
 * the event, because a board can hold several identical "Follow up" links and a screen reader's links
 * list shows each one out of context.
 */
function FollowUpCardLink({ href, title }: { href: string; title: string }) {
  return (
    <Link
      href={href}
      draggable={false}
      onClick={e => e.stopPropagation()}
      className="flex w-full items-start min-h-11 mt-2.5 pt-2.5 border-t border-[var(--rule)] text-[11.5px] font-semibold text-[var(--accent)] hover:underline"
    >
      Follow up<span className="sr-only"> with the people you met at {title}</span>
    </Link>
  );
}

/**
 * "Follow up" in a list row: a sibling of the row's opener, never inside it. `min-h-11` paints the
 * 44px height for the same reason the status select beside it does, so neither grows an overlay into
 * the 12px gap between them and neither can take the other's tap.
 */
function FollowUpRowLink({ href, title }: { href: string; title: string }) {
  return (
    <Link
      href={href}
      className="inline-flex min-h-11 shrink-0 items-center r-touch px-1 text-[12px] font-semibold text-[var(--accent)] hover:underline"
    >
      Follow up<span className="sr-only"> with the people you met at {title}</span>
    </Link>
  );
}

/** Where the cover would be, for an event that is no longer listed. The dashed edge reads as "absent". */
function GoneTile({ className }: { className: string }) {
  return (
    <span
      aria-hidden="true"
      className={`flex shrink-0 items-center justify-center rounded-lg border border-dashed border-[var(--rule)] bg-[var(--paper)] ${className}`}
    >
      <span className="material-symbols-outlined text-[18px] text-[var(--ink-3)]">event_busy</span>
    </span>
  );
}

/**
 * A board card for an entry whose event is no longer listed.
 *
 * Quieter than `TrackerCard` — a dashed tile where the cover was, a neutral edge instead of the
 * category accent, and no "Move to" shortcut, since with no event behind it the next pipeline step is
 * rarely the thing to do. It is still the same size of target, still draggable between columns, and
 * still opens the detail sheet, which is where its notes and people are read and where it is removed.
 *
 * THE OPENER IS AN INNER ELEMENT, exactly as on `TrackerCard`, because an Attended card here can carry
 * "Follow up" — its folder, and the people in it, outlive the listing. The whole card used to be the
 * `role="button"`, which is fine while it holds nothing else and is the nesting defect `TrackerCard`
 * records the moment it holds a link: one "button" announced with the link's words inside it, and the
 * card's Enter handler catching the link's keydown on its way up.
 */
function OrphanCard({
  entry,
  dragging,
  onDragStart,
  onDragEnd,
  onOpen,
}: {
  entry: TrackerEntry;
  dragging: boolean;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onOpen: () => void;
}) {
  const followUp = followUpHref(entry);
  return (
    <div
      draggable
      data-dragging={dragging}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      className="kanban-card bg-[var(--surface)] rounded-[var(--r-flat)] p-3 shadow-[inset_0_0_0_1px_var(--rule)] border-l-[3px] border-l-[var(--rule)]"
    >
      <div
        role="button"
        tabIndex={0}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onOpen();
          }
        }}
      >
        <div className="flex gap-2.5">
          <GoneTile className="w-11 h-11" />
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-semibold leading-snug text-[var(--ink)] line-clamp-2">
              {orphanTitle(entry)}
            </p>
            <p className="text-[11.5px] tnum mt-0.5 text-[var(--ink-2)]">{orphanMeta(entry)}</p>
          </div>
        </div>
        <EntryTraces entry={entry} />
      </div>
      {followUp && <FollowUpCardLink href={followUp} title={eventName(entry)} />}
    </div>
  );
}

/**
 * A list row for an entry whose event is no longer listed.
 *
 * ONE target: the whole row opens the detail sheet (44px tall, `--r-touch` for its focus ring). The
 * status is shown as text rather than as the select a normal row carries — it can still be changed
 * from the sheet, and a row that is mostly a record should not lead with a control. The one addition
 * is "Follow up" on an Attended entry with a folder, as a sibling of that opener rather than inside it.
 */
function OrphanRow({
  entry,
  className,
  onOpen,
}: {
  entry: TrackerEntry;
  className: string;
  onOpen: () => void;
}) {
  const column = COLUMNS.find(c => c.id === entry.status);
  const followUp = followUpHref(entry);
  const people = entry.connections.length;
  const traces = [
    people > 0 ? `${people} ${people === 1 ? 'person' : 'people'}` : null,
    entry.notes ? 'notes' : null,
  ].filter(Boolean);
  return (
    <div className={`flex items-center gap-3 px-4 py-3 hover:bg-[var(--paper)] transition-colors ${className}`}>
      <GoneTile className="w-10 h-10" />
      <button
        type="button"
        onClick={onOpen}
        className="flex min-h-11 min-w-0 flex-1 items-center gap-3 r-touch text-left"
      >
        <span className="flex min-w-0 flex-1 flex-col justify-center">
          <span className="block truncate text-[14px] font-semibold text-[var(--ink)]">{orphanTitle(entry)}</span>
          <span className="block truncate text-[12px] tnum text-[var(--ink-2)]">
            {[orphanMeta(entry), ...traces].join(' · ')}
          </span>
        </span>
        <span className="shrink-0 text-[12px] font-semibold text-[var(--ink-2)]">
          {column?.label ?? entry.status}
        </span>
      </button>
      {followUp && <FollowUpRowLink href={followUp} title={eventName(entry)} />}
    </div>
  );
}

function ListView({
  entries,
  onOpen,
  onMove,
}: {
  entries: TrackerEntry[];
  onOpen: (entry: TrackerEntry) => void;
  onMove: (id: string, status: string) => void;
}) {
  const sorted = [...entries].sort(byEventStart);

  return (
    <div className="rounded-[var(--r-flat)] border border-[var(--rule)] overflow-hidden">
      {sorted.map((entry, index) => {
        const divider = index > 0 ? 'border-t border-[var(--rule)]' : '';
        const event = entry.eventId;
        if (!event) {
          return (
            <OrphanRow key={entry._id} entry={entry} className={divider} onOpen={() => onOpen(entry)} />
          );
        }
        const column = COLUMNS.find(c => c.id === entry.status);
        const followUp = followUpHref(entry);
        return (
          <div
            key={entry._id}
            /* WRAPS BELOW `sm`. The status select is 16px on a phone (the iOS no-zoom rule in
               globals.css), which makes the pill ~130px wide, and at 360px that left the title 98px:
               "BADDIES W…" and "Wed, 30 Sept · …", i.e. neither the event nor where it is. Below
               `sm` the title takes the whole line beside the cover and the select drops under it,
               indented to the text; from `sm` up the row is unchanged. */
            className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 hover:bg-[var(--paper)] transition-colors sm:flex-nowrap ${divider}`}
          >
            <EventCover
              src={event.imageUrl}
              title={event.title}
              category={event.category?.[0]}
              className="w-10 h-10 rounded-lg shrink-0"
              monogramSize="text-[11px]"
            />
            {/* LIST VIEW IS NOW THE DEFAULT BELOW `md`, so these two controls are the ones a phone
                actually meets and both were under the 44px floor: this row-opener measured ~34px
                (its two lines of text) and the status select ~30px. `min-h-11` on a button with no
                background of its own is a pure hit-area change — the hover tint belongs to the row,
                not to this element, so nothing painted moves. */}
            <button
              type="button"
              onClick={() => onOpen(entry)}
              className="flex min-h-11 min-w-0 flex-1 basis-[calc(100%-52px)] flex-col justify-center text-left sm:basis-auto"
            >
              <p className="text-[14px] font-semibold text-[var(--ink)] truncate">{event.title}</p>
              <p className="text-[12px] text-[var(--ink-2)] tnum truncate">
                {dayLabelIST(event.startDateTime)} · {timeIST(event.startDateTime)} ·{' '}
                {locationLabel(event)}
              </p>
            </button>
            {entry.connections.length > 0 && (
              <span className="hidden sm:inline-flex items-center gap-1 text-[11.5px] font-semibold text-[var(--accent)] shrink-0">
                <span aria-hidden="true" className="material-symbols-outlined text-[14px]">group</span>
                {entry.connections.length}
              </span>
            )}
            <label className="ml-[52px] shrink-0 sm:ml-0">
              <span className="sr-only">Status for {event.title}</span>
              <select
                value={entry.status}
                onChange={e => onMove(entry._id, e.target.value)}
                /* `min-h-11` rather than an `::after` overlay, because an overlay on the wrapping
                   label would be painted OVER the select and swallow the tap that opens it. This is
                   the one place in this pass where the painted control does grow (30 -> 44px); the
                   type size, weight and radius are untouched, and it is the primary action of the
                   default mobile view. */
                className="min-h-11 text-[12px] font-semibold rounded-full px-3 py-1.5 border border-[var(--rule)] bg-[var(--surface)] focus:outline-none focus:border-[var(--accent)] cursor-pointer"
                style={{ color: column?.tint }}
              >
                {COLUMNS.map(c => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
            {/* After the select, so below `sm` it joins the select on the second line (already
                indented to the text) instead of needing an indent of its own. */}
            {followUp && <FollowUpRowLink href={followUp} title={eventName(entry)} />}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The four figures above the board.
 *
 * This is the one hand-rolled copy of a `ui.tsx` primitive left in these surfaces — `ui.tsx` exports
 * `Stat`, and a second implementation of the same thing is exactly what makes an app look assembled.
 * It is NOT switched to the shared one, for a reason worth stating rather than leaving as a silent
 * divergence: `ui.tsx`'s `Stat` renders its value in `--font-display`, which now resolves to the
 * SERIF. A count is the app speaking, so by the semantic rule it is sans with tabular numerals —
 * which is also what stops four figures shifting width as they update. Same call as `AdminUI`'s
 * `StatCard` and `/dashboard`'s grid, so all three agree; when `ui.tsx`'s `Stat` moves off the
 * legacy scale, all three should collapse into it.
 *
 * Ruled rather than a white plane: with `card-shadow` composited to nothing, `bg-[var(--surface)]`
 * on `--paper` had no edge at all.
 */
function Stat({ label, value, loading = false }: { label: string; value: number; loading?: boolean }) {
  return (
    <div className="rounded-[var(--r-flat)] border border-[var(--rule)] px-[var(--s-4)] py-[var(--s-3)]">
      {loading ? (
        <p aria-hidden="true" className="skeleton h-6 w-8 rounded" />
      ) : (
        <p className="tnum text-[24px] font-semibold leading-none tracking-[-0.02em] text-[var(--ink)]">{value}</p>
      )}
      <p className="ty-meta mt-[var(--s-1)]">{label}</p>
    </div>
  );
}

function BoardSkeleton() {
  return (
    <div className="flex gap-4 overflow-hidden">
      {Array.from({ length: 5 }, (_, i) => (
        <div key={i} className="w-[290px] shrink-0 rounded-[var(--r-flat)] border border-[var(--rule)] p-2.5">
          <div className="skeleton h-4 w-24 rounded mb-3 ml-1" />
          {Array.from({ length: 2 }, (_, j) => (
            <div key={j} className="rounded-[var(--r-flat)] border border-[var(--rule)] p-3 mb-2">
              <div className="flex gap-2.5">
                <div className="skeleton w-11 h-11 rounded-lg shrink-0" />
                <div className="flex-1 flex flex-col gap-1.5">
                  <div className="skeleton h-3 w-full rounded" />
                  <div className="skeleton h-3 w-2/3 rounded" />
                </div>
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[var(--paper)]">
      <DesktopNav />
      <header className="md:hidden fixed top-0 w-full h-14 bg-[var(--surface)]/96 glass-nav z-50 border-b border-[var(--rule)] flex items-center justify-between px-5">
        <Link href="/" className="text-lg font-bold tracking-tight text-[var(--ink)]">
          PulseBLR
        </Link>
        <span className="text-[var(--ink-2)] text-label-md font-semibold">Tracker</span>
      </header>
      <main className="pt-14 pb-24 md:pb-10">{children}</main>
      <MobileBottomNav />
    </div>
  );
}
