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

const DB_NAME = 'pulseblr-outbox';
const DB_VERSION = 1;
const CONTACTS = 'contacts';
const FOLDERS = 'folders';

export interface QueuedFolderRecord {
  clientId: string;
  name: string;
  eventDate?: string;
  venue?: string;
  note?: string;
  queuedAt: number;
}

export interface QueuedContactRecord extends ContactInput {
  queuedAt: number;
  /** Failed attempts so far. Used only to show "N could not sync", never to give up. */
  attempts?: number;
  lastError?: string;
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

export async function queueContact(record: ContactInput): Promise<void> {
  await tx<IDBValidKey>(CONTACTS, 'readwrite', s =>
    s.put({ ...record, queuedAt: Date.now() } satisfies QueuedContactRecord)
  );
  notify();
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

async function removeContact(clientId: string): Promise<void> {
  await tx<undefined>(CONTACTS, 'readwrite', s => s.delete(clientId));
}

async function removeFolder(clientId: string): Promise<void> {
  await tx<undefined>(FOLDERS, 'readwrite', s => s.delete(clientId));
}

async function markContactFailed(record: QueuedContactRecord, error: string): Promise<void> {
  await tx<IDBValidKey>(CONTACTS, 'readwrite', s =>
    s.put({ ...record, attempts: (record.attempts ?? 0) + 1, lastError: error })
  );
}

/* ────────────────────────────── drain ────────────────────────────── */

export interface DrainResult {
  attempted: number;
  synced: number;
  failed: number;
  /** True when nothing was tried because the queue was empty or we are offline. */
  skipped: boolean;
  /** Contacts the server accepted, so the UI can replace its pending rows with real ones. */
  saved?: unknown[];
}

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
export async function drain(): Promise<DrainResult> {
  if (draining) return { attempted: 0, synced: 0, failed: 0, skipped: true };
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { attempted: 0, synced: 0, failed: 0, skipped: true };
  }

  draining = true;
  try {
    const [contacts, folders] = await Promise.all([pendingContacts(), pendingFolders()]);
    if (!contacts.length && !folders.length) {
      return { attempted: 0, synced: 0, failed: 0, skipped: true };
    }

    const response = await fetch('/api/contacts/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folders, contacts }),
    });

    if (!response.ok) {
      // Nothing is removed. A 401 means the session lapsed and re-signing in will drain it;
      // a 5xx means try later. Either way the captures are still here.
      return { attempted: contacts.length, synced: 0, failed: contacts.length, skipped: false };
    }

    const result = (await response.json()) as {
      folders?: Array<{ clientId: string; ok: boolean; error?: string }>;
      contacts?: Array<{ clientId: string; ok: boolean; error?: string }>;
      saved?: unknown[];
    };

    for (const item of result.folders ?? []) {
      if (item.ok) await removeFolder(item.clientId);
    }

    let synced = 0;
    let failed = 0;
    for (const item of result.contacts ?? []) {
      if (item.ok) {
        await removeContact(item.clientId);
        synced++;
      } else {
        failed++;
        const record = contacts.find(c => c.clientId === item.clientId);
        if (record) await markContactFailed(record, item.error ?? 'Unknown error');
      }
    }

    notify();
    return {
      attempted: contacts.length,
      synced,
      failed,
      skipped: false,
      saved: result.saved,
    };
  } catch {
    // Offline, or the request never left. Everything stays queued.
    return { attempted: 0, synced: 0, failed: 0, skipped: false };
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
