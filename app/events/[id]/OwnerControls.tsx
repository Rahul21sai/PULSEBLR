'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Banner, Button } from '../../components/ui';
import EditEventSheet from '../../my-events/EditEventSheet';
import DeleteEventSheet from '../../my-events/DeleteEventSheet';
import { OWNER_STATUS, OwnerStatusBadge } from '../../my-events/owner-status';
import type { EventDetail } from '@/lib/events/serialize';

/**
 * Edit and Delete for the AUTHOR of a hand-added event. Rendered only when the server-built DTO says
 * `isOwner` — a courtesy that decides what to draw; the boundary is the owner-scoped query in
 * `PATCH`/`DELETE /api/events/[id]`, which answers 404 to anyone else.
 *
 * Placed under the title rather than in the action rail, because it must be reachable at every
 * width: below `lg` the rail's actions live in the sticky bar, which has room for Register and Save
 * and nothing else.
 *
 * AFTER A SAVE, `router.refresh()` re-runs the server component, so the page shows the stored row —
 * not the draft. A reviewer-facing change (a public event going back to review) is announced here
 * because the page still renders for the owner and would otherwise look unchanged.
 */
export default function OwnerControls({ event }: { event: EventDetail }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // Bumped per open so the form re-seeds from the latest server data rather than a stale draft.
  const [editKey, setEditKey] = useState(0);

  const visibility = event.visibility ?? 'private';

  return (
    <div className="mt-[var(--s-4)] rule-t pt-[var(--s-3)]">
      <div className="flex flex-wrap items-center gap-x-[var(--s-3)] gap-y-[var(--s-2)]">
        <OwnerStatusBadge visibility={visibility} />
        <p className="min-w-0 flex-1 ty-meta">
          You added this event. {OWNER_STATUS[visibility].line}
        </p>
        <div className="flex gap-[var(--s-2)]">
          <Button
            tone="quiet"
            icon="edit"
            className="min-h-11"
            onClick={() => {
              setEditKey(k => k + 1);
              setEditing(true);
            }}
          >
            Edit
          </Button>
          <Button tone="danger" icon="delete" className="min-h-11" onClick={() => setDeleting(true)}>
            Delete
          </Button>
        </div>
      </div>

      {note && (
        <Banner tone="ok" className="mt-[var(--s-3)]">
          {note}{' '}
          <Link href="/my-events" className="font-semibold text-[var(--accent)] hover:underline">
            My events
          </Link>
        </Banner>
      )}

      <EditEventSheet
        key={editKey}
        event={event}
        open={editing}
        onClose={() => setEditing(false)}
        onSaved={result => {
          setEditing(false);
          setNote(
            result.changed.length === 0
              ? 'Nothing had changed, so nothing was saved.'
              : result.reReview
                ? 'Saved. It has gone back for review, so only you can see it until an admin approves it.'
                : 'Saved.'
          );
          router.refresh();
        }}
      />
      <DeleteEventSheet
        event={event}
        open={deleting}
        onClose={() => setDeleting(false)}
        onDeleted={() => {
          setDeleting(false);
          // The page 404s now, for the owner as well, so there is nothing here to go back to.
          router.push('/my-events');
        }}
      />
    </div>
  );
}
