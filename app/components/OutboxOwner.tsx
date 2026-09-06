'use client';

import { useEffect } from 'react';
import { useSession } from 'next-auth/react';
import { setOutboxOwner } from '@/lib/scan/outbox';

/**
 * Tells the offline outbox which account is signed in. Renders nothing.
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
 */
export default function OutboxOwner() {
  const { data: session, status } = useSession();

  useEffect(() => {
    if (status === 'loading') return;
    setOutboxOwner(session?.user?.id ?? null);
  }, [session?.user?.id, status]);

  return null;
}
