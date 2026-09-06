'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import QrScanner from '../components/scan/QrScanner';
import Sheet from '../components/Sheet';
import ContactFields, { type ContactDraft } from '../components/scan/ContactFields';
import { Banner, Button, ButtonLink } from '../components/ui';
import { parseScanPayload } from '@/lib/scan/parse-payload';
import { capturedViaFor, type ParsedScan } from '@/lib/scan/types';
import {
  drain,
  newClientId,
  pendingSummary,
  saveContact,
  startAutoDrain,
  subscribe,
  type PendingSummary,
} from '@/lib/scan/outbox';
import type { FolderDTO } from '@/lib/contacts/types';

/**
 * The scanner.
 *
 * THE FLOW, and why it is not "scan → jump straight to LinkedIn": a browser blocks opening a
 * new tab from a camera callback, because that is not a user gesture. Navigating the current
 * tab would work but leaves the app mid-scan, loses the moment when you can still get their
 * phone number, and means hitting back before the next person. So: save instantly, then show a
 * card whose primary action is a REAL TAP on "Connect on LinkedIn" — which reliably hands the
 * URL to the native app via universal links.
 *
 * Rendered with no app chrome (`AppShell bare`): the nav is `bg-white/96` and looks wrong over
 * a viewfinder, and this is the app's only dark surface.
 */
export default function ScanPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-black" />}>
      <ScanScreen />
    </Suspense>
  );
}

