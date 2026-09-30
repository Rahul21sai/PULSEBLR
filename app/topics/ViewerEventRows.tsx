'use client';

import { useEffect, useState } from 'react';
import { useSession } from 'next-auth/react';

import type { FeedEvent } from '@/lib/event-types';
import { trackedEventIds } from '@/lib/tracker/entry-view';

import EventRow from '../components/EventRow';
import { signedInAccount } from '../components/OutboxOwner';

const NOTHING_SAVED: ReadonlySet<string> = new Set();

/**
 * A list of `EventRow`s on a page whose HTML is the SAME FOR EVERY VISITOR, with the one per-reader
 * fact a row shows — "you already saved this" — filled in by the browser.
 *
 * TWO CALLERS, BOTH PUBLIC: `/topics/[slug]` and `/digest`. It lives beside the first and the second
 * imports it from here.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * THE BUG. Both pages rendered `EventRow`, which hands `event.tracked` to `SaveButton`, and neither
 * loader ever set it — so every bookmark read "not saved" whatever the reader had saved, and the first
 * tap on one they had saved answered `409 Already tracking`. The feed never had this problem because
 * `GET /api/events` attaches `tracked` per request.
 *
 * WHY THE BROWSER AND NOT THE LOADER. Neither page may know who is reading it while it renders.
 * `/topics/[slug]` is ISR (`revalidate = 3600`): per-reader state in its loader would either make the
 * page dynamic or bake the first visitor's saved events into HTML served to everybody for an hour.
 * `/digest` states that nothing in its chain reads a session, because a page that personalised itself
 * would be uncacheable and "one refactor away from putting somebody's private submission in Google's
 * index". So the server keeps rendering the same rows for everyone, and this asks after hydration.
 *
 * ONLY FOR A SIGNED-IN READER — `signedInAccount`, the same gate the outbox drain uses. Signed out,
 * still loading, or a session with no user id: no request, and every row keeps exactly the flag it
 * arrived with — none. The answer is kept with the account it was fetched for, and shown only while
 * that account is still the one signed in.
 *
 * THE SAME FACT THE FEED USES. `GET /api/tracker` returns the reader's own entries, user-scoped by the
 * route and network-only in `sw.js`; `trackedEventIds` reads the saved set out of that listing — see
 * its note in `lib/tracker/entry-view.ts` for why that is not a second definition of "saved".
 *
 * A FAILED REQUEST CHANGES NOTHING, which is the correct failure: the rows render exactly as they did
 * before this existed, and `SaveButton` still turns a 409 into "Saved". A save the reader makes here
 * is `SaveButton`'s own state from then on — it reads `initiallySaved` only while idle, so a late
 * answer can never overwrite a tap.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 */
export default function ViewerEventRows({
  events,
  showDate = false,
}: {
  events: FeedEvent[];
  /** Passed straight to `EventRow` — both callers are ranked lists with no day headings. */
  showDate?: boolean;
}) {
  const { data: session, status } = useSession();
  const viewerId = signedInAccount(status, session?.user?.id);
  const hasRows = events.length > 0;
  const [saved, setSaved] = useState<{ viewerId: string; ids: ReadonlySet<string> } | null>(null);

  useEffect(() => {
    if (!viewerId || !hasRows) return;
    const controller = new AbortController();
    fetch('/api/tracker', { signal: controller.signal })
      .then(res => (res.ok ? res.json() : null))
      .then((data: { entries?: unknown } | null) => {
        if (data) setSaved({ viewerId, ids: trackedEventIds(data.entries) });
      })
      .catch(() => {
        // Offline, aborted, or a body that was not JSON: the rows stay as rendered. See above.
      });
    return () => controller.abort();
  }, [viewerId, hasRows]);

  const ids = saved && saved.viewerId === viewerId ? saved.ids : NOTHING_SAVED;

  return (
    <>
      {events.map(event => (
        <EventRow
          key={event._id}
          event={ids.has(event._id) ? { ...event, tracked: true } : event}
          showDate={showDate}
        />
      ))}
    </>
  );
}
