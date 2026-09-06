/**
 * The offline outbox: every capture is written locally FIRST and posted afterwards.
 *
 * This is the feature's most important reliability property. At a real event the network is
 * saturated — at Google I/O Connect it will be unusable — and a scanner that loses a person
 * because a POST timed out is worse than no scanner, because you believed it worked.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS IN THE PAGE AND NOT IN THE SERVICE WORKER
 *
 * Four measured facts about `public/sw.js` make the worker the wrong home for a queue:
 *
 *   1. It returns early for EVERY non-GET request, so a POST never reaches it at all.
 *   2. Background Sync is not wired anywhere — no `sync` listener, no `registration.sync` —
 *      and it does not exist on iOS Safari regardless, which is where a conference-hall PWA
 *      is most likely to be used.
 *   3. `activate` DELETES EVERY CACHE not named `…-v2`. A queue in Cache Storage would be
 *      erased by a routine version bump. IndexedDB is untouched by that sweep and by the
 *      dev-mode purge in `layout.tsx`, which only calls `caches.delete`.
 *   4. There is no page↔worker channel: no `message` listener, and the registration object
 *      is discarded on registration. Reporting "3 scans synced" back to the UI would mean
 *      building that plumbing first.
 *
 * So the page owns the queue, and `sw.js` is left alone — it is the highest-risk file in this
 * repo, having once poisoned browsers with a stale shell pointing at dead JS chunks.
 *
 * KNOWN LIMIT, STATED PLAINLY: with no service-worker change the app cannot COLD-BOOT
 * offline, because `sw.js` skips `/_next/*` so the JS chunks are never cached. Scanning
 * therefore requires `/scan` to have been opened before you lost signal — which is the
 * realistic flow, since you open the scanner and keep it open. Fixing cold boot is a
 * separate, riskier change.
 * ─────────────────────────────────────────────────────────────────────────────────────
 */
import type { ContactInput } from '../contacts/types';
import { classifyStatus, refusalMessage, type FailureKind } from './failure';

const DB_NAME = 'pulseblr-outbox';
const DB_VERSION = 1;
const CONTACTS = 'contacts';
const FOLDERS = 'folders';

/**
 * Every network call here is bounded. NONE OF THEM USED TO BE, and that is a wedge.
 *
 * `drain()` holds a module-level latch cleared in `finally`. A saturated hall network that
 * completes the TCP handshake and then never answers leaves `await fetch(…)` pending
 * indefinitely, so `finally` never runs, the latch stays set, and every later drain — INCLUDING
 * a forced "Sync now" — returns at the guard without attempting anything. The queue is dead
 * until a page reload, while the banner keeps promising an upload. That is the reported symptom
 * exactly, and it is invisible because no record is ever marked.
 *
 * `lib/scrapers/core/http.ts`, `lib/security/safe-fetch.ts` and `lib/llm/tagger.ts` all use
 * `AbortSignal.timeout`; this file was the one network caller that did not.
 */
const SAVE_TIMEOUT_MS = 15_000;
const SYNC_TIMEOUT_MS = 30_000;

/**
 * A drain in flight for longer than this is treated as dead, so a new one may start.
 *
 * A bare boolean latch cannot recover from a hung request. Comfortably above
 * `SYNC_TIMEOUT_MS` so a slow-but-alive request is never cut in on.
 */
const STALE_DRAIN_MS = SYNC_TIMEOUT_MS + 15_000;

/**
 * Records per sync request. Well under the route's `MAX_ITEMS` of 500, and chosen for the
 * BODY size rather than the count: `rawPayload` alone is capped at 4000 characters per
 * contact, so 500 records can approach Vercel's 4.5 MB request-body limit and earn a 413 the
 * route never even sees. A 413 is a `classifyStatus` 'permanent', so before chunking one
 * oversized batch could mark hundreds of individually-perfect captures as blocked, after which
 * the auto-drain refused to attempt them at all. Chunking makes that unreachable.
 */
const SYNC_CHUNK = 100;

/**
 * What every queued record carries about its own failures.
 *
 * `attempts` and `lastError` existed and were WRITE-ONLY — `markContactFailed()` maintained
 * them faithfully and no screen ever read either one, which is how a capture could be rejected
 * on identical grounds forty times while the UI said it would "upload on their own". `blocked`
 * is what makes the state visible: it means the server has refused on the merits, so this
 * record is not going to move without the user doing something.
 *
 * `blocked` is RE-EVALUATED on every drain, never latched. A folder can be recreated and a
 * name can be typed in, and when that happens the record must heal on its own rather than
 * wearing a permanent mark from a condition that has passed — the same reasoning as
 * `Contact.contactKey` being recomputed rather than frozen.
 */
interface QueueFailureState {
  /** Failed attempts so far, across all drains. */
  attempts?: number;
  lastError?: string;
  /** Set when the server refused on the merits. Cleared again if a later drain is merely unlucky. */
  blocked?: boolean;
  blockedReason?: string;
  /**
   * WHICH SIGNED-IN USER CAPTURED THIS.
   *
   * IndexedDB is per-origin, not per-account, and sign-out deliberately does not clear it —
   * `app/settings/page.tsx` purges Cache Storage only, precisely so captures survive. Without
   * an owner stamp, `drain()` posts whatever it finds as whoever happens to be signed in now.
   * Sign out, sign in with a second Google account — the exact scenario `sw.js` was bumped to
   * v3 for — and account A's queued people are posted as account B, refused `folder-not-found`
   * because B does not own A's folders, marked permanently blocked, and then LISTED BY NAME on
   * B's screen with Discard as the only option. A's captures become unrecoverable at the same
   * time, since the reason is pinned to a folder id B will never own.
   *
   * So it is the outbox analogue of v3's network-only rule: same class of leak, in the one
   * store the v3 cache sweep cannot touch.
   *
   * Optional because records written before this field existed have no owner. Those are drained
   * as before rather than stranded — one account per device is the overwhelmingly common case,
   * and refusing to upload somebody's real captures on a technicality would be the worse bug.
   */
  queuedFor?: string;
}

