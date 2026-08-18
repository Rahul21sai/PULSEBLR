'use client';

import { useState } from 'react';
import { categoryAccent, monogram } from '@/lib/format';

/**
 * Event cover image with a graceful fallback.
 *
 * Uses a plain <img>, not next/image, on purpose: covers come from a long and
 * growing list of third-party CDNs (lumacdn.com, allevents.in, cloudfront for
 * Unstop, Meetup's photo hosts, Bevy's storage). next/image would need every one
 * declared in next.config remotePatterns, so the day a source changes CDN every
 * image 500s. A lazy <img> degrades to "no image" instead, which the fallback
 * already handles.
 *
 * The fallback is a category-tinted monogram rather than a grey box, so a row
 * without a cover still reads as a designed card and the colour carries the same
 * category signal used elsewhere.
 */
export default function EventCover({
  src,
  title,
  category,
  className = '',
  monogramSize = 'text-lg',
}: {
  src?: string;
  title: string;
  category?: string;
  className?: string;
  monogramSize?: string;
}) {
  const [failed, setFailed] = useState(false);
  const accent = categoryAccent(category);

  if (!src || failed) {
    // FLAT tint, not a 135° two-tone gradient.
    //
    // 21% of events have no cover, so this fallback is on screen constantly — and a
    // saturated diagonal gradient made every one of them shout louder than the real
    // photographs beside it. A pale wash of the category colour with the monogram in
    // that same colour keeps the category signal, stays quiet next to real imagery,
    // and reads as intentional rather than as a placeholder.
    return (
      <div
        className={`cover-fallback ${monogramSize} ${className}`}
        style={{
          background: `color-mix(in srgb, ${accent} 12%, #FFFFFF)`,
          color: `color-mix(in srgb, ${accent} 78%, #1D1D1F)`,
          boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.05)',
        }}
        aria-hidden="true"
      >
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
