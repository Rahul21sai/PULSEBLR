'use client';
import Link from 'next/link';

import { FeedEvent } from '@/lib/event-types';
import { meterLabel, meterLevel, scoreReasonLine } from '@/lib/events/score-reason';
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
             thing being scanned. `whitespace-nowrap` because "15 Sept" must not wrap to two lines
             in a 42px gutter and push the time out of alignment with the rail node.
             NOT `.t-label`: that class uppercases, so this read "15 SEPT" — a tracked-out caps
             label above content that needs no announcing, and the date's own capitalisation
             carries more information than the shout does. */
          <span className="whitespace-nowrap text-[10px] font-semibold tracking-[0.01em] leading-none text-[color:var(--ink-3)] mb-1">
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
                /* Was `#a1a1a6`, which measured 2.36:1 on the page grey — the worst contrast
                   ratio in the app, on an 11px string. See the ink ramp note in globals.css. */
                className="tnum text-[11px] text-[color:var(--ink-3)] leading-none mt-1"
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

          {/*
           * A GRID, NOT A FLEX ROW, AND THE REASON IS THE FOOTER BAND'S GEOMETRY.
           *
           * Three rows — title, meta, the connection band — with the cover spanning the first two
           * on a phone and all three on a desktop. That single difference is what lets the band be
           * full-width UNDER the cover on a phone and beside it on a desktop, from one DOM.
           *
           * IT WAS A FLEX ROW WITH `mt-auto` AND A NEGATIVE MARGIN FIRST, AND THAT WAS BROKEN.
           * `mt-auto` aligns the band's BOTTOM with the cover's bottom, not its top — so a card
           * whose text is shorter than its cover put the band's hairline straight across the cover.
           * Measured on the worst real case (a one-word title like "Demos", no organiser): cover
           * bottom at 107px, band top at 77px, a rule drawn 30px up the image. It survived six
           * fixture rows only because every one of them had a two-line title. Grid cannot express
           * that bug: on a phone the band is in row 3 and the cover ends in row 2.
           *
           * `minmax(0,1fr)` rather than `1fr` for the text column: a bare `1fr` floors at
           * min-content, which stops `truncate` and `line-clamp` from ever clamping.
           */}
          <div
            className="grid grid-cols-[76px_minmax(0,1fr)] md:grid-cols-[104px_minmax(0,1fr)]
                       grid-rows-[auto_auto_auto] md:grid-rows-[auto_minmax(0,1fr)_auto]
                       gap-x-3 md:gap-x-4 gap-y-1
                       pt-3 md:pt-4 pb-3 md:pb-4 pl-4 md:pl-5 pr-3 md:pr-4"
          >
            {/* aria-hidden as well as tabIndex={-1}: this link duplicates the title link below
                it and wraps a deliberately decorative cover (EventCover sets alt=""), so it has
                no accessible name and a screen reader would announce it as an unlabelled link.
                Safe to hide because it is already out of the tab order — hiding a FOCUSABLE
                element is the anti-pattern, and this is not one.
                `self-start` so the link does not stretch past the cover it wraps when the text
                beside it is the taller side. */}
            <Link
              href={href}
              className="row-span-2 md:row-span-3 self-start rounded-xl overflow-hidden"
              tabIndex={-1}
              aria-hidden="true"
            >
              <EventCover
                src={event.imageUrl}
                title={event.title}
                category={primaryCategory}
                className="w-[76px] h-[76px] md:w-[104px] md:h-[104px] rounded-xl"
                /* Coverless rows — 40% of the first twenty — show the date here instead of a
                   monogram. It repeats the gutter visually and that is the intended trade: the
                   gutter is a schedule column read vertically, the tile is this card's identity,
                   and under a day-grouped sort (`showDate` false) the tile is the row's only date.
                   It costs a screen-reader user nothing, because the tile is aria-hidden. */
                date={event.startDateTime}
              />
            </Link>

            <div className="col-start-2 row-start-1 min-w-0 flex items-start gap-2">
              <h3 className="flex-1 min-w-0 text-[15.5px] md:text-[17.5px] font-semibold leading-[1.28] tracking-[-0.021em] text-[#1D1D1F]">
                <Link href={href} className="hover:text-[#0071E3] transition-colors line-clamp-2">
                  {event.title}
                </Link>
              </h3>
              {/* `event.tracked` comes from `GET /api/events` for a signed-in caller, so a row
                  the user already saved opens with a FILLED bookmark. Before this the prop
                  existed and nothing passed it, and the only way to learn you had saved
                  something was to save it again and collect a 409. */}
              <SaveButton eventId={event._id} initiallySaved={event.tracked} />
            </div>

            <div className="col-start-2 row-start-2 self-start flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] tracking-[0] text-[#6E6E73] min-w-0">
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

            {/*
             * THE CARD'S CONCLUSION, and the app's signature object.
             *
             * The meter used to be the FIRST ITEM of the metadata row above, at the same 12.5px
             * grey as the host and the venue, with its clause truncated at 210px. The one signal
             * Luma and Meetup cannot show was therefore one of five equal-weight scraps, which is
             * why the row read as a wall.
             *
             * WHAT MAKES IT THE SIGNATURE IS STRUCTURE, NOT WEIGHT — a hairline and a band of its
             * own, with the pills brought down beside it: the judgement on the left, the facts
             * behind it on the right. The type stays the same quiet grey as everything else,
             * because a card gets two levels of emphasis and the title already holds the loud
             * one. A third would rebuild the wall this is fixing.
             *
             * IT SPANS BOTH COLUMNS ON A PHONE AND ONLY THE TEXT COLUMN ON A DESKTOP, and both
             * halves of that are measured rather than chosen:
             *
             *   · Desktop, at the feed's real 896px column: the 104px cover is taller than the
             *     text beside it, so the foot of the text column was already empty. Putting the
             *     band there costs NOTHING — 136px per row before, 132px after. A full-width
             *     footer under the cover was built first and measured +38px per row for no extra
             *     information, because it converted that free space into new height.
             *   · Phone, at 390px: the text is the taller side, so the band costs a line wherever
             *     it goes — but confined to the 167px text column it wrapped to three lines and
             *     orphaned a single pill on its own right-aligned row. Spanning both columns it
             *     gets 255px, fits the clause and the pills in two, and saves 113px over six rows.
             *
             * Net against the shipped layout, same six fixtures: 1095 → 1060px on a phone and
             * 888 → 864px on a desktop. The signature got bigger and the feed got shorter.
             */}
            <div className="col-span-2 md:col-span-1 md:col-start-2 row-start-3 hairline-t pt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
              {typeof event.connectionScore === 'number' && (
                <ConnectionMeter score={event.connectionScore} reason={cardReasonLine(event)} />
              )}
              {/* `ml-auto` so the facts sit opposite the judgement on one line where there is room.
                  When they wrap they wrap as a GROUP, which reads as composed; the earlier version
                  let a single pill orphan itself, right-aligned, on its own line. */}
              <div className="ml-auto">
                <EventPills event={event} compact />
              </div>
            </div>
          </div>
        </div>
      </article>
    </div>
  );
}

