'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import AppShell from '../components/AppShell';
import { Banner, Button, ButtonLink, EmptyState, PageHeader, Skeleton } from '../components/ui';
import { dayLabelIST, hasEnded, locationLabel, timeIST } from '@/lib/format';
import type { EventDetail } from '@/lib/events/serialize';
import EditEventSheet from './EditEventSheet';
import DeleteEventSheet from './DeleteEventSheet';
import { OWNER_STATUS, OwnerStatusBadge } from './owner-status';

/**
 * The owner's list of their own hand-added events.
 *
 * WHY THIS PAGE HAD TO EXIST. A user could add an event and then never touch it again: `PUT` and
 * `DELETE /api/events/[id]` were admin-only and nothing listed what you had added. A private event
 * with a typo in its date stayed wrong forever, and a submission sat "in review" with no way to see
 * that it was.
 *
 * Status words come from `OWNER_STATUS`, the same table the event page's owner line uses, so the two
 * surfaces cannot describe one row two ways.
 *
 * Past events are listed, below the upcoming ones, because a past event is where the people you met
 * hang off — deleting one is a decision about that record, not housekeeping.
 */

type Load =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'signed-out' }
  | { state: 'ready'; events: EventDetail[] };

export default function MyEventsClient() {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [editing, setEditing] = useState<EventDetail | null>(null);
  const [deleting, setDeleting] = useState<EventDetail | null>(null);
  const [editKey, setEditKey] = useState(0);
  const [note, setNote] = useState<string | null>(null);

  const fetchEvents = useCallback(async () => {
    try {
      const res = await fetch('/api/me/events', { cache: 'no-store' });
      if (res.status === 401) {
        setLoad({ state: 'signed-out' });
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setLoad({ state: 'ready', events: (data.events ?? []) as EventDetail[] });
    } catch {
      setLoad({ state: 'error', message: 'Could not load your events. Nothing has been lost — try again.' });
    }
  }, []);

  useEffect(() => {
    // Deferred a tick so the effect does not set state synchronously — the pattern the folders and
    // tracker pages use for the same lint rule.
    const timer = setTimeout(() => void fetchEvents(), 0);
    return () => clearTimeout(timer);
  }, [fetchEvents]);

  function replace(updated: EventDetail) {
    setLoad(prev =>
      prev.state === 'ready'
        ? { state: 'ready', events: prev.events.map(e => (e._id === updated._id ? updated : e)) }
        : prev
    );
  }

  function remove(id: string) {
    setLoad(prev =>
      prev.state === 'ready' ? { state: 'ready', events: prev.events.filter(e => e._id !== id) } : prev
    );
  }

  const events = load.state === 'ready' ? load.events : [];
  const upcoming = events
    .filter(e => !hasEnded(e.startDateTime, e.endDateTime))
    .sort((a, b) => a.startDateTime.localeCompare(b.startDateTime));
  const past = events.filter(e => hasEnded(e.startDateTime, e.endDateTime));

  return (
    <AppShell title="My events">
      <div className="mx-auto max-w-[860px] px-4 md:px-8 pt-[var(--s-6)]">
        <PageHeader
          title="My events"
          subtitle="Events you added by hand. Edit them, see where they are in review, or delete them."
          action={
            <ButtonLink href="/add-event" tone="secondary" icon="add" className="min-h-11">
              Add an event
            </ButtonLink>
          }
        />

        {note && (
          <Banner tone="ok" className="mb-[var(--s-4)]">
            {note}
          </Banner>
        )}

        {load.state === 'loading' && (
          <div className="flex flex-col gap-[var(--s-3)]" aria-busy="true">
            <Skeleton className="h-[72px]" />
            <Skeleton className="h-[72px]" />
            <Skeleton className="h-[72px]" />
          </div>
        )}

        {load.state === 'error' && (
          <Banner tone="error">
            {load.message}{' '}
            <button
              type="button"
              onClick={() => {
                setLoad({ state: 'loading' });
                void fetchEvents();
              }}
              className="inline-flex min-h-11 items-center font-semibold underline"
            >
              Retry
            </button>
          </Banner>
        )}

        {load.state === 'signed-out' && (
          <EmptyState
            icon="lock"
            title="Sign in to see your events"
            body="The events you add are tied to your account."
            action={<ButtonLink href="/login?callbackUrl=%2Fmy-events" className="min-h-11">Sign in</ButtonLink>}
          />
        )}

        {load.state === 'ready' && events.length === 0 && (
          <EmptyState
            icon="event"
            title="You have not added any events"
            body="Add one the feed cannot know about — an internal hackathon, a reading group — for yourself or for everyone."
            action={<ButtonLink href="/add-event" tone="secondary" className="min-h-11">Add an event</ButtonLink>}
          />
        )}

        {upcoming.length > 0 && (
          <EventList
            heading="Upcoming"
            events={upcoming}
            onEdit={e => {
              setEditKey(k => k + 1);
              setEditing(e);
            }}
            onDelete={setDeleting}
          />
        )}
        {past.length > 0 && (
          <EventList
            heading="Past"
            events={past}
            onEdit={e => {
              setEditKey(k => k + 1);
              setEditing(e);
            }}
            onDelete={setDeleting}
          />
        )}
      </div>

      {editing && (
        <EditEventSheet
          key={editKey}
          event={editing}
          open
          onClose={() => setEditing(null)}
          onSaved={result => {
            setEditing(null);
            replace(result.event);
            setNote(
              result.changed.length === 0
                ? 'Nothing had changed, so nothing was saved.'
                : result.reReview
                  ? `Saved “${result.event.title}”. It has gone back for review, so only you can see it until an admin approves it.`
                  : `Saved “${result.event.title}”.`
            );
          }}
        />
      )}
      {deleting && (
        <DeleteEventSheet
          event={deleting}
          open
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            const title = deleting.title;
            remove(deleting._id);
            setDeleting(null);
            setNote(`Deleted “${title}”.`);
          }}
        />
      )}
    </AppShell>
  );
}

