'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import AppShell from '../components/AppShell';
import Sheet from '../components/Sheet';
import { Button, ButtonLink, Card, EmptyState, PageHeader, Banner } from '../components/ui';
import { dayHeading, fullDateIST } from '@/lib/format';
import { drain, newClientId, pendingCount, startAutoDrain, subscribe } from '@/lib/scan/outbox';
import type { FolderDTO } from '@/lib/contacts/types';

/**
 * Folders — one per event, each holding the people you met there.
 *
 * The entry point for the whole scan feature, and the reason a folder is created by hand
 * rather than derived from the tracker: you make it on the morning of the event, and the
 * event itself is often not in the scraped corpus at all.
 */
export default function FoldersPage() {
  const [folders, setFolders] = useState<FolderDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [pending, setPending] = useState(0);
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/folders');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setFolders(data.folders ?? []);
      setError(null);
    } catch {
      // `sw.js` v3 deliberately does NOT cache private API responses — that fixed a real
      // cross-account leak — so offline means no folder list. Anything captured while offline
      // still lives in the outbox and is shown on the folder page, which is the part that
      // matters.
      setError('Could not load your folders. Nothing has been lost — try again in a moment.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(load, 0);
    return () => clearTimeout(timer);
  }, [load]);

  // Keep the unsynced count honest without polling.
  useEffect(() => {
    const refresh = () => {
      void pendingCount().then(setPending);
    };
    refresh();
    const unsubscribe = subscribe(refresh);
    const stopAutoDrain = startAutoDrain();
    return () => {
      unsubscribe();
      stopAutoDrain();
    };
  }, []);

  async function syncNow() {
    setSyncing(true);
    const result = await drain();
    setSyncing(false);
    setPending(await pendingCount());
    if (result.synced > 0) await load();
  }

  return (
    <AppShell title="People">
      <div className="mx-auto max-w-[1100px] px-4 pt-4 md:px-8">
        <PageHeader
          title="People you've met"
          subtitle="One folder per event. Scan a LinkedIn QR and it lands in the folder you're pointing at."
          action={
            <div className="flex items-center gap-2">
              <Button tone="quiet" icon="create_new_folder" onClick={() => setCreating(true)}>
                New folder
              </Button>
              <ButtonLink href="/scan" tone="primary" icon="qr_code_scanner">
                Scan
              </ButtonLink>
            </div>
          }
        />

        {pending > 0 && (
          <div className="mb-4">
            <Banner tone="warn">
              <span className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  <strong className="tnum">{pending}</strong> capture{pending === 1 ? '' : 's'} not
                  synced yet. They are saved on this device and will upload on their own.
                </span>
                <Button size="sm" tone="quiet" onClick={syncNow} disabled={syncing}>
                  {syncing ? 'Syncing…' : 'Sync now'}
                </Button>
              </span>
            </Banner>
          </div>
        )}

        {error && (
          <div className="mb-4">
            <Banner tone="error">{error}</Banner>
          </div>
        )}

        {loading ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {[0, 1, 2, 3].map(i => (
              <Card key={i}>
                <div className="h-4 w-1/2 rounded bg-[#EEEEF0]" />
                <div className="mt-3 h-3 w-1/3 rounded bg-[#F3F3F5]" />
              </Card>
            ))}
          </div>
        ) : folders.length === 0 ? (
          <EmptyState
            icon="groups"
            title="No folders yet"
            body="Make one named after the event you're going to — “I/O Connect”, “GDG DevFest” — then scan people into it."
            action={
              <Button tone="primary" icon="create_new_folder" onClick={() => setCreating(true)}>
                Create your first folder
              </Button>
            }
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {folders.map(folder => (
              <FolderCard key={folder._id} folder={folder} />
            ))}
          </div>
        )}

        <div className="mt-8 mb-4">
          <Card padding="tight">
            <p className="text-[12.5px] leading-relaxed text-[#6E6E73]">
              <strong className="text-[#1D1D1F]">A note on badges.</strong>{' '}
              Scanning somebody&apos;s conference badge or ticket does not give you their details —
              those codes are opaque ids only the organiser can resolve, on every platform. What
              works is their LinkedIn QR, your own card, or typing the name in.
            </p>
          </Card>
        </div>
      </div>

      {/* Mounted only while open, so its fields start fresh without an effect resetting them. */}
      {creating && (
        <NewFolderSheet
          onClose={() => setCreating(false)}
          onCreated={async () => {
            setCreating(false);
            await load();
          }}
        />
      )}
    </AppShell>
  );
}

