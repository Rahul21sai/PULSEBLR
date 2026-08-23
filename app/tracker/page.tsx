'use client';

import Link from 'next/link';

import { useEffect, useState, useCallback, useMemo } from 'react';
import EditTrackerModal from './components/EditTrackerModal';
import { DesktopNav, MobileBottomNav } from '../components/NavBar';
import EventCover from '../components/EventCover';
import { dayLabelIST, timeIST, relativeTime, categoryAccent, locationLabel } from '@/lib/format';

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

type ViewMode = 'board' | 'list';

export default function TrackerPage() {
  const [entries, setEntries] = useState<TrackerEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [unauthorized, setUnauthorized] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>('board');
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
          <span className="material-symbols-outlined text-[48px] text-[#d5d5da] block mb-3">
            lock
          </span>
          <h1 className="text-[22px] font-bold text-[#1D1D1F]">Sign in to use your tracker</h1>
          <p className="text-[14px] text-[#6E6E73] mt-2">
            Your tracker keeps the events you saved, who you met, and when to follow up. It’s
            private to your account.
          </p>
          <Link
            href="/login"
            className="inline-block mt-6 px-6 py-2.5 rounded-full bg-[#0071E3] text-white text-label-md font-semibold hover:bg-blue-600 transition-colors"
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
        {/* Header */}
        <div className="flex flex-wrap items-end justify-between gap-4 mb-5">
          <div>
            <h1 className="text-[24px] md:text-[30px] font-bold tracking-[-0.025em] text-[#1D1D1F]">
              Your tracker
            </h1>
            <p className="text-[13.5px] text-[#6E6E73] mt-0.5">
              Events you saved, and what happened next.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 bg-white border border-[#e5e5ea] rounded-full p-0.5">
              {(['board', 'list'] as const).map(mode => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setView(mode)}
                  aria-pressed={view === mode}
                  className={`px-3.5 h-8 rounded-full text-[12.5px] font-semibold transition-colors ${
                    view === mode ? 'bg-[#f3f3f5] text-[#1D1D1F]' : 'text-[#86868B] hover:text-[#1D1D1F]'
                  }`}
                >
                  {mode === 'board' ? 'Board' : 'List'}
                </button>
              ))}
            </div>
            <Link
              href="/"
              className="h-9 px-4 rounded-full bg-[#1D1D1F] text-white text-[12.5px] font-semibold flex items-center hover:bg-black transition-colors"
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
          <div className="mb-4 bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-[13px] text-red-700">
            {error}
          </div>
        )}

        {/* Follow-ups due — the tracker's reason to exist, so it leads. */}
        {dueFollowUps.length > 0 && (
          <section className="mb-5 bg-white rounded-2xl card-shadow overflow-hidden">
            <div className="h-1 bg-[#FF9500]" />
            <div className="p-4 md:p-5">
              <h2 className="text-[15px] font-bold text-[#1D1D1F] flex items-center gap-1.5 mb-3">
                <span className="material-symbols-outlined text-[18px] text-[#FF9500]">
                  notifications_active
                </span>
                {dueFollowUps.length} follow-up{dueFollowUps.length === 1 ? '' : 's'} due
              </h2>
              <div className="flex flex-col gap-2">
                {dueFollowUps.slice(0, 5).map(({ entry, connection }, index) => (
                  <div
                    key={`${entry._id}-${connection.name}-${index}`}
                    className="flex items-center gap-3 bg-[#f9f9fb] rounded-xl px-3 py-2.5"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-[13.5px] font-semibold text-[#1D1D1F] truncate">
                        {connection.name}
                        {connection.company && (
                          <span className="font-normal text-[#6E6E73]"> · {connection.company}</span>
                        )}
                      </p>
                      <p className="text-[12px] text-[#86868B] truncate">
                        Met at {entry.eventId!.title} · due{' '}
                        {relativeTime(connection.followUpAt!)}
                      </p>
                    </div>
                    {connection.linkedin && (
                      <a
                        href={connection.linkedin}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="shrink-0 text-[12px] font-semibold text-[#0071E3] hover:underline"
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
                      className="pressable shrink-0 h-8 px-3 rounded-full bg-[#1D1D1F] text-[12px] font-semibold text-white hover:bg-black disabled:opacity-50"
                    >
                      {completing === `${entry._id}:${connection.name}` ? 'Saving…' : 'Done'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditing(entry)}
                      className="pressable shrink-0 h-8 px-3 rounded-full bg-white text-[12px] font-semibold text-[#1D1D1F] shadow-[inset_0_0_0_1px_var(--hairline-strong)] hover:bg-[#F7F7F9]"
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
          <div className="bg-white rounded-2xl card-shadow py-20 px-6 text-center">
            <span className="material-symbols-outlined text-[44px] text-[#d5d5da] block mb-3">
              bookmarks
            </span>
            <p className="text-[17px] font-semibold text-[#1D1D1F]">Nothing tracked yet</p>
            <p className="text-[14px] text-[#6E6E73] mt-1.5 max-w-sm mx-auto">
              Save an event from the feed and it lands here, ready to move through your pipeline.
            </p>
            <Link
              href="/"
              className="inline-block mt-6 px-6 py-2.5 rounded-full bg-[#1D1D1F] text-white text-label-md font-semibold hover:bg-black transition-colors"
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
                  className="kanban-col w-[290px] shrink-0 bg-[#efeff2] rounded-2xl flex flex-col transition-colors"
                >
                  <div className="px-3.5 py-3 flex items-center justify-between sticky top-0">
                    <span className="flex items-center gap-2 text-[13px] font-bold text-[#1D1D1F]">
                      <span
                        className="w-2 h-2 rounded-full"
                        style={{ background: column.tint }}
                        aria-hidden="true"
                      />
                      {column.label}
                    </span>
                    <span className="tnum text-[11.5px] font-semibold text-[#86868B] bg-white rounded-full px-2 py-0.5">
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
                      <div className="flex items-center justify-center h-[110px] text-[12px] text-[#b0b0b5]">
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
          <div className="relative bg-white w-full md:max-w-lg rounded-t-3xl md:rounded-2xl max-h-[88vh] overflow-y-auto">
            <div className="flex justify-center pt-3 pb-1 md:hidden">
              <div className="w-10 h-1 bg-[#e5e5ea] rounded-full" />
            </div>
            <div className="p-5 md:p-6">
              <div className="flex items-start justify-between gap-3 mb-4">
                <h2 className="text-[19px] font-bold leading-snug tracking-[-0.01em] text-[#1D1D1F]">
                  {selected.eventId.title}
                </h2>
                <button
                  type="button"
                  onClick={() => setSelected(null)}
                  aria-label="Close"
                  className="shrink-0 w-8 h-8 rounded-full bg-[#f3f3f5] flex items-center justify-center hover:bg-[#e8e8ea] transition-colors"
                >
                  <span className="material-symbols-outlined text-[18px]">close</span>
                </button>
              </div>

              <label className="block text-label-sm uppercase tracking-widest text-[#86868B] mb-2">
                Status
              </label>
              <select
                value={selected.status}
                onChange={e => {
                  moveTo(selected._id, e.target.value);
                  setSelected({ ...selected, status: e.target.value });
                }}
                className="w-full px-4 py-2.5 border border-[#e5e5ea] rounded-xl text-label-md text-[#1D1D1F] focus:outline-none focus:border-[#0071E3] bg-white mb-5"
              >
                {COLUMNS.map(column => (
                  <option key={column.id} value={column.id}>
                    {column.label}
                  </option>
                ))}
              </select>

              <div className="bg-[#f9f9fb] rounded-xl p-4 mb-5 flex flex-col gap-2 text-[13.5px] text-[#3a3a3c]">
                <span className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-[16px] text-[#86868B]">
                    calendar_month
                  </span>
                  <span className="tnum">
                    {dayLabelIST(selected.eventId.startDateTime)} ·{' '}
                    {timeIST(selected.eventId.startDateTime)}
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-[16px] text-[#86868B]">
                    location_on
                  </span>
                  {locationLabel(selected.eventId)}
                </span>
              </div>

              {selected.notes && (
                <div className="mb-5">
                  <p className="text-label-sm uppercase tracking-widest text-[#86868B] mb-2">
                    Notes
                  </p>
                  <p className="text-[13.5px] text-[#1D1D1F] bg-[#f9f9fb] rounded-xl p-4 whitespace-pre-line">
                    {selected.notes}
                  </p>
                </div>
              )}

              {selected.connections.length > 0 && (
                <div className="mb-5">
                  <p className="text-label-sm uppercase tracking-widest text-[#86868B] mb-2">
                    People met ({selected.connections.length})
                  </p>
                  <div className="flex flex-col gap-2">
                    {selected.connections.map((connection, index) => (
                      <div key={index} className="bg-[#f9f9fb] rounded-xl p-3">
                        <p className="text-[13.5px] font-semibold text-[#1D1D1F]">
                          {connection.name}
                        </p>
                        {(connection.role || connection.company) && (
                          <p className="text-[12.5px] text-[#6E6E73]">
                            {connection.role}
                            {connection.role && connection.company ? ' @ ' : ''}
                            {connection.company}
                          </p>
                        )}
                        {connection.followUpAt && (
                          <p className="text-[12px] text-[#FF9500] font-semibold mt-1">
                            Follow up {relativeTime(connection.followUpAt)}
                            {connection.followedUp && ' · done'}
                          </p>
                        )}
                        {connection.linkedin && (
                          <a
                            href={connection.linkedin}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[12px] font-semibold text-[#0071E3] hover:underline mt-1 inline-block"
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
                  className="flex-1 min-w-[120px] text-center bg-[#1D1D1F] text-white text-label-md font-semibold py-3 rounded-full hover:bg-black transition-colors"
                >
                  View event
                </Link>
                <button
                  type="button"
                  onClick={() => {
                    setEditing(selected);
                    setSelected(null);
                  }}
                  className="flex-1 min-w-[120px] bg-[#f3f3f5] text-[#1D1D1F] text-label-md font-semibold py-3 rounded-full hover:bg-[#e8e8ea] transition-colors"
                >
                  Edit notes & people
                </button>
                <button
                  type="button"
                  onClick={() => remove(selected._id)}
                  className="px-5 py-3 rounded-full text-label-md font-semibold text-red-600 bg-red-50 hover:bg-red-100 transition-colors"
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
      className="kanban-card bg-white rounded-xl p-3 shadow-[0_2px_10px_rgba(0,0,0,0.05)] hover:shadow-[0_5px_18px_rgba(0,0,0,0.09)] transition-shadow"
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
          <p className="text-[13px] font-semibold leading-snug text-[#1D1D1F] line-clamp-2">
            {event.title}
          </p>
          <p className={`text-[11.5px] tnum mt-0.5 ${isPast ? 'text-[#b0b0b5]' : 'text-[#6E6E73]'}`}>
            {dayLabelIST(event.startDateTime)} · {timeIST(event.startDateTime)}
          </p>
        </div>
      </div>

      {(entry.connections.length > 0 || entry.notes) && (
        <div className="flex items-center gap-3 mt-2 text-[11px] text-[#86868B]">
          {entry.connections.length > 0 && (
            <span className="inline-flex items-center gap-1 text-[#0071E3] font-semibold">
              <span className="material-symbols-outlined text-[13px]">group</span>
              {entry.connections.length}
            </span>
          )}
          {entry.notes && (
            <span className="inline-flex items-center gap-1">
              <span className="material-symbols-outlined text-[13px]">notes</span>
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
          className="w-full mt-2.5 pt-2.5 border-t border-[#f0f0f2] text-[11.5px] font-semibold text-[#0071E3] hover:text-[#0060C0] transition-colors text-left"
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
    <div className="bg-white rounded-2xl card-shadow overflow-hidden">
      {sorted.map((entry, index) => {
        const event = entry.eventId!;
        const column = COLUMNS.find(c => c.id === entry.status);
        return (
          <div
            key={entry._id}
            className={`flex items-center gap-3 px-4 py-3 hover:bg-[#f9f9fb] transition-colors ${
              index > 0 ? 'border-t border-[#f0f0f2]' : ''
            }`}
          >
            <EventCover
              src={event.imageUrl}
              title={event.title}
              category={event.category?.[0]}
              className="w-10 h-10 rounded-lg shrink-0"
              monogramSize="text-[11px]"
            />
            <button
              type="button"
              onClick={() => onOpen(entry)}
              className="min-w-0 flex-1 text-left"
            >
              <p className="text-[14px] font-semibold text-[#1D1D1F] truncate">{event.title}</p>
              <p className="text-[12px] text-[#86868B] tnum truncate">
                {dayLabelIST(event.startDateTime)} · {timeIST(event.startDateTime)} ·{' '}
                {locationLabel(event)}
              </p>
            </button>
            {entry.connections.length > 0 && (
              <span className="hidden sm:inline-flex items-center gap-1 text-[11.5px] font-semibold text-[#0071E3] shrink-0">
                <span className="material-symbols-outlined text-[14px]">group</span>
                {entry.connections.length}
              </span>
            )}
            <label className="shrink-0">
              <span className="sr-only">Status for {event.title}</span>
              <select
                value={entry.status}
                onChange={e => onMove(entry._id, e.target.value)}
                className="text-[12px] font-semibold rounded-full px-3 py-1.5 border border-[#e5e5ea] bg-white focus:outline-none focus:border-[#0071E3] cursor-pointer"
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

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-white rounded-xl card-shadow px-4 py-3">
      <p className="tnum text-[24px] font-bold leading-none text-[#1D1D1F]">{value}</p>
      <p className="text-[12px] text-[#86868B] mt-1">{label}</p>
    </div>
  );
}

function BoardSkeleton() {
  return (
    <div className="flex gap-4 overflow-hidden">
      {Array.from({ length: 5 }, (_, i) => (
        <div key={i} className="w-[290px] shrink-0 bg-[#efeff2] rounded-2xl p-2.5">
          <div className="skeleton h-4 w-24 rounded mb-3 ml-1" />
          {Array.from({ length: 2 }, (_, j) => (
            <div key={j} className="bg-white rounded-xl p-3 mb-2">
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
    <div className="min-h-screen bg-[#F5F5F7]">
      <DesktopNav />
      <header className="md:hidden fixed top-0 w-full h-14 bg-white/96 glass-nav z-50 border-b border-black/5 flex items-center justify-between px-5">
        <Link href="/" className="text-lg font-bold tracking-tight text-[#1D1D1F]">
          PulseBLR
        </Link>
        <span className="text-[#86868B] text-label-md font-semibold">Tracker</span>
      </header>
      <main className="pt-14 pb-24 md:pb-10">{children}</main>
      <MobileBottomNav />
    </div>
  );
}
