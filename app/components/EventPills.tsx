'use client';

import { FeedEvent } from '@/lib/event-types';
import { priceLabel, isHappeningNow, durationLabel } from '@/lib/format';

/**
 * The metadata pills under an event title.
 *
 * Ordered by decision value, not by what's available: whether it's on RIGHT NOW,
 * then cost, then whether you have to travel, then perks. A user scanning the feed
 * is filtering on those in that order, so the pills mirror it.
 */
export default function EventPills({
  event,
  compact = false,
}: {
  event: FeedEvent;
  compact?: boolean;
}) {
  const live = isHappeningNow(event.startDateTime, event.endDateTime);
  const duration = durationLabel(event.startDateTime, event.endDateTime);

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {live && (
        <span className="pill pill-live">
          <span className="live-dot w-1.5 h-1.5 rounded-full bg-[#FF3B30]" />
          Happening now
        </span>
      )}

      {/* Hand-added by an admin rather than scraped. Placed straight after "Happening now" and
          before price, because it is a PROVENANCE claim: it says a human chose to put this here,
          which changes how much the rest of the card is worth trusting. `source` is the same
          marker `POST /api/events` writes (`body.source || 'manual'`), so nothing new is stored
          to support this. */}
      {event.source === 'manual' && (
        <span
          className="pill pill-quiet"
          title="Added by hand rather than scraped — curated by PulseBLR"
        >
          Curated
        </span>
      )}

      {event.soldOut ? (
        <span className="pill pill-sold">Sold out</span>
      ) : (
        <span className={`pill ${event.isFree ? 'pill-free' : 'pill-quiet'}`}>
          {priceLabel(event)}
        </span>
      )}

      {event.format === 'online' && <span className="pill pill-online">Online</span>}
      {event.format === 'hybrid' && <span className="pill pill-online">Hybrid</span>}

      {event.hasFood === 'yes' && (
        <span className="pill pill-quiet">
          <span aria-hidden="true" className="material-symbols-outlined text-[13px]">restaurant</span>
          Food
        </span>
      )}

      {typeof event.attendeeCount === 'number' && event.attendeeCount > 0 && (
        <span className="pill pill-quiet">
          <span aria-hidden="true" className="material-symbols-outlined text-[13px]">group</span>
          {event.attendeeCount} going
        </span>
      )}

      {!compact && duration && <span className="pill pill-quiet">{duration}</span>}

      {!compact && event.recruiterMentioned && (
        <span className="pill pill-quiet" title="This listing mentions hiring or recruiters">
          <span aria-hidden="true" className="material-symbols-outlined text-[13px]">work</span>
          Hiring
        </span>
      )}
    </div>
  );
}