function EventList({
  heading,
  events,
  onEdit,
  onDelete,
}: {
  heading: string;
  events: EventDetail[];
  onEdit: (event: EventDetail) => void;
  onDelete: (event: EventDetail) => void;
}) {
  return (
    <section className="mt-[var(--s-6)]">
      <h2 className="t-sub text-[var(--ink)]">{heading}</h2>
      <ul className="mt-[var(--s-3)] rule-t">
        {events.map(event => {
          const visibility = event.visibility ?? 'private';
          const others = event.savedByOthers ?? 0;
          return (
            <li key={event._id} className="rule-b py-[var(--s-4)]">
              <div className="flex flex-col gap-[var(--s-3)] sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <Link
                    href={`/events/${event._id}`}
                    className="ty-row-title text-[var(--ink)] hover:text-[var(--accent)] transition-colors"
                  >
                    {event.title}
                  </Link>
                  <p className="mt-1 ty-meta">
                    {dayLabelIST(event.startDateTime)} · {timeIST(event.startDateTime)} · {locationLabel(event)}
                  </p>
                  <div className="mt-[var(--s-2)] flex flex-wrap items-center gap-x-[var(--s-2)] gap-y-1">
                    <OwnerStatusBadge visibility={visibility} />
                    <span className="text-[12.5px] text-[var(--ink-2)]">
                      {OWNER_STATUS[visibility].line}
                      {others > 0 && ` Saved by ${others} ${others === 1 ? 'other person' : 'other people'}.`}
                    </span>
                  </div>
                </div>
                <div className="flex shrink-0 gap-[var(--s-2)]">
                  <Button tone="quiet" icon="edit" className="min-h-11" onClick={() => onEdit(event)}>
                    Edit
                  </Button>
                  <Button
                    tone="danger"
                    icon="delete"
                    className="min-h-11"
                    onClick={() => onDelete(event)}
                    aria-label={`Delete ${event.title}`}
                  >
                    Delete
                  </Button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
