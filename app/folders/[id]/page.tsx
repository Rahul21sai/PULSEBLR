'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { use, useCallback, useEffect, useMemo, useState } from 'react';
import AppShell from '../../components/AppShell';
import Sheet from '../../components/Sheet';
import QrCode from '../../components/QrCode';
import ContactFields, {
  TAP_44,
  TAP_44_SQUARE,
  canonicaliseTagInput,
  canonicaliseTagList,
  useTagVocabulary,
  type ContactDraft,
} from '../../components/scan/ContactFields';
import FolderSettingsSheet from './FolderSettingsSheet';
import { Banner, Button, ButtonLink } from '../../components/ui';
import { dayHeading, fullDateIST, relativeTime, timeIST } from '@/lib/format';
import {
  moveQueuedContact,
  newClientId,
  pendingContacts,
  startAutoDrain,
  subscribe,
  updateQueuedContact,
} from '@/lib/scan/outbox';
import { dayOffsetIST, followUpInstantForDay, todayDayIST } from '@/lib/scan/follow-up';
import type { ContactDTO, FolderDTO } from '@/lib/contacts/types';

/**
 * One folder, as a table — "the sheet".
 *
 * A real `<table>` on a wide screen because that is what the data is, and stacked cards on a
 * phone because a 16-column table on 390px is unreadable. Same rows, same order, one source.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * SELECTION IS AN EXPLICIT MODE, following `app/people/page.tsx` rather than inventing a second
 * idiom — two selection patterns drifting is exactly what makes two pages stop feeling like one app.
 * "Select" flips the rows from "open the editor" to "pick me", reveals the bulk bar, withdraws the
 * competing tap targets, and Escape or Cancel leaves. No `pointer-events` juggling.
 *
 * THIS TABLE HAS ONE PROBLEM `/people` DOES NOT: HALF ITS ROWS MAY HAVE NO SERVER DOCUMENT. A queued
 * capture's row id is `pending:<clientId>`, which cannot be PATCHed — the old edit path hit
 * `/api/contacts/pending:<clientId>`, got nothing, and rolled back against an array that never held
 * the row: a silent no-op behind "Could not save that change". So a bulk action here writes to BOTH
 * stores — `/api/contacts/bulk` for the synced rows, `updateQueuedContact` / `moveQueuedContact` for
 * the queued ones — and the bar says how many of each it is about to touch. Excluding them would
 * have been allowed; skipping them silently is the failure this whole feature keeps almost making.
 *
 * THE SELECTION IS RESOLVED AGAINST `rows`, NOT COUNTED FROM THE `Set`. This page runs the
 * auto-drain, so a queued row can sync mid-selection and its id changes from `pending:<clientId>` to
 * a real ObjectId underneath the user. Reading `selected.size` would then report a person who is no
 * longer addressable by the id that was stored.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 */
