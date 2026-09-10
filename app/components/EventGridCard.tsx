'use client';
import Link from 'next/link';

import { FeedEvent } from '@/lib/event-types';
import { timeIST, dayLabelIST, locationLabel, categoryAccent } from '@/lib/format';
import EventCover from './EventCover';
import EventPills from './EventPills';
import SaveButton from './SaveButton';
// Imported from the rail row rather than copied or given its own file: the meter and the rule about
// which clauses a CARD may repeat are one decision, and two copies of it would drift the way the two
// copies of the `>= 70 ? 3` threshold already had.
import { ConnectionMeter, cardReasonLine } from './EventRow';

/**
 * Image-forward card for grid view.
 *
 * Grid view exists for a different task than the rail: browsing by vibe rather
 * than scheduling. So here the cover leads at 16:9 and the date moves INTO the
 * card (there's no rail to carry it).
 */
export default function EventGridCard({ event }: { event: FeedEvent }) {
  const primaryCategory = event.category?.[0];
  const href = `/events/${event._id}`;

  return (
    <article className="group bg-white rounded-2xl card-shadow overflow-hidden flex flex-col transition-[transform,box-shadow] duration-200 hover:shadow-[0_10px_34px_rgba(0,0,0,0.08)] hover:-translate-y-0.5">
      {/* aria-hidden as well as tabIndex={-1}: duplicates the title link and wraps a decorative
          cover, so it has no accessible name. Already unfocusable, so hiding it is safe. */}
      <Link
        href={href}
        className="relative block aspect-[16/9] overflow-hidden"
        tabIndex={-1}
        aria-hidden="true"
      >
        <EventCover
          src={event.imageUrl}
          title={event.title}
          category={primaryCategory}
          className="w-full h-full"
          monogramSize="text-3xl"
        />
        {primaryCategory && (
          <span
            className="absolute left-3 top-3 pill text-white shadow-sm"
            style={{ background: categoryAccent(primaryCategory) }}
          >
            {primaryCategory}
          </span>
        )}
      </Link>

      <div className="p-4 flex-1 flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2 text-[12px] font-semibold text-[#0071E3]">
          <span className="tnum">
            {dayLabelIST(event.startDateTime)} · {timeIST(event.startDateTime)}
          </span>
          {/* Same as the rail row: the feed can only show what you already saved if the flag
              the API now sends actually reaches the button. */}
          <SaveButton eventId={event._id} initiallySaved={event.tracked} />
        </div>

        <h3 className="text-[16px] font-semibold leading-snug tracking-[-0.01em] text-[#1D1D1F]">
          <Link href={href} className="hover:text-[#0071E3] transition-colors line-clamp-2">
            {event.title}
          </Link>
        </h3>

        <p className="text-[12.5px] text-[#6E6E73] flex items-center gap-1 min-w-0">
          <span aria-hidden="true" className="material-symbols-outlined text-[14px] shrink-0">
            {event.format === 'online' ? 'videocam' : 'location_on'}
          </span>
          <span className="truncate">{locationLabel(event)}</span>
        </p>

        {/* The connection meter was on the rail row and NOT here, so switching to grid view lost the
            one signal this app has that Luma and Meetup do not — while the sort it powers stayed
            selected. A view toggle should change the shape of the list, not what it tells you. */}
        {typeof event.connectionScore === 'number' && (
          <div className="text-[12.5px] text-[#6E6E73] min-w-0">
            <ConnectionMeter score={event.connectionScore} reason={cardReasonLine(event)} />
          </div>
        )}

        <div className="mt-auto pt-2">
          <EventPills event={event} compact />
        </div>
      </div>
    </article>
  );
}
