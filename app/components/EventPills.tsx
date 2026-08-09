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
          <span className="material-symbols-outlined text-[13px]">restaurant</span>
          Food
        </span>
      )}

      {typeof event.attendeeCount === 'number' && event.attendeeCount > 0 && (
        <span className="pill pill-quiet">
          <span className="material-symbols-outlined text-[13px]">group</span>
          {event.attendeeCount} going
        </span>
      )}

      {!compact && duration && <span className="pill pill-quiet">{duration}</span>}

      {!compact && event.recruiterMentioned && (
        <span className="pill pill-quiet" title="This listing mentions hiring or recruiters">
          <span className="material-symbols-outlined text-[13px]">work</span>
          Hiring
        </span>
      )}
    </div>
  );
}
