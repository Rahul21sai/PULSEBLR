import type { ReactNode } from 'react';

/**
 * Every section heading on the home page, in THREE DECLARED WEIGHTS.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS: THE PAGE HAD ONE HEADING DEVICE AND USED IT SEVEN TIMES.
 *
 * A tracked ALL-CAPS `t-label`, a hairline filling the remaining width, and an 11.5px grey caption
 * on the right — repeated identically above the week strip, the Spotlight, the curated shelf, the
 * following shelf, "Happening now", "Coming up" and every day group. The sections are not equals:
 * the Spotlight is editorial, the curated shelf is supply the scrapers cannot reach, the following
 * shelf is a fact about the reader, and the feed's own headings are landmarks in a list that runs
 * for hundreds of rows. Drawing all seven the same way told the reader none of that, so the page
 * read as one texture and the eye had nothing to rank.
 *
 * The three tones and what each is FOR:
 *
 *   `editorial` — the Spotlight, and nothing else. It is the loudest thing between the hero and the
 *                 feed because it is two large covers chosen on the reader's behalf, and this design
 *                 system rations colour precisely so a cover carries it. `t-head` is an EXISTING
 *                 step in the scale (globals.css), not a new size invented for one heading.
 *   `shelf`     — the week strip, the curated shelf, the following shelf. Static titles over one row
 *                 of cards. 13px semibold sentence case: legible, quiet, and NOT a device.
 *   `feed`      — "Happening now", "Coming up", and each day group. The ONLY tone that is sticky and
 *                 the only one that keeps the hairline rule, because only here is a heading doing a
 *                 grouped-list job: marking a boundary inside a list long enough that the reader
 *                 needs to be told where they are. Apple's sectioned table earns that rule; a
 *                 one-row shelf does not.
 *
 * ── AND FROM `lg` THE `feed` TONE BECOMES A DATE RAIL, WHICH IS WHAT `railed` SWITCHES. ────────
 * A sticky bar is the right device on a phone, where the column is the screen. On a laptop the feed
 * column is ~730px and a full-width 13px label with a hairline running off to the right of it is a
 * lot of horizontal rule to say "Saturday" — and it floats OVER the rows it belongs to, so the
 * reader loses a line of content to it for the whole descent. In `railed` mode the caller puts this
 * heading in a 136px left column and the rows in the other, and the heading sticks down its own
 * column: the date stays on screen for as long as its rows do, occludes nothing, and the section
 * reads as a dated entry in a diary rather than as a bar taped over a list.
 *
 * STICKINESS IS NOW INFORMATION. `.day-heading` is `position: sticky`, so before this the reader
 * scrolled through a relay of seven headings taking turns under the command bar, four of them
 * belonging to sections a single swipe tall. Now the first heading that sticks is the feed's, which
 * means "you are in the list" — something worth saying.
 *
 * ── ALL-CAPS WAS ALSO SCROLLING THE PAGE SIDEWAYS. ─────────────────────────────────────────────
 * Not a style complaint. Measured in a static harness at 390x844: the following shelf's heading row
 * put its right edge at **x=426 in a 390px viewport**, scrolling the whole document body — which
 * `docs/design-direction.md` forbids outright. The cause is the device itself. `t-label` is 11px
 * uppercase at +0.055em, so "Hosted by a company you follow" set 243px wide where the same words in
 * 13px sentence case set ~170px; the `<h2>` carried `shrink-0` and the caption carried `shrink-0`,
 * so with a three-company caption neither yielded and 433px of content sat in 358px of room.
 *
 * Two things fix it and BOTH are kept, because the first alone would only move the threshold: the
 * caps are gone, and in the `shelf` tone the title may shrink (`min-w-0 truncate`) while the caption
 * is bounded (`max-w-[52%] truncate`). No combination of heading and caption can overflow now.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */
export type SectionTone = 'editorial' | 'shelf' | 'feed';