function ScanScreen() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const folderParam = searchParams.get('folder');

  const [folders, setFolders] = useState<FolderDTO[]>([]);
  const [folderId, setFolderId] = useState<string | null>(folderParam);
  const [choosingFolder, setChoosingFolder] = useState(false);
  const [captured, setCaptured] = useState<ParsedScan | null>(null);
  const [draft, setDraft] = useState<ContactDraft>({ name: '' });
  const [showAllFields, setShowAllFields] = useState(false);
  const [recent, setRecent] = useState<string[]>([]);
  const [pending, setPending] = useState<PendingSummary>({
    waiting: 0,
    blocked: 0,
    otherAccount: 0,
    waitingFolders: 0,
    total: 0,
    authExpired: false,
  });
  const [toast, setToast] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  /**
   * The payload just saved, and when.
   *
   * WHY THIS EXISTS — found by pointing the scanner at a real LinkedIn QR: after "Save & scan
   * next" the camera is still aimed at the SAME code, so the loop re-detects it within ~100 ms and
   * re-opens the capture card. One more tap and the same person is in the folder twice.
   *
   * `clientId` idempotency cannot help: each capture legitimately mints a new one, so the server
   * sees two genuinely distinct writes. The fix has to be here, where "the same code, still in
   * frame" is knowable.
   */
  const lastSavedRef = useRef<{ raw: string; at: number } | null>(null);

  const folder = useMemo(() => folders.find(f => f._id === folderId) ?? null, [folders, folderId]);

  /* ── Folders ────────────────────────────────────────────────────────── */
  const loadFolders = useCallback(async () => {
    try {
      const res = await fetch('/api/folders');
      if (!res.ok) return;
      const data = await res.json();
      const list: FolderDTO[] = data.folders ?? [];
      setFolders(list);

      // No folder chosen: prefer today's, else the most recent. Opening the scanner should
      // never make you pick something before you can point it at anybody.
      if (!folderParam && list.length) {
        const today = new Date().toISOString().slice(0, 10);
        const todays = list.find(f => f.eventDate?.slice(0, 10) === today);
        setFolderId((todays ?? list[0])._id);
      }
    } catch {
      // Offline. The chip will say so and the outbox still works.
    }
  }, [folderParam]);

  useEffect(() => {
    const timer = setTimeout(loadFolders, 0);
    return () => clearTimeout(timer);
  }, [loadFolders]);

  useEffect(() => {
    const refresh = () => void pendingSummary().then(setPending);
    refresh();
    const unsubscribe = subscribe(refresh);
    const stopAutoDrain = startAutoDrain();
    return () => {
      unsubscribe();
      stopAutoDrain();
    };
  }, []);

  /* ── A code was decoded ─────────────────────────────────────────────── */
  const onDetect = useCallback(
    (raw: string) => {
      // Ignore a repeat of whatever we are already looking at: the loop runs at 10 fps and the
      // same code stays in frame while you read the card.
      if (captured) return;

      /**
       * And ignore the code we just saved, for as long as it is plausibly still in frame.
       *
       * Without this, saving somebody and lowering the phone re-opens their card immediately, and
       * the obvious next tap files them twice. Ten seconds is long enough to move to the next
       * person and short enough that meeting the same person twice in one event still works.
       */
      const justSaved = lastSavedRef.current;
      if (justSaved && justSaved.raw === raw && Date.now() - justSaved.at < 10_000) {
        setToast('Already saved — point at the next person.');
        setTimeout(() => setToast(null), 1800);
        return;
      }

      const parsed = parseScanPayload(raw);

      if (!parsed.isPerson) {
        // Recognised, and definitely not a contact — a ticket, a Wi-Fi code, a UPI code. Say so
        // rather than saving rubbish, and keep scanning.
        setToast(parsed.reason ?? 'That is not a contact code.');
        setTimeout(() => setToast(null), 3500);
        navigator.vibrate?.([20, 60, 20]);
        return;
      }

      setCaptured(parsed);
      setShowAllFields(!parsed.person.linkedinSlug);
      setDraft({
        name: parsed.person.name ?? '',
        nameIsGuess: parsed.person.nameIsGuess,
        headline: parsed.person.headline,
        company: parsed.person.company,
        role: parsed.person.role,
        linkedin: parsed.person.linkedin,
        phone: parsed.person.phone,
        email: parsed.person.email,
        x: parsed.person.x,
        github: parsed.person.github,
        website: parsed.person.website,
        note: parsed.person.note,
        followUpAt: null,
      });
    },
    [captured]
  );

  /* ── Save ───────────────────────────────────────────────────────────── */
  const save = useCallback(
    async (thenScanNext: boolean) => {
      if (!captured || !folderId) return;
      if (!draft.name.trim()) {
        setToast('Add a name first — the code does not carry one.');
        setTimeout(() => setToast(null), 3000);
        return;
      }

      setSaving(true);
      const record = {
        ...draft,
        name: draft.name.trim(),
        clientId: newClientId(),
        folderId,
        capturedVia: capturedViaFor(captured.kind),
        rawPayload: captured.raw,
        scannedAt: new Date().toISOString(),
      };
      // `nameIsGuess` is a UI concern only and is not part of the stored record.
      delete (record as Record<string, unknown>).nameIsGuess;

      /**
       * THE IMPORTANT PATH, and it is `saveContact`'s job now rather than this component's.
       *
       * A failed POST does not lose the person — that has always been true and still is. What
       * changed is that a failure is no longer reported as if it were always the network: this
       * screen used to say "Saved <name> on this device" for a 404 whose folder had been
       * deleted, which is a promise the queue could not keep. See `lib/scan/failure.ts`.
       */
      // try/finally so `setSaving(false)` cannot be skipped. `saveContact` is written not to
      // throw, but the Save button freezing on "Saving…" with the person standing in front of you
      // is bad enough that it should not depend on that promise holding.
      let result: Awaited<ReturnType<typeof saveContact>>;
      try {
        result = await saveContact(record);
      } finally {
        setSaving(false);
      }

      const blocked = result.outcome !== 'saved' && result.outcome !== 'queued';
      setToast(
        result.outcome === 'saved'
          ? `Saved ${record.name}`
          : result.outcome === 'queued'
            ? `Saved ${record.name} on this device`
            : result.outcome === 'lost'
              ? // The one outcome where the record is genuinely gone. Say so plainly rather than
                // implying it is queued.
                `NOT SAVED — ${result.reason}`
              : `Kept ${record.name} on this device — ${result.reason}`
      );

      if (result.outcome === 'lost') {
        // Keep the capture card open with the typed fields intact, so the details can be
        // re-entered or written down. Everything below unwinds the card.
        return;
      }

      // Remember what was saved so the loop does not immediately re-offer the same code.
      lastSavedRef.current = { raw: captured.raw, at: Date.now() };

      setRecent(current => [record.name, ...current].slice(0, 3));
      // A problem needs longer on screen than a success does — you are standing in front of
      // the person you just scanned, and 2.5 seconds is not enough to read and act on it.
      setTimeout(() => setToast(null), blocked ? 6000 : 2500);
      setCaptured(null);
      setDraft({ name: '' });

      if (!thenScanNext) router.push(`/folders/${folderId}`);
    },
    [captured, draft, folderId, router]
  );

  async function syncNow() {
    // `force`, because this is the user asking. An automatic drain declines an all-blocked
    // queue; a deliberate tap is evidence something may have changed since it was judged.
    const result = await drain({ force: true });
    const summary = await pendingSummary();
    setPending(summary);

    // Reporting only `synced > 0` was half the original bug: every other outcome looked
    // identical to doing nothing, which is precisely what "Sync now doesn't work" meant.
    const uploaded = result.synced + result.foldersSynced;
    setToast(
      result.authExpired
        ? 'Sign in again and these will upload'
        : uploaded > 0
          ? `Uploaded ${uploaded}${summary.blocked ? ` · ${summary.blocked} still stuck` : ''}`
          : result.batchRefused
            ? 'The server refused the upload — your captures are safe'
            : summary.blocked > 0
              ? `${summary.blocked} cannot upload — open People to fix`
              : result.skipReason === 'offline'
                ? 'No network yet'
                : result.skipReason === 'no-owner'
                  ? 'These were captured on another account'
                  : result.skipped
                    ? 'Nothing to upload'
                    : 'Still offline'
    );
    setTimeout(() => setToast(null), summary.blocked > 0 || result.authExpired ? 6000 : 2500);
  }

  return (
    <div className="fixed inset-0 flex flex-col bg-black">
      {/* ── Top bar ─────────────────────────────────────────────────────── */}
      <div
        className="relative z-10 flex items-center gap-2 px-3 pb-2"
        style={{ paddingTop: 'max(12px, env(safe-area-inset-top))' }}
      >
        <Link
          href={folderId ? `/folders/${folderId}` : '/folders'}
          aria-label="Close the scanner"
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-white/15 text-white [touch-action:manipulation]"
        >
          <span aria-hidden="true" className="material-symbols-outlined text-[20px]">close</span>
        </Link>

        <button
          type="button"
          onClick={() => setChoosingFolder(true)}
          className="flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-full bg-white/15 px-4 py-2.5 text-[13px] font-semibold text-white [touch-action:manipulation]"
        >
          <span aria-hidden="true" className="material-symbols-outlined text-[17px]">folder</span>
          <span className="truncate">{folder ? folder.name : 'Choose a folder'}</span>
          <span aria-hidden="true" className="material-symbols-outlined text-[17px]">expand_more</span>
        </button>

        <Link
          href="/card"
          aria-label="Show my own code"
          title="Show my code"
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-white/15 text-white [touch-action:manipulation]"
        >
          <span aria-hidden="true" className="material-symbols-outlined text-[20px]">qr_code_2</span>
        </Link>
      </div>

      {/* ── Viewfinder ──────────────────────────────────────────────────── */}
      <div className="relative min-h-0 flex-1">
        {folderId ? (
          <QrScanner onDetect={onDetect} paused={Boolean(captured)} />
        ) : (
          <div className="grid h-full place-items-center px-6 text-center">
            <div>
              <p className="text-[15px] font-semibold text-white">Pick a folder first</p>
              <p className="mt-1.5 text-[13px] leading-relaxed text-white/70">
                Everything you scan lands in it, so it is worth naming after the event.
              </p>
              <div className="mt-5 flex items-center justify-center gap-2">
                <Button tone="secondary" onClick={() => setChoosingFolder(true)}>
                  Choose a folder
                </Button>
                <ButtonLink href="/folders" tone="quiet">
                  Manage folders
                </ButtonLink>
              </div>
            </div>
          </div>
        )}

        {/* Recent captures, so it visibly works even when the sheet is closed. */}
        {recent.length > 0 && !captured && (
          <div className="pointer-events-none absolute inset-x-0 bottom-20 flex flex-col items-center gap-1.5 px-4">
            {recent.map((name, index) => (
              <span
                key={`${name}-${index}`}
                className="rounded-full bg-black/55 px-3 py-1 text-[12px] font-semibold text-white"
                style={{ opacity: 1 - index * 0.3 }}
              >
                ✓ {name}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* ── Toast + pending ─────────────────────────────────────────────── */}
      {toast && (
        <div className="pointer-events-none absolute inset-x-0 top-20 z-20 px-4">
          <p
            role="status"
            className="mx-auto max-w-[420px] rounded-2xl bg-white/95 px-4 py-3 text-center text-[13px] font-medium leading-relaxed text-[#1D1D1F]"
          >
            {toast}
          </p>
        </div>
      )}

      {pending.total > 0 && !captured && (
        <div className="absolute inset-x-0 bottom-0 z-20 p-3" style={{ paddingBottom: 'max(12px, env(safe-area-inset-bottom))' }}>
          <button
            type="button"
            onClick={syncNow}
            className={`mx-auto flex items-center gap-2 rounded-full px-4 py-2 text-[12px] font-semibold ${
              pending.blocked > 0 ? 'bg-[#FFF1F0]/95 text-[#C7362D]' : 'bg-white/95 text-[#1D1D1F]'
            }`}
          >
            <span aria-hidden="true" className="material-symbols-outlined text-[16px]">
              {pending.blocked > 0 ? 'error' : 'cloud_upload'}
            </span>
            {/* Two counts, because they mean opposite things: one is patience, one is a problem. */}
            {pending.blocked > 0 ? (
              <>
                <span className="tnum">{pending.blocked}</span> cannot upload
                {pending.waiting > 0 && (
                  <>
                    {' · '}
                    <span className="tnum">{pending.waiting}</span> waiting
                  </>
                )}
                {' — tap to retry'}
              </>
            ) : (
              <>
                <span className="tnum">{pending.waiting}</span> waiting to upload — tap to retry
              </>
            )}
          </button>
        </div>
      )}

      {/* ── The capture card ────────────────────────────────────────────── */}
      {captured && (
        <Sheet
          open
          onClose={() => {
            setCaptured(null);
            setDraft({ name: '' });
          }}
          title={draft.name.trim() || 'Who was that?'}
          subtitle={folder ? `Into ${folder.name}` : undefined}
          labelledBy="capture-title"
          footer={
            <div className="flex items-center gap-2">
              <Button tone="primary" full onClick={() => save(true)} disabled={saving}>
                {saving ? 'Saving…' : 'Save & scan next'}
              </Button>
              <Button tone="quiet" onClick={() => save(false)} disabled={saving}>
                Save & close
              </Button>
            </div>
          }
        >
          {/**
           * The Connect button is FIRST and is a real tap, which is what makes it work: an
           * https linkedin.com/in/<slug> URL is claimed by the LinkedIn app through iOS
           * universal links and Android App Links, so it opens the app when installed and the
           * browser when not. A `linkedin://` scheme is never used — those forms are all from
           * 2013-2015 and unverifiable.
           */}
          {captured.actionUrl && (
            <div className="mb-4">
              <ButtonLink
                href={captured.actionUrl}
                external
                tone="secondary"
                full
                icon="open_in_new"
              >
                {captured.actionLabel ?? 'Open profile'}
              </ButtonLink>
              <p className="mt-1.5 text-center text-[12px] text-[#8E8E93]">
                Opens LinkedIn. Come back here — this is already saved when you tap Save.
              </p>
            </div>
          )}

          {captured.reason && (
            <div className="mb-4">
              <Banner tone="warn">{captured.reason}</Banner>
            </div>
          )}

          <ContactFields
            draft={draft}
            onChange={setDraft}
            showAll={showAllFields}
            onToggleShowAll={() => setShowAllFields(true)}
          />
        </Sheet>
      )}

      {/* ── Folder picker ───────────────────────────────────────────────── */}
      <Sheet
        open={choosingFolder}
        onClose={() => setChoosingFolder(false)}
        title="Scan into"
        labelledBy="folder-picker-title"
        footer={
          <ButtonLink href="/folders" tone="quiet" full icon="create_new_folder">
            Manage folders
          </ButtonLink>
        }
      >
        {folders.length === 0 ? (
          <p className="text-[13.5px] leading-relaxed text-[#6E6E73]">
            You have no folders yet. Create one — name it after the event — and come back.
          </p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {folders.map(option => (
              <button
                key={option._id}
                type="button"
                onClick={() => {
                  setFolderId(option._id);
                  setChoosingFolder(false);
                }}
                aria-pressed={option._id === folderId}
                className={`flex items-center justify-between gap-3 rounded-xl px-4 py-3 text-left [touch-action:manipulation] ${
                  option._id === folderId ? 'bg-[#EBF4FE]' : 'bg-[#F7F7F9] hover:bg-[#EEEEF0]'
                }`}
              >
                <span className="min-w-0">
                  <span className="block truncate text-[14px] font-semibold text-[#1D1D1F]">
                    {option.name}
                  </span>
                  <span className="block text-[12px] text-[#6E6E73]">
                    {option.contactCount ?? 0} {option.contactCount === 1 ? 'person' : 'people'}
                  </span>
                </span>
                {option._id === folderId && (
                  <span aria-hidden="true" className="material-symbols-outlined shrink-0 text-[20px] text-[#0071E3]">
                    check_circle
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </Sheet>
    </div>
  );
}
