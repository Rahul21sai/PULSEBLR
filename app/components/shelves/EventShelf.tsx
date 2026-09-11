'use client';

import Link from 'next/link';
import EventRow from '../EventRow';
import EventGridCard from '../EventGridCard';
import { FeedEvent } from '@/lib/event-types';
import { dayHeading, timeIST, locationLabel } from '@/lib/format';

/**
 * One event as a COMPACT shelf card — no cover, and the matched company promoted to the top line.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS RATHER THAN A THIRD USE OF `EventGridCard`. Two reasons, and the design one came
 * first.
 *
 * 1. TWO ADJACENT SHELVES WITH THE SAME TREATMENT READ AS ONE CONFUSED BLOCK. "Curated by us" is
 *    already a 441px horizontal rail of cover cards. A second, identical 441px rail directly beneath
 *    it does not read as a different claim about different events — it reads as the first shelf
 *    having scrolled oddly. Differentiating them is what makes both legible.
 * 2. THE COVER IS THE WRONG THING TO LEAD WITH HERE. This shelf's entire claim is "Microsoft is
 *    hosting this and you follow Microsoft", and `EventGridCard` does not show the company at all —
 *    so the cover card spends 300px on an image while omitting the one fact that justifies the row.
 *    Leading with the company makes the card MORE informative than the cover version, not less.
 *
 * The budget is the third reason and the reason it happened now: measured, this is ~180px against
 * the cover rail's 441px on a 390px screen, and the page had already spent 2008px on sections above
 * the feed.
 *
 * It is a plain `Link`, so the whole card is one target and there is no nested interactive element —
 * `EventRow`'s save button and connection meter are deliberately not reproduced. A shelf is a
 * pointer; the event page is one tap away and has all of it.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */
function CompactShelfCard({
  event,
  highlight,
}: {
  event: FeedEvent;
  /** Company names worth naming — the reader's follow list. See `matched` below. */
  highlight: readonly string[];
}) {
  /*
   * ONLY A COMPANY IN BOTH SETS MAY BE NAMED. An event can carry three company names while the
   * reader follows only one, so printing `companies[0]` would put a company they do not follow on a
   * card under a heading saying they do. `undefined` when nothing matches — which cannot happen on
   * this shelf's own rows, but this component must not depend on its caller's filter to stay honest.
   */
  const matched = event.companies?.find(company => highlight.includes(company));
  const place = locationLabel(event);

  return (
    <Link
      href={`/events/${event._id}`}
      className="pressable flex h-full w-full flex-col gap-1 rounded-[14px] bg-white px-3.5 py-3 text-left shadow-[inset_0_0_0_1px_var(--hairline)] transition-colors hover:bg-[#FAFAFC] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0071E3]"
    >
      {matched && <span className="t-label truncate text-[#0071E3]">{matched}</span>}
      <span className="line-clamp-2 text-[13.5px] font-semibold leading-[1.3] tracking-[-0.01em] text-[#1D1D1F]">
        {event.title}
      </span>
      {/* Day, time and place on one line. `dayHeading` gives "Today"/"Tomorrow" where they apply,
          which is the part a reader scans for; the shelf spans weeks, so a bare time would leave the
          ordering looking arbitrary — the same reason the cover rails pass `showDate`. */}
      <span className="mt-auto truncate text-[11.5px] text-[#6E6E73]">
        <span className="font-semibold text-[#3a3a3c]">{dayHeading(event.startDateTime)}</span>
        {' · '}
        {timeIST(event.startDateTime)}
        {place && ` · ${place}`}
      </span>
    </Link>
  );
}

/**
 * The row of compact cards, in its two jobs.
 *
 * ONE DEFINITION, TWO CALLERS, and the only difference is what happens at `sm`. As the `compact`
 * VARIANT it is the shelf at every width, so it reflows from a scroller into a grid. As the mobile
 * half of a `cover` shelf it must simply stop existing at `sm`, where the cover rail takes over —
 * `sm:hidden` rather than `sm:grid`. Writing it twice is how the two drift, and the failure mode is
 * a shelf that renders both treatments at once on a laptop.
 */