export default function FolderPage({ params }: { params: Promise<{ id: string }> }) {
  // A client component cannot be `async`, so params is unwrapped with React's `use()` —
  // the same approach app/events/[id]/page.tsx takes.
  const { id } = use(params);
  const router = useRouter();

  const [folder, setFolder] = useState<FolderDTO | null>(null);
  const [contacts, setContacts] = useState<ContactDTO[]>([]);
  const [pendingRows, setPendingRows] = useState<ContactDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<ContactDTO | null>(null);
  const [addingManually, setAddingManually] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  // The other folders, for the move picker in the edit sheet and in the bulk bar.
  const [otherFolders, setOtherFolders] = useState<FolderDTO[]>([]);

  /**
   * SELECTION MODE. Off by default: the common intent here is to correct one person, and a table whose
   * rows are permanently checkboxes makes that the awkward case. Holds ROW ids, which for a queued
   * capture is `pending:<clientId>` — see the file header.
   */
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkTagText, setBulkTagText] = useState('');
  /** Pre-filled with tomorrow, so the common batch answer is two taps rather than a date entry. */
  const [bulkDay, setBulkDay] = useState(() => dayOffsetIST(1));
  const [working, setWorking] = useState(false);
  const tagVocabulary = useTagVocabulary();

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/folders/${id}`);
      if (res.status === 404) {
        setError('That folder does not exist, or is not yours.');
        setLoading(false);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setFolder(data.folder);
      setContacts(data.contacts ?? []);
      setError(null);
    } catch {
      setError('Could not load this folder. Nothing has been lost — try again.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    const timer = setTimeout(load, 0);
    return () => clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    // One fetch for the page. Archived ones included: moving somebody into a folder you have tidied
    // away is a legitimate thing to want, and excluding them would silently drop options.
    // The param is `archived`, NOT `includeArchived` — the route reads
    // `searchParams.get('archived')`, so the wrong name fails silently by returning fewer folders.
    const timer = setTimeout(() => {
      void fetch('/api/folders?archived=true')
        .then(r => (r.ok ? r.json() : null))
        .then(d => {
          if (d?.folders) setOtherFolders((d.folders as FolderDTO[]).filter(f => f._id !== id));
        })
        .catch(() => {
          /* Offline: the picker simply does not render. */
        });
    }, 0);
    return () => clearTimeout(timer);
  }, [id]);

  /**
   * Merge in anything still sitting in the outbox for this folder, flagged `pending`.
   *
   * Without this a scan made offline would simply not appear, which reads as "the scanner
   * didn't work" — the single worst thing this feature could communicate.
   */
  const refreshPending = useCallback(async () => {
    const queued = await pendingContacts();
    setPendingRows(
      queued
        .filter(record => record.folderId === id)
        .map(record => ({
          _id: `pending:${record.clientId}`,
          folderId: id,
          clientId: record.clientId,
          name: record.name,
          headline: record.headline ?? null,
          role: record.role ?? null,
          company: record.company ?? null,
          linkedin: record.linkedin ?? null,
          linkedinSlug: record.linkedinSlug ?? null,
          x: record.x ?? null,
          github: record.github ?? null,
          website: record.website ?? null,
          email: record.email ?? null,
          phone: record.phone ?? null,
          note: record.note ?? null,
          tags: record.tags ?? [],
          followUpAt: record.followUpAt ?? null,
          followedUp: false,
          capturedVia: record.capturedVia ?? 'manual',
          scannedAt: record.scannedAt ?? new Date(record.queuedAt).toISOString(),
          contactKey: '',
          companies: [],
          isTargetCompany: false,
          createdAt: new Date(record.queuedAt).toISOString(),
          updatedAt: new Date(record.queuedAt).toISOString(),
          pending: true,
          // Carried through so this table distinguishes "waiting for signal" from "the server
          // said no", rather than showing both with the same reassuring chip.
          blocked: record.blocked,
          blockedReason: record.blockedReason,
        }))
    );
  }, [id]);

  useEffect(() => {
    // Deferred by a tick so the effect does not setState synchronously — the same pattern the
    // feed and tracker pages use.
    const timer = setTimeout(() => void refreshPending(), 0);
    const unsubscribe = subscribe(() => {
      void refreshPending();
      void load();
    });
    /**
     * DRAIN HERE TOO. This page displayed the queue without ever moving it: only /folders and
     * /scan wired the auto-drain, and this is the screen you land on after "Save & close" and
     * read between people. Captures sat here under a grey `local` chip indefinitely while signal
     * was available, which reads as a scanner that quietly stopped working.
     */
    const stopAutoDrain = startAutoDrain();
    return () => {
      clearTimeout(timer);
      unsubscribe();
      stopAutoDrain();
    };
  }, [refreshPending, load]);

  // Deduped by clientId: once a queued row syncs, the server copy is authoritative.
  const rows = useMemo(() => {
    const synced = new Set(contacts.map(c => c.clientId));
    return [...pendingRows.filter(p => !synced.has(p.clientId)), ...contacts];
  }, [contacts, pendingRows]);

  const due = useMemo(
    () => rows.filter(c => c.followUpAt && !c.followedUp && new Date(c.followUpAt) <= new Date()),
    [rows]
  );

  /**
   * The selection, resolved against the rows on screen right now — see the file header for why this
   * is not `selected.size`. Split by store, because the two halves are written by different code.
   */
  const chosen = useMemo(() => rows.filter(c => selected.has(c._id)), [rows, selected]);
  const chosenQueued = useMemo(() => chosen.filter(c => c.pending), [chosen]);
  const chosenSynced = useMemo(() => chosen.filter(c => !c.pending), [chosen]);

  /**
   * Escape leaves selection mode.
   *
   * Bound at the document, because the rows do not contain focus. A mode with no keyboard exit is a
   * trap for anybody not using a mouse, and every other dismissible surface here answers Escape.
   */
  useEffect(() => {
    if (!selecting) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      setSelecting(false);
      setSelected(new Set());
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [selecting]);

  function leaveSelection() {
    setSelecting(false);
    setSelected(new Set());
    setBulkTagText('');
  }

  function toggleRow(id: string) {
    setSelected(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function flash(message: string) {
    setNotice(message);
    setTimeout(() => setNotice(null), 6000);
  }

  function complain(message: string) {
    setError(message);
    setTimeout(() => setError(null), 6000);
  }

  /**
   * Apply one change to every selected row, ACROSS BOTH STORES.
   *
   * The server half is a single request — forty PATCHes can fail halfway with no way for the user to
   * tell which half landed, and each would run a full person recompute behind it. The device half is
   * a loop by necessity: IndexedDB has no batch write here, and each queued record is rewritten in
   * place. A failure in the loop is counted, not thrown, because the records that were rewritten
   * really were rewritten.
   *
   * `request` carries the action and its fields; `applyLocally` is the same change expressed against
   * a queued record. Both are passed in so the two halves of one action are written next to each
   * other and cannot drift into meaning different things.
   */
  async function runBulk(
    request: Record<string, unknown>,
    applyLocally: (contact: ContactDTO) => Promise<void>,
    describe: (count: number) => string
  ) {
    if (!chosen.length || working) return;
    setWorking(true);
    setError(null);

    let changed = 0;
    let unchanged = 0;

    try {
      if (chosenSynced.length) {
        const res = await fetch('/api/contacts/bulk', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...request, contactIds: chosenSynced.map(c => c._id) }),
        });
        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!res.ok) {
          // The route names the field it refused; showing that beats a generic apology.
          complain(
            typeof data.error === 'string' ? data.error : `Could not apply that (${res.status}).`
          );
          return;
        }
        changed += Number(data.changed ?? 0);
        // `matched` can legitimately be lower than `requested` — a row deleted in another tab is not
        // in the scoped filter any more. Reporting the gap beats silently changing fewer people.
        unchanged +=
          Number(data.failed ?? 0) +
          Math.max(0, Number(data.requested ?? 0) - Number(data.matched ?? 0));
      }

      for (const contact of chosenQueued) {
        try {
          await applyLocally(contact);
          changed += 1;
        } catch {
          unchanged += 1;
        }
      }

      leaveSelection();
      await Promise.all([load(), refreshPending()]);
      flash(
        describe(changed) +
          (unchanged ? ` ${unchanged} could not be changed.` : '') +
          (chosenQueued.length
            ? ` ${chosenQueued.length} of them ${
                chosenQueued.length === 1 ? 'is' : 'are'
              } still only on this device — that change is saved here and uploads with them.`
            : '')
      );
    } catch {
      complain('Could not reach the server, so nothing on it was changed.');
    } finally {
      setWorking(false);
    }
  }

  function bulkTag(mode: 'add' | 'remove') {
    // Canonicalised through the SAME mirror the tag field uses, so a tag applied in bulk lands in the
    // identical facet bucket — including for a queued row, which never passes through the server.
    const tag = canonicaliseTagInput(bulkTagText);
    if (!tag) return;
    void runBulk(
      { action: 'tag', [mode]: [tag] },
      async contact => {
        const current = contact.tags ?? [];
        await updateQueuedContact(contact.clientId, {
          tags:
            mode === 'add'
              ? canonicaliseTagList([...current, tag])
              : canonicaliseTagList(current.filter(t => t !== tag)),
        });
      },
      count =>
        `${mode === 'add' ? 'Tagged' : 'Untagged'} ${count} ${
          count === 1 ? 'person' : 'people'
        } “${tag}”.`
    );
  }

  function bulkFollowUp(day: string | null) {
    /**
     * The IST conversion is `lib/scan/follow-up.ts`'s, on BOTH sides. The server re-derives it from
     * the day for the synced rows — a client cannot be trusted to have got it right — and this call
     * is what the queued rows get, since nothing else will run for them.
     */
    const instant = day ? followUpInstantForDay(day) : null;
    if (day && !instant) {
      complain('Pick today or a day after it.');
      return;
    }
    void runBulk(
      { action: 'followUp', day },
      async contact =>
        updateQueuedContact(contact.clientId, {
          followUpAt: instant,
          // A new reminder on somebody already ticked off would never surface: the derivation skips
          // any capture marked done. Clearing leaves the flag alone — "I already replied" stays true.
          ...(instant ? { followedUp: false } : {}),
        }),
      count =>
        instant
          ? `Reminder set for ${count} ${count === 1 ? 'person' : 'people'} on ${fullDateIST(
              instant
            )}.`
          : `Cleared the reminder for ${count} ${count === 1 ? 'person' : 'people'}.`
    );
  }

  function bulkMove(folderId: string) {
    const destination = otherFolders.find(f => f._id === folderId);
    void runBulk(
      { action: 'move', folderId },
      async contact => moveQueuedContact(contact.clientId, folderId),
      count =>
        `Moved ${count} ${count === 1 ? 'person' : 'people'} to ${
          destination?.name ?? 'another folder'
        }.`
    );
  }

  async function saveContact(contact: ContactDTO, draft: ContactDraft) {
    /**
     * A PENDING capture is edited in IndexedDB, not through the API.
     *
     * It has no server document — its row id here is `pending:<clientId>` — so the PATCH below would
     * hit `/api/contacts/pending:<clientId>`, which cannot resolve, and the rollback would then
     * `setContacts(previous)` on an array that never held the row. The edit was a silent no-op behind
     * "Could not save that change", which is why the sheet used to refuse pending rows outright and a
     * name mistyped offline stayed wrong until it synced.
     */
    if (contact.pending) {
      await updateQueuedContact(contact.clientId, draft);
      setEditing(null);
      // `subscribe` fires from the outbox write, so the pending rows refresh themselves.
      setNotice(`Updated ${draft.name || contact.name} on this device.`);
      setTimeout(() => setNotice(null), 4000);
      return;
    }

    // Optimistic, matching the tracker's house pattern: apply locally, roll back only on a
    // hard rejection. A network failure is not a rejection — it means "not yet".
    const previous = contacts;
    setContacts(current =>
      current.map(c => (c._id === contact._id ? { ...c, ...draft, tags: draft.tags ?? c.tags } : c))
    );
    setEditing(null);

    try {
      const res = await fetch(`/api/contacts/${contact._id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await load();
    } catch {
      setContacts(previous);
      setError('Could not save that change. Your edit was undone, nothing else.');
      setTimeout(() => setError(null), 4000);
    }
  }

  /**
   * Move a SYNCED contact to another folder.
   *
   * `PATCH /api/contacts/[id]` has always validated that the destination folder is yours — this was
   * the last thing on the scan feature's "does not do yet" list that was pure UI. Only a queued
   * capture could be moved before, and only from the stuck-captures list, because
   * `folder-not-found` recovery needed it.
   *
   * NOT optimistic, unlike the other writes here. The row leaves this folder entirely on success, so
   * an optimistic remove followed by a rollback would make it flicker out and back in; and the
   * contact is somebody's real details, so "it moved" should mean the server said so.
   */
  async function moveContact(contact: ContactDTO, folderId: string) {
    try {
      const res = await fetch(`/api/contacts/${contact._id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderId }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setEditing(null);
      await load();
      setNotice(`Moved ${contact.name} to another folder.`);
      setTimeout(() => setNotice(null), 4000);
    } catch {
      setError('Could not move that person.');
      setTimeout(() => setError(null), 4000);
    }
  }

  async function deleteContact(contact: ContactDTO) {
    const previous = contacts;
    setContacts(current => current.filter(c => c._id !== contact._id));
    setEditing(null);
    try {
      const res = await fetch(`/api/contacts/${contact._id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch {
      setContacts(previous);
      setError('Could not delete that person.');
      setTimeout(() => setError(null), 4000);
    }
  }

  async function markFollowedUp(contact: ContactDTO) {
    setContacts(current =>
      current.map(c => (c._id === contact._id ? { ...c, followedUp: true } : c))
    );
    try {
      await fetch(`/api/contacts/${contact._id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ followedUp: true }),
      });
    } catch {
      await load();
    }
  }

  function copyLinkedIns() {
    const urls = rows.map(c => c.linkedin).filter(Boolean).join('\n');
    if (!urls) {
      setNotice('Nobody in this folder has a LinkedIn URL yet.');
      setTimeout(() => setNotice(null), 3000);
      return;
    }
    void navigator.clipboard
      ?.writeText(urls)
      .then(() => {
        setNotice(`Copied ${rows.filter(c => c.linkedin).length} LinkedIn URLs.`);
        setTimeout(() => setNotice(null), 3000);
      })
      .catch(() => setNotice('Could not copy — your browser blocked clipboard access.'));
  }

  if (error && !folder) {
    return (
      <AppShell title="People">
        <div className="mx-auto max-w-[900px] px-4 pt-6 md:px-8">
          <div className="rule-y py-[var(--s-8)]">
            <h1 className="ty-section text-[var(--ink)]">Folder not found</h1>
            <p className="mt-[var(--s-3)] ty-body max-w-[52ch] text-[color:var(--ink-2)]">{error}</p>
            <div className="mt-[var(--s-4)]">
              <ButtonLink href="/folders">Back to folders</ButtonLink>
            </div>
          </div>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell title="People">
      <div className="mx-auto max-w-[1240px] px-4 pt-4 md:px-8">
        <Link
          href="/folders"
          className="pressable mb-[var(--s-3)] inline-flex h-11 items-center gap-1 ty-meta font-semibold transition-colors hover:text-[var(--ink)]"
        >
          <span aria-hidden="true" className="material-symbols-outlined text-[16px]">arrow_back</span>
          All folders
        </Link>

        {/*
          THE FOLDER'S NAME IS SERIF AT `.ty-h1`, because it is an event that happened in the city —
          the same face and step the event page gives an event title. The date above it and the count
          below it are the app talking, so both are `.ty-meta` sans. `PageHeader` could not express
          that (it sets one face for every page) and its `eyebrow` slot printed the date in the
          tracked-out small label this system removed.

          No `shrink-0` on the action group: five controls at 390 measure well past the content box,
          and pinning their width is what puts a page into a sideways scroll.
        */}
        <div className="mb-[var(--s-8)] flex flex-wrap items-start justify-between gap-[var(--s-4)]">
          <div className="min-w-0 basis-full md:max-w-[62ch] md:basis-auto">
            {folder?.eventDate && <p className="ty-meta mb-[var(--s-1)]">{dayHeading(folder.eventDate)}</p>}
            <h1 className="ty-h1 text-[var(--ink)]">{folder?.name ?? (loading ? 'Loading…' : 'Folder')}</h1>
            {folder && (
              <p className="ty-meta mt-[var(--s-2)]">
                {rows.length} {rows.length === 1 ? 'person' : 'people'}
                {folder.venue ? ` · ${folder.venue}` : ''}
              </p>
            )}
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              {/*
                THE MODE SWITCH, offered only when there is something to select — a Select button over
                an empty folder is a control that cannot do anything, and the empty state already says
                what to do instead.

                A raw button rather than `<Button>` for one reason: `ui.tsx` hardcodes its own
                `className` and spreads `...rest` after it, so a passed class REPLACES the styling
                rather than adding to it — there is no way to attach the 44px overlay from outside.
                The painted size and tones match its neighbours exactly.
              */}
              {rows.length > 0 && (
                <button
                  type="button"
                  aria-pressed={selecting}
                  onClick={() => (selecting ? leaveSelection() : setSelecting(true))}
                  className={`${TAP_44} inline-flex h-10 items-center justify-center gap-1.5 r-touch bg-[var(--surface)] px-5 text-[13.5px] font-semibold tracking-[-0.006em] text-[var(--ink)] shadow-[inset_0_0_0_1px_var(--rule)] pressable hover:bg-[var(--paper)]`}
                >
                  <span aria-hidden="true" className="material-symbols-outlined text-[17px]">
                    {selecting ? 'close' : 'checklist'}
                  </span>
                  {selecting ? 'Done selecting' : 'Select'}
                </button>
              )}
              <ButtonLink href={`/scan?folder=${id}`} tone="primary" icon="qr_code_scanner">
                Scan
              </ButtonLink>
              <Button tone="quiet" icon="person_add" onClick={() => setAddingManually(true)}>
                Add by hand
              </Button>
              {/* Rename, re-date, archive, delete. The API handled all four from the start and
                  nothing called it, so a folder created with a typo — or auto-created from a tracker
                  confirmation with an unwieldy event title — was permanent. */}
              <Button
                tone="quiet"
                icon="settings"
                onClick={() => setShowSettings(true)}
                aria-label="Folder settings"
              >
                Settings
              </Button>
            </div>
          </div>
        </div>

        {notice && (
          <div className="mb-4">
            <Banner tone="ok">{notice}</Banner>
          </div>
        )}
        {error && (
          <div className="mb-4">
            <Banner tone="error">{error}</Banner>
          </div>
        )}

        {/* Withdrawn while selecting: its Message and Done buttons are competing targets, and this
            mode has one meaning per tap. */}
        {due.length > 0 && !selecting && (
          /* A LEFT RULE IN `--accent`, which is `Banner`'s own tone treatment: the follow-up strip is
             this feature's reason to exist, so it leads — but `--live` is rationed for things that
             expire imminently, and a permanent fixture wearing the loudest colour is how an accent
             stops meaning anything. That trade is already recorded for the tracker's strip. */
          <div className="mb-[var(--s-6)] border-l-2 border-[var(--accent)] bg-[var(--paper)] px-[var(--s-4)] py-[var(--s-3)]">
              <div className="mb-2 flex items-center justify-between">
                <h2 className="t-label text-[color:var(--ink)]">
                  {due.length} follow-up{due.length === 1 ? '' : 's'} due
                </h2>
              </div>
              <div className="flex flex-col">
                {due.map(contact => (
                  <div
                    key={contact._id}
                    className="rule-b flex items-center justify-between gap-3 py-[var(--s-2)] last:border-0"
                  >
                    <div className="min-w-0">
                      {/* SERIF: a person's name. */}
                      <p className="ty-row-title truncate text-[var(--ink)]">{contact.name}</p>
                      <p className="ty-meta">due {relativeTime(contact.followUpAt!)}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {contact.linkedin && (
                        <ButtonLink
                          href={contact.linkedin}
                          external
                          size="sm"
                          tone="secondary"
                          icon="open_in_new"
                        >
                          Message
                        </ButtonLink>
                      )}
                      <Button size="sm" tone="quiet" onClick={() => markFollowedUp(contact)}>
                        Done
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
          </div>
        )}

        {/* ── Bulk bar — only in selection mode, and only with a selection ─ */}
        {selecting && chosen.length > 0 && (
          /* Sticky under the mobile header (`--topbar-h`), so it stays reachable while scrolling
             forty rows. Not `.sticky-bar`: that shadow is thrown upward for a BOTTOM bar. */
          <div className="sticky top-[var(--topbar-h)] z-20 mb-[var(--s-4)] rule-b bg-[var(--surface)]">
            <BulkBar
              total={chosen.length}
              queued={chosenQueued.length}
              working={working}
              tagText={bulkTagText}
              onTagText={setBulkTagText}
              onTag={bulkTag}
              tagVocabulary={tagVocabulary}
              day={bulkDay}
              onDay={setBulkDay}
              onFollowUp={bulkFollowUp}
              folders={otherFolders}
              onMove={bulkMove}
              onCancel={leaveSelection}
            />
          </div>
        )}

        {/* ── Export row ─────────────────────────────────────────────────── */}
        {rows.length > 0 && !selecting && (
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <ButtonLink
              href={`/api/folders/${id}/export?format=csv`}
              size="sm"
              tone="quiet"
              icon="table_view"
            >
              Export CSV
            </ButtonLink>
            <ButtonLink
              href={`/api/folders/${id}/export?format=vcf`}
              size="sm"
              tone="quiet"
              icon="contact_page"
            >
              Export contacts
            </ButtonLink>
            <Button size="sm" tone="quiet" icon="content_copy" onClick={copyLinkedIns}>
              Copy LinkedIn URLs
            </Button>
            <Button size="sm" tone="quiet" icon="qr_code_2" onClick={() => setShowQr(true)}>
              Sign-up QR
            </Button>
          </div>
        )}

        {loading ? (
          <div className="rule-t pt-[var(--s-4)]">
            <div className="h-5 w-1/3 bg-[var(--paper)]" />
            <div className="mt-3 h-3 w-1/2 bg-[var(--paper)]" />
          </div>
        ) : rows.length === 0 ? (
          <div className="rule-y py-[var(--s-8)]">
            <h2 className="ty-section text-[var(--ink)]">Nobody here yet</h2>
            <p className="mt-[var(--s-3)] ty-body max-w-[52ch] text-[color:var(--ink-2)]">
              Point the scanner at somebody&apos;s LinkedIn QR, or add them by hand if they&apos;d
              rather just tell you.
            </p>
            <div className="mt-[var(--s-4)]">
              <ButtonLink href={`/scan?folder=${id}`} tone="primary" icon="qr_code_scanner">
                Open the scanner
              </ButtonLink>
            </div>
          </div>
        ) : (
          <>
            {selecting && (
              <p className="ty-meta mb-2">
                <strong className="tnum text-[var(--ink)]">{chosen.length}</strong> of{' '}
                <span className="tnum">{rows.length}</span> selected — tap a row to pick it, Escape to
                stop.
              </p>
            )}
            <ContactTable
              rows={rows}
              onEdit={setEditing}
              selecting={selecting}
              selected={selected}
              onToggle={toggleRow}
            />
            <ContactCards
              rows={rows}
              onEdit={setEditing}
              selecting={selecting}
              selected={selected}
              onToggle={toggleRow}
            />
          </>
        )}

        <div className="h-8" />
      </div>

      {editing && (
        <EditContactSheet
          contact={editing}
          onClose={() => setEditing(null)}
          onSave={draft => saveContact(editing, draft)}
          onDelete={() => deleteContact(editing)}
          otherFolders={otherFolders}
          onMove={folderId => moveContact(editing, folderId)}
          tagVocabulary={tagVocabulary}
        />
      )}

      {addingManually && folder && (
        <ManualAddSheet
          folderId={id}
          tagVocabulary={tagVocabulary}
          onClose={() => setAddingManually(false)}
          onAdded={async () => {
            setAddingManually(false);
            await load();
          }}
        />
      )}

      {showSettings && folder && (
        <FolderSettingsSheet
          folder={folder}
          contactCount={contacts.length}
          onClose={() => setShowSettings(false)}
          onSaved={async () => {
            setShowSettings(false);
            await load();
          }}
          onDeleted={() => {
            // Back to the folder list: this folder no longer exists, so staying here would render a
            // 404 for something the user just deliberately removed.
            //
            // `router.replace`, not `push` — the deleted folder must not be a back-button
            // destination, since returning to it can only show that 404. And not
            // `window.location.href`, which throws away the client router and reloads the app.
            router.replace('/folders');
          }}
        />
      )}

      {showQr && folder && (
        <FolderQrSheet folder={folder} onClose={() => setShowQr(false)} onChanged={load} />
      )}
    </AppShell>
  );
}

/* ────────────────────────────── table (desktop) ────────────────────────────── */

function ContactTable({
  rows,
  onEdit,
  selecting,
  selected,
  onToggle,
}: {
  rows: ContactDTO[];
  onEdit: (contact: ContactDTO) => void;
  selecting: boolean;
  selected: Set<string>;
  onToggle: (id: string) => void;
}) {
  /**
   * The Links and Edit columns are DROPPED while selecting, header and all, rather than left in place
   * and ignored. They are the competing tap targets — a stray tap on a LinkedIn icon during a
   * forty-row selection navigates the browser away and loses the whole selection — and hiding the
   * cells while keeping the headers would advertise columns with nothing in them.
   */
  const headers = selecting
    ? ['', 'Name', 'Company', 'How you met', 'Scanned']
    : ['Name', 'Company', 'How you met', 'Links', 'Scanned', ''];

  return (
    /* Flat and ruled: `card-shadow` resolves to `--lift-1: none`, so the rounded surface was a
       radius around nothing. The header row's hairline is what separates it now. */
    <div className="hidden overflow-hidden rule-t md:block">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="rule-b">
              {headers.map((header, i) => (
                <th key={`${header}:${i}`} className="t-label px-4 py-3 text-[color:var(--ink-2)]">
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(contact => {
              const isSelected = selected.has(contact._id);
              return (
                <tr
                  key={contact._id}
                  className={`rule-b last:border-0 ${
                    isSelected ? 'bg-[var(--paper)]' : 'hover:bg-[var(--paper)]'
                  }`}
                >
                  {selecting && (
                    <td className="w-11 px-4 py-3 align-top">
                      {/*
                        `aria-pressed` on a checkbox-shaped button, not a hidden `<input>` — the same
                        choice `/people` makes, and for the same reason: a real checkbox would be a
                        second focus stop saying what this one already says. 20px painted, 44px hit
                        area; a table cell has nothing adjacent for the overlay to steal.
                      */}
                      <button
                        type="button"
                        aria-pressed={isSelected}
                        aria-label={`Select ${contact.name}`}
                        onClick={() => onToggle(contact._id)}
                        className={`${TAP_44_SQUARE} grid h-5 w-5 place-items-center r-touch ${
                          isSelected
                            ? 'bg-[var(--accent)] text-[var(--accent-ink)]'
                            : 'bg-[var(--surface)] shadow-[inset_0_0_0_1px_var(--rule)]'
                        }`}
                      >
                        {isSelected && (
                          <span
                            aria-hidden="true"
                            className="material-symbols-outlined text-[15px] leading-none"
                          >
                            check
                          </span>
                        )}
                      </button>
                    </td>
                  )}
                  <td className="px-4 py-3 align-top">
                    <div className="flex items-start gap-2">
                      <div className="min-w-0">
                        {/* SERIF: a person's name, the same face `/people` gives it. */}
                        <p className="ty-row-title text-[var(--ink)]">{contact.name}</p>
                        {(contact.role || contact.headline) && (
                          <p className="text-[12px] text-[var(--ink-2)]">
                            {contact.role || contact.headline}
                          </p>
                        )}
                      </div>
                      {contact.pending && (
                        <PendingDot blocked={contact.blocked} reason={contact.blockedReason} />
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 align-top">
                    <span className="text-[13px] text-[var(--ink)]">{contact.company || '—'}</span>
                    {contact.isTargetCompany && <TargetBadge />}
                  </td>
                  <td className="max-w-[280px] px-4 py-3 align-top">
                    <p className="line-clamp-2 text-[12.5px] leading-relaxed text-[var(--ink-2)]">
                      {contact.note || '—'}
                    </p>
                  </td>
                  {!selecting && (
                    <td className="px-4 py-3 align-top">
                      <ContactLinks contact={contact} />
                    </td>
                  )}
                  <td className="whitespace-nowrap px-4 py-3 align-top text-[12px] text-[var(--ink-2)]">
                    {/* IST, via lib/format.ts. */}
                    {timeIST(contact.scannedAt)}
                  </td>
                  {!selecting && (
                    <td className="px-4 py-3 align-top text-right">
                      <button
                        type="button"
                        onClick={() => onEdit(contact)}
                        className={`${TAP_44} r-touch px-3 py-1.5 text-[12.5px] font-semibold text-[var(--accent)] hover:bg-[var(--paper)]`}
                      >
                        Edit
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ────────────────────────────── cards (mobile) ────────────────────────────── */

function ContactCards({
  rows,
  onEdit,
  selecting,
  selected,
  onToggle,
}: {
  rows: ContactDTO[];
  onEdit: (contact: ContactDTO) => void;
  selecting: boolean;
  selected: Set<string>;
  onToggle: (id: string) => void;
}) {
  return (
    <div className="rule-t md:hidden">
      {rows.map(contact => {
        const isSelected = selected.has(contact._id);

        // Extracted so both wrappers render the IDENTICAL summary. Two copies drift, and the one that
        // drifts is always the mode you look at less often.
        const summary = (
          <>
            <p className="ty-row-title flex items-center gap-2 text-[var(--ink)]">
              <span className="truncate">{contact.name}</span>
              {contact.pending && (
                <PendingDot blocked={contact.blocked} reason={contact.blockedReason} />
              )}
            </p>
            <p className="ty-meta mt-[var(--s-1)]">
              {[contact.role || contact.headline, contact.company].filter(Boolean).join(' · ') ||
                'No details yet'}
            </p>
            {contact.isTargetCompany && <TargetBadge />}
          </>
        );

        return (
          <div
            key={contact._id}
            className={`rule-b py-[var(--s-4)] ${
              isSelected ? 'border-l-2 border-[var(--accent)] pl-[var(--s-3)]' : 'border-l-2 border-transparent pl-[var(--s-3)]'
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              {selecting ? (
                /*
                  THE WHOLE SUMMARY IS THE TARGET on a phone — a 20px checkbox is not something you
                  hit forty times in a row while standing up. The card is already well past 44px tall,
                  so no overlay is needed here.
                */
                <button
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() => onToggle(contact._id)}
                  className="flex min-w-0 flex-1 items-start gap-3 r-touch text-left outline-none [touch-action:manipulation] focus-visible:shadow-[0_0_0_2px_var(--accent)]"
                >
                  <span
                    aria-hidden="true"
                    className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center r-touch ${
                      isSelected
                        ? 'bg-[var(--accent)] text-[var(--accent-ink)]'
                        : 'bg-[var(--surface)] shadow-[inset_0_0_0_1px_var(--rule)]'
                    }`}
                  >
                    {isSelected && (
                      <span className="material-symbols-outlined text-[15px] leading-none">
                        check
                      </span>
                    )}
                  </span>
                  <span className="min-w-0 flex-1">{summary}</span>
                </button>
              ) : (
                <>
                  <div className="min-w-0">{summary}</div>
                  <button
                    type="button"
                    onClick={() => onEdit(contact)}
                    aria-label={`Edit ${contact.name}`}
                    className={`${TAP_44_SQUARE} grid h-8 w-8 shrink-0 place-items-center r-touch bg-[var(--paper)] text-[var(--ink-2)]`}
                  >
                    <span aria-hidden="true" className="material-symbols-outlined text-[18px]">
                      edit
                    </span>
                  </button>
                </>
              )}
            </div>

            {contact.note && (
              <p className="mt-[var(--s-2)] border-l-2 border-[color:var(--rule)] pl-2.5 text-[13px] leading-[1.5] text-[color:var(--ink-2)]">
                {contact.note}
              </p>
            )}

            <div className="mt-3 flex items-center justify-between gap-2">
              {/* Links withdrawn while selecting, for the reason the table drops the column. */}
              {selecting ? <span /> : <ContactLinks contact={contact} />}
              <span className="ty-meta">{timeIST(contact.scannedAt)}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ContactLinks({ contact }: { contact: ContactDTO }) {
  const links: Array<{ href: string; icon: string; label: string }> = [];
  if (contact.linkedin) {
    links.push({ href: contact.linkedin, icon: 'person', label: 'LinkedIn' });
  }
  if (contact.phone) links.push({ href: `tel:${contact.phone}`, icon: 'call', label: 'Call' });
  if (contact.email) links.push({ href: `mailto:${contact.email}`, icon: 'mail', label: 'Email' });
  if (contact.x) links.push({ href: `https://x.com/${contact.x}`, icon: 'alternate_email', label: 'X' });
  if (contact.github) {
    links.push({ href: `https://github.com/${contact.github}`, icon: 'code', label: 'GitHub' });
  }

  if (!links.length) return <span className="text-[12.5px] text-[var(--ink-2)]">—</span>;

  return (
    /*
      `gap-3` (12px), not `gap-1.5`, and this one was caught by measuring rather than by reasoning.
      A 44px overlay on a 32px icon overhangs 6px on EACH side, so at a 6px gap two neighbours' overlays
      meet in the same 6px band and the later one in the DOM wins it. Hit-tested: the FIRST of two
      adjacent icons got 38×44 while the second got the full 44×44 — the earlier icon silently gave up
      its right-hand 6px. Two overhangs need `2 × 6 = 12px` between them, not 6. The painted 32px circles
      and their spacing-to-size relationship are otherwise unchanged.
    */
    <span className="flex items-center gap-3">
      {links.map(link => (
        <a
          key={link.label}
          href={link.href}
          target={link.href.startsWith('http') ? '_blank' : undefined}
          rel="noopener noreferrer"
          aria-label={link.label}
          title={link.label}
          className={`${TAP_44_SQUARE} grid h-8 w-8 place-items-center r-touch bg-[var(--paper)] text-[var(--ink-2)] hover:text-[var(--accent)]`}
        >
          <span aria-hidden="true" className="material-symbols-outlined text-[17px]">{link.icon}</span>
        </a>
      ))}
    </span>
  );
}

/** Not synced yet. Greyscale, because `--live` means exactly one thing in this app. */
/**
 * The "not on the server yet" chip.
 *
 * Two states, because they mean opposite things to the person reading them: grey `local` is
 * patience (it will go), red `stuck` is a problem (it will not). One chip for both is what let a
 * refused capture sit in a folder looking perfectly healthy.
 */
function PendingDot({ blocked = false, reason }: { blocked?: boolean; reason?: string }) {
  if (blocked) {
    return (
      <span
        title={reason ?? 'The server refused this capture. Open People to fix or discard it.'}
        className="pill pill-live shrink-0"
      >
        <span aria-hidden="true" className="material-symbols-outlined text-[12px]">error</span>
        stuck
      </span>
    );
  }
  return (
    <span
      title="Saved on this device, not uploaded yet"
      className="pill pill-quiet shrink-0"
    >
      <span aria-hidden="true" className="material-symbols-outlined text-[12px]">cloud_off</span>
      local
    </span>
  );
}

function TargetBadge() {
  return (
    <span className="pill pill-quiet mt-1 text-[color:var(--accent)]">
      Target company
    </span>
  );
}

/* ────────────────────────────── bulk bar ────────────────────────────── */

/**
 * What you can do to a selection: tag it, give it a follow-up date, or move it.
 *
 * THREE LABELLED ROWS RATHER THAN A TOOLBAR OF ICONS. Each row is one thought and says what it is
 * about; an icon strip would need a legend and would still be ambiguous about which of the three
 * "apply" buttons belongs to which input.
 *
 * NO BULK DELETE. Deliberate: it is the one irreversible thing here, and the folder-delete sheet is
 * the precedent for how much ceremony that needs. `Delete` in the per-person editor already covers it.
 *
 * The follow-up row offers a DATE rather than the sheet's four presets. The presets exist because at a
 * conference one tap is everything; a bulk edit happens afterwards, sitting down, where the answer is
 * a specific day — and the field is pre-filled with tomorrow so the common case is still two taps.
 */
function BulkBar({
  total,
  queued,
  working,
  tagText,
  onTagText,
  onTag,
  tagVocabulary,
  day,
  onDay,
  onFollowUp,
  folders,
  onMove,
  onCancel,
}: {
  total: number;
  queued: number;
  working: boolean;
  tagText: string;
  onTagText: (value: string) => void;
  onTag: (mode: 'add' | 'remove') => void;
  tagVocabulary: string[];
  day: string;
  onDay: (value: string) => void;
  onFollowUp: (day: string | null) => void;
  folders: FolderDTO[];
  onMove: (folderId: string) => void;
  onCancel: () => void;
}) {
  const ACTION =
    'inline-flex h-11 items-center justify-center r-touch px-4 text-[13px] font-semibold pressable disabled:opacity-45 disabled:pointer-events-none';
  const PRIMARY = `${ACTION} bg-[var(--ink)] text-[var(--accent-ink)]`;
  const QUIET = `${ACTION} bg-[var(--surface)] text-[var(--ink)] shadow-[inset_0_0_0_1px_var(--rule)] hover:bg-[var(--paper)]`;
  const INPUT =
    'h-11 min-w-[150px] flex-1 r-touch bg-[var(--paper)] px-4 text-[13.5px] text-[var(--ink)] shadow-[inset_0_0_0_1px_var(--rule)] outline-none focus:shadow-[inset_0_0_0_2px_var(--accent)]';
  const LABEL = 't-label w-[68px] shrink-0 pt-3 text-[var(--ink-2)]';

  return (
    /* The bulk bar is the one raised element here, and it is raised by its STICKY wrapper's
       hairline rather than by a shadow — see the wrapper for why `.sticky-bar` is wrong at the top
       of a page. */
    <div className="bg-[var(--surface)] px-[var(--s-4)] py-[var(--s-3)]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] font-semibold text-[var(--ink)]">
          <span className="tnum">{total}</span> selected
          {queued > 0 && (
            /*
              SAID OUT LOUD, because it changes where the write goes. A queued capture has no server
              document, so its change is written to this device and travels with the upload. Silently
              skipping these is the documented failure mode of this whole area.
            */
            <span className="ml-2 font-normal text-[var(--ink-2)]">
              · <span className="tnum">{queued}</span> only on this device
            </span>
          )}
        </p>
        <button type="button" onClick={onCancel} disabled={working} className={QUIET}>
          Cancel
        </button>
      </div>

      <div className="rule-t mt-3 flex flex-col gap-2 pt-3">
        {/* ── Tag ── */}
        <div className="flex flex-wrap items-center gap-2">
          <span className={LABEL}>Tag</span>
          <input
            value={tagText}
            onChange={e => onTagText(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') onTag('add');
            }}
            list="folder-bulk-tag-vocabulary"
            maxLength={40}
            placeholder="Tag them all…"
            aria-label="Tag for the selected people"
            className={INPUT}
          />
          {/* Native datalist rather than a bespoke popover: it is one field of type-ahead, and the
              browser's own affordance beats a hand-rolled one. */}
          <datalist id="folder-bulk-tag-vocabulary">
            {tagVocabulary.map(t => (
              <option key={t} value={t} />
            ))}
          </datalist>
          <button
            type="button"
            onClick={() => onTag('add')}
            disabled={working || !tagText.trim()}
            className={PRIMARY}
          >
            {working ? 'Working…' : 'Apply'}
          </button>
          {/* Remove sits beside Apply because it is the same gesture with the same input, and a tag
              applied by mistake to forty people needs an equally cheap undo. */}
          <button
            type="button"
            onClick={() => onTag('remove')}
            disabled={working || !tagText.trim()}
            className={QUIET}
          >
            Remove
          </button>
        </div>

        {/* ── Follow up ── */}
        <div className="flex flex-wrap items-center gap-2">
          <span className={LABEL}>Remind</span>
          <input
            type="date"
            value={day}
            /* Today IN IST, not the browser's today. Only a hint — the module refuses a past day too. */
            min={todayDayIST()}
            onChange={e => onDay(e.target.value)}
            aria-label="Follow-up date for the selected people"
            className={INPUT}
          />
          <button
            type="button"
            onClick={() => onFollowUp(day)}
            disabled={working || !day}
            className={PRIMARY}
          >
            Set
          </button>
          <button
            type="button"
            onClick={() => onFollowUp(null)}
            disabled={working}
            className={QUIET}
          >
            Clear
          </button>
        </div>

        {/* ── Move ── */}
        {folders.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className={LABEL}>Move</span>
            <select
              value=""
              disabled={working}
              aria-label="Move the selected people to another folder"
              onChange={e => {
                if (e.target.value) onMove(e.target.value);
              }}
              className={INPUT}
            >
              <option value="">Choose a folder…</option>
              {folders.map(f => (
                <option key={f._id} value={f._id}>
                  {f.name}
                  {f.archivedAt ? ' (archived)' : ''}
                </option>
              ))}
            </select>
            <span className="text-[12px] text-[var(--ink-2)]">Moves them straight away.</span>
          </div>
        )}
      </div>
    </div>
  );
}

/* ────────────────────────────── sheets ────────────────────────────── */

function draftFrom(contact: ContactDTO): ContactDraft {
  return {
    name: contact.name,
    headline: contact.headline ?? undefined,
    company: contact.company ?? undefined,
    role: contact.role ?? undefined,
    linkedin: contact.linkedin ?? undefined,
    phone: contact.phone ?? undefined,
    email: contact.email ?? undefined,
    x: contact.x ?? undefined,
    github: contact.github ?? undefined,
    website: contact.website ?? undefined,
    note: contact.note ?? undefined,
    tags: contact.tags,
    followUpAt: contact.followUpAt ?? null,
  };
}

function EditContactSheet({
  contact,
  onClose,
  onSave,
  onDelete,
  otherFolders,
  onMove,
  tagVocabulary,
}: {
  contact: ContactDTO;
  onClose: () => void;
  onSave: (draft: ContactDraft) => void;
  onDelete: () => void;
  otherFolders: FolderDTO[];
  onMove: (folderId: string) => void;
  /**
   * Passed in, not fetched here — which is what the hook's own docblock asks for: "Per PAGE and not
   * per sheet", because this component is mounted and unmounted per person and a request per capture
   * is the wrong thing to spend on the saturated network this feature exists to survive. It was being
   * called here AND in the manual-add sheet; the page now holds the one copy, for the bulk bar too.
   */
  tagVocabulary: string[];
}) {
  const [draft, setDraft] = useState<ContactDraft>(() => draftFrom(contact));
  const [showAll, setShowAll] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <Sheet
      open
      onClose={onClose}
      title={contact.name}
      subtitle={
        contact.pending
          ? contact.blocked
            ? 'Could not be uploaded'
            : 'Not uploaded yet'
          : `Added ${fullDateIST(contact.createdAt)}`
      }
      labelledBy="edit-contact-title"
      footer={
        <div className="flex items-center gap-2">
          <Button tone="primary" full onClick={() => onSave(draft)}>
            Save
          </Button>
          {confirmDelete ? (
            <Button tone="danger" onClick={onDelete}>
              Really delete
            </Button>
          ) : (
            <Button tone="quiet" icon="delete" onClick={() => setConfirmDelete(true)} aria-label="Delete">
              Delete
            </Button>
          )}
        </div>
      }
    >
      {contact.pending && (
        <div className="mb-4">
          {/*
            Two messages, because only one of them is true at a time. Telling somebody a
            permanently refused capture "will upload on its own" is the promise this whole fix
            exists to stop making.
          */}
          {contact.blocked ? (
            <Banner tone="error">
              {contact.blockedReason ?? 'The server refused this capture.'} It is still saved on
              this device. Go to People to retry it or discard it.
            </Banner>
          ) : (
            <Banner tone="warn">
              {/*
                Was: "it cannot be edited on the server yet". It can be edited NOW — the save writes
                straight to this device's queue and uploads with the corrected fields. That sentence
                was the reason a name mistyped offline stayed wrong until it synced, on exactly the
                path this feature exists for.
              */}
              This one is still only on this device. Edits are saved here and upload with it.
            </Banner>
          )}
        </div>
      )}

      {contact.linkedin && (
        <div className="mb-4">
          <ButtonLink href={contact.linkedin} external tone="secondary" full icon="open_in_new">
            Open on LinkedIn
          </ButtonLink>
        </div>
      )}

      {/*
        MOVE TO ANOTHER FOLDER — only for a SYNCED contact.
        A queued one has never reached the server, so there is nothing to PATCH; those are moved from
        the stuck-captures list on /folders, which rewrites the record in IndexedDB instead.
      */}
      {!contact.pending && otherFolders.length > 0 && (
        <label className="mb-4 block">
          <span className="t-label text-[var(--ink-2)]">Move to another folder</span>
          <select
            defaultValue=""
            aria-label={`Move ${contact.name} to another folder`}
            onChange={e => {
              if (e.target.value) onMove(e.target.value);
            }}
            className="mt-1.5 h-11 w-full r-touch bg-[var(--paper)] px-3.5 text-[15px] text-[var(--ink)] shadow-[inset_0_0_0_1px_var(--rule)] outline-none focus:shadow-[inset_0_0_0_2px_var(--accent)]"
          >
            <option value="">Stay in this folder</option>
            {otherFolders.map(f => (
              <option key={f._id} value={f._id}>
                {f.name}
                {f.archivedAt ? ' (archived)' : ''}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-[12px] text-[var(--ink-2)]">
            Moves them straight away — the other fields here still need Save.
          </span>
        </label>
      )}

      <ContactFields
        tagSuggestions={tagVocabulary}
        draft={draft}
        onChange={setDraft}
        showAll={showAll}
        onToggleShowAll={() => setShowAll(true)}
      />

      {contact.companies.length > 0 && (
        <p className="mt-4 text-[12px] text-[var(--ink-2)]">
          Matched to {contact.companies.join(', ')} in the company registry.
        </p>
      )}
    </Sheet>
  );
}

function ManualAddSheet({
  folderId,
  onClose,
  onAdded,
  tagVocabulary,
}: {
  folderId: string;
  onClose: () => void;
  onAdded: () => void;
  /** From the page, for the reason stated on `EditContactSheet`'s copy of this prop. */
  tagVocabulary: string[];
}) {
  const [draft, setDraft] = useState<ContactDraft>({ name: '' });
  const [showAll, setShowAll] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!draft.name.trim()) {
      setError('A name is the one thing this needs.');
      return;
    }
    setSaving(true);
    setError(null);
    const clientId = newClientId();

    // Same path a scan takes — `saveContact` queues rather than losing the person, and tells us
    // whether the queue can actually deliver it.
    const { saveContact } = await import('@/lib/scan/outbox');
    let result: Awaited<ReturnType<typeof saveContact>>;
    try {
      result = await saveContact({ ...draft, clientId, folderId, capturedVia: 'manual' });
    } finally {
      // In a `finally` so the Save button cannot be left disabled reading "Saving…" forever.
      setSaving(false);
    }

    if (result.outcome !== 'saved' && result.outcome !== 'queued') {
      // Keep the sheet open with the reason on it AND the typed fields intact. The record is
      // queued on every outcome except 'lost', but closing on a refusal is what let a doomed
      // capture disappear behind a success animation.
      setError(result.reason ?? 'That could not be saved.');
      return;
    }
    onAdded();
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title="Add somebody"
      subtitle="For when they'd rather just tell you"
      labelledBy="manual-add-title"
      footer={
        <Button tone="primary" full onClick={submit} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      }
    >
      {error && (
        <div className="mb-4">
          <Banner tone="error">{error}</Banner>
        </div>
      )}
      <ContactFields
        tagSuggestions={tagVocabulary}
        draft={draft}
        onChange={setDraft}
        showAll={showAll}
        onToggleShowAll={() => setShowAll(true)}
      />
    </Sheet>
  );
}

/**
 * The folder's public sign-up QR.
 *
 * For a booth, or five people at once: they scan, fill in three fields, and land here. Off by
 * default and expiring by default, because it is the one unauthenticated write path in the app.
 */
function FolderQrSheet({
  folder,
  onClose,
  onChanged,
}: {
  folder: FolderDTO;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  /**
   * Seeded from whatever the server already has, as a lazy initial value rather than an effect.
   * This component is mounted only while the sheet is open, so there is nothing to re-sync — and
   * setting state inside an effect for a value derivable from props causes a cascading render.
   */
  const [url, setUrl] = useState<string | null>(() =>
    folder.intakeEnabled && folder.intakeToken && typeof window !== 'undefined'
      ? `${window.location.origin}/f/${folder.intakeToken}`
      : null
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function call(action: 'enable' | 'rotate' | 'disable') {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/folders/${folder._id}/intake`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setUrl(data.url ?? null);
      await onChanged();
    } catch {
      setError('Could not change the link. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title="Sign-up QR"
      subtitle={folder.name}
      labelledBy="folder-qr-title"
      footer={
        url ? (
          <div className="flex items-center gap-2">
            <Button tone="quiet" full onClick={() => call('rotate')} disabled={busy}>
              New link
            </Button>
            <Button tone="danger" full onClick={() => call('disable')} disabled={busy}>
              Turn off
            </Button>
          </div>
        ) : (
          <Button tone="primary" full onClick={() => call('enable')} disabled={busy}>
            {busy ? 'Creating…' : 'Create a sign-up link'}
          </Button>
        )
      }
    >
      {error && (
        <div className="mb-4">
          <Banner tone="error">{error}</Banner>
        </div>
      )}

      {url ? (
        <div className="flex flex-col items-center text-center">
          <QrCode value={url} size={240} ariaLabel={`Sign-up QR for ${folder.name}`} />
          <p className="mt-4 text-[13px] leading-relaxed text-[var(--ink-2)]">
            Anyone who scans this adds themselves to <strong>{folder.name}</strong>. Works with any
            phone camera — they don&apos;t need this app.
          </p>
          <code className="mt-3 block w-full break-all r-touch bg-[var(--paper)] px-3 py-2 text-[11.5px] text-[var(--ink-2)] shadow-[inset_0_0_0_1px_var(--rule)]">
            {url}
          </code>
          {folder.intakeExpiresAt && (
            <p className="mt-3 text-[12px] text-[var(--ink-2)]">
              Stops working on {fullDateIST(folder.intakeExpiresAt)} at{' '}
              {timeIST(folder.intakeExpiresAt)}.
            </p>
          )}
        </div>
      ) : (
        <div>
          <p className="text-[13.5px] leading-relaxed text-[var(--ink-2)]">
            Show one code and let people add themselves — useful at a booth, or when five people
            want to swap details at once.
          </p>
          <ul className="mt-3 flex flex-col gap-1.5 text-[12.5px] text-[var(--ink-2)]">
            <li>· Expires after 12 hours, so a photographed code stops working after the event.</li>
            <li>· Anyone with the link can add a row, but nobody can read the folder.</li>
            <li>· You can turn it off or replace it at any time.</li>
          </ul>
        </div>
      )}
    </Sheet>
  );
}
