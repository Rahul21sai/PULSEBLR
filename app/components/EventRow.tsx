'use client';
import Link from 'next/link';

import { FeedEvent } from '@/lib/event-types';
import {
  timeIST,
  shortDateIST,
  istDaysSpanned,
  locationLabel,
  priceLabel,
  isHappeningNow,
} from '@/lib/format';
import SaveButton from './SaveButton';

/**
 * One row of the feed — an EDITORIAL LIST ROW, not a card.
 *
 * ```
 *  19:30    Kubernetes Bengaluru Meetup #42          [save]
 *           Indiranagar · CNCF Bangalore · 180 going
 *  ───────────────────────────────────────────────────────
 * ```
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT CAME OFF, AND WHY EACH REMOVAL IS THE POINT RATHER THAN A SIDE EFFECT.
 *
 * This row was a white `rounded-[18px] card-shadow` panel holding a 76px cover thumbnail, a
 * 15.5px sans title, an organiser line with an avatar, a venue line, a hairline band, three
 * connection bars, a reason clause and a pill row — thirty of them stacked down the page. Since
 * `--lift-1` was neutralised to `none`, the shadow composited to nothing, so what a reader
 * actually met was thirty white rectangles floating on the paper ground with no defined edge.
 * A list of cards is the one shape that reads as a template no matter what is in it.
 *
 *  · **THE CARD.** `--r-flat` on containers and list rows is the geometry rule, and hairlines do
 *    all separating. So the row is a `rule-b` and nothing else: no surface, no radius, no ring.
 *    The paper is the ground for the whole feed, which is what lets the day headings and the
 *    rows read as one document instead of as a stack of objects.
 *
 *  · **THE `.meter`.** Three bars derived from `connectionScore`. The direction is explicit that
 *    the score may never be a number, bar, meter, star or percentage — it is a ranking signal,
 *    and "83" (or three bars) implies a resolution it does not have. CLAUDE.md §7 calls the meter
 *    "the signature element"; that is now history, and `/events/[id]` lost it in the same pass.
 *    **ROW ORDER IS HOW THE SCORE EXPRESSES ITSELF HERE.** Nothing replaces the bars — no badge,
 *    no dot scale, no word like "high". The full rationale is one tap away on the event page,
 *    which is where an argument belongs.
 *
 *  · **THE COVER THUMBNAIL.** The hardest removal to argue and the one with the best evidence:
 *    `EventCover`'s own header measures **40% of the first twenty ranked rows with no
 *    `imageUrl`** (29% corpus-wide), and its fallback for those is the event's DATE in the
 *    category tint — sitting 12px from a gutter printing the same date. Two rows in five spent
 *    76px square repeating their own neighbour. Removing it also returns ~90px of measure to the
 *    title at 390px, which is what lets a 20px serif set as a headline rather than as a caption.
 *    Covers are still the only colour this design system permits — they lead the Spotlight, the
 *    curated shelf and grid view, all of which are one tap or one toggle away.
 *
 *  · **THE RAIL SPINE AND ITS NODE.** `.rail::before` drew a 1px vertical line at 58px and
 *    `.rail-node` a dot where each card met it. That is a second separator system running at
 *    right angles to the hairlines that now do the separating, and the node existed to mark the
 *    join between a spine and a card — neither of which is left. Its 9px column is gone too.
 *
 *  · **THE PILL ROW, AND `EventPills.tsx` WITH IT — THE FILE IS DELETED.** Five `rounded-full`
 *    capsules per row is the one geometry this system does not have: radius here means "you can
 *    touch this", and nothing in a pill row is touchable. Dropping it from the row alone would have
 *    left the component alive for `EventGridCard`, i.e. two vocabularies for the same four facts
 *    across two views of one list — so `EventFactsLine` below serves both and the pills are gone.
 *    That also closes a live violation of a recorded refusal: the price pill was `Free` on 88.5% of
 *    rows. What each pill carried is accounted for in `EventFactsLine`'s header.
 *
 * WHAT THE TWO FACES ARE DOING, because it is the whole design in two lines of type. The title
 * is `.ty-row-title` — 20px Newsreader, the same class the event page gives a venue name —
 * because an event is a thing in the world. Everything else on the row is the app talking about
 * it, so the clock, the date, the area, the host and the count are all tabular Jakarta at 13px.
 * A reader can tell the two apart before reading a word, which is the only reason the row needs
 * no labels, no icons and no chips to be scannable.
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 */
export default function EventRow({
  event,
  showDate = false,
}: {
  event: FeedEvent;
  /**
   * Render the DATE above the time in the gutter.
   *
   * Off by default, because in the day-grouped feed the section heading already says which day it
   * is and repeating it on every row is noise.
   *
   * It must be ON for any ungrouped list — the ranked sorts, which are the DEFAULT view. Those
   * deliberately have no day headings (grouping a ranked list by day would re-sort it
   * chronologically and discard the ranking), and without this the gutter showed "18:30 / 21:30"
   * with the date appearing nowhere on the row at all. Verified at 375px: a reader could not tell
   * whether the top event was tonight or in three weeks.
   */
  showDate?: boolean;
}) {
  const live = isHappeningNow(event.startDateTime, event.endDateTime);
  const href = `/events/${event._id}`;
  const spanDays = event.endDateTime
    ? istDaysSpanned(event.startDateTime, event.endDateTime)
    : 0;

  return (
    /*
     * `rule-b` on every row, including the last of a group. The day heading below it opens with
     * its own rule, so a group boundary reads as one line rather than two — and the final row of
     * the final group wants a rule anyway: it is what tells the reader the list has ended rather
     * than been cut off.
     */
    <article className="rule-b">
      <div className="flex items-start gap-[var(--s-3)] py-[var(--s-4)] md:gap-[var(--s-4)]">
        {/*
         * THE CLOCK GUTTER — a schedule column read vertically, which is the one thing a card
         * cannot give you. `tnum` (from `.ty-meta`) is what makes it a column: proportional
         * figures put "11:00" and "19:30" at different widths and the edge stops being straight.
         *
         * 54px holds `26 Sept` at 13px with 2px to spare; 68px from `md`. The date is above the
         * time and quieter than it, because under a ranked sort the date is context and the time
         * is what is being scanned.
         */}
        {/*
         * `.ty-meta` IS ON THIS CONTAINER AND NOT ON THE THREE SPANS INSIDE IT, AND THAT IS A HARD
         * CONSTRAINT OF THE SUBSTRATE RATHER THAN A STYLE CHOICE.
         *
         * `.ty-meta` is written UNLAYERED in globals.css while every Tailwind utility is emitted into
         * `@layer utilities`, and an unlayered declaration beats every layered one whatever its
         * specificity. So `ty-meta font-semibold text-[var(--ink)]` on one element silently computes
         * **weight 500 in --ink-2** — measured in Chromium, on this very row, before this comment
         * existed: the clock rendered grey and unbolded and nothing in the source said so.
         *
         * Putting the class on the PARENT gives the children the size, the face and `tabular-nums` by
         * inheritance, and leaves each free to set its own weight and ink with an ordinary utility —
         * because those children carry no unlayered rule of their own. It is the only fix that keeps
         * the scale in one place; the alternative is hand-setting `text-[13px] leading-[1.4]` per
         * element, which is the drift the scale exists to prevent.
         */}
        <div className="ty-meta w-[54px] shrink-0 md:w-[68px]">
          {showDate && (
            <span className="block whitespace-nowrap">{shortDateIST(event.startDateTime)}</span>
          )}
          <span
            /* `--live` on the clock is the ONE place a row spends the second hue, and it replaces
               `.rail-node[data-live]`'s dot. The time is the right carrier: what is urgent about a
               live event is its clock, and the ranked feed already groups live rows under their own
               heading, so a per-row badge would say it twice. */
            className={`block font-semibold ${live ? 'text-[var(--live)]' : 'text-[var(--ink)]'}`}
          >
            {timeIST(event.startDateTime)}
          </span>
          {event.endDateTime && (
            /*
             * A multi-day event shows how many days it RUNS, not a bare end time.
             *
             * Printing the end time unconditionally made every multi-day event read as ending
             * before it started: 15 of the first 100 tech events cross an IST day boundary, and the
             * conference sources are worst because their dates are date-only — `Great International
             * Developer Summit` (3 days) rendered "05:30 / 05:30". Identical start and end reads as
             * a data bug, so the reader distrusts the row rather than understanding it.
             *
             * `+3d` rather than the end date, because the exact end is on the event page and this
             * gutter is 54px. `--ink-2`, not `--ink-3`: the ink ramp forbids the lightest grey for
             * text at any size, and this is 13px.
             */
            <span
              /* No `text-[…]` here: `--ink-2` is what `.ty-meta` on the parent already gives, and a
                 utility restating it would look like it was doing work it cannot do — see the note
                 above. `--ink-3` would be wrong anyway; the ink ramp forbids it for text. */
              className="block"
              title={
                spanDays > 0
                  ? `Runs until ${shortDateIST(event.endDateTime)}`
                  : `Ends ${timeIST(event.endDateTime)}`
              }
            >
              {spanDays > 0 ? `+${spanDays}d` : timeIST(event.endDateTime)}
            </span>
          )}
        </div>

        <div className="min-w-0 flex-1">
          {/* `.ty-row-title`: 20px Newsreader at 390, 22px from 768. The loudest thing in the
              feed, and the only serif on the row. `line-clamp-2` because a scraped title can run
              to 140 characters and a three-line headline turns a schedule back into a wall. */}
          <h3 className="ty-row-title text-[var(--ink)]">
            <Link href={href} className="line-clamp-2 hover:text-[var(--accent)] transition-colors">
              {event.title}
            </Link>
          </h3>
          <EventFactsLine event={event} className="mt-[var(--s-1)]" />
        </div>

        {/* Already `r-touch` with a 44px `::after` overlay of its own. It stands 12px clear of the
            title link, which is more than the 8px two overhangs would need to stop contesting each
            other's band — the failure the scan sheet records. */}
        <SaveButton eventId={event._id} initiallySaved={event.tracked} />
      </div>
    </article>
  );
}

