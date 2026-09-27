import type { OwnerVisibility } from '@/lib/events/owner-edit';

/**
 * How an owner's event's review state is named, in ONE place, so the badge on `/my-events` and the
 * line on the event page cannot describe the same row two ways.
 *
 * Hooks-free and server-safe, so the server-rendered event page and the client list both import it.
 *
 * Words, not colours, carry the state. `--live` is the palette's "urgent or destructive" and none of
 * these is either, so all three badges are the same quiet outline and differ only by label.
 */
export const OWNER_STATUS: Record<OwnerVisibility, { label: string; line: string }> = {
  private: {
    label: 'Private',
    line: 'Only you can see this event.',
  },
  pending: {
    label: 'In review',
    line: 'Waiting for an admin. Until it is approved, only you can see it.',
  },
  public: {
    label: 'Public',
    line: 'In the feed for everyone.',
  },
};

export function OwnerStatusBadge({ visibility }: { visibility: OwnerVisibility }) {
  return <span className="pill pill-quiet">{OWNER_STATUS[visibility].label}</span>;
}
