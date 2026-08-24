/**
 * The PulseBLR mark.
 *
 * A single-stroke pulse trace. Literal on purpose: this app's one job is telling you what is
 * happening in the city right now, and a pulse reads as "live" at 20px in a way an abstract
 * glyph does not. The trace is asymmetric — a flat lead-in, one tall spike, a short echo — so it
 * is recognisable as a silhouette rather than as a generic zigzag.
 *
 * `currentColor`, NOT a fixed brand colour, and that is the design-system call. `app/globals.css`
 * rule 4 is "one accent, rationed: --blue means you can act on this, and is never decoration."
 * A blue logo would spend the accent on identity. Inheriting `currentColor` instead means the
 * mark is ink beside the ink wordmark and turns blue on hover exactly when the wordmark does,
 * because the link already animates its own colour. One fewer colour, one more relationship.
 *
 * Geometry notes, since a mark gets re-drawn by people who did not draw it:
 *   · 24x24 viewBox, stroke-only, no fill — so it scales to a favicon and up to a hero.
 *   · strokeWidth 2.1 holds at 20px without the spike closing up. Below ~16px use the tile
 *     version in `public/icon-192.svg` instead; a hairline trace disappears at that size.
 *   · round caps and joins: the design system's surfaces are all soft radii, and a mitred
 *     spike here looks like a different family.
 *   · `vectorEffect="non-scaling-stroke"` is deliberately NOT set — the stroke should thicken
 *     with the mark, otherwise it reads as a hairline at hero sizes.
 */
export default function Logo({ className = '', title }: { className?: string; title?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={2.1}
      strokeLinecap="round"
      strokeLinejoin="round"
      // Decorative beside the "PulseBLR" wordmark, which already names the brand. Given a
      // `title` it becomes an image with that accessible name instead — for the places where
      // the mark stands alone.
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : 'true'}
      aria-label={title}
    >
      <path d="M1.8 14.1h4.1l2.2-6.6 3.1 9.9 2.3-5.2 1.7 1.9h5.1" />
    </svg>
  );
}
