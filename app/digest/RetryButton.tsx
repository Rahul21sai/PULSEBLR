'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

/**
 * A retry that actually retries.
 *
 * `router.refresh()` re-runs the server component and discards the client-side router cache, which is
 * the only reason this page is `force-dynamic` (see the note in `page.tsx`): on a statically
 * revalidated route the refresh would be served the SAME cached error render, and a button that
 * cannot change anything is worse than no button. It tells the reader the failure is theirs to fix.
 *
 * `useTransition` is what makes the press legible. Without a pending state the button looks inert for
 * the length of a database timeout, and a reader who has just been told something went wrong reads
 * "nothing happened" as a second failure.
 */
export default function RetryButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [tries, setTries] = useState(0);

  return (
    <div>
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          setTries(count => count + 1);
          startTransition(() => router.refresh());
        }}
        className="pressable inline-flex min-h-[44px] items-center rounded-full bg-[var(--ink)] px-5 text-label-md font-semibold text-[var(--accent-ink)] transition-colors hover:bg-[var(--ink)] disabled:opacity-60"
      >
        {pending ? 'Trying again…' : 'Try again'}
      </button>
      {/* Said only after a failed retry, because "still not working" is different information from
          the first failure and is what tells the reader to stop pressing. */}
      {tries > 1 && !pending && (
        <p className="mt-2 text-[12.5px] text-[var(--ink-2)]">
          Still not loading. This is our end, not yours — the events themselves are fine.
        </p>
      )}
    </div>
  );
}