/**
 * Where, who, how many, what it costs — one line, in the reader's question order.
 *
 * EXPORTED AND SHARED WITH `EventGridCard`, for the reason that file already gives for importing
 * from this one: which facts a card may state is ONE decision, and two copies of it drift the way
 * two copies of the `>= 70 ? 3` threshold already had. It is also what keeps the view toggle honest
 * — switching to grid changes the SHAPE of the list, never what it tells you.
 *
 * THIS REPLACES `EventPills`, WHICH IS DELETED. Five capsule chips per row said the same four
 * things at a fifth of the legibility, and radius in this system means "you can touch this" —
 * nothing in a pill row is touchable. Everything the pills carried survives: live is the clock in
 * `--live`, the price and the count and the venue are here, `Curated` is the last element below,
 * and the duration is derivable from a start and an end. What did NOT survive is the `Food` chip,
 * which is a perk rather than a fact about where and when, and which the event page states in
 * prose where there is room to say what the food actually is.
 *
 * **NO "FREE" ELEMENT, AND THAT IS A MEASURED REFUSAL RATHER THAN AN OMISSION.** `Event.isFree` is
 * `{ type: Boolean, default: true }` and reads true on 88.5% of upcoming tech events, so a `Free`
 * label carries no information on nine rows in ten — and `EventPills` was still drawing one, filled,
 * on every card in the feed, against a refusal `docs/design-decisions.md` records explicitly. A
 * price is printed only when there IS a price; absence means free.
 *
 * **NO CLAUSE FROM THE SCORER EITHER.** The direction permits row order "plus at most one factual
 * clause", and at most one includes none. The three clauses a row would earn — in person, the
 * attendee count, the price — are already here as facts the event states about itself, so a
 * scorer-derived sentence would be the app repeating them back in its own voice thirty rows deep.
 * `locationLabel` returning `Online` is what makes "in person" redundant rather than merely
 * repetitive: the format is legible from the place on every row, both ways round. `cardReasonLine`
 * went with it — it had no other caller.
 */
