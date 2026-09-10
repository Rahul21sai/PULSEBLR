'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import QrScanner from '../components/scan/QrScanner';
import Sheet from '../components/Sheet';
import ContactFields, { useTagVocabulary, type ContactDraft } from '../components/scan/ContactFields';
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

/**
 * The three ways to record somebody.
 *
 * WHY THERE ARE THREE, AND WHY THE MIDDLE ONE MATTERS MOST. Everything above assumes a QR code
 * exists. At a Bengaluru meetup most people will not produce a LinkedIn QR — they have not enabled
 * it, they cannot find it, their phone is at 4%, or they simply hand you a business card. Until
 * this existed the whole scan → people → export loop had a hole at its entrance: the app could
 * remember only the minority of people who arrived machine-readable.
 *
 * `photo` is deliberately a STUB and says so on screen. It needs a vision model, and a vision model
 * will misread names — so shipping it without the manual-edit fallback that `type` provides would
 * quietly fill the contact list with wrong names, which is the one failure this feature cannot
 * absorb (a wrong name is a wrong `contactKey`, and `deriveContactKey` falls back to `nm:<name>`
 * exactly when there is no LinkedIn slug to key on).
 */
type CaptureMode = 'qr' | 'type' | 'photo';

/**
 * What the capture sheet is currently holding.
 *
 * ONE UNION RATHER THAN A SECOND `manualOpen` BOOLEAN. Two independent pieces of state describing
 * one sheet is how a screen ends up able to be in both states at once — and the two branches
 * genuinely differ in what they store: a QR capture has a `rawPayload` to keep verbatim and a
 * `capturedVia` derived from the payload FORMAT, while a typed one has neither and is `'manual'`.
 * Making that a discriminated union means the save path cannot forget which it is holding.
 */
type Capture =
  | { via: 'qr'; parsed: ParsedScan }
  | { via: 'manual' };

/**
 * The switcher, in the order the plan specifies: `[ Scan QR ] [ Type it ] [ Card photo ]`.
 *
 * QR stays FIRST and stays the default even though it is the less common case, because it is the
 * only one that is instant and cannot be mistyped. "Type it" sits in the middle where a thumb
 * lands, since it is the one reached for when the fast path fails.
 */
const MODES: ReadonlyArray<{ id: CaptureMode; label: string; icon: string }> = [
  { id: 'qr', label: 'Scan QR', icon: 'qr_code_scanner' },
  { id: 'type', label: 'Type it', icon: 'keyboard' },
  { id: 'photo', label: 'Card photo', icon: 'photo_camera' },
];

