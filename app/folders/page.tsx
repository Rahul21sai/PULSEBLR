'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import AppShell from '../components/AppShell';
import Sheet from '../components/Sheet';
import { TAP_44 } from '../components/scan/ContactFields';
import { Button, ButtonLink, Card, EmptyState, PageHeader, Banner } from '../components/ui';
import { dayHeading } from '@/lib/format';
import {
  blockedCaptures,
  discardContact,
  discardFolder,
  drain,
  moveQueuedContact,
  newClientId,
  pendingFolders,
  pendingSummary,
  retryCapture,
  saveFolder,
  startAutoDrain,
  subscribe,
  type BlockedCapture,
  type PendingSummary,
  type QueuedFolderRecord,
} from '@/lib/scan/outbox';
import type { FolderDTO } from '@/lib/contacts/types';

/**
 * Folders — one per event, each holding the people you met there.
 *
 * The entry point for the whole scan feature, and the reason a folder is created by hand
 * rather than derived from the tracker: you make it on the morning of the event, and the
 * event itself is often not in the scraped corpus at all.
 *
 * A NOTE ON THE SMALL BUTTONS HERE. Sync, Retry and Discard are painted at 32px on purpose - they are
 * secondary to the banner text they sit inside - but a 32px target fails the 44px floor (WCAG 2.5.5),
 * and Discard is destructive. They are written as raw buttons rather than `<Button size="sm">` for a
 * mechanical reason: `ui.tsx` hardcodes its own `className` and spreads `...rest` AFTER it, so a class
 * passed from outside REPLACES the styling instead of adding to it, and there is no way to attach the
 * `::after` overlay that grows the hit area. The painted look and tones are identical.
 */
/**
 * `<Button tone="quiet" size="sm">`'s exact painted appearance, with a 44px hit area on top. See the
 * file header for why this is not the shared component.
 */
const SMALL_QUIET =
  TAP_44 +
  ' inline-flex h-8 items-center justify-center gap-1 rounded-full bg-white px-3.5 text-[12.5px]' +
  ' font-semibold tracking-[-0.006em] text-[#1D1D1F] shadow-[inset_0_0_0_1px_var(--hairline-strong)]' +
  ' pressable hover:bg-[#F7F7F9] disabled:pointer-events-none disabled:opacity-45';

