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
}) {
  if (tone === 'editorial') {
    return (
      <h2 className="t-head mb-3.5 text-[#1D1D1F]">{title}</h2>
    );
  }

  if (tone === 'shelf') {
    return (
      <div className="mb-2.5 flex items-baseline gap-2.5">
        <h2 className="min-w-0 flex-1 truncate text-[13px] font-semibold leading-[1.25] tracking-[-0.006em] text-[#1D1D1F]">
          {title}
        </h2>
        {caption !== undefined && caption !== null && (
          /* `--ink-3` (#8E8E93) was the caption colour everywhere on this page and it measures
             2.97:1 against the page grey at 11.5px — below the 4.5:1 floor. `--ink-2` (#6E6E73) is
             4.6:1 at the same size. See the report: the token itself is the defect, and this file
             cannot edit globals.css. */
          <span className="max-w-[52%] shrink-0 truncate text-[11.5px] text-[#6E6E73]">
            {caption}
          </span>
        )}
      </div>
    );
  }

  // `feed`: the grouped-list device, sticky under the command bar, rule and all.
  return (
    <div className="day-heading pt-2.5 pb-2 mb-1.5">
      <div className="flex items-center gap-2.5">
        <h2
          className={`flex shrink-0 items-center gap-1.5 text-[12.5px] font-semibold leading-[1.2] tracking-[0] ${
            live ? 'text-[#FF3B30]' : 'text-[#1D1D1F]'
          }`}
        >
          {live && <span className="live-dot h-1.5 w-1.5 rounded-full bg-[#FF3B30]" />}
          {title}
        </h2>
        {caption !== undefined && caption !== null && (
          <span className="min-w-0 truncate text-[11.5px] text-[#6E6E73]">{caption}</span>
        )}
        {/* The rule fills whatever is left, so it always reaches the column edge without a width. */}
        <span aria-hidden="true" className="h-px flex-1 bg-[color:var(--hairline)]" />
        {trailing !== undefined && trailing !== null && (
          <span className="tnum shrink-0 text-[11.5px] text-[#6E6E73]">{trailing}</span>
        )}
      </div>
    </div>
  );
}
