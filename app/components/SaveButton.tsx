'use client';
import Link from 'next/link';

import { useState } from 'react';

type State = 'idle' | 'saving' | 'saved' | 'exists' | 'unauthorized' | 'error';

/**
 * Save an event to the personal tracker.
 *
 * The interaction is optimistic and self-explaining: the icon fills the moment
 * you click, and the only states that produce words are the two you can act on
 * — "Sign in to save" and a retryable failure. Silently swallowing errors (the
 * previous behaviour) taught users the button was broken.
 *
 * `initiallySaved` COMES FROM `GET /api/events`'s per-row `tracked` flag. It was declared here
 * from the start and passed by NOBODY, so the feed could never show what the user had already
 * saved — a crawl of one session recorded 20 × `409 Already tracking`, each of them a user
 * discovering a fact the feed already had. See `attachTracked` in `app/api/events/route.ts`.
 *
 * THE HIT AREA IS 44px AND THE PAINTED CONTROL IS STILL 36px. Grown with an `::after` overlay
 * rather than by padding, because the pill's diameter is part of the card's density (see the
 * design-system rules in CLAUDE.md §7) while the touch target is a WCAG 2.5.5 floor on a product
 * used one-handed at an event. The overlay reaches into the card's own `p-3`, so nothing moves.
 */
export default function SaveButton({
  eventId,
  initiallySaved = false,
  variant = 'icon',
  onSaved,
}: {
  eventId: string;
  initiallySaved?: boolean;
  variant?: 'icon' | 'full';
  onSaved?: () => void;
}) {
  const [state, setState] = useState<State>(initiallySaved ? 'saved' : 'idle');

  /*
   * `initiallySaved` is also honoured while IDLE, not only at mount.
   *
   * The rows are rendered after their fetch resolves, so the mount value is normally already
   * correct — but a section that fills from a second request (the Spotlight, the curated shelf)
   * can hand the same event to a button that mounted without the flag. Reading it here rather
   * than syncing it into state means a late arrival is reflected without an effect that could
   * clobber a save the user has already started: once the state machine has moved off `idle`,
   * it owns the answer.
   */
  const saved = state === 'saved' || state === 'exists' || (initiallySaved && state === 'idle');

  async function save(event: React.MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (saved || state === 'saving') return;

    setState('saving');
    try {
      const res = await fetch('/api/tracker', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId, status: 'Interested' }),
      });

      if (res.status === 401) {
        setState('unauthorized');
        return;
      }
      if (res.status === 409) {
        setState('exists');
        return;
      }
      if (!res.ok) {
        setState('error');
        return;
      }
      setState('saved');
      onSaved?.();
    } catch {
      setState('error');
    }
  }

  if (state === 'unauthorized') {
    return (
      <Link
        href="/login"
        onClick={e => e.stopPropagation()}
        className={
          variant === 'full'
            ? 'r-touch flex-1 min-h-11 flex items-center justify-center text-center bg-[var(--accent)] text-[var(--accent-ink)] text-[13.5px] font-semibold py-3 transition-colors'
            : "relative shrink-0 h-9 px-3 r-touch border border-[var(--rule)] bg-[var(--surface)] text-[11px] font-semibold text-[var(--accent)] hover:bg-[var(--paper)] transition-colors after:absolute after:-inset-1 after:content-['']"
        }
      >
        Sign in to save
      </Link>
    );
  }

  const label = saved
    ? 'Saved to tracker'
    : state === 'saving'
      ? 'Saving…'
      : state === 'error'
        ? 'Try again'
        : 'Save to tracker';

  if (variant === 'full') {
    return (
      <button
        type="button"
        onClick={save}
        aria-pressed={saved}
        /* EVERY STATE CARRIES AN EDGE. The default used to be `bg-[var(--paper)]` on a --paper
           page — paper on paper, a word with no button around it. A hairline ring is what separates
           a surface in this design, so the resting state is `--surface` inside a `--rule` ring and
           the saved state is the accent's own ring, which reads as "on" without a tint. */
        className={`r-touch flex-1 min-h-11 text-[13.5px] font-semibold py-3 transition-colors ${
          saved
            ? 'bg-[var(--surface)] text-[var(--accent)] shadow-[inset_0_0_0_1px_var(--accent)]'
            : state === 'error'
              ? 'bg-[var(--surface)] text-[var(--live)] shadow-[inset_0_0_0_1px_var(--live)]'
              : 'bg-[var(--surface)] text-[var(--ink)] shadow-[inset_0_0_0_1px_var(--rule)] hover:bg-[var(--paper)]'
        }`}
      >
        {saved ? 'Saved' : state === 'saving' ? 'Saving…' : state === 'error' ? 'Try again' : 'Save'}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={save}
      title={label}
      aria-label={label}
      aria-pressed={saved}
      className={`relative shrink-0 w-9 h-9 r-touch border flex items-center justify-center transition-colors active:scale-90 after:absolute after:-inset-1 after:content-[''] ${
        saved
          ? 'border-[var(--accent)]/25 bg-[var(--accent)]/10 text-[var(--accent)]'
          : state === 'error'
            ? 'border-[var(--live)] bg-[var(--surface)] text-[var(--live)]'
            : 'border-[var(--rule)] bg-[var(--surface)] text-[var(--ink-2)] hover:text-[var(--ink)] hover:bg-[var(--paper)]'
      }`}
    >
      <span aria-hidden="true"
        className="material-symbols-outlined text-[18px]"
        style={{ fontVariationSettings: `'FILL' ${saved ? 1 : 0}` }}
      >
        {state === 'error' ? 'refresh' : 'bookmark'}
      </span>
    </button>
  );
}