function CompactRail({
  events,
  highlight,
  reflowAtSm,
}: {
  events: FeedEvent[];
  highlight: readonly string[];
  reflowAtSm: boolean;
}) {
  return (
    <div
      className={`-mx-4 flex snap-x snap-mandatory gap-2.5 overflow-x-auto overscroll-x-contain px-4 pb-1 no-scrollbar ${
        reflowAtSm
          ? 'sm:mx-0 sm:grid sm:grid-cols-2 sm:gap-3 sm:overflow-visible sm:px-0 lg:grid-cols-3'
          : 'sm:hidden'
      }`}
    >
      {events.map(event => (
        <div
          key={event._id}
          className={`flex w-[248px] shrink-0 snap-start ${reflowAtSm ? 'sm:w-auto' : ''}`}
        >
          <CompactShelfCard event={event} highlight={highlight} />
        </div>
      ))}
    </div>
  );
}

/**
 * A titled shelf of events above the ranked feed.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * TWO VARIANTS, AND `cover` IS THE DEFAULT FOR A REASON. It reuses `EventRow` and `EventGridCard`
 * rather than a shelf-only card: this design system permits one accent and keeps everything else
 * greyscale specifically so the cover images are the only colourful thing on screen, so a card that
 * leads with the cover is already the strongest treatment available — and reusing the feed's own card
 * means a shelf cannot drift from the list underneath it.
 *
 * `compact` (see `CompactShelfCard`) is the deliberate exception, for a shelf whose justifying fact
 * is not on the cover and which would otherwise be the second identical cover rail in a row. Its
 * header records the argument. Reach for it on those grounds, not to save space in general — a page
 * of compact shelves would have given up the covers, which are this design's only colour.
 *
 * WHAT FOLLOWS APPLIES TO `cover`. Two treatments switched by width, and the HORIZONTAL one is the
 * mobile half — the opposite
 * switch from the Spotlight, and the same one as "Curated by us", for the reason recorded there: a
 * shelf showing two events can put both covers side by side on a laptop and must stack them on a
 * phone, but a shelf showing up to six cannot stack — five vertical rows measured 877px and pushed
 * the first ranked row to y=1899 on a 375-wide screen, 2.34 screens of scroll before the feed.
 * A snap scroller costs ONE card height instead of six.
 *
 * A SCROLLER RATHER THAN A SHORTER LIST, because dropping rows is not available: `app/page.tsx`
 * removes these events from "Coming up" so nothing renders twice, so a row hidden on mobile is gone
 * from the phone entirely rather than merely deferred. Every card stays reachable by swipe, and by
 * Tab — focusing a link scrolls it into view.
 *
 * `compactOnMobile` REPLACES THE MOBILE HALF OF A COVER SHELF WITH THE COMPACT CARD, and its own
 * comment carries the measurement (285px on the curated shelf). It changes the card, never the number
 * of cards — which is what keeps it on the right side of the paragraph above.
 *
 * `-mx-4 px-4` cancels the section padding so the cards bleed to the screen edge and the shelf reads
 * as continuing past it, while the inner padding keeps the first card aligned with the heading.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */
