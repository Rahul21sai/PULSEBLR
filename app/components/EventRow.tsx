'use client';
import Link from 'next/link';

import { FeedEvent } from '@/lib/event-types';
import { timeIST, locationLabel, isHappeningNow, categoryAccent } from '@/lib/format';
import EventCover from './EventCover';
import EventPills from './EventPills';
import SaveButton from './SaveButton';

/**
 * One row on the time rail — the feed's primary unit.
 *
 * Layout: [ 19:30 ]──●──[ cover | title / host / where / pills ]──[ save ]
 *
 * The clock time lives OUTSIDE the card, on the rail, so a column of times reads
 * as a schedule you can scan vertically. Putting the time inside each card (the
 * obvious choice) forces the eye to re-find it on every row.
 */
export default function EventRow({ event }: { event: FeedEvent }) {
  const live = isHappeningNow(event.startDateTime, event.endDateTime);
  const primaryCategory = event.category?.[0];
  const accent = categoryAccent(primaryCategory);
  const href = `/events/${event._id}`;

  return (
    <div className="flex items-stretch gap-3 md:gap-4">
      {/* Time + rail node */}
      <div className="w-[42px] md:w-[58px] shrink-0 pt-4 flex flex-col items-end">
        <span
          className={`tnum text-[13px] md:text-[15px] font-semibold leading-none ${
            live ? 'text-[#FF3B30]' : 'text-[#1D1D1F]'
          }`}
        >
          {timeIST(event.startDateTime)}
        </span>
        {event.endDateTime && (
          <span className="tnum text-[11px] text-[#a1a1a6] leading-none mt-1">
            {timeIST(event.endDateTime)}
          </span>
        )}
      </div>

      <div className="w-[9px] shrink-0 flex justify-center pt-[22px]">
        <span className="rail-node" data-live={live} />
      </div>

      {/* Card */}
      <article className="flex-1 min-w-0 mb-3">
        <div className="group relative bg-white rounded-2xl card-shadow overflow-hidden transition-[transform,box-shadow] duration-200 hover:shadow-[0_8px_30px_rgba(0,0,0,0.07)] hover:-translate-y-px">
          {/* Category hairline — a quiet colour cue that doesn't cost layout space */}
          <span
            aria-hidden="true"
            className="absolute left-0 top-0 bottom-0 w-[3px]"
            style={{ background: accent }}
          />

          <div className="flex gap-3 md:gap-4 p-3 md:p-4 pl-4 md:pl-5">
            <Link href={href} className="shrink-0 rounded-xl overflow-hidden" tabIndex={-1}>
              <EventCover
                src={event.imageUrl}
                title={event.title}
                category={primaryCategory}
                className="w-[76px] h-[76px] md:w-[104px] md:h-[104px] rounded-xl"
              />
            </Link>

            <div className="flex-1 min-w-0 flex flex-col gap-1.5">
              <div className="flex items-start gap-2">
                <h3 className="flex-1 min-w-0 text-[15px] md:text-[17px] font-semibold leading-snug tracking-[-0.01em] text-[#1D1D1F]">
                  <Link href={href} className="hover:text-[#0071E3] transition-colors line-clamp-2">
                    {event.title}
                  </Link>
                </h3>
                <SaveButton eventId={event._id} />
              </div>

              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-[#6E6E73] min-w-0">
                {event.organizer && (
                  <span className="inline-flex items-center gap-1 min-w-0 max-w-full">
                    {event.hostAvatarUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element -- third-party avatar CDN
                      <img
                        src={event.hostAvatarUrl}
                        alt=""
                        loading="lazy"
                        className="w-4 h-4 rounded-full object-cover shrink-0"
                      />
                    ) : (
                      <span className="material-symbols-outlined text-[14px] shrink-0">person</span>
                    )}
                    <span className="truncate max-w-[180px]">{event.organizer}</span>
                  </span>
                )}
                <span className="inline-flex items-center gap-1 min-w-0">
                  <span className="material-symbols-outlined text-[14px] shrink-0">
                    {event.format === 'online' ? 'videocam' : 'location_on'}
                  </span>
                  <span className="truncate max-w-[220px]">{locationLabel(event)}</span>
                </span>
              </div>

              <EventPills event={event} compact />
            </div>
          </div>
        </div>
      </article>
    </div>
  );
}
