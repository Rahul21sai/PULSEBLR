'use client';

import { useState } from 'react';
import { categoryAccent, dateBlockIST, monogram } from '@/lib/format';

/**
 * Event cover image, and the thing shown when there isn't one.
 *
 * Uses a plain <img>, not next/image, on purpose: covers come from a long and
 * growing list of third-party CDNs (lumacdn.com, allevents.in, cloudfront for
 * Unstop, Meetup's photo hosts, Bevy's storage). next/image would need every one
 * declared in next.config remotePatterns, so the day a source changes CDN every
 * image 500s. A lazy <img> degrades to "no image" instead, which the fallback
 * already handles.
 *
 * ─── THE FALLBACK IS THE FEED'S IDENTITY, NOT AN EDGE CASE ─────────────────────────────────────
 *
 * Measured on the ranked feed: 40% of the first 20 rows have no `imageUrl` (29% corpus-wide), in an
 * unbroken run from rank 15 down. The whole design system is built on "covers are the only colour",
 * so for two rows in five the fallback is what the reader actually sees — and it used to be a
 * two-letter monogram, which carries no information whatsoever. `PB` tells you nothing you could
 * act on.
 *
 * So when the caller knows the date, the fallback IS the date, set in the display face in the
 * category tint. It reads as a designed tile rather than a placeholder, and the information on it is
 * the first thing a reader deciding "is this worth my evening" needs.
 *
 * `date` is OPTIONAL and the monogram is still here, deliberately: the event page's hero, its
 * related-event thumbnails and the tracker's kanban cards all call this component and are owned
 * elsewhere. They keep exactly what they had until their owners choose to pass a date.
 *
 * The tile is `aria-hidden` like the image it replaces. That is why the visual repeat of the date
 * beside the rail's own copy costs a screen-reader user nothing — they hear it once, from the row.
 */
export default function EventCover({
  src,
  title,
  category,
  className = '',
  monogramSize = 'text-lg',
  date,
}: {
  src?: string;
  title: string;
  category?: string;
  className?: string;
  monogramSize?: string;
  /** When given, a coverless event shows this date instead of a monogram. */
  date?: string | Date;
}) {
  const [failed, setFailed] = useState(false);
  const accent = categoryAccent(category);

  if (!src || failed) {
    /*
     * FLAT tint, never a 135° two-tone gradient.
     *
     * A saturated diagonal made every one of these shout louder than the real photographs beside
     * it — which inverts the system: the photograph is content, the tile is chrome. A pale wash of
     * the category colour with the type in that same colour keeps the category signal, stays quiet
     * next to real imagery, and is the one sanctioned use of category colour (it may tint a block
     * or carry a thin spine; it may never become a badge or a fill).
     */
    /*
     * THE TYPE MIX WAS 78% AND SEVEN CATEGORIES FAILED CONTRAST AT IT. Measured in the browser over
     * all 22 accents, type on its own 12% wash: at 78% the worst is Hardware/Robotics at **2.45:1**,
     * and `Meetup` — one of the commonest categories in the corpus — sits at 2.82:1. Seven fail even
     * the 3:1 floor that only large text is allowed, and seventeen fail 4.5:1. That was already true
     * of the shipped monogram; the date tile would have inherited it and made it worse, because the
     * month label is ~11px and 11px type gets no large-text exemption.
     *
     * At 50% the worst case is 4.59:1 and all 22 pass 4.5:1 at any size. The tile reads as ink with
     * a category cast rather than as a coloured object, which is also the right answer to a second
     * problem: `categoryAccent('AI/ML')` is `#0071E3`, byte-identical to `--blue`, and AI/ML is the
     * largest category in the corpus. At 78% the commonest tile in the feed was painted in the one
     * colour reserved for "you can act on this".
     */
    const tint = {
      background: `color-mix(in srgb, ${accent} 12%, #FFFFFF)`,
      color: `color-mix(in srgb, ${accent} 50%, #1D1D1F)`,
      boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.05)',
    };

    if (date) {
      const { day, month } = dateBlockIST(date);
      return (
        /* Sizes itself from the box it is given — see `.cover-date` in globals.css. One
           implementation therefore serves a 76px square on a phone, a 104px one on a desktop row
           and a 16:9 grid tile, with no size prop to keep in step at four call sites. */
        <div className={`cover-date ${className}`} style={tint} aria-hidden="true">
          <span className="cover-date-day tnum">{day}</span>
          <span className="cover-date-month">{month}</span>
        </div>
      );
    }

    return (
      <div className={`cover-fallback ${monogramSize} ${className}`} style={tint} aria-hidden="true">
        {monogram(title)}
      </div>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- third-party CDNs, see file header
    <img
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      className={`cover ${className}`}
    />
  );
}
