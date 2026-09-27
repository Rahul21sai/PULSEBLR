'use client';

import { useState } from 'react';
import Sheet from '../components/Sheet';
import { Banner, Button } from '../components/ui';
import { ownerDeleteMode, type OwnerDeleteMode } from '@/lib/events/owner-edit';
import type { EventDetail } from '@/lib/events/serialize';

/**
 * The owner's delete confirmation. It says WHAT HAPPENS TO THE PEOPLE WHO SAVED IT before asking,
 * because that is the one consequence the owner cannot see from their own screen.
 *
 * The copy follows `ownerDeleteMode` (lib/events/owner-edit.ts), which the server applies again at
 * delete time from fresh counts — so this is a preview of the rule, never the decision. Using the
 * DTO's `deleteMode`, with the same pure function as the fallback, keeps the words and the outcome
 * from disagreeing.
 *
 * What the saved entries become is real, not promised: the tracker renders an entry whose event is
 * gone as "no longer listed" and keeps its notes (the orphan handling in `app/tracker/page.tsx`).
 */
export default function DeleteEventSheet({
  event,
  open,
  onClose,
  onDeleted,
}: {
  event: EventDetail;
  open: boolean;
  onClose: () => void;
  onDeleted: (mode: OwnerDeleteMode) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const others = event.savedByOthers ?? 0;
  const mode =
    event.deleteMode ?? ownerDeleteMode({ visibility: event.visibility, othersReferencing: others });
  const people = `${others} ${others === 1 ? 'person has' : 'people have'}`;

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/events/${event._id}`, { method: 'DELETE' });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(
          res.status === 404
            ? 'This event is already gone.'
            : res.status === 403
              ? 'This page could not be verified. Reload it and try again — nothing was deleted.'
              : data?.error || 'Could not delete the event. Nothing was changed.'
        );
        return;
      }
      onDeleted((data?.mode as OwnerDeleteMode) ?? mode);
    } catch {
      setError('Could not reach the server. Nothing was changed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Delete this event?"
      subtitle={event.title}
      labelledBy="delete-event-title"
      footer={
        <div className="flex gap-[var(--s-3)]">
          <Button tone="quiet" onClick={onClose} className="min-h-11 flex-1">
            Keep it
          </Button>
          <Button tone="danger" onClick={confirm} disabled={busy} className="min-h-11 flex-1">
            {busy ? 'Deleting…' : 'Delete event'}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-[var(--s-3)] text-[14px] leading-[1.55] text-[var(--ink)]">
        {error && <Banner tone="error">{error}</Banner>}

        {others > 0 ? (
          <p>
            {people} saved this event. They keep their saved entry and their notes, but the event will
            show as no longer listed and its page will stop opening for them.
          </p>
        ) : (
          <p>Nobody else has saved this event.</p>
        )}

        {mode === 'soft' ? (
          <p className="text-[var(--ink-2)]">
            It comes off the feed and search straight away. Because other people saw it, PulseBLR keeps
            a copy so an admin can restore it if this was a mistake.
          </p>
        ) : (
          <p className="text-[var(--ink-2)]">
            This permanently deletes it and cannot be undone.
            {event.tracked ? ' Your own saved entry stays, with your notes, marked as no longer listed.' : ''}{' '}
            Any folder you made for it keeps the people in it.
          </p>
        )}
      </div>
    </Sheet>
  );
}
