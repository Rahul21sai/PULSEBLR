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
    return (
      <div
        className={`cover-fallback ${monogramSize} ${className}`}
        style={{
          background: `linear-gradient(135deg, ${accent} 0%, color-mix(in srgb, ${accent} 60%, #1D1D1F) 100%)`,
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