export default function EventShelf({
  heading,
  caption,
  events,
  variant = 'cover',
  compactOnMobile = false,
  highlight = [],
}: {
  heading: string;
  /**
   * What makes these events THESE events, stated so a reader can judge the shelf.
   *
   * Required, not optional. Every shelf on this page is a claim — "hand-picked", "added by hand",
   * "hosted by a company you follow" — and a shelf whose basis a reader cannot see is indistinguishable
   * from an ad. The Spotlight's caption exists for exactly this reason and names which of its two
   * modes produced the rows.
   */
  caption: string;
  events: FeedEvent[];
  /**
   * `cover` reuses the feed's own cards; `compact` is the text treatment above.
   *
   * NOT A STYLE KNOB. Pick `compact` when the shelf sits next to another cover rail, when the fact
   * that justifies the row is not on the cover, or when the section budget above the feed is spent —
   * all three applied to "Hosted by a company you follow". Default `cover`, because reusing the
   * feed's card is what stops a shelf drifting from the list underneath it.
   */
  variant?: 'cover' | 'compact';
  /**
   * `cover` only: use the COMPACT card below `sm` and the cover rail from `sm` up.
   *
   * ─────────────────────────────────────────────────────────────────────────────────────────────
   * MEASURED, AND IT IS THE LARGEST SINGLE SAVING ON THE MOBILE HOME PAGE. A 262px cover card in the
   * mobile scroller is 375px tall — the cover is 147px of it and the body another 228px — so the
   * "Curated by us" section costs 449px on a 390px screen. The same six events as compact cards cost
   * 164px. That is 285px, a third of a phone screen, for a treatment nobody asked for on a phone.
   *
   * WHY THIS IS NOT THE SAME AS DROPPING ROWS. Every event still renders, in the same order, all six
   * reachable by swipe and by Tab. `app/page.tsx` subtracts a shelf's ids from "Coming up", so a row
   * a phone does not draw is gone from the phone entirely — that is the trap, and switching the CARD
   * does not go near it. Compare `WeekAheadStrip`, which may hide its per-day title precisely because
   * it claims nothing.
   *
   * THE COVER IS NOT WHAT THIS SHELF IS FOR. A cover earns its space by being the one colourful thing
   * on the screen, and it needs horizontal room to do that. At 262px inside a scroller a phone shows
   * one and a half of them, so the reader pays for six covers and sees one — while the facts that make
   * a shelf row worth a tap (when, where, who) are all text. From `sm` up the rail has the room and
   * the cover comes back.
   *
   * IT DOES PUT TWO COMPACT RAILS NEXT TO EACH OTHER ON A PHONE, which is the mirror of the clash
   * `CompactShelfCard`'s own header warns about. Checked on a screenshot rather than argued: the two
   * still read as two, because each keeps its own heading device (tracked label, hairline, caption) and
   * the cards differ where it matters — the following shelf's lead with a blue company line and the
   * curated shelf's do not, so one is visibly a line taller than the other. If a THIRD compact shelf
   * is ever added above the feed, re-check that on a screenshot before believing it still holds.
   * ─────────────────────────────────────────────────────────────────────────────────────────────
   */
  compactOnMobile?: boolean;
  /** For `compact`: the company names it may name. See `CompactShelfCard`. */
  highlight?: readonly string[];
}) {
  // The caller decides eligibility and precedence; this returns null only so no caller has to wrap
  // its own render in the same condition. An empty shelf is the ORDINARY state for most of these —
  // nobody has to have pinned, added or followed anything — so it must cost nothing and look like
  // nothing rather than like a misconfiguration.
  if (events.length === 0) return null;

  return (
    /* `pb-6 sm:pb-8`, and the 8px it gives back is not cosmetic on a phone. Four of these sections
       stack above the ranked feed, so the gap between them is paid four times — 32px, most of a
       card's title. From `sm` up the page is not fighting for vertical room and the original rhythm
       stands. The heading device itself is untouched: what changes is the space AFTER the shelf. */
    <section className="max-w-[1240px] mx-auto px-4 md:px-8 pb-6 sm:pb-8">
      <div className="day-heading pb-2 mb-3.5">
        <div className="flex items-center gap-2.5">
          <h2 className="t-label shrink-0 text-[#1D1D1F]">{heading}</h2>
          <span aria-hidden="true" className="h-px flex-1 bg-[color:var(--hairline)]" />
          {/* The caption sits beside the heading rather than inside it so the heading stays a stable
              landmark for a screen reader instead of changing every time the shelf does. */}
          <span className="shrink-0 text-[11.5px] text-[#8E8E93]">{caption}</span>
        </div>
      </div>

      {variant === 'compact' ? (
        /* ONE TREATMENT AT EVERY WIDTH, unlike the cover variant below.
           A compact card is legible at 250px and at 390px, so there is nothing for a breakpoint to
           fix — and the two-treatment switch exists only because a COVER needs horizontal room. On a
           phone this is a snap scroller; from `sm` up the same cards sit in a three-column grid,
           which is the same row of objects reflowed rather than a second design. */
        <CompactRail events={events} highlight={highlight} reflowAtSm />
      ) : (
        <>
          {compactOnMobile ? (
            <CompactRail events={events} highlight={highlight} reflowAtSm={false} />
          ) : (
            <div className="-mx-4 flex snap-x snap-mandatory gap-3.5 overflow-x-auto overscroll-x-contain px-4 pb-1 no-scrollbar sm:hidden">
              {events.map(event => (
                <div key={event._id} className="w-[262px] shrink-0 snap-start">
                  <EventGridCard event={event} />
                </div>
              ))}
            </div>
          )}
          {/* `showDate` because a shelf is not a schedule — its rows can be weeks apart, and without
              a date the ordering reads as arbitrary. */}
          <div className="hidden rail sm:block">
            {events.map(event => (
              <EventRow key={event._id} event={event} showDate />
            ))}
          </div>
        </>
      )}
    </section>
  );
}