function FolderCard({ folder }: { folder: FolderDTO }) {
  return (
    <Link href={`/folders/${folder._id}`} className="block">
      <Card interactive>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="t-sub truncate text-[#1D1D1F]">{folder.name}</h2>
            <p className="mt-1 text-[12.5px] text-[#6E6E73]">
              {/* Formatted through lib/format.ts, which is pinned to Asia/Kolkata. */}
              {folder.eventDate ? dayHeading(folder.eventDate) : 'No date'}
              {folder.venue ? ` · ${folder.venue}` : ''}
            </p>
          </div>
          <span className="shrink-0 text-right">
            <span
              className="tnum block text-[22px] font-bold leading-none tracking-[-0.03em] text-[#1D1D1F]"
              style={{ fontFamily: 'var(--font-display)' }}
            >
              {folder.contactCount ?? 0}
            </span>
            <span className="t-label text-[#8E8E93]">
              {folder.contactCount === 1 ? 'person' : 'people'}
            </span>
          </span>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {(folder.pendingFollowUps ?? 0) > 0 && (
            <span className="rounded-full bg-[#FFF4E5] px-2.5 py-1 text-[11px] font-bold text-[#A85B00]">
              {folder.pendingFollowUps} follow-up{folder.pendingFollowUps === 1 ? '' : 's'} due
            </span>
          )}
          {folder.intakeEnabled && (
            <span className="rounded-full bg-[#EBF4FE] px-2.5 py-1 text-[11px] font-bold text-[#0058B0]">
              Sign-up link live
            </span>
          )}
        </div>
      </Card>
    </Link>
  );
}

/**
 * Create a folder.
 *
 * Queues locally when the request fails, so a folder can be created on the way to the venue
 * with no signal and the contacts scanned into it still resolve later — the sync endpoint
 * processes folders before contacts for exactly this case.
 */
function NewFolderSheet({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  // Lazy initial value rather than an effect: defaults to today, because a folder gets made on
  // the morning of the event. The component is mounted per-open, so there is nothing to reset.
  const [eventDate, setEventDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [venue, setVenue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!name.trim()) {
      setError('Give the folder a name.');
      return;
    }
    setSaving(true);
    setError(null);

    /**
     * `<input type="date">` submits YYYY-MM-DD, which Mongoose casts to UTC MIDNIGHT — 5:30 AM
     * IST the same day. Sending noon IST instead keeps the stored instant inside the intended
     * day even if something later subtracts hours.
     */
    const isoDate = eventDate ? `${eventDate}T12:00:00+05:30` : undefined;

    try {
      const res = await fetch('/api/folders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), eventDate: isoDate, venue: venue.trim() }),
      });

      if (res.status === 409) {
        setError('You already have a folder with that name.');
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      onCreated();
    } catch {
      // Offline: keep it locally and let the outbox deal with it.
      const { queueFolder } = await import('@/lib/scan/outbox');
      await queueFolder({
        clientId: newClientId(),
        name: name.trim(),
        eventDate: isoDate,
        venue: venue.trim() || undefined,
      });
      setError(null);
      onCreated();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title="New folder"
      subtitle="Name it after the event"
      labelledBy="new-folder-title"
      footer={
        <Button tone="primary" full onClick={submit} disabled={saving}>
          {saving ? 'Creating…' : 'Create folder'}
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
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="I/O Connect"
          className="mt-1.5 h-11 w-full rounded-xl bg-[#F7F7F9] px-3.5 text-[15px] text-[#1D1D1F] outline-none focus:shadow-[inset_0_0_0_2px_var(--blue)]"
        />
      </label>

      <label className="mt-4 block">
        <span className="t-label text-[#8E8E93]">Date</span>
        <input
          type="date"
          value={eventDate}
          onChange={e => setEventDate(e.target.value)}
          className="mt-1.5 h-11 w-full rounded-xl bg-[#F7F7F9] px-3.5 text-[15px] text-[#1D1D1F] outline-none focus:shadow-[inset_0_0_0_2px_var(--blue)]"
        />
      </label>

      <label className="mt-4 block">
        <span className="t-label text-[#8E8E93]">Venue (optional)</span>
        <input
          value={venue}
          onChange={e => setVenue(e.target.value)}
          placeholder="Bangalore International Exhibition Centre"
          className="mt-1.5 h-11 w-full rounded-xl bg-[#F7F7F9] px-3.5 text-[15px] text-[#1D1D1F] outline-none focus:shadow-[inset_0_0_0_2px_var(--blue)]"
        />
      </label>

      <p className="mt-4 text-[12px] leading-relaxed text-[#8E8E93]">
        Created on {fullDateIST(new Date())}. You can rename it later.
      </p>
    </Sheet>
  );
}
