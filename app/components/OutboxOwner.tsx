'use client';

import { useEffect } from 'react';
import { useSession } from 'next-auth/react';
import { setOutboxOwner, startAutoDrain } from '@/lib/scan/outbox';

/** `useSession()`'s three states, spelled out so the decision below can be tested without it. */
export type SessionStatus = 'loading' | 'authenticated' | 'unauthenticated';

/**
 * The account a client-side side effect may act for right now, or `null` for none.
 *
 * TWO CALLERS, ONE RULE: the outbox's automatic drain below, and `app/topics/ViewerEventRows.tsx`,
 * which asks for the reader's saved events on the two public lists. Both must never act for a
 * signed-out visitor, and both must not flap on a refetch.
 *
 * `unauthenticated` is always `null`, whatever stale data lingers — nothing uploads, and nothing is
 * fetched, on nobody's behalf. A session with no `user.id` is `null` too: CLAUDE.md §6 records that
 * such a session LOOKS signed in and every `requireUser()` route answers it with 401, so acting for it
 * could only fail.
 *
 * `loading` KEEPS WHATEVER IS THERE, and that is the case worth pinning. On a fresh load the data is
 * still `undefined`, so this is `null` and nothing starts before the session resolves. But
 * `useSession().update()` flips the status to `loading` while it refetches and keeps the previous
 * data on screen — so reading `loading` as "no account" would tear the drain's triggers down and put
 * them back, with a fresh boot drain, on every refetch (and re-ask for the saved set likewise).
 */
export function signedInAccount(status: SessionStatus, userId: string | null | undefined): string | null {
  if (status === 'unauthenticated') return null;
  return userId || null;
}

/**
 * Tells the offline outbox which account is signed in, and keeps its automatic drain running on
 * every page for that account. Renders nothing.
 *
 * WHY IT EXISTS. IndexedDB is scoped to the ORIGIN, not to the account, and sign-out
 * deliberately does not clear it — `app/settings/page.tsx` purges Cache Storage only, precisely
 * so that captures nobody has uploaded yet survive signing out. Without an owner, `drain()`
 * posts whatever it finds as whoever happens to be signed in now:
 *
 *   1. Account A scans ten people at an event. The network is bad; they stay queued.
 *   2. A signs out. B signs in on the same device — the exact scenario `public/sw.js` was
 *      bumped to v3 for.
 *   3. The next drain posts A's ten people as B. `findOwnedFolder(B, folderIdOfA)` returns null,
 *      so every one is refused `folder-not-found` and marked permanently blocked.
 *   4. /folders then lists A's captured people BY NAME to B, with Discard as the only option.
 *      A's captures are simultaneously unrecoverable, pinned to a folder id B will never own.
 *
 * Same class of leak as the v3 cache bug, in the one store the v3 sweep cannot touch.
 *
 * Mounted in `Providers`, inside `SessionProvider`, so it tracks sign-in and sign-out on every
 * page and no capture site has to thread a session down to the outbox. The outbox module keeps
 * the owner in a module variable rather than reading the session itself, because it is imported
 * by non-React code and by `tests/`.
 *
 * `status === 'loading'` is deliberately NOT treated as signed out. Writing `null` during the
 * first render would stamp a capture made in that window as ownerless — harmless today, since
 * unstamped records still drain, but it would quietly defeat the check for exactly the records
 * captured fastest after a page load.
 *
 * THE DRAIN IS HELD HERE, NOT ONLY ON THE SCAN SCREENS. `startAutoDrain()` used to be taken by
 * `/scan`, `/folders` and `/folders/[id]` alone, so someone who scanned offline at a venue and later
 * opened only the feed never uploaded — the `online` event fired into a page with nobody listening.
 * This hold makes the triggers app-wide for a signed-in account. The three screens still take their
 * own holds, which the outbox COUNTS rather than wiring twice (see `createAutoDrain`), so there is
 * one set of listeners and one boot drain whichever page the session resolves on. The owner is set
 * BEFORE the hold is taken — effects run in declaration order — so the boot drain the hold asks for
 * already knows whose captures to send.
 */
export default function OutboxOwner() {
  const { data: session, status } = useSession();
  const userId = session?.user?.id;

  useEffect(() => {
    if (status === 'loading') return;
    setOutboxOwner(userId ?? null);
  }, [userId, status]);

  const drainFor = signedInAccount(status, userId);
  useEffect(() => {
    if (!drainFor) return;
    return startAutoDrain();
  }, [drainFor]);

  return null;
}
