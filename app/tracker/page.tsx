'use client';

import Link from 'next/link';

import { useEffect, useState, useCallback, useMemo } from 'react';
import EditTrackerModal from './components/EditTrackerModal';
import { DesktopNav, MobileBottomNav } from '../components/NavBar';
import EventCover from '../components/EventCover';
import { dayLabelIST, timeIST, relativeTime, categoryAccent, locationLabel } from '@/lib/format';
// From the PURE validator module, not lib/contacts/service.ts — this is a client component and
// service.ts imports mongoose.
import { FOLDER_ON_TRACKER_STATUS } from '@/lib/tracker/validate';

interface Connection {
  name: string;
  role?: string;
  company?: string;
  linkedin?: string;
  context?: string;
  followUpAt?: string;
  followedUp?: boolean;
}

interface TrackedEvent {
  _id: string;
  title: string;
  description?: string;
  startDateTime: string;
  endDateTime?: string;
  venue?: string;
  area?: string;
  city?: string;
  format: string;
  category: string[];
  sourceUrl: string;
  imageUrl?: string;
  organizer?: string;
}

interface TrackerEntry {
  _id: string;
  eventId: TrackedEvent | null;
  status: string;
  notes?: string;
  appliedAt?: string;
  outcome?: string;
  connections: Connection[];
  updatedAt: string;
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
      // A tracked event can be deleted upstream by the pruner, leaving a dangling
      // reference. Drop those rather than crashing on entry.eventId.title.
      setEntries((data.entries || []).filter((e: TrackerEntry) => e.eventId));
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
    for (const key of Object.keys(groups)) {
      groups[key].sort(
        (a, b) =>
          new Date(a.eventId!.startDateTime).getTime() -
          new Date(b.eventId!.startDateTime).getTime()
      );
    }
    return groups;
  }, [entries]);

  /** Follow-ups whose date has arrived and that aren't marked done. */
  const dueFollowUps = useMemo(() => {
    const due: Array<{ entry: TrackerEntry; connection: Connection }> = [];
    for (const entry of entries) {
      for (const connection of entry.connections || []) {
        if (
          connection.followUpAt &&
          !connection.followedUp &&
          new Date(connection.followUpAt).getTime() <= now
        ) {
          due.push({ entry, connection });
        }
      }
    }
    return due;
  }, [entries, now]);

  const totals = useMemo(() => {
    const connections = entries.reduce((sum, e) => sum + (e.connections?.length || 0), 0);
    const upcoming = entries.filter(
      e => new Date(e.eventId!.startDateTime).getTime() > now
    ).length;
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
        <div className="max-w-[520px] mx-auto px-4 pt-24 text-center">
          <span aria-hidden="true" className="material-symbols-outlined text-[48px] text-[var(--ink-3)] block mb-3">
            lock
          </span>
          <h1 className="text-[22px] font-bold text-[var(--ink)]">Sign in to use your tracker</h1>
          <p className="text-[14px] text-[var(--ink-2)] mt-2">
            Your tracker keeps the events you saved, who you met, and when to follow up. It’s
            private to your account.
          </p>
          <Link
            href="/login"
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
      <div className="max-w-[1400px] mx-auto px-4 md:px-8 pt-4">
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
          <Stat label="Tracked" value={totals.tracked} />
          <Stat label="Still upcoming" value={totals.upcoming} />
          <Stat label="Attended" value={totals.attended} />
          <Stat label="People met" value={totals.connections} />
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
              aria-label="Dismiss"
              className="shrink-0 text-[var(--accent)]/60 hover:text-[var(--accent)]"
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
                {dueFollowUps.slice(0, 5).map(({ entry, connection }, index) => (
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
                        Met at {entry.eventId!.title} · due{' '}
                        {relativeTime(connection.followUpAt!)}
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
                      className="pressable shrink-0 h-8 px-3 rounded-full bg-[var(--ink)] text-[12px] font-semibold text-[var(--accent-ink)] hover:bg-[var(--ink)] disabled:opacity-50"
                    >
                      {completing === `${entry._id}:${connection.name}` ? 'Saving…' : 'Done'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditing(entry)}
                      className="pressable shrink-0 h-8 px-3 rounded-full bg-[var(--surface)] text-[12px] font-semibold text-[var(--ink)] shadow-[inset_0_0_0_1px_var(--hairline-strong)] hover:bg-[var(--paper)]"
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
                    {byColumn[column.id]?.map(entry => (
                      <TrackerCard
                        key={entry._id}
                        entry={entry}
                        now={now}
                        dragging={dragId === entry._id}
                        onDragStart={e => {
                          setDragId(entry._id);
                          e.dataTransfer.setData('text/plain', entry._id);
                          e.dataTransfer.effectAllowed = 'move';
                        }}
                        onDragEnd={() => {
                          setDragId(null);
                          setOverColumn(null);
                        }}
                        onOpen={() => setSelected(entry)}
                        onMove={status => moveTo(entry._id, status)}
                      />
                    ))}

                    {(byColumn[column.id]?.length || 0) === 0 && (
                      <div className="flex items-center justify-center h-[110px] text-[12px] text-[var(--ink-2)]">
                        Drop here
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Detail sheet */}
      {selected && selected.eventId && (
        <div className="fixed inset-0 z-[60] flex items-end md:items-center justify-center">
          <button
            type="button"
            aria-label="Close"
            onClick={() => setSelected(null)}
            className="absolute inset-0 bg-black/45 backdrop-blur-sm"
          />
          <div className="relative bg-[var(--surface)] w-full md:max-w-lg rounded-[var(--r-flat)] md:rounded-[var(--r-flat)] max-h-[88vh] overflow-y-auto">
            <div className="flex justify-center pt-3 pb-1 md:hidden">
              <div className="w-10 h-1 bg-[var(--rule)] rounded-full" />
            </div>
            <div className="p-5 md:p-6">
              <div className="flex items-start justify-between gap-3 mb-4">
                <h2 className="text-[19px] font-bold leading-snug tracking-[-0.01em] text-[var(--ink)]">
                  {selected.eventId.title}
                </h2>
                <button
                  type="button"
                  onClick={() => setSelected(null)}
                  aria-label="Close"
                  className="shrink-0 w-8 h-8 rounded-full bg-[var(--paper)] flex items-center justify-center transition-colors"
                >
                  <span aria-hidden="true" className="material-symbols-outlined text-[18px]">close</span>
                </button>
              </div>

              <label className="block text-label-sm uppercase tracking-widest text-[var(--ink-2)] mb-2">
                Status
              </label>
              <select
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
            </div>
          </div>
        </div>
      )}

      {editing && (
        <EditTrackerModal
          entryId={editing._id}
          eventTitle={editing.eventId?.title}
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
  now,
  dragging,
  onDragStart,
  onDragEnd,
  onOpen,
  onMove,
}: {
  entry: TrackerEntry;
  /** Passed in rather than read here, so rendering stays a pure function of props. */
  now: number;
  dragging: boolean;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onOpen: () => void;
  onMove: (status: string) => void;
}) {
  const event = entry.eventId!;
  const accent = categoryAccent(event.category?.[0]);
  const currentIndex = COLUMN_IDS.indexOf(entry.status);
  const next = currentIndex >= 0 ? COLUMNS[currentIndex + 1] : undefined;
  const isPast = new Date(event.startDateTime).getTime() < now;

  return (
    <div
      draggable
      data-dragging={dragging}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      role="button"
      tabIndex={0}
      className="kanban-card bg-[var(--surface)] rounded-[var(--r-flat)] p-3 shadow-[inset_0_0_0_1px_var(--rule)]"
      style={{ borderLeft: `3px solid ${accent}` }}
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

      {(entry.connections.length > 0 || entry.notes) && (
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
      )}

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
             card itself is `role="button"` with an `onClick`, so an overlay reaching into the
             card's padding would silently convert "open this entry" taps into status changes. */
          className="flex w-full items-start min-h-11 mt-2.5 pt-2.5 border-t border-[var(--rule)] text-[11.5px] font-semibold text-[var(--accent)] transition-colors text-left"
        >
          Move to {next.label} →
        </button>
      )}
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
  const sorted = [...entries].sort(
    (a, b) =>
      new Date(a.eventId!.startDateTime).getTime() - new Date(b.eventId!.startDateTime).getTime()
  );

  return (
    <div className="rounded-[var(--r-flat)] border border-[var(--rule)] overflow-hidden">
      {sorted.map((entry, index) => {
        const event = entry.eventId!;
        const column = COLUMNS.find(c => c.id === entry.status);
        return (
          <div
            key={entry._id}
            className={`flex items-center gap-3 px-4 py-3 hover:bg-[var(--paper)] transition-colors ${
              index > 0 ? 'border-t border-[var(--rule)]' : ''
            }`}
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
              className="flex min-h-11 min-w-0 flex-1 flex-col justify-center text-left"
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
            <label className="shrink-0">
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
function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-[var(--r-flat)] border border-[var(--rule)] px-[var(--s-4)] py-[var(--s-3)]">
      <p className="tnum text-[24px] font-semibold leading-none tracking-[-0.02em] text-[var(--ink)]">{value}</p>
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
