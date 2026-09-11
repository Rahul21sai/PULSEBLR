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
 *
 * ─── TWO THINGS CAME OFF THIS CARD, AND BOTH WERE RULE BREAKS RATHER THAN TASTE ─────────────────
 *
 * 1. A CATEGORY PILL FILLED WITH THE CATEGORY ACCENT, white type, over the cover. Category colour
 *    is structural here — it may tint a date block or carry a thin spine, it may not become a
 *    badge — and this was the loudest thing on a card whose only permitted colour is the
 *    photograph. Eight gradient category tiles were deleted from globals.css for the same reason;
 *    this was the survivor. The category still reads: it tints the date tile, and it now carries
 *    the rule under the cover, at a tenth of the weight.
 * 2. THE DATE LINE IN `--blue`. Blue means "you can act on this" — links, focus, primary actions,
 *    the connection meter. A date is not an action, and spending the one rationed accent on the
 *    most common string on the card is what makes the rest of the blue stop meaning anything.
 */
export default function EventGridCard({ event }: { event: FeedEvent }) {
  const primaryCategory = event.category?.[0];
  const href = `/events/${event._id}`;

  return (
    <article className="group bg-white rounded-2xl card-shadow overflow-hidden flex flex-col transition-[transform,box-shadow] duration-200 hover:shadow-[0_10px_34px_rgba(0,0,0,0.08)] hover:-translate-y-0.5">
      {/* aria-hidden as well as tabIndex={-1}: duplicates the title link and wraps a decorative
          cover, so it has no accessible name. Already unfocusable, so hiding it is safe.
          The 16:9 box reserves the image's space, so a grid does not reflow as covers land. */}
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
          /* No rail here, so a coverless tile becomes the date at poster scale — the strongest
             typographic moment in the feed, and the only colour it uses is the category tint the
             deleted pill used to shout. */
          date={event.startDateTime}
        />
      </Link>

      {/* The thin category spine, transposed from the rail row's left edge to the seam under a
          cover-led card. Structural: it identifies the category and separates image from content in
          one mark. Full width rather than a 3px stub, because on this card it is also the rule. */}
      {primaryCategory && (
        <span
          aria-hidden="true"
          className="block h-[3px] shrink-0 opacity-70"
          style={{ background: categoryAccent(primaryCategory) }}
        />
      )}

      <div className="px-4 pt-4 pb-3.5 flex-1 flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2 text-[12px] font-semibold text-[#6E6E73]">
          {/* "at" rather than a middle dot: the reason line below already spends this card's one
              permitted dot chain on `in person · meetup`, where the parts genuinely are a list of
              equals. A date and a time are a sentence. */}
          <span className="tnum">
            {dayLabelIST(event.startDateTime)} at {timeIST(event.startDateTime)}
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
      </div>

      {/* The same footer band the rail row carries, so the two card shapes read as one family: the
          judgement on the left, the facts behind it on the right, under a hairline.

          The connection meter was on the rail row and NOT here, so switching to grid view lost the
          one signal this app has that Luma and Meetup do not — while the sort it powers stayed
          selected. A view toggle should change the shape of the list, not what it tells you. */}
      <div className="hairline-t mt-auto flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5">
        {typeof event.connectionScore === 'number' && (
          <ConnectionMeter score={event.connectionScore} reason={cardReasonLine(event)} />
        )}
        <div className="ml-auto">
          <EventPills event={event} compact />
        </div>
      </div>
    </article>
  );
}