export interface QueuedFolderRecord extends QueueFailureState {
  clientId: string;
  name: string;
  eventDate?: string;
  venue?: string;
  note?: string;
  queuedAt: number;
}

export interface QueuedContactRecord extends ContactInput, QueueFailureState {
  queuedAt: number;
}

/** One stuck record, flattened for the UI that offers to retry, move or discard it. */
export interface BlockedCapture {
  kind: 'contact' | 'folder';
  clientId: string;
  /** The person's name, or the folder's. */
  label: string;
  reason: string;
  attempts: number;
  queuedAt: number;
  /** Contacts only: the folder it is aimed at, so "move it somewhere that exists" is offerable. */
  folderId?: string;
}

/* ────────────────────────────── who owns the queue ────────────────────────────── */

let owner: string | null = null;

/**
 * Tell the outbox which account is signed in.
 *
 * Called by `<OutboxOwner />` inside the session provider, so it tracks sign-in and sign-out
 * for every page without each capture site having to pass a session down. `null` means signed
 * out, which is why `drain()` treats an unknown owner as "do not send" rather than "send
 * everything".
 */
export function setOutboxOwner(userId: string | null): void {
  if (owner === userId) return;
  owner = userId;
  notify();
}

export function outboxOwner(): string | null {
  return owner;
}

/* ────────────────────────────── lapsed session ────────────────────────────── */

let authExpiredAt: number | null = null;

/**
 * Remember that the server said 401, so a banner can say so without the user pressing anything.
 *
 * A 401 marks no record — correctly, the records are fine — but `startAutoDrain()`'s trigger is
 * `void drain()`, which discards the result. So a session lapsing mid-event (a conference day
 * outlasts a token) put the queue into a silent infinite retry: one POST on every
 * `visibilitychange` and every `online` event, forever, all 401, with the banner still promising
 * "they will upload on their own" and nothing anywhere offering a sign-in. Holding the state
 * here is what lets the banner switch to an auth variant with a link to /login.
 */
function noteAuthExpired(): void {
  authExpiredAt = Date.now();
  notify();
}

/** Cleared by any drain that gets a non-401 answer, so signing back in heals the banner. */
function clearAuthExpired(): void {
  if (authExpiredAt === null) return;
  authExpiredAt = null;
  notify();
}

export function authExpired(): boolean {
  return authExpiredAt !== null;
}

/** Is this record ours to upload? Unstamped legacy records are, on purpose — see `queuedFor`. */
function ownedByCurrentUser(record: QueueFailureState): boolean {
  return record.queuedFor === undefined || record.queuedFor === owner;
}

