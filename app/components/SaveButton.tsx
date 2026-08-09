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

  const saved = state === 'saved' || state === 'exists';

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
            ? 'flex-1 text-center bg-[#0071E3] text-white text-label-md font-semibold py-3 rounded-full hover:bg-blue-600 transition-colors'
            : 'shrink-0 h-9 px-3 rounded-full border border-[#e5e5ea] bg-white text-[11px] font-semibold text-[#0071E3] hover:bg-[#f3f3f5] transition-colors'
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
        className={`flex-1 text-label-md font-semibold py-3 rounded-full transition-colors ${
          saved
            ? 'bg-[#0071E3]/10 text-[#0071E3]'
            : state === 'error'
              ? 'bg-red-50 text-red-600 hover:bg-red-100'
              : 'bg-[#f3f3f5] text-[#1D1D1F] hover:bg-[#e8e8ea]'
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
      className={`shrink-0 w-9 h-9 rounded-full border flex items-center justify-center transition-colors active:scale-90 ${
        saved
          ? 'border-[#0071E3]/25 bg-[#0071E3]/10 text-[#0071E3]'
          : state === 'error'
            ? 'border-red-200 bg-red-50 text-red-600'
            : 'border-[#e5e5ea] bg-white text-[#86868B] hover:text-[#1D1D1F] hover:bg-[#f3f3f5]'
      }`}
    >
      <span
        className="material-symbols-outlined text-[18px]"
        style={{ fontVariationSettings: `'FILL' ${saved ? 1 : 0}` }}
      >
        {state === 'error' ? 'refresh' : 'bookmark'}
      </span>
    </button>
  );
}