export function EventFactsLine({ event, className = '' }: { event: FeedEvent; className?: string }) {
  /*
   * THE AREA, NOT THE VENUE, AND THAT IS THE WHOLE DIFFERENCE BETWEEN ONE LINE AND THREE.
   *
   * `locationLabel` returns `venue · area` and the venues are scraped strings that already carry the
   * city: measured on the live feed, `East of NGEF Layout, Bengaluru · Kalyan Nagar` and
   * `Prestige Ferns Galaxy, Bellandur, Bengaluru · Sarjapur Road`. Prefixing that to a host and a
   * count wrapped this line to THREE lines under a two-line serif title, which is how a row starts
   * competing with itself again.
   *
   * The area is also the fact the decision actually turns on — "can I get to Indiranagar on a
   * Tuesday" — while the street address is what you need once you have decided, which is what the
   * event page is for. `locationLabel` is kept as the fallback so an event with no `area` still says
   * where it is (venue, then city) and an online one still says `Online`; area coverage is 63.7%
   * after the geo backfill, so the fallback is a third of rows rather than an edge case.
   *
   * `'Other'` IS EXCLUDED, AND IT IS THE COMMONEST BUCKET — 31 of the areas the facet endpoint
   * returns for the tech feed, against 11 for the runner-up. It is `resolveArea`'s sentinel for "a
   * Bengaluru event we cannot place", so printing it renders an internal bucket name to a reader as
   * though it were a neighbourhood: the row read `Other · bangalore apache airflow meetup`.
   *
   * EXCLUDING IT HERE WAS NOT ENOUGH, and that is worth recording because the first attempt looked
   * right and shipped the same string: `locationLabel` composes `venue · area` ITSELF, so falling
   * through to it re-introduced `Uber Bangalore Office · Other`. The fallback therefore hands it an
   * event with `area` cleared, which is also why this is not just `event.venue` — that keeps
   * `dropRepeatedSegments` (venues arrive as `Prestige Ferns Galaxy, Bellandur, Bengaluru`) and the
   * city fallback for a row with no venue at all.
   */
  const area = event.area && event.area !== 'Other' ? event.area : null;
  const place =
    event.format === 'online' ? 'Online' : (area ?? locationLabel({ ...event, area: undefined }));
  const facts: string[] = [place];

  // The host is the fact a reader cannot infer from anywhere else on the row, and the one this
  // product is actually about — "CNCF Bangalore is running this" is why you would go. The avatar
  // that used to sit beside it is gone: a 16px third-party image is decoration at that size, and it
  // was the row's only network request once the cover went.
  if (event.organizer) facts.push(event.organizer);
  if (typeof event.attendeeCount === 'number' && event.attendeeCount > 0) {
    facts.push(`${event.attendeeCount} going`);
  }
  if (event.soldOut) facts.push('Sold out');
  else if (!event.isFree && event.price) facts.push(priceLabel(event));
  // LAST, because it is a claim about the listing rather than about the event. `source: 'manual'` is
  // what `POST /api/events` writes for anything typed in by hand, and in grid view — which has no
  // "Added by hand" shelf heading above it — this is the only place that provenance appears.
  if (event.source === 'manual') facts.push('Added by hand');

  return (
    /* `line-clamp-2` is a CEILING, not the expected shape: with the area rather than the venue the
       line fits once on almost every row, and the clamp is there so a 60-character community name
       (`Bangalore Apache Airflow / Iceberg / Kafka Meetup Group`) cannot turn a 110px row into a
       160px one. Two lines of 13px is the most a fact line may spend under a title. */
    <p className={`ty-meta line-clamp-2 ${className}`}>{facts.join(' · ')}</p>
  );
}
