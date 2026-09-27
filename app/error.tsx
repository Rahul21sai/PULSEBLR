'use client';

import { useEffect } from 'react';
import { Button, ButtonLink } from './components/ui';

/**
 * The error boundary for every page segment under the root layout.
 *
 * Without it, an uncaught render error anywhere replaced the whole page with Next's generic
 * message and no way forward. This renders INSIDE the root layout, so the offline strip
 * (`OfflineBanner`) is still on screen above it — which matters, because a failed fetch at a venue
 * is the likeliest cause and that strip is what says so.
 *
 * `retry`, NOT `reset`. In Next 16.3 (`next/dist/client/components/error-boundary.js`) `reset` only
 * clears the boundary's state and re-renders the same children, while `retry` runs
 * `router.refresh()` first, re-fetching the segment's server components. Several pages here are
 * Server Components (the event page), and re-rendering them without re-fetching reproduces the
 * error. The docs for this version say to prefer `retry`.
 *
 * DELIBERATELY NO NAV CHROME. An error boundary's fallback must not depend on the thing that may
 * have failed; the page's own nav is part of the page. Two actions are enough to leave: try again,
 * or go to the feed (a soft navigation, which resets this boundary — it clears on a pathname
 * change — and falls back to a hard load by itself if the deployment has moved on).
 *
 * The raw `message` is never shown: a server error arrives with a generic message plus a `digest`,
 * and a client error's message can carry internals. The digest IS shown, because it is the one
 * thing that matches this screen to a line in the server log.
 */
export default function RouteError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  // The runtime types `error` as `unknown` ("we don't guarantee that" it is an Error), so read the
  // digest defensively.
  const digest = typeof error?.digest === 'string' ? error.digest : null;

  return (
    <main className="min-h-screen bg-[var(--paper)]">
      <div className="mx-auto max-w-[520px] px-[var(--s-4)] pt-[var(--s-24)] text-center">
        {/* `alert`: the page the user was reading has just been replaced, and a screen reader user
            would otherwise not know. The reference sits outside it — it is not worth interrupting for. */}
        <div role="alert">
          <h1 className="ty-section text-[var(--ink)]">This page didn’t load</h1>
          <p className="ty-body mx-auto mt-[var(--s-2)] text-[var(--ink-2)]">
            Something went wrong while showing it. Try again, or start over from the events feed.
          </p>
        </div>
        <div className="mt-[var(--s-6)] flex flex-wrap items-center justify-center gap-[var(--s-3)]">
          <Button size="lg" onClick={() => retry()}>
            Try again
          </Button>
          <ButtonLink href="/" size="lg" tone="quiet">
            Go to events
          </ButtonLink>
        </div>
        {digest && <p className="ty-meta mt-[var(--s-6)]">Reference {digest}</p>}
      </div>
    </main>
  );
}
