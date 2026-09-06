'use client';

import { useState } from 'react';
import Sheet from '../../components/Sheet';
import { Banner, Button } from '../../components/ui';
import type { FolderDTO } from '@/lib/contacts/types';

/**
 * Rename, re-date, archive or delete a folder.
 *
 * `PATCH /api/folders/[id]` has handled name/note/venue/eventDate/archived since the folder model
 * existed, and `DELETE` cascades the folder's contacts — and NOTHING in the app called either. The
 * only PATCH calls anywhere in `app/` went to `/api/contacts/`. So a folder created with a typo, or
 * one auto-created from a tracker confirmation with an unwieldy event title, was permanent.
 *
 * THREE THINGS THIS IS CAREFUL ABOUT:
 *
 * · DELETE TAKES THE PEOPLE WITH IT, and says the number out loud before you confirm. Contacts are
 *   meaningless without their folder — a contact records "who I met at this event" — so the cascade
 *   is right, but it is also the one irreversible action in the scan feature. A generic "Are you
 *   sure?" would not tell you that 12 people are about to go.
 *
 * · ARCHIVE IS OFFERED FIRST, and is what the copy steers toward. `listFolders` excludes archived
 *   folders by default, so it does everything "get this off my list" needs without destroying
 *   anything, and it is reversible from the folders list.
 *
 * · A NAME CLASH IS A 409 AND IS REPORTED AS ONE. `{ userId, slug }` is unique, so renaming onto an
 *   existing folder's name fails — and the route's duplicate-key handler branches on `keyPattern`
 *   precisely so this reports the name and not some unrelated index. Do not turn this into a generic
 *   error: "you already have a folder called that" is actionable, "could not save" is not.
 */
export default function FolderSettingsSheet({
  folder,
  contactCount,
  onClose,
  onSaved,
  onDeleted,
}: {
  folder: FolderDTO;
  contactCount: number;
  onClose: () => void;
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const [name, setName] = useState(folder.name);
  const [venue, setVenue] = useState(folder.venue ?? '');
  const [note, setNote] = useState(folder.note ?? '');
  const [eventDate, setEventDate] = useState(
    folder.eventDate ? new Date(folder.eventDate).toISOString().slice(0, 10) : ''
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const archived = Boolean(folder.archivedAt);

  async function patch(body: Record<string, unknown>, then: () => void) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/folders/${folder._id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.status === 409) {
        // Named, not generic — see the header.
        setError('You already have a folder with that name.');
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      then();
    } catch {
      setError('Could not save that. Nothing was changed.');
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!name.trim()) {
      setError('Give the folder a name.');
      return;
    }
    await patch(
      {
        name: name.trim(),
        venue: venue.trim(),
        note: note.trim(),
        // Noon IST, not the raw YYYY-MM-DD: Mongoose casts a bare date to UTC midnight, which is
        // 5:30 AM IST the same day, so anything that later subtracts hours slides it a day earlier.
        ...(eventDate ? { eventDate: `${eventDate}T12:00:00+05:30` } : {}),
      },
      onSaved
    );
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/folders/${folder._id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      onDeleted();
    } catch {
      setError('Could not delete that folder.');
      setBusy(false);
    }
  }

  const field =
    'mt-1.5 h-11 w-full rounded-xl bg-[#F7F7F9] px-3.5 text-[15px] text-[#1D1D1F] outline-none focus:shadow-[inset_0_0_0_2px_var(--blue)]';

  return (
    <Sheet
      open
      onClose={onClose}
      title="Folder settings"
      subtitle={folder.name}
      labelledBy="folder-settings-title"
      footer={
        <Button tone="primary" full onClick={() => void save()} disabled={busy}>
          {busy ? 'Saving…' : 'Save changes'}
        </Button>
      }
    >
      {error && (
        <div className="mb-4">
          <Banner tone="error">{error}</Banner>
        </div>
      )}

      <label className="block">
        <span className="t-label text-[#8E8E93]">Name</span>
        <input value={name} onChange={e => setName(e.target.value)} className={field} />
      </label>

      <label className="mt-4 block">
        <span className="t-label text-[#8E8E93]">Date</span>
        <input
          type="date"
          value={eventDate}
          onChange={e => setEventDate(e.target.value)}
          className={field}
        />
      </label>

      <label className="mt-4 block">
        <span className="t-label text-[#8E8E93]">Venue</span>
        <input value={venue} onChange={e => setVenue(e.target.value)} className={field} />
      </label>

      <label className="mt-4 block">
        <span className="t-label text-[#8E8E93]">Note</span>
        <textarea
          value={note}
          onChange={e => setNote(e.target.value)}
          rows={2}
          className="mt-1.5 w-full resize-none rounded-xl bg-[#F7F7F9] px-3.5 py-2.5 text-[15px] leading-relaxed text-[#1D1D1F] outline-none focus:shadow-[inset_0_0_0_2px_var(--blue)]"
        />
      </label>

      {/* Archive before delete, deliberately: it does what "clear this off my list" means and
          destroys nothing. */}
      <div className="mt-6 border-t border-[color:var(--hairline)] pt-4">
        <p className="t-label text-[#8E8E93]">
          {archived ? 'Archived' : 'Tidy up'}
        </p>
        <p className="mt-1 text-[12.5px] leading-relaxed text-[#6E6E73]">
          {archived
            ? 'This folder is hidden from your folder list. Its people are untouched.'
            : 'Archiving hides it from your folder list and keeps everybody in it. Reversible.'}
        </p>
        <Button
          tone="quiet"
          icon={archived ? 'unarchive' : 'archive'}
          onClick={() => void patch({ archived: !archived }, onSaved)}
          disabled={busy}
        >
          {archived ? 'Un-archive' : 'Archive this folder'}
        </Button>
      </div>

      <div className="mt-6 border-t border-[color:var(--hairline)] pt-4">
        <p className="t-label text-[#C7362D]">Delete</p>
        <p className="mt-1 text-[12.5px] leading-relaxed text-[#6E6E73]">
          {/* The number, before the confirm — not after. */}
          {contactCount > 0 ? (
            <>
              This also deletes the{' '}
              <strong className="text-[#1D1D1F]">
                {contactCount} {contactCount === 1 ? 'person' : 'people'}
              </strong>{' '}
              in it, including their notes and follow-ups. It cannot be undone. Export the CSV first
              if you want to keep them.
            </>
          ) : (
            'This folder has nobody in it. Deleting it cannot be undone.'
          )}
        </p>
        {confirmDelete ? (
          <div className="mt-2 flex flex-wrap gap-2">
            <Button tone="danger" onClick={() => void remove()} disabled={busy}>
              {busy
                ? 'Deleting…'
                : contactCount > 0
                  ? `Delete folder and ${contactCount} ${contactCount === 1 ? 'person' : 'people'}`
                  : 'Delete this folder'}
            </Button>
            <Button tone="quiet" onClick={() => setConfirmDelete(false)} disabled={busy}>
              Keep it
            </Button>
          </div>
        ) : (
          <Button tone="quiet" icon="delete" onClick={() => setConfirmDelete(true)} disabled={busy}>
            Delete this folder
          </Button>
        )}
      </div>
    </Sheet>
  );
}
