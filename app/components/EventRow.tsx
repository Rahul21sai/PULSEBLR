'use client';
import Link from 'next/link';

import { FeedEvent } from '@/lib/event-types';
import {
  timeIST,
  shortDateIST,
  istDaysSpanned,
  locationLabel,
  isHappeningNow,
  categoryAccent,
} from '@/lib/format';
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
export default function EventRow({
  event,
  showDate = false,
}: {
  event: FeedEvent;
  /**
   * Render the DATE above the time in the rail gutter.
   *
   * Off by default, because in the day-grouped feed the section heading above already says which
   * day it is and repeating it on every row is noise.
   *
   * It must be ON for any ungrouped list — currently the ranked sorts, which are the DEFAULT view.
   * Those deliberately have no day headings (grouping a ranked list by day would re-sort it
   * chronologically and discard the ranking), and without this the rail showed "18:30 / 21:30" with
   * the date appearing nowhere on the row at all. Verified on a 375px viewport: a reader could not
   * tell whether the top event was tonight or in three weeks.
   */
  showDate?: boolean;
}) {
  const live = isHappeningNow(event.startDateTime, event.endDateTime);
  const primaryCategory = event.category?.[0];
  const accent = categoryAccent(primaryCategory);
  const href = `/events/${event._id}`;

  return (
    <div className="flex items-stretch gap-3 md:gap-4">
      {/* Time + rail node */}
      <div className="w-[42px] md:w-[58px] shrink-0 pt-4 flex flex-col items-end">
        {showDate && (
          /* Above the time, and quieter than it: under a ranked sort the date is context, not the
             thing being scanned. `whitespace-nowrap` because "15 Aug" must not wrap to two lines
             in a 42px gutter and push the time out of alignment with the rail node. */
          <span className="t-label whitespace-nowrap text-[10px] leading-none text-[#86868B] mb-1">
            {shortDateIST(event.startDateTime)}
          </span>
        )}
        <span
          className={`tnum text-[13px] md:text-[15px] font-semibold leading-none ${
            live ? 'text-[#FF3B30]' : 'text-[#1D1D1F]'
          }`}
        >
          {timeIST(event.startDateTime)}
        </span>
        {event.endDateTime &&
          (() => {
            /*
             * A multi-day event shows how many days it RUNS, not a bare end time.
             *
             * Printing the end time unconditionally made every multi-day event read as ending
             * before it started. Measured on the live feed: 15 of the first 100 tech events cross
             * an IST day boundary, and the conference sources are worst because their dates are
             * date-only — `Great International Developer Summit` (3 days) and `WeAreDevelopers
             * Conference India` (1 day) both rendered "05:30 / 05:30". Identical start and end
             * reads as a data bug, so the reader distrusts the row rather than understanding it.
             *
             * `+3d` rather than the end date, because this gutter is 42px on a phone and
             * "→ 30 Apr" cannot fit without wrapping, which would push the time out of alignment
             * with the rail node. The exact end is on the detail page; the rail only needs to say
             * "this is not a one-evening thing".
             */
            const days = istDaysSpanned(event.startDateTime, event.endDateTime);
            return (
              <span
                className="tnum text-[11px] text-[#a1a1a6] leading-none mt-1"
                title={
                  days > 0
                    ? `Runs until ${shortDateIST(event.endDateTime)}`
                    : `Ends ${timeIST(event.endDateTime)}`
                }
              >
                {days > 0 ? `+${days}d` : timeIST(event.endDateTime)}
              </span>
            );
          })()}
      </div>

      <div className="w-[9px] shrink-0 flex justify-center pt-[22px]">
        <span className="rail-node" data-live={live} />
      </div>

      {/* Card */}
      <article className="flex-1 min-w-0 mb-3">
        <div className="group relative bg-white rounded-[18px] card-shadow raise pressable overflow-hidden">
          {/* Category cue. Kept to a low-opacity tint rather than a saturated stripe:
              the cover image is the only thing on this card allowed to be colourful,
              because it is the only part that is real content. */}
          <span
            aria-hidden="true"
            className="absolute left-0 top-0 bottom-0 w-[3px] opacity-70"
            style={{ background: accent }}
          />

          <div className="flex gap-3 md:gap-4 p-3 md:p-4 pl-4 md:pl-5">
            {/* aria-hidden as well as tabIndex={-1}: this link duplicates the title link below
                it and wraps a deliberately decorative cover (EventCover sets alt=""), so it has
                no accessible name and a screen reader would announce it as an unlabelled link.
                Safe to hide because it is already out of the tab order — hiding a FOCUSABLE
                element is the anti-pattern, and this is not one. */}
            {/* `contact-shadow` gives the cover its own plane — it reads as resting ON the
                card rather than printed into it, which is where this row's depth comes
                from. Deliberately the transform-free utility, not `.lift-object`: infinite
                scroll can put hundreds of these on the page and a translateZ on each would
                promote hundreds of compositing layers for an effect a shadow already
                delivers. */}
            <Link
              href={href}
              className="shrink-0 rounded-xl overflow-hidden contact-shadow"
              tabIndex={-1}
              aria-hidden="true"
            >
              <EventCover
                src={event.imageUrl}
                title={event.title}
                category={primaryCategory}
                className="w-[76px] h-[76px] md:w-[104px] md:h-[104px] rounded-xl"
              />
            </Link>

            <div className="flex-1 min-w-0 flex flex-col gap-1.5">
              <div className="flex items-start gap-2">
                <h3 className="flex-1 min-w-0 text-[15.5px] md:text-[17.5px] font-semibold leading-[1.28] tracking-[-0.021em] text-[#1D1D1F]">
                  <Link href={href} className="hover:text-[#0071E3] transition-colors line-clamp-2">
                    {event.title}
                  </Link>
                </h3>
                <SaveButton eventId={event._id} />
              </div>

              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] tracking-[0] text-[#6E6E73] min-w-0">
                {typeof event.connectionScore === 'number' && (
                  <ConnectionMeter score={event.connectionScore} />
                )}
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
                      <span aria-hidden="true" className="material-symbols-outlined text-[14px] shrink-0">person</span>
                    )}
                    <span className="truncate max-w-[180px]">{event.organizer}</span>
                  </span>
                )}
                <span className="inline-flex items-center gap-1 min-w-0">
                  <span aria-hidden="true" className="material-symbols-outlined text-[14px] shrink-0">
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

/**
 * How likely is this event to leave you with useful contacts?
 *
 * `connectionScore` is computed for every event by lib/events/connection-score.ts —
 * in-person weighting, log-scaled attendee counts, food, and a hard penalty for
 * certification funnels — and it powers the "Best for connections" sort. It was
 * displayed NOWHERE, which meant the app's most distinctive signal was invisible and
 * that sort order looked arbitrary.
 *
 * Three bars, not the number. The score is a ranking signal, not a measurement, and
 * printing "83" invites a precision it does not have. Bars rank at a glance; the title
 * attribute carries the detail for anyone who wants it.
 */
function ConnectionMeter({ score }: { score: number }) {
  const level = score >= 70 ? 3 : score >= 50 ? 2 : 1;
  const label =
    level === 3
      ? 'Strong chance of useful contacts'
      : level === 2
        ? 'Some chance of useful contacts'
        : 'Unlikely to lead to contacts';

  return (
    <span className="inline-flex items-center gap-1.5 shrink-0" title={`${label} · score ${score}/100`}>
      <span className="meter" data-level={level} aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span className="sr-only">{label}</span>
    </span>
  );
}
