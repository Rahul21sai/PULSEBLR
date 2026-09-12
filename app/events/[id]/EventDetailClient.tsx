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
 * TWO VARIANTS, ONE COMPONENT, and that is the point rather than a convenience.
 *
 * `rail` is the desktop block inside the facts section. `bar` is the mobile sticky bar. They share
 * the share/clipboard logic, the fallback chain and the "Link copied" state — a second component
 * would be a second implementation of `navigator.share`'s fallback, which is exactly how `Chip` and
 * `Button` ended up with two different className merges that were both wrong.
 *
 * `bar` carries Register AND Save, deliberately. Register alone is what every ticketing site's
 * sticky bar carries; Save is the action that starts THIS product's loop — decide by whether you
 * will leave with contacts, then track who you met. It is also the only action here that the event's
 * own site cannot offer.
 *
 * The calendar and share controls stay OFF the bar. Three tap targets in a 390px band leaves each
 * one narrow, and the rule that matters is at most one primary target per row.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */
export default function EventActions({
  event,
  variant = 'rail',
  isPast = false,
}: {
  event: FeedEvent;
  variant?: 'rail' | 'bar';
  /** Decided on the SERVER — see the note above the component. Never recomputed here. */
  isPast?: boolean;
}) {
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

  const registerLabel = event.soldOut ? `View on ${event.source}` : 'Register';

  if (variant === 'bar') {
    return (
      /* `.sticky-bar` supplies the ONE box-shadow the codebase allows (`--shadow-sticky`), which is
         what separates this from the page without a border. `pb` carries the iOS home-indicator
         inset — `viewportFit: 'cover'` is set globally in layout.tsx, so `env()` resolves here. */
      <div
        /* SITS ABOVE THE MOBILE BOTTOM NAV BELOW `md`, AT THE FOOT OF THE VIEWPORT FROM `md`.
           `MobileBottomNav` is `fixed bottom-0 z-50` and `md:hidden`, so below 768 the two share the
           band and the nav wins on z-index — measured with `elementFromPoint`, a tap aimed at
           Register hit a nav link. `--bottomnav-h` (globals.css) restates the nav's own padding
           formula so this offset tracks the safe-area inset instead of a headless-browser constant.
           From `md` the nav is gone, so the bar drops to the floor. */
        className="sticky-bar fixed inset-x-0 bottom-[var(--bottomnav-h)] md:bottom-0 z-40 lg:hidden px-[var(--s-4)] pt-[var(--s-3)]"
        style={{ paddingBottom: 'max(var(--s-3), env(safe-area-inset-bottom))' }}
      >
        <div className="flex items-center gap-[var(--s-3)]">
          {isPast ? (
            /* A SENTENCE, NOT A DISABLED BUTTON. A greyed-out Register still reads as an offer that
               failed; "This event has ended" is the fact, and it is the only thing on the page that
               needs to be in --live, because it is the one time-critical claim left. Save stays: you
               may have met people there, and the folder is what this product is for. */
            <p className="flex-1 min-h-[48px] flex items-center ty-meta font-semibold text-[color:var(--live)]">
              This event has ended
            </p>
          ) : (
            <a
              href={event.applyLink || event.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="pressable r-touch flex-1 min-h-[48px] flex items-center justify-center bg-[var(--accent)] text-[var(--accent-ink)] text-[15px] font-semibold"
            >
              {registerLabel}
            </a>
          )}
          <SaveButton eventId={event._id} variant="full" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 pt-1">
      {isPast ? (
        <p className="ty-meta font-semibold text-[color:var(--live)] py-3">This event has ended</p>
      ) : (
        <a
          href={event.applyLink || event.sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          /* `.pressable` rather than a hand-rolled `active:scale-[0.98]`: one curve and one scale for
             every interactive surface in the app, and a hover-grow has no touch equivalent. */
          className="pressable r-touch w-full text-center bg-[var(--accent)] text-[var(--accent-ink)] text-[15px] font-semibold py-3"
        >
          {registerLabel}
        </a>
      )}
      <div className="flex gap-2">
        <SaveButton eventId={event._id} variant="full" />
        {/* Both 44px PAINTED, so no 44px overlay is needed and the two cannot contest each other's
            tap band — the failure mode a smaller painted control with an overlay produces. */}
        <a
          href={`/api/events/${event._id}/ics`}
          title="Add to calendar"
          aria-label="Add to calendar"
          className="pressable r-touch w-11 h-11 bg-[var(--paper)] shadow-[inset_0_0_0_1px_var(--rule)] flex items-center justify-center text-[var(--ink)] shrink-0"
        >
          <span aria-hidden="true" className="material-symbols-outlined text-[18px]">event_available</span>
        </a>
        <button
          type="button"
          onClick={share}
          title={copied ? 'Link copied' : 'Share'}
          aria-label="Share event"
          className="pressable r-touch w-11 h-11 bg-[var(--paper)] shadow-[inset_0_0_0_1px_var(--rule)] flex items-center justify-center text-[var(--ink)] shrink-0"
        >
          <span aria-hidden="true" className="material-symbols-outlined text-[18px]">
            {copied ? 'check' : 'ios_share'}
          </span>
        </button>
      </div>
      {/* `--good`, not a fourth hue. This was a third green in a palette that declares exactly
          one (`--good`, aliased to `--accent`, used by `.pill-free`). `aria-live` because the only
          other signal that the copy worked is a `title` tooltip, which a touch device never shows. */}
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
