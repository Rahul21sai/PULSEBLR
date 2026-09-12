'use client';
import Link from 'next/link';

import { FeedEvent } from '@/lib/event-types';
import { timeIST, dayLabelIST, isHappeningNow } from '@/lib/format';
import EventCover from './EventCover';
import SaveButton from './SaveButton';
// Imported from the list row rather than copied or given its own file: which facts a card may state
// is ONE decision, and two copies of it would drift the way the two copies of the `>= 70 ? 3`
// threshold already had. It is also what keeps the view toggle honest — grid changes the SHAPE of
// the list, never what it tells you.
import { EventFactsLine } from './EventRow';

/**
 * Image-forward card for grid view, the Spotlight and the curated shelf.
 *
 * Grid view exists for a different task than the list: browsing by vibe rather than scheduling. So
 * here the cover leads at 16:9 and the date moves into the card, since there is no clock gutter to
 * carry it. **This is where the covers live now** — the list row dropped its 76px thumbnail, so the
 * one element this design system allows to carry colour gets a full-width box instead of a stamp.
 *
 * ─── FOUR THINGS CAME OFF THIS CARD, AND NONE OF THEM WAS TASTE ─────────────────────────────────
 *
 * 1. **`card-shadow` AND THE 16px RADIUS.** `--lift-1` is `none`, so the class already composited
 *    to nothing and the card was a white rectangle on paper with no defined edge — which is exactly
 *    the complaint the old elevation system was replaced over. `--r-flat` is the rule for a
 *    container, and a hairline is what separates: this is a `rule-b`, and its own cover is its top
 *    edge. The touchable elements on it (the title link, Save) keep `--r-touch`, so radius means
 *    one thing here instead of two.
 * 2. **THE `.meter`.** Three bars from `connectionScore`, on a card in a grid whose ORDER is that
 *    same score. See `EventRow`'s header: the score may never be drawn as a bar, and nothing
 *    replaces it.
 * 3. **THE 3px CATEGORY SPINE** under the cover. It was doing the job of a rule in a colour from
 *    outside the nine, on the seam where this design system's answer is a hairline. The category
 *    signal survives where it carries information rather than decoration: `EventCover` tints a
 *    coverless tile with it, and 29% of the corpus is coverless.
 * 4. **THE PILL ROW.** `EventPills` is deleted, not merely dropped — see `EventFactsLine`, which
 *    replaces it on both card shapes and states in prose what five capsules said in chips,
 *    including the price rule that had a `Free` pill on 88.5% of rows.
 */
export default function EventGridCard({ event }: { event: FeedEvent }) {
  const primaryCategory = event.category?.[0];
  const href = `/events/${event._id}`;
  const live = isHappeningNow(event.startDateTime, event.endDateTime);

  return (
    <article className="group flex h-full flex-col rule-b">
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
          /* No clock gutter here, so a coverless tile becomes the date at poster scale — the
             strongest typographic moment in the feed, and the only colour it uses is the category
             tint the deleted pill used to shout. */
          date={event.startDateTime}
        />
      </Link>

      <div className="flex flex-1 flex-col gap-[var(--s-2)] pt-[var(--s-3)] pb-[var(--s-4)]">
        {/* `.ty-meta` on the ROW, not on the date span — see the long note in `EventRow`: the class
            is unlayered, so a `font-semibold` or `text-[…]` utility on the same element is silently
            discarded and the date rendered at weight 500 in --ink-2. On the parent it supplies the
            size, the face and `tabular-nums` by inheritance and the child keeps its overrides. */}
        <div className="ty-meta flex items-start justify-between gap-[var(--s-2)]">
          {/* "at" rather than a middle dot: this card spends its one dot chain on the facts line
              below, where the parts genuinely are a list of equals. A date and a time are a
              sentence. `--live` on the whole clause is the same signal the list row's gutter
              carries, and the only second hue on the card. */}
          <span className={`font-semibold ${live ? 'text-[var(--live)]' : 'text-[var(--ink-2)]'}`}>
            {live
              ? 'Happening now'
              : `${dayLabelIST(event.startDateTime)} at ${timeIST(event.startDateTime)}`}
          </span>
          {/* Same as the list row: the feed can only show what you already saved if the flag the
              API sends actually reaches the button. */}
          <SaveButton eventId={event._id} initiallySaved={event.tracked} />
        </div>

        {/* `.ty-row-title` — the SAME class the list row uses, and the same class the event page
            gives a venue name. An event title is a thing in the world at every size, so the two
            card shapes share one step of the scale rather than each picking its own; `.ty-lede` was
            tried and is wrong by role (it is an editorial standfirst) and by leading (1.6 on a
            clamped two-line title sets the second line adrift). */}
        <h3 className="ty-row-title text-[var(--ink)]">
          <Link href={href} className="line-clamp-2 hover:text-[var(--accent)] transition-colors">
            {event.title}
          </Link>
        </h3>

        <EventFactsLine event={event} className="mt-auto" />
      </div>
    </article>
  );
}