export default function SectionHeading({
  tone,
  title,
  caption,
  trailing,
  live = false,
  railed = false,
}: {
  tone: SectionTone;
  /** Sentence case. A heading, never a label — if the content below says it, do not say it here. */
  title: ReactNode;
  /**
   * The evidence for the section's claim: the companies matched, the date a day group covers.
   *
   * `editorial` has no caption slot, deliberately. The Spotlight's caption used to be the whole
   * claim ("Hand-picked" / "Best for connections right now") set in 11.5px grey at the far right of
   * the line, i.e. the least-read position on the row, under a heading that said only "SPOTLIGHT" —
   * a word that describes nothing about why those two events. The claim is now the heading and
   * there is no second slot to fill.
   */
  caption?: ReactNode;
  /** `feed` only: the row count, after the rule. */
  trailing?: ReactNode;
  /** `feed` only: an event in progress. The one place a second hue is spent. */
  live?: boolean;
  /**
   * `feed` only: this heading is the LEFT COLUMN of a two-column section from `lg` — see the
   * date-rail note at the foot of this file. The caller supplies the grid; this supplies the
   * stacked, rule-less shape the narrow column needs, and the sticky element that travels in it.
   */
  railed?: boolean;
}) {
  if (tone === 'editorial') {
    /* `.ty-section` — 26px Jakarta 600, from the shared scale. SANS, and that is the semantic rule
       doing work rather than being restated: this heading is a group the SYSTEM made ("Best for
       connections right now"), not a thing that exists in the city, so it is the product's voice.
       The event titles under it are the serif. It was `t-head`, 19px in the DISPLAY face, which put
       the app's own claim in the same typeface as the events it was claiming about — and at 19px it
       was barely louder than the shelf tone it is supposed to outrank. */
    return <h2 className="ty-section mb-[var(--s-4)] text-[var(--ink)]">{title}</h2>;
  }

  if (tone === 'shelf') {
    return (
      /* `.ty-meta` ON THE ROW, NEVER ON THE `<h2>` — the class is unlayered in globals.css and every
         Tailwind utility is in `@layer utilities`, so `ty-meta font-semibold text-[var(--ink)]` on one
         element computes weight 500 in --ink-2. Measured: this heading rendered grey and unbolded with
         both utilities present in its class list. On the parent the size, the face and `tabular-nums`
         inherit and each child keeps its own weight and ink. */
      <div className="ty-meta mb-[var(--s-3)] flex items-baseline gap-[var(--s-3)]">
        <h2 className="min-w-0 flex-1 truncate font-semibold text-[var(--ink)]">{title}</h2>
        {caption !== undefined && caption !== null && (
          /* `--ink-3` was the caption colour everywhere on this page and measured 2.97:1 against the
             page grey — below the 4.5:1 floor. `--ink-2` clears it. The palette block in globals.css
             states the rule outright: `--ink-3` is icons, disabled and decorative only, never text.

             It goes UP from 11.5px to the scale's 13px meta step, and the overflow this file's header
             records cannot come back from it: the title is `min-w-0 flex-1 truncate` and this is
             bounded at 52% and truncates, so no pair of strings can exceed the column. */
          <span className="max-w-[52%] shrink-0 truncate">{caption}</span>
        )}
      </div>
    );
  }

  // `feed`: the grouped-list device — a sticky bar under the command bar below `lg`, and the sticky
  // DATE RAIL of a two-column section from `lg`.
  return (
    /*
     * ── `lg:self-start` IS NOT COSMETIC: WITHOUT IT THE RAIL CANNOT TRAVEL, AND WITH A WRAPPER
     *    ROUND IT THE PHONE'S BAR CANNOT EITHER. BOTH WERE MEASURED, THE SECOND ONE AS A BUG I
     *    SHIPPED FOR TWENTY MINUTES. ───────────────────────────────────────────────────────────
     *
     * A sticky element can only move inside its containing block, so this element must BE the tall
     * box's child (below `lg`, where the `<section>` is that box) and its grid item (from `lg`, where
     * the grid AREA is that box — a grid area is sized by the row, i.e. by the rows column beside it,
     * not by this item).
     *
     *  · The first attempt put a plain `<div>` around this to be the grid cell. At `lg` that worked;
     *    below `lg` the wrapper is only as tall as the heading, so the sticky child had ZERO travel
     *    and the phone's sticky day heading silently stopped sticking. Caught by the harness
     *    reporting "none pinned" at 768 — nothing about the rendering says a sticky element has lost
     *    its scroll range.
     *  · `align-self` defaults to `stretch`, which would make this item exactly as tall as its own
     *    grid area — again zero travel, and again invisible on any group short enough to fit the
     *    viewport. `lg:self-start` is what keeps the area tall and the item short.
     */
    <div
      className={`day-heading pt-[var(--s-3)] pb-[var(--s-2)] mb-[var(--s-1)] ${
        railed ? 'lg:self-start' : ''
      }`}
    >
      {/* `.ty-meta` on the ROW — see the note in the `shelf` branch. It is what made the `live`
          heading render in --ink-2 instead of `--live` when the class sat on the `<h2>` itself. */}
      <div
        className={`ty-meta flex items-center gap-[var(--s-3)] ${
          railed ? 'lg:flex-col lg:items-start lg:gap-[var(--s-1)]' : ''
        }`}
      >
        <h2
          className={`flex shrink-0 items-center gap-1.5 font-semibold ${
            live ? 'text-[var(--live)]' : 'text-[var(--ink)]'
          }`}
        >
          {live && <span className="live-dot h-1.5 w-1.5 rounded-full bg-[var(--live)]" />}
          {title}
        </h2>
        {caption !== undefined && caption !== null && (
          <span className={`min-w-0 truncate ${railed ? 'lg:order-3 lg:max-w-full' : ''}`}>
            {caption}
          </span>
        )}
        {/* The rule fills whatever is left, so it always reaches the column edge without a width.
            GONE in the rail, where there is no width left to fill and a 128px hairline beside a date
            would read as a dash. The rows' own `rule-b` is what separates there. */}
        <span
          aria-hidden="true"
          className={`h-px flex-1 bg-[var(--rule)] ${railed ? 'lg:hidden' : ''}`}
        />
        {trailing !== undefined && trailing !== null && (
          <span className={`shrink-0 ${railed ? 'lg:order-4' : ''}`}>{trailing}</span>
        )}
      </div>
    </div>
  );
}