/**
 * The clause that goes beside the meter on a CARD, as opposed to the full rationale the detail
 * page's "Worth going?" panel prints.
 *
 * WHAT IT LEAVES OUT IS THE DESIGN. `EventPills`, directly below, already shows a pill for food, for
 * the attendee count and for the price, and an `Online` pill for an online event — so naming any of
 * those again spends the row's remaining width saying nothing new. What is left is exactly the part
 * of the ranking a reader cannot see anywhere else on the row: whether it is in person (which has no
 * pill, absence being the only cue), what kind of gathering it is, who is behind it, and whether the
 * title reads like a sales session.
 *
 * The format exclusion is CONDITIONAL because the pills are asymmetric — an online event gets a
 * pill and an in-person one does not, and in-person is the single biggest term in the score. Only
 * the component knows what else is on screen, which is why `scoreReasonLine` takes the exclusion
 * rather than guessing.
 *
 * Two clauses, not four: a strong meetup reads `in person · meetup`, and the rest is one tap away.
 *
 * `host` LOOKS LIKE IT BELONGS IN THE EXCLUSION LIST AND MUST NOT GO IN IT. The card prints the
 * organiser two lines up, so `hosted by Razorpay` beside `Razorpay Rize` is a visible repeat — but
 * excluding it makes the reason line EMPTY on exactly the rows that need it most. Read against the
 * scorer's weights: format is 34, a social category 12, a peer title 10, a named company 8. At
 * `max: 2` the host clause is already fourth and effectively never rendered, so excluding it buys
 * nothing on a normal row; the only rows where it DOES surface are the ones with no format, no
 * social category and no peer title, where it is the single thing the ranking has to say. Silence
 * under three bars is worse than a repeat.
 */
export function cardReasonLine(event: FeedEvent): string {
  const covered = ['food', 'attendees', 'price'] as const;
  return scoreReasonLine(event, {
    max: 2,
    exclude: event.format === 'online' ? [...covered, 'format'] : covered,
  });
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
 * printing "83" invites a precision it does not have.
 *
 * BUT BARS ALONE WERE NOT ENOUGH, and the words are the fix. Three unlabelled bars rank at a glance
 * and explain nothing, so "Best for connections" still read as an arbitrary order — the reader had
 * no way to agree or disagree with it. The clause is derived from the same arithmetic that produced
 * the bars (`lib/events/score-reason.ts` differences `connectionScore` rather than restating it), so
 * the two cannot contradict each other.
 *
 * The level and the screen-reader label come from the same module for the same reason: this
 * component and the detail page each held their own copy of `>= 70 ? 3 : >= 50 ? 2 : 1`.
 */
export function ConnectionMeter({ score, reason }: { score: number; reason?: string }) {
  const level = meterLevel(score);
  const label = meterLabel(score);

  return (
    <span className="inline-flex items-center gap-2 min-w-0 text-[12.5px] text-[#6E6E73]" title={label}>
      {/* `meter-lg` rather than `meter`: at 3×11px, beside a 15.5px title, the bars read as a speck
          of punctuation. The detail page keeps the small one because a 19px verdict word sits
          beside it there and carries the judgement on its own. */}
      <span className="meter meter-lg shrink-0" data-level={level} aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      {/* The bars are the judgement; this is what a screen reader hears in their place, and what a
          pointer user gets from the title. NOT the number — the score is a ranking signal, and "83"
          would imply a precision it does not have. */}
      <span className="sr-only">{label}</span>
      {reason && (
        /* Wraps now rather than truncating at 210px. In the old metadata row a long clause pushed
           the host and the venue onto a third line, so cutting it was the lesser cost; in its own
           band the second line is free, and the tail of the clause is the part the reader had no
           other way to see. */
        <span className="min-w-0">{reason}</span>
      )}
    </span>
  );
}