function ScanScreen() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const folderParam = searchParams.get('folder');

  const [folders, setFolders] = useState<FolderDTO[]>([]);
  const [folderId, setFolderId] = useState<string | null>(folderParam);
  const [choosingFolder, setChoosingFolder] = useState(false);
  const [mode, setMode] = useState<CaptureMode>('qr');
  const [capture, setCapture] = useState<Capture | null>(null);
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
  /**
   * A failure that happens WHILE THE CAPTURE SHEET IS OPEN, reported inside the sheet.
   *
   * WHY THIS IS SEPARATE FROM `toast`. `Sheet` is `z-[70]` and the toast is `z-20`, both in the
   * scan screen's stacking context (its root is `fixed` with `z-index: auto`, so it creates none).
   * So every message raised without closing the sheet rendered BEHIND the sheet's own backdrop —   * and those are exactly the two messages that matter: "add a name first", and the `lost` outcome
   * where the record is genuinely gone and the sheet is deliberately kept open so the details can
   * be re-entered. A failed capture therefore showed NOTHING while the user was standing in front
   * of the person they had just scanned.
   *
   * The z-index of the toast is raised too (see below), because `syncNow` and the duplicate-code
   * notice can fire while the folder picker is open. But a message about the form belongs ON the
   * form rather than floating over it: it survives while the user fixes the field, and a screen
   * reader meets it inside the dialog it applies to instead of in a region outside the modal.
   */
  const [sheetError, setSheetError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // One fetch for the page; the capture sheet is remounted per person.
  const tagVocabulary = useTagVocabulary();

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
      if (capture) return;

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

      setCapture({ via: 'qr', parsed });
      // A new person, so any verdict about the last one is stale.
      setSheetError(null);
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
    [capture]
  );

  /**
   * Open an empty capture sheet for a typed entry.
   *
   * `showAllFields` starts CLOSED even though nothing is prefilled, which looks backwards and is
   * not. The extra fields are LinkedIn, headline, X, GitHub, email and website — none of which you
   * get by talking to somebody for thirty seconds. What you actually get is a name, where they
   * work, and one sentence about why they matter, and those are the four fields already visible.
   * Showing eleven inputs instead would make the fast path look slow. "More fields" is one tap away.
   */
  const startTyping = useCallback(() => {
    setCapture({ via: 'manual' });
    setSheetError(null);
    setShowAllFields(false);
    setDraft({ name: '', followUpAt: null });
  }, []);

  /* ── Save ───────────────────────────────────────────────────────────── */
  const save = useCallback(
    async (thenScanNext: boolean) => {
      if (!capture || !folderId) return;
      if (!draft.name.trim()) {
        // In the sheet, not in a toast: the sheet is still open, so a toast is behind its backdrop,
        // and the message is about a field the user is looking at. The wording differs by mode
        // because the reason differs — a QR genuinely did not carry a name, whereas a typed entry
        // is simply not finished.
        setSheetError(
          capture.via === 'qr'
            ? 'Add a name first — the code does not carry one.'
            : 'Add a name first. Anything else can wait.'
        );
        return;
      }

      setSheetError(null);
      setSaving(true);
      /**
       * ONE RECORD SHAPE FOR BOTH MODES, and the two differences are exactly the two the union
       * encodes: a typed entry is `capturedVia: 'manual'` and carries NO `rawPayload`.
       *
       * `rawPayload` is omitted rather than set to `''`. The field's contract (see
       * `lib/scan/types.ts` and `parseScanPayload`) is "the literal decoded string, kept verbatim
       * so a format we do not understand today can be re-parsed tomorrow". An empty string would
       * assert that a code was scanned and decoded to nothing, which is a different and false
       * claim; absent correctly says no code was involved.
       */
      const record = {
        ...draft,
        name: draft.name.trim(),
        clientId: newClientId(),
        folderId,
        capturedVia: capture.via === 'qr' ? capturedViaFor(capture.parsed.kind) : ('manual' as const),
        ...(capture.via === 'qr' ? { rawPayload: capture.parsed.raw } : {}),
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
        //
        // And say so INSIDE the card. The toast set above is now above the sheet too, but this is
        // the one outcome where the record is genuinely gone and the user has to act on the words:
        // it must not time out, and it must sit next to the fields it is asking them to preserve.
        setSheetError(`NOT SAVED — ${result.reason}`);
        setToast(null);
        return;
      }

      // Remember what was saved so the loop does not immediately re-offer the same code. Only
      // meaningful for a QR capture — there is no code in frame to re-detect after a typed entry,
      // and stamping the ref with an empty payload would suppress a genuine scan of a blank-ish
      // code for ten seconds.
      if (capture.via === 'qr') {
        lastSavedRef.current = { raw: capture.parsed.raw, at: Date.now() };
      }

      setRecent(current => [record.name, ...current].slice(0, 3));
      // A problem needs longer on screen than a success does — you are standing in front of
      // the person you just scanned, and 2.5 seconds is not enough to read and act on it.
      setTimeout(() => setToast(null), blocked ? 6000 : 2500);
      setCapture(null);
      setDraft({ name: '' });

      /**
       * "Save & add next" in TYPED mode reopens an empty sheet immediately.
       *
       * In QR mode closing the sheet is the right move because the viewfinder behind it is the next
       * step. In typed mode there is nothing behind it — closing to a panel with an "Add someone"
       * button would cost a tap per person for no reason, and a queue of people waiting to be
       * recorded is exactly when taps matter.
       */
      if (thenScanNext) {
        if (capture.via === 'manual') startTyping();
      } else {
        router.push(`/folders/${folderId}`);
      }
    },
    [capture, draft, folderId, router, startTyping]
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

      {/* ── The capture surface: viewfinder, typed panel, or the photo stub ── */}
      <div className="relative min-h-0 flex-1">
        {!folderId ? (
          <div className="grid h-full place-items-center px-6 text-center">
            <div>
              <p className="text-[15px] font-semibold text-white">Pick a folder first</p>
              <p className="mt-1.5 text-[13px] leading-relaxed text-white/70">
                Everyone you record lands in it, so it is worth naming after the event.
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
        ) : mode === 'qr' ? (
          <QrScanner onDetect={onDetect} paused={Boolean(capture)} />
        ) : mode === 'type' ? (
          /**
           * The typed panel. Its whole job is one big target.
           *
           * Placed low on purpose — `justify-end` with generous bottom padding — because this
           * screen is used one-handed while standing, and the bottom third is the only part of a
           * phone a thumb reaches without regripping. A centred button looks tidier in a
           * screenshot and is worse in a corridor.
           */
          <div className="flex h-full flex-col justify-end px-6 pb-8 text-center">
            <p className="text-[17px] font-semibold text-white">No QR? Just type it.</p>
            <p className="mx-auto mt-2 max-w-[300px] text-[13px] leading-relaxed text-white/70">
              A name is enough to start. Everything else — company, one line about why they matter,
              a reminder — can go in now or later.
            </p>
            <div className="mt-6">
              <Button tone="primary" full onClick={startTyping}>
                Add someone
              </Button>
            </div>
            <p className="mt-3 text-[12px] text-white/55">
              Works with no signal. It uploads itself when you are back on.
            </p>
          </div>
        ) : (
          /**
           * The card-photo stub.
           *
           * SAYS IT IS NOT BUILT, rather than offering a file picker that leads nowhere. A control
           * that appears to work and then does nothing is worse than an absent one at an event —
           * the user believes the person is recorded and moves on, and the loss is silent and
           * unrecoverable. The honest panel costs one screen and routes to the mode that works.
           *
           * What it is waiting on, so the next person does not have to re-derive it: OCR needs a
           * vision model, and a misread name becomes a wrong `nm:` contact key (see
           * `deriveContactKey`) that no later scan reconciles. So it is only worth shipping behind
           * the same editable review step the typed form already is — which is precisely why that
           * one had to come first.
           */
          <div className="flex h-full flex-col justify-end px-6 pb-8 text-center">
            <span
              aria-hidden="true"
              className="material-symbols-outlined mx-auto text-[34px] text-white/40"
            >
              photo_camera
            </span>
            <p className="mt-2 text-[17px] font-semibold text-white">Card photo is not built yet</p>
            <p className="mx-auto mt-2 max-w-[320px] text-[13px] leading-relaxed text-white/70">
              Reading a business card needs a vision model, and it will get names wrong. Rather than
              quietly file somebody under a misspelling, this stays switched off until it can hand
              you the same editable form to correct first.
            </p>
            <div className="mt-6">
              <Button tone="secondary" full onClick={() => { setMode('type'); startTyping(); }}>
                Type it instead
              </Button>
            </div>
            <p className="mt-3 text-[12px] text-white/55">
              Keep the card. Ten seconds of typing beats a wrong name.
            </p>
          </div>
        )}

        {/* Recent captures, so it visibly works even when the sheet is closed. */}
        {recent.length > 0 && !capture && (
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

        {/* ── Pending uploads ───────────────────────────────────────────────
            INSIDE this container rather than positioned against the screen, so it floats over the
            capture surface and cannot collide with the mode switcher below it. It used to be
            `absolute bottom-0` on the root, which the switcher now occupies. */}
        {pending.total > 0 && !capture && (
          <div className="absolute inset-x-0 bottom-0 z-20 p-3">
            <button
              type="button"
              onClick={syncNow}
              className={`mx-auto flex min-h-11 items-center gap-2 rounded-full px-4 py-2 text-[12px] font-semibold [touch-action:manipulation] ${
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
      </div>

      {/* ── Mode switcher ────────────────────────────────────────────────────
          A REAL FLEX CHILD, not an absolutely-positioned bar. Everything else on this screen floats
          over the camera, and adding one more absolute element at the bottom is how the sync chip
          and the switcher would have ended up on top of each other on a short viewport. As a flex
          row it cannot overlap anything by construction, and it owns the home-indicator inset.

          44px minimum per button (`h-11`), which is the WCAG 2.5.5 floor this work holds to and
          which several controls elsewhere in the app currently miss. */}
      <div
        role="tablist"
        aria-label="How to record somebody"
        className="relative z-10 flex shrink-0 items-center gap-1 px-3 pt-2"
        style={{ paddingBottom: 'max(10px, env(safe-area-inset-bottom))' }}
      >
        {MODES.map(option => {
          const active = option.id === mode;
          return (
            <button
              key={option.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => {
                setMode(option.id);
                // Entering typed mode opens the sheet straight away: the user tapped "Type it"
                // because they have somebody in front of them, so making them tap "Add someone"
                // as well is a tap that answers a question they already answered. Dismissing the
                // sheet leaves the panel behind, so there is no reopen loop.
                if (option.id === 'type' && folderId) startTyping();
              }}
              className={`flex h-11 flex-1 items-center justify-center gap-1.5 rounded-full text-[12.5px] font-semibold [touch-action:manipulation] ${
                active ? 'bg-white text-[#1D1D1F]' : 'bg-white/15 text-white'
              }`}
            >
              <span aria-hidden="true" className="material-symbols-outlined text-[17px]">
                {option.icon}
              </span>
              {option.label}
            </button>
          );
        })}
      </div>

      {/* ── Toast + pending ───────────────────────────────────────────────
          `z-[80]`, ABOVE `Sheet`'s `z-[70]`. It was `z-20`, so every toast raised while a sheet was
          open rendered behind that sheet's backdrop — invisible. The scan root is `fixed` with
          `z-index: auto` and so creates no stacking context of its own, which is why the two
          numbers compete directly. `pointer-events-none` is what makes stacking it over a modal
          safe: it cannot intercept a tap meant for the sheet. */}
      {toast && (
        <div className="pointer-events-none absolute inset-x-0 top-20 z-[80] px-4">
          <p
            role="status"
            className="mx-auto max-w-[420px] rounded-2xl bg-white/95 px-4 py-3 text-center text-[13px] font-medium leading-relaxed text-[#1D1D1F]"
          >
            {toast}
          </p>
        </div>
      )}

      {/* ── The capture card ────────────────────────────────────────────── */}
      {capture && (
        <Sheet
          open
          onClose={() => {
            setCapture(null);
            setDraft({ name: '' });
            setSheetError(null);
          }}
          // A typed entry has no "that" to refer to — nothing was scanned — so the empty-state
          // title asks the question the form is actually asking.
          title={draft.name.trim() || (capture.via === 'qr' ? 'Who was that?' : 'Who did you meet?')}
          subtitle={folder ? `Into ${folder.name}` : undefined}
          labelledBy="capture-title"
          footer={
            <div className="flex items-center gap-2">
              <Button tone="primary" full onClick={() => save(true)} disabled={saving}>
                {saving ? 'Saving…' : capture.via === 'qr' ? 'Save & scan next' : 'Save & add next'}
              </Button>
              <Button tone="quiet" onClick={() => save(false)} disabled={saving}>
                Save & close
              </Button>
            </div>
          }
        >
          {/* THE FIRST THING IN THE SCROLLPORT, above even the Connect button, so a refusal is on
              screen without scrolling on a phone. `error` rather than `warn` because both cases it
              carries are things the save declined to do, and it does NOT time out: the `lost`
              outcome is asking the user to preserve what they typed. `Banner` sets `role="status"`,
              and being inside the dialog means a screen reader meets it within the modal it
              applies to rather than in a live region the modal has hidden. */}
          {sheetError && (
            <div className="mb-4">
              <Banner tone="error">{sheetError}</Banner>
            </div>
          )}

          {/**
           * The Connect button is FIRST and is a real tap, which is what makes it work: an
           * https linkedin.com/in/<slug> URL is claimed by the LinkedIn app through iOS
           * universal links and Android App Links, so it opens the app when installed and the
           * browser when not. A `linkedin://` scheme is never used — those forms are all from
           * 2013-2015 and unverifiable.
           */}
          {capture.via === 'qr' && capture.parsed.actionUrl && (
            <div className="mb-4">
              <ButtonLink
                href={capture.parsed.actionUrl}
                external
                tone="secondary"
                full
                icon="open_in_new"
              >
                {capture.parsed.actionLabel ?? 'Open profile'}
              </ButtonLink>
              <p className="mt-1.5 text-center text-[12px] text-[#8E8E93]">
                Opens LinkedIn. Come back here — this is already saved when you tap Save.
              </p>
            </div>
          )}

          {capture.via === 'qr' && capture.parsed.reason && (
            <div className="mb-4">
              <Banner tone="warn">{capture.parsed.reason}</Banner>
            </div>
          )}

          <ContactFields
            tagSuggestions={tagVocabulary}
            draft={draft}
            onChange={setDraft}
            showAll={showAllFields}
            onToggleShowAll={() => setShowAllFields(true)}
            // Only for a typed entry. See the prop's own note: after a scan the card is prefilled
            // and the keyboard would cover the fields being checked.
            autoFocusName={capture.via === 'manual'}
          />
        </Sheet>
      )}

      {/* ── Folder picker ───────────────────────────────────────────────── */}
      <Sheet
        open={choosingFolder}
        onClose={() => setChoosingFolder(false)}
        // "Scan into" was accurate when scanning was the only way in. Two of the three modes do not
        // scan anything.
        title="Record people into"
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
