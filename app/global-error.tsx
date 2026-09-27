'use client';

/*
 * Global styles, imported HERE. This component REPLACES the root layout when it renders, and the
 * Next 16.3 docs are explicit that it then gets none of the layout's styles — without this import
 * every token below resolves to nothing. It is the same module the layout imports, so it is one
 * CSS chunk, not two.
 *
 * The layout's `next/font` faces are NOT reproduced: `--font-sans` falls back to `system-ui` by
 * design (see the note on it in globals.css), and a second set of font loaders for a page that
 * should almost never render is cost without benefit.
 */
import './globals.css';

import { useEffect } from 'react';
import { Button } from './components/ui';

/**
 * The last-resort boundary: the root layout itself failed (a provider, the gate, the layout's own
 * render). Must render its own `<html>` and `<body>`, and cannot export `metadata`, hence the React
 * `<title>`, as the docs recommend.
 *
 * "Go to events" is a PLAIN `<a>`, a full document load, on purpose — unlike `app/error.tsx`. When
 * the root layout is what broke, a soft navigation re-renders the same layout in the same client
 * state; a fresh document is the dependable reset, and it is also what recovers a long-lived TWA
 * session holding a build the server no longer has.
 */
export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  const digest = typeof error?.digest === 'string' ? error.digest : null;

  return (
    <html lang="en">
      <body className="min-h-full bg-[var(--paper)] antialiased">
        <title>Something went wrong · PulseBLR</title>
        <main className="mx-auto max-w-[520px] px-[var(--s-4)] pt-[var(--s-24)] text-center">
          <div role="alert">
            <h1 className="ty-section text-[var(--ink)]">PulseBLR couldn’t load</h1>
            <p className="ty-body mx-auto mt-[var(--s-2)] text-[var(--ink-2)]">
              Something went wrong starting the app. Try again, or reload from the events feed.
            </p>
          </div>
          <div className="mt-[var(--s-6)] flex flex-wrap items-center justify-center gap-[var(--s-3)]">
            <Button size="lg" onClick={() => retry()}>
              Try again
            </Button>
            {/* Classes mirror ui.tsx's `quiet` tone at `lg`; `buttonClass` is not exported. */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- a full load is the point; see above */}
            <a
              href="/"
              className="pressable inline-flex h-12 items-center justify-center gap-2 r-touch bg-[var(--surface)] px-6 text-[15px] font-semibold tracking-[-0.006em] text-[var(--ink)] shadow-[inset_0_0_0_1px_var(--rule)] hover:bg-[var(--paper)]"
            >
              Go to events
            </a>
          </div>
          {digest && <p className="ty-meta mt-[var(--s-6)]">Reference {digest}</p>}
        </main>
      </body>
    </html>
  );
}
