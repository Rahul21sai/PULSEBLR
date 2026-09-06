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

/** One stuck record, flattened for the UI that offers to retry or discard it. */
export interface BlockedCapture {
  kind: 'contact' | 'folder';
  clientId: string;
  /** The person's name, or the folder's. */
  label: string;
  reason: string;
  attempts: number;
  queuedAt: number;
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
  await tx<IDBValidKey>(CONTACTS, 'readwrite', s =>
    s.put({
      ...record,
      queuedAt: Date.now(),
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

export type SaveOutcome = 'saved' | 'queued' | 'blocked' | 'auth';

export interface SaveResult {
  outcome: SaveOutcome;
  /** What to tell the user. Set on everything except `saved`. */
  reason?: string;
  /** The stored document, on `saved`. */
  contact?: unknown;
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
    });
  } catch {
    // `fetch` rejected, so there is no response and the server formed no opinion. This is the
    // ONLY case that is genuinely "the request never left", and the only one the original code
    // was actually right about.
    await queueContact(record);
    return { outcome: 'queued', reason: 'Saved on this device. It will upload on its own.' };
  }

  if (response.ok) {
    const data = (await response.json().catch(() => ({}))) as { contact?: unknown };
    return { outcome: 'saved', contact: data.contact };
  }

  const body = (await response.json().catch(() => ({}))) as { error?: string; refusal?: string };
  const kind = classifyStatus(response.status);

  if (kind === 'auth') {
    await queueContact(record);
    return {
      outcome: 'auth',
      reason: 'Your session expired. Sign in again and this will upload.',
    };
  }

  if (kind === 'permanent') {
    const reason = refusalMessage(body.refusal, body.error);
    await queueContact(record, reason);
    return { outcome: 'blocked', reason };
  }

  await queueContact(record);
  return { outcome: 'queued', reason: 'Saved on this device. It will upload on its own.' };
}

export async function queueFolder(record: Omit<QueuedFolderRecord, 'queuedAt'>): Promise<void> {
  await tx<IDBValidKey>(FOLDERS, 'readwrite', s =>
    s.put({ ...record, queuedAt: Date.now() } satisfies QueuedFolderRecord)
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

export async function pendingCount(): Promise<number> {
  const [contacts, folders] = await Promise.all([pendingContacts(), pendingFolders()]);
  return contacts.length + folders.length;
}

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
  total: number;
}

export async function pendingSummary(): Promise<PendingSummary> {
  const [contacts, folders] = await Promise.all([pendingContacts(), pendingFolders()]);
  const all = [...contacts, ...folders];
  const blocked = all.filter(r => r.blocked).length;
  return { waiting: all.length - blocked, blocked, total: all.length };
}

/** Every stuck record, so the UI can name it rather than counting it. */
export async function blockedCaptures(): Promise<BlockedCapture[]> {
  const [contacts, folders] = await Promise.all([pendingContacts(), pendingFolders()]);
  const rows: BlockedCapture[] = [
    ...folders
      .filter(f => f.blocked)
      .map(f => ({
        kind: 'folder' as const,
        clientId: f.clientId,
        label: f.name || 'Untitled folder',
        reason: f.blockedReason ?? f.lastError ?? 'The server refused this folder.',
        attempts: f.attempts ?? 0,
        queuedAt: f.queuedAt,
      })),
    ...contacts
      .filter(c => c.blocked)
      .map(c => ({
        kind: 'contact' as const,
        clientId: c.clientId,
        label: c.name || 'Unnamed capture',
        reason: c.blockedReason ?? c.lastError ?? 'The server refused this capture.',
        attempts: c.attempts ?? 0,
        queuedAt: c.queuedAt,
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
  synced: number;
  failed: number;
  /** Of `failed`, how many the server refused on the merits. These will not fix themselves. */
  blocked: number;
  /** True when nothing was tried: the queue was empty, we are offline, or a drain is running. */
  skipped: boolean;
  /** The session has lapsed. Nothing is wrong with the records; the user needs to sign in. */
  authExpired?: boolean;
  /** HTTP status, when the request completed and was refused wholesale. */
  status?: number;
  /** Contacts the server accepted, so the UI can replace its pending rows with real ones. */
  saved?: unknown[];
}

const NOTHING: DrainResult = {
  attempted: 0,
  synced: 0,
  failed: 0,
  blocked: 0,
  skipped: true,
};

let draining = false;

/**
 * Push everything queued to the server and remove what it confirms.
 *
 * FOLDERS GO FIRST, in the same request, because a contact captured offline may belong to a
 * folder that also only exists offline; the response's `folderMap` resolves the client id to
 * a real one.
 *
 * A record is removed ONLY when the server confirms it — including when it reports the record
 * as a duplicate, which means an earlier attempt actually succeeded and the response was lost.
 * A record that fails for any other reason stays queued, because the alternative is losing a
 * person.
 */
export async function drain(options: { force?: boolean } = {}): Promise<DrainResult> {
  if (draining) return NOTHING;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return NOTHING;

  draining = true;
  try {
    const [contacts, folders] = await Promise.all([pendingContacts(), pendingFolders()]);
    const queued = [...contacts, ...folders];
    if (!queued.length) return NOTHING;

    /**
     * An automatic drain does not re-post a queue that is entirely blocked.
     *
     * `startAutoDrain()` fires on every `visibilitychange` and every `online` event, so a
     * single doomed record otherwise means a request every time the user glances at another
     * app — forever, achieving nothing. An explicit "Sync now" always goes, because the user
     * may well have just fixed the thing that was wrong, and one deliberate request is cheap.
     * The moment ONE record is still waiting the whole batch goes as before: blocked records
     * ride along at no extra cost, and being re-judged is how they unblock themselves.
     */
    if (!options.force && queued.every(r => r.blocked)) {
      return { ...NOTHING, attempted: 0, blocked: queued.length };
    }

    const response = await fetch('/api/contacts/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folders, contacts }),
    });

    if (!response.ok) {
      /**
       * The whole batch was refused, so no individual record learned anything about itself and
       * none is removed. What the caller needs is WHICH kind of refusal, because the three
       * demand different words on screen and only one of them is the user's problem:
       * a 401 is "sign in again", a 5xx is "we will keep trying", and a 413 means the batch is
       * too big and will be refused identically forever.
       */
      const kind = classifyStatus(response.status);
      if (kind === 'permanent') {
        // Mark every record, so a batch-level dead end is as visible as an item-level one
        // instead of being an invisible no-op on each drain.
        const reason =
          response.status === 413
            ? 'There are too many queued captures to upload in one go.'
            : 'The server refused this upload.';
        for (const record of contacts) await markContactFailed(record, reason, 'permanent');
        for (const record of folders) await markFolderFailed(record, reason, 'permanent');
        notify();
      }
      return {
        attempted: queued.length,
        synced: 0,
        failed: queued.length,
        blocked: kind === 'permanent' ? queued.length : 0,
        skipped: false,
        authExpired: kind === 'auth',
        status: response.status,
      };
    }

    const result = (await response.json()) as {
      folderMap?: Record<string, string>;
      folders?: Array<{ clientId: string; ok: boolean; error?: string; permanent?: boolean; refusal?: string }>;
      contacts?: Array<{ clientId: string; ok: boolean; error?: string; permanent?: boolean; refusal?: string }>;
      saved?: unknown[];
    };

    let synced = 0;
    let failed = 0;
    let blocked = 0;

    for (const item of result.folders ?? []) {
      if (item.ok) {
        await removeFolder(item.clientId);
        continue;
      }
      failed++;
      const kind: FailureKind = item.permanent ? 'permanent' : 'transient';
      if (kind === 'permanent') blocked++;
      const record = folders.find(f => f.clientId === item.clientId);
      if (record) await markFolderFailed(record, refusalMessage(item.refusal, item.error), kind);
    }

    for (const item of result.contacts ?? []) {
      if (item.ok) {
        await removeContact(item.clientId);
        synced++;
        continue;
      }
      failed++;
      const kind: FailureKind = item.permanent ? 'permanent' : 'transient';
      if (kind === 'permanent') blocked++;
      const record = contacts.find(c => c.clientId === item.clientId);
      if (record) await markContactFailed(record, refusalMessage(item.refusal, item.error), kind);
    }

    /**
     * LAST, and the order is load-bearing.
     *
     * `markContactFailed()` writes the whole in-memory `record`, which still carries the
     * pre-map `folderClientId`. Applying the map first would have every transiently-failed
     * contact immediately overwritten back to its old reference — undoing the fix on exactly
     * the records that need it, and only on those, which is the sort of thing that looks like
     * it works right up until a contact fails once.
     */
    await applyFolderMap(result.folderMap ?? {});

    notify();
    return {
      attempted: queued.length,
      synced,
      failed,
      blocked,
      skipped: false,
      saved: result.saved,
    };
  } catch {
    // Offline, or the request never left. Everything stays queued and nothing is judged —
    // a request that did not arrive is not evidence about any record in it.
    return { attempted: 0, synced: 0, failed: 0, blocked: 0, skipped: false };
  } finally {
    draining = false;
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

  // Not `force`: an automatic trigger declines to re-post a queue that is entirely blocked.
  // See the note in `drain()` — the user's own "Sync now" passes `{ force: true }` and always
  // goes, because a person pressing a button is evidence that something may have changed.
  const run = () => {
    void drain();
  };

  const onVisible = () => {
    if (document.visibilityState === 'visible') run();
  };

  window.addEventListener('online', run);
  document.addEventListener('visibilitychange', onVisible);
  // Once on boot, deferred so it never competes with the first paint.
  const timer = setTimeout(run, 1200);

  return () => {
    window.removeEventListener('online', run);
    document.removeEventListener('visibilitychange', onVisible);
    clearTimeout(timer);
  };
}