/** A client-generated id, which is the idempotency key the server dedupes on. */
export function newClientId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // randomUUID needs a secure context. Fall back rather than throw, so a scan is never lost
  // for want of an id.
  return `cid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/* ────────────────────────────── IndexedDB plumbing ────────────────────────────── */

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB is unavailable'));
  }
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      // Keyed by clientId so a re-queue of the same capture overwrites rather than
      // duplicating — the same guarantee the server's unique index gives.
      if (!db.objectStoreNames.contains(CONTACTS)) {
        db.createObjectStore(CONTACTS, { keyPath: 'clientId' });
      }
      if (!db.objectStoreNames.contains(FOLDERS)) {
        db.createObjectStore(FOLDERS, { keyPath: 'clientId' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open the outbox'));
  });

  // A failed open must not be cached forever, or the queue is dead for the session.
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  return openDb().then(
    db =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(store, mode);
        const request = run(transaction.objectStore(store));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('Outbox write failed'));
      })
  );
}

/* ────────────────────────────── queue + read ────────────────────────────── */

export async function queueContact(record: ContactInput, blockedReason?: string): Promise<void> {
  // A blank `clientId` would be stored under an unusable key AND echoed back by the server as
  // the literal '(missing)', which matches nothing on the way home — so the record's verdict is
  // silently discarded and it sits in the queue forever, counted as waiting and appearing in no
  // blocked list. Mint one rather than refuse: an id is recoverable, a person is not.
  const clientId = record.clientId?.trim() || newClientId();
  await tx<IDBValidKey>(CONTACTS, 'readwrite', s =>
    s.put({
      ...record,
      clientId,
      queuedAt: Date.now(),
      ...(owner ? { queuedFor: owner } : {}),
      // Queued already-blocked when the server has ALREADY refused this exact record. Waiting
      // for a drain to rediscover that would show the user a reassuring "will upload on their
      // own" for the seconds or minutes until the next one, which is the wrong first
      // impression to give about a capture that is not going anywhere.
      ...(blockedReason ? { blocked: true, blockedReason, attempts: 1, lastError: blockedReason } : {}),
    } satisfies QueuedContactRecord)
  );
  notify();
}

/* ────────────────────────────── the one capture path ────────────────────────────── */

export type SaveOutcome = 'saved' | 'queued' | 'blocked' | 'auth' | 'lost';

export interface SaveResult {
  outcome: SaveOutcome;
  /** What to tell the user. Set on everything except `saved`. */
  reason?: string;
  /** The stored document, on `saved`. */
  contact?: unknown;
}

/**
 * Queue a record, and never let the queue write itself throw at a call site.
 *
 * `tx()` REJECTS when `openDb()` fails or a write fails — iOS Safari private browsing, storage
 * quota pressure, a blocked version upgrade. Every `await queueContact(record)` in `saveContact`
 * sat on a path with no handler, and the one inside the fetch `catch` block would escape
 * `saveContact` entirely. No call site wrapped it, so the `setSaving(false)` on the following
 * line never ran: the Save button stayed disabled reading "Saving…", the sheet never closed, no
 * toast appeared, and the capture existed nowhere at all. The user is standing in front of the
 * person with a frozen button and no way to know the scan was lost.
 *
 * 'lost' is the honest outcome for that, and it is the ONLY one that means the record is gone.
 * It exists so the UI can say "write this down" instead of freezing.
 */
async function queueOrReport(record: ContactInput, blockedReason?: string): Promise<SaveResult> {
  try {
    await queueContact(record, blockedReason);
  } catch {
    return {
      outcome: 'lost',
      reason: 'This device would not store the capture. Write their details down — nothing was saved.',
    };
  }
  if (blockedReason) return { outcome: 'blocked', reason: blockedReason };
  return { outcome: 'queued', reason: 'Saved on this device. It will upload on its own.' };
}

/**
 * Save one captured person: post it, and on failure decide honestly what happened to it.
 *
 * EVERY CAPTURE SITE MUST GO THROUGH HERE — `/scan`, the manual-add sheet in a folder, and the
 * "save them to a folder" button on a shared card. All three previously wrote their own
 * version of this, all three wrote the same four lines, and all three had the same bug in
 * them:
 *
 *     if (!res.ok) throw new Error(`HTTP ${res.status}`);   // caught below
 *     … catch { await queueContact(record); }               // "the network ate it"
 *
 * Three copies is why it is worth one exported function rather than a fix repeated three
 * times: the next capture surface added to this app inherits the correct behaviour instead of
 * copying the nearest neighbour, which is how this got to three copies in the first place.
 *
 * The outcomes map onto what the user should be told, not onto HTTP:
 *
 *   'saved'    On the server. Nothing queued.
 *   'queued'   Nobody formed an opinion. Queued, and it will go on its own — this is the
 *              normal case in a conference hall, not an error.
 *   'auth'     Session lapsed. Queued, and it will go once they sign in. Do not blame the
 *              network and do not offer to discard a perfectly good capture.
 *   'blocked'  Refused on the merits. STILL QUEUED — nothing here loses a person — but
 *              flagged, so the folders page can say what is wrong and offer a way out.
 */
export async function saveContact(record: ContactInput): Promise<SaveResult> {
  let response: Response;
  try {
    response = await fetch('/api/contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(record),
      // Without this a hall network that accepts the connection and stops answering leaves the
      // Save button spinning with no ceiling.
      signal: AbortSignal.timeout(SAVE_TIMEOUT_MS),
    });
  } catch {
    // `fetch` rejected or timed out, so there is no response and the server formed no opinion.
    // This is the ONLY case that is genuinely "the request never left", and the only one the
    // original code was actually right about.
    return queueOrReport(record);
  }

  if (response.ok) {
    /**
     * A 2xx IS NOT PROOF THE API ANSWERED, and assuming it was is how a capture vanished.
     *
     * Captive-portal Wi-Fi — the standard conference-hall condition this entire queue exists
     * for — answers every request with 200 and an HTML sign-in interstitial (directly, or via a
     * redirect `fetch` follows for us). `response.ok` is then true, `.json()` throws on the
     * HTML, and the old `.catch(() => ({}))` swallowed that and returned `outcome: 'saved'`
     * with `contact: undefined`. The scanner printed "Saved <name>", the record was never
     * queued, and the person was neither on the server nor on the device — the one outcome
     * this module's header promises is impossible. Worse than stuck, because nothing counted it.
     *
     * So a success has to be EVIDENCED: the body must parse and must carry the document the API
     * returns. Anything else is not a success, and the record goes to the queue where it
     * belongs.
     */
    const data = (await response.json().catch(() => null)) as
      | { contact?: unknown; created?: unknown }
      | null;
    if (data && typeof data === 'object' && data.contact) {
      return { outcome: 'saved', contact: data.contact };
    }
    return queueOrReport(record);
  }

  const body = (await response.json().catch(() => ({}))) as { error?: string; refusal?: string };
  const kind = classifyStatus(response.status);

  if (kind === 'auth') {
    noteAuthExpired();
    const queued = await queueOrReport(record);
    if (queued.outcome === 'lost') return queued;
    return {
      outcome: 'auth',
      reason: 'Your session expired. Sign in again and this will upload.',
    };
  }

  if (kind === 'permanent') {
    return queueOrReport(record, refusalMessage(body.refusal, body.error));
  }

  return queueOrReport(record);
}

/**
 * Create a folder, with the same three outcomes as a capture.
 *
 * `NewFolderSheet` kept the pre-fix shape this module was rewritten to eliminate — `if (!res.ok)
 * throw` and queue in the `catch` — so a 400 or 403 from `POST /api/folders` was queued as if
 * the network had eaten it, and a captive-portal 200 with HTML called `onCreated()` for a folder
 * that was never created and never queued.
 *
 * 409 is handled by the caller rather than here: a name clash is not a queueing decision, it is
 * a question for the person typing the name.
 */
export interface SaveFolderResult {
  outcome: SaveOutcome | 'name-taken';
  reason?: string;
  folder?: unknown;
}

export async function saveFolder(
  record: Omit<QueuedFolderRecord, 'queuedAt'>
): Promise<SaveFolderResult> {
  const body = {
    name: record.name,
    eventDate: record.eventDate,
    venue: record.venue,
    note: record.note,
  };

  let response: Response;
  try {
    response = await fetch('/api/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SAVE_TIMEOUT_MS),
    });
  } catch {
    return queueFolderOrReport(record);
  }

  if (response.ok) {
    const data = (await response.json().catch(() => null)) as { folder?: unknown } | null;
    if (data && typeof data === 'object' && data.folder) {
      return { outcome: 'saved', folder: data.folder };
    }
    // Same evidence rule as `saveContact`: a 200 that is not the API's JSON is a portal, not a
    // created folder.
    return queueFolderOrReport(record);
  }

  if (response.status === 409) {
    return { outcome: 'name-taken', reason: 'You already have a folder with that name.' };
  }

  const parsed = (await response.json().catch(() => ({}))) as { error?: string; refusal?: string };
  const kind = classifyStatus(response.status);

  if (kind === 'auth') {
    noteAuthExpired();
    const queued = await queueFolderOrReport(record);
    if (queued.outcome === 'lost') return queued;
    return { outcome: 'auth', reason: 'Your session expired. Sign in again and this will upload.' };
  }
  if (kind === 'permanent') {
    return queueFolderOrReport(record, refusalMessage(parsed.refusal, parsed.error));
  }
  return queueFolderOrReport(record);
}

async function queueFolderOrReport(
  record: Omit<QueuedFolderRecord, 'queuedAt'>,
  blockedReason?: string
): Promise<SaveFolderResult> {
  try {
    await queueFolder(record, blockedReason);
  } catch {
    return {
      outcome: 'lost',
      reason: 'This device would not store the folder. Nothing was saved.',
    };
  }
  if (blockedReason) return { outcome: 'blocked', reason: blockedReason };
  return { outcome: 'queued', reason: 'Saved on this device. It will upload on its own.' };
}

export async function queueFolder(
  record: Omit<QueuedFolderRecord, 'queuedAt'>,
  blockedReason?: string
): Promise<void> {
  const clientId = record.clientId?.trim() || newClientId();
  await tx<IDBValidKey>(FOLDERS, 'readwrite', s =>
    s.put({
      ...record,
      clientId,
      queuedAt: Date.now(),
      ...(owner ? { queuedFor: owner } : {}),
      // `queueContact` grew this parameter and `queueFolder` did not, which meant a folder could
      // only ever be queued as "waiting" — so a refusal from `POST /api/folders` was filed under
      // "the network ate it" and the user learned nothing until a later drain rediscovered it.
      ...(blockedReason ? { blocked: true, blockedReason, attempts: 1, lastError: blockedReason } : {}),
    } satisfies QueuedFolderRecord)
  );
  notify();
}

export async function pendingContacts(): Promise<QueuedContactRecord[]> {
  try {
    const all = await tx<QueuedContactRecord[]>(CONTACTS, 'readonly', s => s.getAll());
    return all.sort((a, b) => a.queuedAt - b.queuedAt);
  } catch {
    return [];
  }
}

export async function pendingFolders(): Promise<QueuedFolderRecord[]> {
  try {
    const all = await tx<QueuedFolderRecord[]>(FOLDERS, 'readonly', s => s.getAll());
    return all.sort((a, b) => a.queuedAt - b.queuedAt);
  } catch {
    return [];
  }
}

/**
 * `pendingCount()` IS GONE ON PURPOSE. Use `pendingSummary()`.
 *
 * It summed folders and contacts into one number, which is the exact conflation that made the
 * original bug unreadable: "1 capture not synced yet … will upload on their own" was a true
 * statement about a record waiting for signal, a lie about one the server had refused, and it
 * called a folder a capture. Leaving a dead export behind that models the discredited shape is
 * an invitation for the next capture surface to import it and reintroduce the misleading count.
 */

/**
 * The queue split by whether it is actually going anywhere.
 *
 * A single total is what made the bug unreadable: "1 capture not synced yet … will upload on
 * their own" is a true statement about a record waiting for signal and a false one about a
 * record the server has already refused, and the user cannot tell which they have.
 */
export interface PendingSummary {
  /** Records that will upload as soon as there is a network. */
  waiting: number;
  /** Records the server has refused on the merits. These need a decision from the user. */
  blocked: number;
  /** Records captured under a DIFFERENT account. Not ours to upload and not ours to show. */
  otherAccount: number;
  /** How many of `waiting` are folders — so a banner never calls a folder a "capture". */
  waitingFolders: number;
  /** Ours, whatever their state: `waiting + blocked`. */
  total: number;
  /** The server last said 401. The records are fine; the session is not. */
  authExpired: boolean;
}

export async function pendingSummary(): Promise<PendingSummary> {
  const [contacts, folders] = await Promise.all([pendingContacts(), pendingFolders()]);
  const all = [...contacts, ...folders];
  const mine = all.filter(ownedByCurrentUser);
  const blocked = mine.filter(r => r.blocked).length;
  return {
    waiting: mine.length - blocked,
    blocked,
    otherAccount: all.length - mine.length,
    waitingFolders: folders.filter(f => ownedByCurrentUser(f) && !f.blocked).length,
    total: mine.length,
    authExpired: authExpired(),
  };
}

/**
 * Clear a record's blocked mark and let the next drain judge it again.
 *
 * The blocked list used to offer Discard and nothing else, which for the realistic refusal —
 * `folder-not-found`, i.e. the folder was deleted after the scan — meant the only button on
 * screen destroyed a real person's details. Retrying is the other half: the condition may have
 * passed, and `blocked` was always designed to be re-derived rather than latched.
 */
export async function retryCapture(kind: 'contact' | 'folder', clientId: string): Promise<void> {
  const store = kind === 'contact' ? CONTACTS : FOLDERS;
  const record = await tx<QueuedContactRecord | QueuedFolderRecord | undefined>(
    store,
    'readonly',
    s => s.get(clientId) as IDBRequest<QueuedContactRecord | QueuedFolderRecord | undefined>
  );
  if (!record) return;
  const cleared = { ...record };
  delete cleared.blocked;
  delete cleared.blockedReason;
  await tx<IDBValidKey>(store, 'readwrite', s => s.put(cleared));
  notify();
}

/**
 * Repoint a queued contact at a different folder, and unblock it.
 *
 * This is what makes `folder-not-found` and `no-folder` RECOVERABLE instead of only
 * discardable. The write is local — the record has never reached the server, so there is nothing
 * to PATCH; `app/folders/[id]` tried to edit a pending row by PATCHing `/api/contacts/pending:<id>`,
 * which cannot resolve, and then rolled back against an array that never held the row, so the
 * edit was a silent no-op behind "Could not save that change."
 */
export async function moveQueuedContact(clientId: string, folderId: string): Promise<void> {
  const record = await tx<QueuedContactRecord | undefined>(CONTACTS, 'readonly', s =>
    s.get(clientId) as IDBRequest<QueuedContactRecord | undefined>
  );
  if (!record) return;
  const moved: QueuedContactRecord = { ...record, folderId };
  delete moved.folderClientId;
  delete moved.blocked;
  delete moved.blockedReason;
  await tx<IDBValidKey>(CONTACTS, 'readwrite', s => s.put(moved));
  notify();
}

/**
 * Every stuck record OF THE CURRENT USER, so the UI can name it rather than counting it.
 *
 * The ownership filter is not cosmetic: without it, switching Google accounts made this list
 * display the previous account's captured people, by name, to somebody else.
 */
export async function blockedCaptures(): Promise<BlockedCapture[]> {
  const [contacts, folders] = await Promise.all([pendingContacts(), pendingFolders()]);
  const rows: BlockedCapture[] = [
    ...folders
      .filter(f => f.blocked && ownedByCurrentUser(f))
      .map(f => ({
        kind: 'folder' as const,
        clientId: f.clientId,
        label: f.name || 'Untitled folder',
        reason: f.blockedReason ?? f.lastError ?? 'The server refused this folder.',
        attempts: f.attempts ?? 0,
        queuedAt: f.queuedAt,
      })),
    ...contacts
      .filter(c => c.blocked && ownedByCurrentUser(c))
      .map(c => ({
        kind: 'contact' as const,
        clientId: c.clientId,
        label: c.name || 'Unnamed capture',
        reason: c.blockedReason ?? c.lastError ?? 'The server refused this capture.',
        attempts: c.attempts ?? 0,
        queuedAt: c.queuedAt,
        folderId: c.folderId,
      })),
  ];
  // Folders first, matching the order they sync in — a blocked folder is often the reason its
  // contacts are blocked, so it is the row worth reading first.
  return rows;
}

async function removeContact(clientId: string): Promise<void> {
  await tx<undefined>(CONTACTS, 'readwrite', s => s.delete(clientId));
}

async function removeFolder(clientId: string): Promise<void> {
  await tx<undefined>(FOLDERS, 'readwrite', s => s.delete(clientId));
}

/**
 * Throw a queued record away at the user's explicit request.
 *
 * The ONLY sanctioned way a record leaves the queue unconfirmed, and it exists because the
 * alternative turned out to be worse. `outbox.ts` has always guaranteed that nothing is
 * dropped without the server's say-so, and that is right for every automatic path — but with
 * no manual escape a capture the server will refuse forever became furniture: a permanent
 * warning banner the user learns to ignore, which is how the next real unsynced capture gets
 * missed. Discarding is a decision a person makes about one named row they can see, which is
 * a different act from a retry loop silently giving up.
 */
export async function discardContact(clientId: string): Promise<void> {
  await removeContact(clientId);
  notify();
}

export async function discardFolder(clientId: string): Promise<void> {
  await removeFolder(clientId);
  notify();
}

async function markContactFailed(
  record: QueuedContactRecord,
  error: string,
  kind: FailureKind
): Promise<void> {
  await tx<IDBValidKey>(CONTACTS, 'readwrite', s =>
    s.put({
      ...record,
      attempts: (record.attempts ?? 0) + 1,
      lastError: error,
      // Assigned on BOTH branches, so a record that was blocked by a condition since fixed
      // (folder recreated, name supplied) stops being blocked without anybody clearing it.
      blocked: kind === 'permanent',
      blockedReason: kind === 'permanent' ? error : undefined,
    })
  );
}

/** The folder equivalent, which did not exist: a failed folder recorded nothing at all. */
async function markFolderFailed(
  record: QueuedFolderRecord,
  error: string,
  kind: FailureKind
): Promise<void> {
  await tx<IDBValidKey>(FOLDERS, 'readwrite', s =>
    s.put({
      ...record,
      attempts: (record.attempts ?? 0) + 1,
      lastError: error,
      blocked: kind === 'permanent',
      blockedReason: kind === 'permanent' ? error : undefined,
    })
  );
}

/**
 * Rewrite queued contacts to point at a folder's REAL id once the server has minted one.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * THIS FIXES A SECOND, INDEPENDENT WAY A CAPTURE COULD GET STUCK FOREVER, and the giveaway
 * was that `drain()`'s own docblock described this behaviour while the code never did it: it
 * read `result.folders` and `result.contacts` and ignored `result.folderMap` entirely.
 *
 * The sequence, all of it ordinary use:
 *
 *   1. Make a folder on the way to the venue with no signal → queued with a `clientId`.
 *   2. Scan people into it → each contact queued carrying `folderClientId`, since the folder
 *      has no real id yet.
 *   3. Signal returns. One drain sends the folder and the contacts together. The FOLDER
 *      succeeds, so it is deleted from IndexedDB. A contact fails transiently — a timeout on
 *      a saturated hall network, which is the exact condition this queue was built for.
 *   4. Every later drain sends that contact with a `folderClientId` and NO folder alongside
 *      it, because the folder is gone from the queue. `folderMap` comes back empty, the
 *      server can resolve nothing, and the contact is refused "No folder for this contact".
 *
 * The folder exists. The contact belongs to it. Neither is malformed. And the record can never
 * succeed again, because the one thing that could have connected them — the mapping in step 3
 * — was thrown away. Worse, it presents as exactly the symptom under investigation: a count
 * stuck at 1 under a banner promising it will upload on its own.
 *
 * So the map is applied the moment it arrives, converting `folderClientId` into a durable
 * `folderId`. After that the contact no longer depends on its folder still being queued.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 */
async function applyFolderMap(folderMap: Record<string, string>): Promise<void> {
  const entries = Object.entries(folderMap);
  if (!entries.length) return;

  const queued = await pendingContacts();
  for (const record of queued) {
    const realId = record.folderClientId ? folderMap[record.folderClientId] : undefined;
    if (!realId || record.folderId === realId) continue;
    // `folderClientId` is DELETED, not merely superseded. Leaving it in place would keep the
    // server's `(folderClientId && folderMap[…]) || folderId` preferring a client id that is
    // about to stop resolving — the same trap, one step later.
    const rewritten: QueuedContactRecord = { ...record, folderId: realId };
    delete rewritten.folderClientId;
    await tx<IDBValidKey>(CONTACTS, 'readwrite', s => s.put(rewritten));
  }
}
/* ────────────────────────────── drain ────────────────────────────── */

/** Why a drain did nothing. One reason each, because the three read completely differently. */
export type SkipReason =
  /** Queue is empty. */
  | 'empty'
  /** Another drain is already in flight. */
  | 'busy'
  /** The browser says there is no network. Only ever an automatic-path decision. */
  | 'offline'
  /** Signed out — nothing may be uploaded on nobody's behalf. */
  | 'no-owner'
  /** Every queued record is one the server has already refused. Automatic path only. */
  | 'all-blocked';

export interface DrainResult {
  /**
   * How many records were sent — CONTACTS AND FOLDERS BOTH.
   *
   * It used to be `contacts.length` on every return path, so a queue holding one folder and no
   * contacts reported `attempted: 0, failed: 0` after a hard failure. The folders page then had
   * a non-zero pending count and a drain result claiming nothing had even been tried, which is
   * unreadable as a bug report and unusable as a status line.
   */
  attempted: number;
  /** Contacts confirmed. */
  synced: number;
  /**
   * Folders confirmed, counted SEPARATELY and not folded into `synced`.
   *
   * The folder loop used to confirm-and-remove without incrementing anything, so a folder-only
   * queue — create a folder offline, come back online, press Sync now — uploaded successfully and
   * reported `synced: 0`. Both callers gate their reload on `synced > 0`, so the folder never
   * appeared in the grid and /scan printed "Still offline" immediately after a successful
   * upload. Two of the three "Sync now does nothing" reports trace to this line.
   */
  foldersSynced: number;
  failed: number;
  /** Of `failed`, how many the server refused on the merits. These will not fix themselves. */
  blocked: number;
  /** True when nothing was tried. `skipReason` says which nothing. */
  skipped: boolean;
  skipReason?: SkipReason;
  /** The session has lapsed. Nothing is wrong with the records; the user needs to sign in. */
  authExpired?: boolean;
  /**
   * The server answered and refused the UPLOAD ITSELF, rather than any record in it.
   *
   * Distinct from `blocked`, and the distinction is the fix for a self-inflicted disaster: a
   * batch-level refusal used to be stamped onto every record in the batch, so one 413 marked up
   * to 500 individually-perfect captures as permanently broken, after which the auto-drain
   * refused to attempt them and Discard was the only button on offer. A record is not what is
   * wrong when the envelope is rejected.
   */
  batchRefused?: boolean;
  /** HTTP status, when the request completed and was refused wholesale. */
  status?: number;
  /** Contacts the server accepted, so the UI can replace its pending rows with real ones. */
  saved?: unknown[];
}

function skip(reason: SkipReason): DrainResult {
  return { attempted: 0, synced: 0, foldersSynced: 0, failed: 0, blocked: 0, skipped: true, skipReason: reason };
}

/**
 * When the in-flight drain started, or `null`.
 *
 * A TIMESTAMP RATHER THAN A BOOLEAN, and that is the whole point. The boolean was cleared only
 * in `finally`, so a `fetch` that never settled left it set for the life of the page and every
 * later drain — forced ones included — returned at the guard without attempting anything. The
 * fetch now has a timeout, which should make that impossible; this is the belt to that braces,
 * because "should be impossible" is what the boolean was too.
 */
let drainStartedAt: number | null = null;

interface SyncItemResult {
  clientId: string;
  ok: boolean;
  error?: string;
  permanent?: boolean;
  refusal?: string;
}

interface SyncResponseBody {
  folderMap?: Record<string, string>;
  folders?: SyncItemResult[];
  contacts?: SyncItemResult[];
  saved?: unknown[];
}

/**
 * Apply one chunk's per-item verdicts.
 *
 * RESULTS ARE CORRELATED BY INDEX, NOT BY THE ECHOED `clientId`. The route pushes exactly one
 * result per input item in input order, so the index is exact — whereas the echo is not: it is
 * `clientId.trim()`, and for a blank id the route substitutes the literal `'(missing)'`, which by
 * construction matches no IndexedDB key. The old `contacts.find(c => c.clientId === item.clientId)`
 * then silently found nothing and dropped the verdict, while `failed++` and `blocked++` still
 * counted it — so `DrainResult.blocked` and `pendingSummary().blocked` disagreed and the row was
 * invisible in exactly the way this rewrite exists to prevent.
 *
 * If the lengths ever disagree the response is not the contract, so nothing is applied by index
 * and we fall back to the id — a mismatch must not mis-assign one person's verdict to another.
 */
async function applyItemResults<T extends QueuedContactRecord | QueuedFolderRecord>(
  sent: T[],
  results: SyncItemResult[] | undefined,
  remove: (clientId: string) => Promise<void>,
  mark: (record: T, reason: string, kind: FailureKind) => Promise<void>
): Promise<{ confirmed: number; failed: number; blocked: number }> {
  const items = results ?? [];
  const aligned = items.length === sent.length;
  if (!aligned && items.length) {
    console.warn(
      `[outbox] sync returned ${items.length} results for ${sent.length} records; falling back to id matching`
    );
  }

  let confirmed = 0;
  let failed = 0;
  let blocked = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const record = aligned ? sent[i] : sent.find(r => r.clientId === item.clientId);

    if (item.ok) {
      // Removal is keyed on OUR id, never the echo — a trimmed or substituted echo would
      // otherwise delete nothing and the record would re-upload forever (harmlessly, thanks to
      // `clientId` idempotency, but permanently).
      await remove(record?.clientId ?? item.clientId);
      confirmed++;
      continue;
    }

    failed++;
    const kind: FailureKind = item.permanent ? 'permanent' : 'transient';
    if (kind === 'permanent') blocked++;
    if (record) {
      await mark(record, refusalMessage(item.refusal, item.error), kind);
    } else {
      // An unmatched result is a contract violation, not a record to ignore. Say so loudly
      // rather than dropping a verdict on the floor, which is what used to happen.
      console.error('[outbox] sync result matched no queued record', item);
    }
  }

  return { confirmed, failed, blocked };
}

/**
 * Push everything queued to the server and remove what it confirms.
 *
 * FOLDERS GO FIRST, and in the FIRST CHUNK, because a contact captured offline may belong to a
 * folder that also only exists offline; the response's `folderMap` resolves the client id to a
 * real one and `applyFolderMap()` makes that durable.
 *
 * A record is removed ONLY when the server confirms it — including when it reports the record as
 * a duplicate, which means an earlier attempt actually succeeded and the response was lost. A
 * record that fails for any other reason stays queued, because the alternative is losing a
 * person. Nothing in this function ever discards a capture; only `discardContact` /
 * `discardFolder`, at the user's explicit request, can do that.
 */
export async function drain(options: { force?: boolean } = {}): Promise<DrainResult> {
  const now = Date.now();
  if (drainStartedAt !== null && now - drainStartedAt < STALE_DRAIN_MS) return skip('busy');

  /**
   * `force` OUTRANKS `navigator.onLine`, and the order used to be the other way round.
   *
   * `onLine` is a heuristic that is wrong in exactly the situations this app is used in: it
   * reports false behind captive portals, during VPN transitions, and in several documented
   * Windows and Android states where HTTP works perfectly. Checking it before `force` meant
   * "Sync now" did literally nothing on the browser's word alone, judged no record, and reported
   * "Could not reach the server" without having attempted one request. A person pressing a
   * button is better evidence than a flag.
   */
  if (!options.force && typeof navigator !== 'undefined' && navigator.onLine === false) {
    return skip('offline');
  }

  drainStartedAt = now;
  try {
    const [allContacts, allFolders] = await Promise.all([pendingContacts(), pendingFolders()]);
    const contacts = allContacts.filter(ownedByCurrentUser);
    const folders = allFolders.filter(ownedByCurrentUser);
    const queued = [...contacts, ...folders];

    if (!queued.length) {
      // Distinguish "yours is empty" from "there are records but they belong to someone else",
      // so the UI can tell the user to sign back in rather than reporting all-clear.
      return skip(allContacts.length + allFolders.length > 0 ? 'no-owner' : 'empty');
    }

    /**
     * An automatic drain does not re-post a queue that is entirely blocked.
     *
     * `startAutoDrain()` fires on every `visibilitychange` and every `online` event, so a single
     * doomed record otherwise means a request every time the user glances at another app —
     * forever, achieving nothing. An explicit "Sync now" always goes, because the user may well
     * have just fixed the thing that was wrong, and one deliberate request is cheap. The moment
     * ONE record is still waiting the whole batch goes as before: blocked records ride along at
     * no extra cost, and being re-judged is how they unblock themselves.
     */
    if (!options.force && queued.every(r => r.blocked)) return skip('all-blocked');

    /**
     * CHUNKED. Folders all ride in the first request so `folderMap` always precedes the contacts
     * that depend on it.
     */
    const chunks: Array<{ folders: QueuedFolderRecord[]; contacts: QueuedContactRecord[] }> = [];
    for (let i = 0; i < Math.max(1, Math.ceil(contacts.length / SYNC_CHUNK)); i++) {
      chunks.push({
        folders: i === 0 ? folders : [],
        contacts: contacts.slice(i * SYNC_CHUNK, (i + 1) * SYNC_CHUNK),
      });
    }

    let synced = 0;
    let foldersSynced = 0;
    let failed = 0;
    let blocked = 0;
    const saved: unknown[] = [];
    let folderMap: Record<string, string> = {};

    for (const chunk of chunks) {
      if (!chunk.folders.length && !chunk.contacts.length) continue;

      let response: Response;
      try {
        response = await fetch('/api/contacts/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folders: chunk.folders, contacts: chunk.contacts }),
          signal: AbortSignal.timeout(SYNC_TIMEOUT_MS),
        });
      } catch {
        // The request never left, or timed out. Nothing is judged — a request that did not
        // arrive is not evidence about any record in it. Stop rather than hammering the rest of
        // the chunks against a network that just failed.
        return {
          attempted: queued.length,
          synced,
          foldersSynced,
          failed,
          blocked,
          skipped: false,
        };
      }

      if (!response.ok) {
        /**
         * THE ENVELOPE WAS REFUSED, NOT THE RECORDS — so no record is marked, whatever the
         * status. This is the corrected version of a rule that did real damage: marking every
         * record on a `classifyStatus` 'permanent' turned one 413 into hundreds of permanently
         * blocked captures, each individually acceptable, and then the all-blocked guard above
         * stopped the auto-drain from ever retrying them.
         *
         * The three kinds still read differently to a person, which is what the flags are for:
         * 401 is "sign in", a 5xx is "we will keep trying", and a permanent batch refusal (413,
         * or a 404 meaning the route is not deployed) is "the upload itself is being rejected" —
         * a report, not a verdict on anybody's contact details.
         */
        const kind = classifyStatus(response.status);
        if (kind === 'auth') noteAuthExpired();
        else clearAuthExpired();
        return {
          attempted: queued.length,
          synced,
          foldersSynced,
          failed: failed + chunk.folders.length + chunk.contacts.length,
          blocked,
          skipped: false,
          authExpired: kind === 'auth',
          batchRefused: kind === 'permanent',
          status: response.status,
        };
      }

      clearAuthExpired();

      /**
       * A 200 IS NOT PROOF THE API ANSWERED — same rule as `saveContact`, same reason. An
       * unguarded `await response.json()` on a captive-portal HTML body threw into the outer
       * catch-all, which returned `attempted: 0` and was reported to the user as "offline" for a
       * server that had in fact answered.
       */
      const body = (await response.json().catch(() => null)) as SyncResponseBody | null;
      if (!body || (!Array.isArray(body.folders) && !Array.isArray(body.contacts))) {
        return {
          attempted: queued.length,
          synced,
          foldersSynced,
          failed: failed + chunk.folders.length + chunk.contacts.length,
          blocked,
          skipped: false,
          batchRefused: true,
          status: response.status,
        };
      }

      folderMap = { ...folderMap, ...(body.folderMap ?? {}) };

      const folderOutcome = await applyItemResults(
        chunk.folders,
        body.folders,
        removeFolder,
        markFolderFailed
      );
      const contactOutcome = await applyItemResults(
        chunk.contacts,
        body.contacts,
        removeContact,
        markContactFailed
      );

      foldersSynced += folderOutcome.confirmed;
      synced += contactOutcome.confirmed;
      failed += folderOutcome.failed + contactOutcome.failed;
      blocked += folderOutcome.blocked + contactOutcome.blocked;
      if (Array.isArray(body.saved)) saved.push(...body.saved);
    }

    /**
     * LAST, and the order is load-bearing.
     *
     * `markContactFailed()` writes the whole in-memory `record`, which still carries the pre-map
     * `folderClientId`. Applying the map first would have every transiently-failed contact
     * immediately overwritten back to its old reference — undoing the fix on exactly the records
     * that need it, and only on those, which is the sort of thing that looks like it works right
     * up until a contact fails once.
     */
    await applyFolderMap(folderMap);

    notify();
    return {
      attempted: queued.length,
      synced,
      foldersSynced,
      failed,
      blocked,
      skipped: false,
      saved,
    };
  } catch {
    // A local failure — IndexedDB unavailable, a read rejected. Nothing is judged.
    return { attempted: 0, synced: 0, foldersSynced: 0, failed: 0, blocked: 0, skipped: false };
  } finally {
    drainStartedAt = null;
  }
}

/* ────────────────────────────── change notification ────────────────────────────── */

type Listener = () => void;
const listeners = new Set<Listener>();

/** Subscribe to queue changes, so a pending badge stays accurate without polling. */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // A broken listener must not stop the others, or a UI bug becomes a data bug.
    }
  }
}

/**
 * Wire the foreground drain triggers.
 *
 * These ARE the sync mechanism, not a fallback: Background Sync is Chromium-only and is not
 * wired in this app. Returns a teardown function.
 */
export function startAutoDrain(): () => void {
  if (typeof window === 'undefined') return () => {};

  /**
   * A lapsed session backs the automatic path off for this long.
   *
   * Without it, a token that expires mid-event means one doomed POST on every
   * `visibilitychange` — so every glance at another app and back — forever, all 401, while the
   * banner keeps promising the upload. The banner now reads `authExpired()` and offers a sign-in
   * link, so the retries were achieving nothing but noise. `online` still fires through, because
   * a network change is genuinely new information.
   */
  const AUTH_BACKOFF_MS = 5 * 60_000;
  let lastAuthSkip = 0;

  // Not `force`: an automatic trigger declines to re-post a queue that is entirely blocked.
  // See the note in `drain()` — the user's own "Sync now" passes `{ force: true }` and always
  // goes, because a person pressing a button is evidence that something may have changed.
  const run = (ignoreAuthBackoff = false) => {
    if (!ignoreAuthBackoff && authExpired() && Date.now() - lastAuthSkip < AUTH_BACKOFF_MS) return;
    void drain().then(result => {
      if (result.authExpired) lastAuthSkip = Date.now();
    });
  };

  const onOnline = () => run(true);
  const onVisible = () => {
    if (document.visibilityState === 'visible') run();
  };

  window.addEventListener('online', onOnline);
  document.addEventListener('visibilitychange', onVisible);
  // Once on boot, deferred so it never competes with the first paint.
  const timer = setTimeout(() => run(true), 1200);

  return () => {
    window.removeEventListener('online', onOnline);
    document.removeEventListener('visibilitychange', onVisible);
    clearTimeout(timer);
  };
}
