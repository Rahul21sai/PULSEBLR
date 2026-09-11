'use client';

import { useState } from 'react';
import SaveButton from '../../components/SaveButton';
import type { FeedEvent } from '@/lib/event-types';

/**
 * The interactive island on an otherwise server-rendered event page.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THE PAGE HAD TO STOP BEING A CLIENT COMPONENT, and why this file is what is left.
 *
 * `/events/[id]` was `'use client'` and fetched itself in a `useEffect`. Next supports
 * `generateMetadata` ONLY in Server Components, so the page could not emit a title, a description,
 * an OG card or JSON-LD — and the crawlers that matter here (WhatsApp, LinkedIn, Slack, Twitter)
 * execute no JavaScript, so nothing the effect produced was ever visible to them. Sharing an event
 * link produced a bare URL with no preview at all.
 *
 * Converting the page is therefore not a refactor for its own sake: it is the only way the metadata
 * exists. Everything that does not need a browser moved to the server, which is all of the content.
 * What genuinely needs a client is small and lives here:
 *
 *   · `navigator.share` / `navigator.clipboard` — browser APIs, plus the "Link copied" state.
 *   · `SaveButton` — its own client component; it reads the session and POSTs to the tracker.
 *
 * NOT HERE, DELIBERATELY: the related-events fetch. The page reads "similar events" from Mongo in
 * the same request, with `visibilityClause` applied — a client fetch would add a round trip on every
 * page view to obtain data the server already had in hand, and would leave the section empty for
 * the crawler that is the whole point of this change.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */
export default function EventActions({ event }: { event: FeedEvent }) {
  const [copied, setCopied] = useState(false);

  async function share() {
    const url = window.location.href;
    const title = event.title || 'Event on PulseBLR';
    // Prefer the native share sheet on mobile; fall back to the clipboard, which is
    // the only thing that works reliably on desktop browsers.
    if (navigator.share) {
      try {
        await navigator.share({ title, url });
        return;
      } catch {
        // Sheet dismissed — fall through to copy.
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked — nothing useful to do */
    }
  }

  return (
    <div className="flex flex-col gap-2 pt-1">
      <a
        href={event.applyLink || event.sourceUrl}
        target="_blank"
        rel="noopener noreferrer"
        /* `.pressable` rather than a hand-rolled `active:scale-[0.98]`: one curve and one scale for
           every interactive surface in the app, and a hover-grow has no touch equivalent. */
        className="pressable w-full text-center bg-[#1D1D1F] text-white text-label-md font-semibold py-3 rounded-full hover:bg-black"
      >
        {event.soldOut ? `View on ${event.source}` : 'Register'}
      </a>
      <div className="flex gap-2">
        <SaveButton eventId={event._id} variant="full" />
        {/* Both 44px PAINTED, so no 44px overlay is needed and the two cannot contest each other's
            tap band — the failure mode a smaller painted control with an overlay produces. */}
        <a
          href={`/api/events/${event._id}/ics`}
          title="Add to calendar"
          aria-label="Add to calendar"
          className="pressable w-11 h-11 rounded-full bg-[#f3f3f5] flex items-center justify-center text-[#1D1D1F] hover:bg-[#e8e8ea] shrink-0"
        >
          <span aria-hidden="true" className="material-symbols-outlined text-[18px]">event_available</span>
        </a>
        <button
          type="button"
          onClick={share}
          title={copied ? 'Link copied' : 'Share'}
          aria-label="Share event"
          className="pressable w-11 h-11 rounded-full bg-[#f3f3f5] flex items-center justify-center text-[#1D1D1F] hover:bg-[#e8e8ea] shrink-0"
        >
          <span aria-hidden="true" className="material-symbols-outlined text-[18px]">
            {copied ? 'check' : 'ios_share'}
          </span>
        </button>
      </div>
      {/* `--good`, not a fourth hue. `#34C759` was a third green in a palette that declares exactly
          one (`--good: #166B35`, used by `.pill-free`). `aria-live` because the only other signal
          that the copy worked is a `title` tooltip, which a touch device never shows. */}
      {copied && (
        <p
          aria-live="polite"
          className="text-[12px] text-center font-semibold text-[color:var(--good)]"
        >
          Link copied
        </p>
      )}
    </div>
  );
}