export default function FoldersPage() {
  const [folders, setFolders] = useState<FolderDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [pending, setPending] = useState<PendingSummary>({
    waiting: 0,
    blocked: 0,
    otherAccount: 0,
    waitingFolders: 0,
    total: 0,
    authExpired: false,
  });
  const [stuck, setStuck] = useState<BlockedCapture[]>([]);
  /**
   * Folders that exist only on this device.
   *
   * Rendered as real rows, because otherwise a folder created offline is INVISIBLE — the grid
   * shows server folders only, so the single trace of it was an increment in a count that called
   * it a "capture". A user who made a folder on the way to the venue saw a warning about an
   * unsynced capture and no folder anywhere.
   */
  const [queuedFolders, setQueuedFolders] = useState<QueuedFolderRecord[]>([]);
  const [syncing, setSyncing] = useState(false);
  /** What the last "Sync now" actually did. Its absence was half of the reported bug. */
  const [syncNote, setSyncNote] = useState<string | null>(null);

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
  const refreshQueue = useCallback(async () => {
    const [summary, blocked, local] = await Promise.all([
      pendingSummary(),
      blockedCaptures(),
      pendingFolders(),
    ]);
    setPending(summary);
    setStuck(blocked);
    setQueuedFolders(local.filter(f => !f.blocked));
  }, []);

  useEffect(() => {
    // `load()` too, not just the queue: a drain that uploads a FOLDER changes the server list,
    // and this was the one screen that ignored its own queue notifications for the folder grid
    // (app/folders/[id] already reloaded both).
    const refresh = () => {
      void refreshQueue();
      void load();
    };
    // Deferred by a tick so the effect does not setState synchronously — the same pattern
    // app/folders/[id], the feed and the tracker use.
    const timer = setTimeout(() => void refreshQueue(), 0);
    const unsubscribe = subscribe(refresh);
    const stopAutoDrain = startAutoDrain();
    return () => {
      clearTimeout(timer);
      unsubscribe();
      stopAutoDrain();
    };
  }, [refreshQueue, load]);

  /**
   * Sync, and SAY WHAT HAPPENED.
   *
   * The version this replaces did the work and reported none of it: it only reloaded the folder
   * list when `synced > 0`, so a hard rejection, a lapsed session and a queue full of records
   * the server refuses were all indistinguishable from the button being broken. That is the
   * literal complaint this fix started from — "Sync now appears to do nothing" — and it was
   * true on every path except the happy one.
   */
  async function syncNow() {
    setSyncing(true);
    setSyncNote(null);
    // `force`: the user asked. See the note in `drain()` about the automatic path declining an
    // all-blocked queue.
    const result = await drain({ force: true });
    const summary = await pendingSummary();
    setSyncing(false);
    await refreshQueue();
    // BOTH counters. Gating the reload on `synced` alone meant a folder-only queue uploaded
    // successfully and the folder never appeared, over a note reading "Everything is uploaded".
    const uploaded = result.synced + result.foldersSynced;
    if (uploaded > 0) await load();

    setSyncNote(
      result.authExpired
        ? 'Your session has expired. Sign in again and these will upload on their own.'
        : uploaded > 0
          ? `Uploaded ${uploaded}.${summary.blocked ? ` ${summary.blocked} still ${summary.blocked === 1 ? 'needs' : 'need'} attention below.` : ''}`
          : result.batchRefused
            ? // The records are fine — the server refused the upload itself. Saying "captures
              // could not upload" here would blame the wrong thing and invite a discard.
              `The server refused the upload itself (HTTP ${result.status}), not your captures. Nothing was lost — try again shortly.`
            : summary.blocked > 0 && summary.waiting === 0
              ? 'Nothing uploaded — every remaining capture is one the server has refused. See below.'
              : result.skipReason === 'offline'
                ? 'No network. Everything is still saved on this device.'
                : result.skipReason === 'busy'
                  ? 'A sync is already running.'
                  : result.skipReason === 'no-owner'
                    ? 'These captures were made on another account. Sign back in as that account to upload them.'
                    : summary.total === 0
                      ? 'Everything is uploaded.'
                      : 'Could not reach the server. Everything is still saved on this device.'
    );
  }

  async function discard(item: BlockedCapture) {
    if (item.kind === 'folder') await discardFolder(item.clientId);
    else await discardContact(item.clientId);
    await refreshQueue();
    setSyncNote(`Discarded “${item.label}”.`);
  }

  /** Clear the blocked mark and try again — the condition may have passed. */
  async function retry(item: BlockedCapture) {
    await retryCapture(item.kind, item.clientId);
    await syncNow();
  }

  /**
   * Point a stuck capture at a folder that exists.
   *
   * This is what turns `folder-not-found` — the realistic refusal, where the folder was deleted
   * after the scan — from "your only button destroys a real person's details" into a recoverable
   * state.
   */
  async function moveTo(item: BlockedCapture, folderId: string) {
    await moveQueuedContact(item.clientId, folderId);
    await syncNow();
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

        {/*
          TWO BANNERS, NOT ONE COUNT.
          The single "N captures not synced yet … will upload on their own" was accurate for a
          record waiting for signal and a lie for a record the server had refused, and the user
          had no way to tell which they were looking at. The number would simply never fall.
        */}
        {pending.waiting > 0 && (
          <div className="mb-4">
            <Banner tone={pending.authExpired ? 'error' : 'warn'}>
              <span className="flex flex-wrap items-center justify-between gap-2">
                {/*
                  THE AUTH VARIANT IS NOT COSMETIC. A session that lapses mid-event leaves records
                  that are perfectly good and cannot upload until somebody signs in — and the
                  banner used to keep saying "they will upload on their own", which was false and
                  named no remedy.
                */}
                {pending.authExpired ? (
                  <span>
                    <strong className="tnum">{pending.waiting}</strong> capture
                    {pending.waiting === 1 ? '' : 's'} cannot upload because your session expired.
                    They are safe on this device.{' '}
                    <Link href="/login" className="font-bold underline">
                      Sign in again
                    </Link>{' '}
                    and they will go on their own.
                  </span>
                ) : (
                  <span>
                    <strong className="tnum">{pending.waiting}</strong>{' '}
                    {/* Named by kind: calling a folder a "capture" is how an offline folder
                        became invisible. */}
                    {pending.waitingFolders === pending.waiting
                      ? `folder${pending.waiting === 1 ? '' : 's'}`
                      : `capture${pending.waiting === 1 ? '' : 's'}`}{' '}
                    not synced yet. They are saved on this device and will upload on their own.
                  </span>
                )}
                <button type="button" onClick={syncNow} disabled={syncing} className={SMALL_QUIET}>
                  {syncing ? 'Syncing…' : 'Sync now'}
                </button>
              </span>
            </Banner>
          </div>
        )}

        {pending.otherAccount > 0 && (
          <div className="mb-4">
            {/*
              Counted but never shown in detail, and never uploaded. Before the owner stamp these
              records were posted as whoever was signed in now, refused, and then LISTED BY NAME
              to the wrong person — so this banner deliberately says nothing about who they are.
            */}
            <Banner tone="info">
              <strong className="tnum">{pending.otherAccount}</strong> unsynced capture
              {pending.otherAccount === 1 ? '' : 's'} on this device{' '}
              {pending.otherAccount === 1 ? 'was' : 'were'} made on a different account. Sign in as
              that account to upload {pending.otherAccount === 1 ? 'it' : 'them'}.
            </Banner>
          </div>
        )}

        {stuck.length > 0 && (
          <div className="mb-4">
            <Banner tone="error">
              <span className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  <strong className="tnum">{stuck.length}</strong> capture
                  {stuck.length === 1 ? '' : 's'} cannot upload.{' '}
                  {stuck.length === 1 ? 'It is' : 'They are'} still saved on this device — nothing
                  has been lost — but the server has refused{' '}
                  {stuck.length === 1 ? 'it' : 'them'}, so{' '}
                  {stuck.length === 1 ? 'it will' : 'they will'} not go on{' '}
                  {stuck.length === 1 ? 'its' : 'their'} own.
                </span>
                {pending.waiting === 0 && (
                  <button type="button" onClick={syncNow} disabled={syncing} className={SMALL_QUIET}>
                    {syncing ? 'Retrying…' : 'Try again'}
                  </button>
                )}
              </span>
            </Banner>

            <div className="mt-2 flex flex-col gap-2">
              {stuck.map(item => (
                <Card key={`${item.kind}:${item.clientId}`} padding="tight">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-[13.5px] font-semibold text-[#1D1D1F]">
                        {item.label}
                        {item.kind === 'folder' && (
                          <span className="ml-2 rounded-full bg-[#F5F5F7] px-2 py-0.5 text-[10.5px] font-bold uppercase tracking-[0.05em] text-[#6E6E73]">
                            folder
                          </span>
                        )}
                      </p>
                      <p className="mt-0.5 text-[12.5px] leading-relaxed text-[#6E6E73]">
                        {item.reason}
                      </p>
                    </div>

                    {/*
                      THREE ACTIONS, NOT ONE. Discard was the only button here, and the most
                      likely refusal is `folder-not-found` — the folder was deleted after the
                      scan — so the single affordance on offer destroyed a real person's details.
                      Retry covers a condition that has since passed; Move covers the folder case
                      directly, rewriting the queued record locally (there is nothing on the
                      server to PATCH).
                    */}
                    {/* `gap-2` (8px) clears the 6px each way a 44px overlay overhangs a 32px
                        button, so a wrapped row cannot steal the row above's taps. */}
                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                      {item.kind === 'contact' && folders.length > 0 && (
                        /*
                          THE ONE CONTROL THAT CANNOT TAKE THE OVERLAY. A `<select>` is a replaced
                          element, so `select::after` does not render in Chrome or Safari and the
                          `TAP_44` trick is silently a no-op on it. So the PILL is a 32px wrapper and
                          the select itself is 44px and transparent on top of it: the painted control
                          is unchanged, the hit area is a full 44px, and the 6px it overflows each way
                          costs nothing because the wrapper still sets the layout height.
                        */
                        <span className="inline-flex h-8 items-center rounded-full bg-[#F7F7F9]">
                          <select
                            aria-label={`Move ${item.label} to another folder`}
                            defaultValue=""
                            onChange={e => {
                              if (e.target.value) void moveTo(item, e.target.value);
                            }}
                            className="h-11 rounded-full bg-transparent px-3 text-[12px] font-semibold text-[#1D1D1F] outline-none focus:shadow-[inset_0_0_0_2px_var(--blue)] [touch-action:manipulation]"
                          >
                            <option value="">Move to…</option>
                            {folders.map(f => (
                              <option key={f._id} value={f._id}>
                                {f.name}
                              </option>
                            ))}
                          </select>
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() => void retry(item)}
                        disabled={syncing}
                        aria-label={`Retry ${item.label}`}
                        className={SMALL_QUIET}
                      >
                        Retry
                      </button>
                      <button
                        type="button"
                        onClick={() => void discard(item)}
                        aria-label={`Discard ${item.label}`}
                        className={SMALL_QUIET}
                      >
                        Discard
                      </button>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          </div>
        )}

        {syncNote && (
          <div className="mb-4">
            <Banner tone="info">{syncNote}</Banner>
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
        ) : folders.length === 0 && queuedFolders.length === 0 ? (
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
            {/*
              Device-only folders FIRST and as real cards. They used to render nowhere — the grid
              shows server folders only — so a folder made offline existed solely as +1 on a count
              that called it a "capture". Not links: there is no server id to open yet.
            */}
            {queuedFolders.map(folder => (
              <Card key={`local:${folder.clientId}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="t-sub truncate text-[#1D1D1F]">{folder.name}</h2>
                    <p className="mt-1 text-[12.5px] text-[#6E6E73]">
                      {folder.eventDate ? dayHeading(folder.eventDate) : 'No date'}
                      {folder.venue ? ` · ${folder.venue}` : ''}
                    </p>
                  </div>
                  <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[#F5F5F7] px-2 py-0.5 text-[10.5px] font-bold text-[#6E6E73]">
                    <span aria-hidden="true" className="material-symbols-outlined text-[12px]">
                      cloud_off
                    </span>
                    local
                  </span>
                </div>
                <p className="mt-3 text-[12px] text-[#8E8E93]">
                  On this device only. It will upload on its own, and you can open it then.
                </p>
              </Card>
            ))}
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

    /**
     * `saveFolder()` rather than a local fetch, for the reasons in `lib/scan/failure.ts`.
     *
     * This function used to carry the pre-fix shape verbatim — `if (!res.ok) throw` and queue in
     * the `catch` — with two consequences. A 400 or 403 was filed as "the network ate it" under a
     * banner promising an upload, and a captive-portal 200 with an HTML body passed `!res.ok`,
     * called `onCreated()`, and closed the sheet on a folder that was created NOWHERE: not on the
     * server and not in the queue.
     */
    try {
      const result = await saveFolder({
        clientId: newClientId(),
        name: name.trim(),
        eventDate: isoDate,
        venue: venue.trim() || undefined,
      });

      if (result.outcome === 'name-taken' || result.outcome === 'blocked' || result.outcome === 'lost' || result.outcome === 'auth') {
        // Keep the sheet open with the reason on it, and the typed name still in the field.
        setError(result.reason ?? 'That folder could not be created.');
        return;
      }
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

    </Sheet>
  );
}
