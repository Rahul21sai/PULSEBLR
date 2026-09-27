'use client';

import { useId, useState } from 'react';
import type { FeedEvent } from '@/lib/event-types';
import type { SeriesGroup } from '@/lib/events/series';
import { shortDateIST } from '@/lib/format';
import EventRow from './EventRow';

/**
 * One row for a recurring event, with its other dates behind a disclosure. See `lib/events/series.ts`
 * for why a series is grouped and how its key is built.
 *
 * COLLAPSED, IT STILL SAYS WHEN. "+3 more dates" alone would make the reader open it to learn the
 * one thing they want; the next two dates are printed beside the count, so the common question —
 * "is there one I can make?" — is answered without a tap.
 *
 * A REAL DISCLOSURE, so `aria-expanded` is honest here (unlike "1 more happening now", which loads
 * rows rather than revealing them). The revealed rows are ordinary `EventRow`s with their own links
 * and Save buttons, so each date can still be opened and saved on its own.
 */
export default function SeriesRow({ group }: { group: SeriesGroup<FeedEvent> }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const { lead, later } = group;

  if (later.length === 0) return <EventRow event={lead} showDate />;

  const preview = later.slice(0, 2).map(e => shortDateIST(e.startDateTime)).join(', ');
  const count = later.length;

  return (
    <div>
      <EventRow
        event={lead}
        showDate
        footer={
          <button
            type="button"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen(v => !v)}
            className="pressable r-touch -ml-2 inline-flex min-h-11 items-center gap-1 px-2 text-[13px] font-semibold text-[var(--accent)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] [touch-action:manipulation]"
          >
            {open ? 'Hide other dates' : `+${count} more ${count === 1 ? 'date' : 'dates'}`}
            {!open && (
              <span className="font-normal text-[var(--ink-2)]">
                · {preview}
                {count > 2 ? '…' : ''}
              </span>
            )}
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`}
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        }
      />
      <div id={panelId} hidden={!open}>
        {open && later.map(event => <EventRow key={event._id} event={event} showDate />)}
      </div>
    </div>
  );
}
