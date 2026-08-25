'use client';

import { useState } from 'react';
import EventCover from './EventCover';

/**
 * The event detail hero: the cover, given depth by its own light.
 *
 * WHY THIS SHAPE. The detail page opened on a flat `card-shadow` box holding a 2:1 cover —
 * correct but inert, and the page had only six depth-carrying classes on it in total. The
 * obvious "premium" fix is a decorative WebGL field or a gradient panel behind the title.
 * Both were rejected: globals.css rations one accent so the COVER is the only colourful
 * thing on screen, and a gradient behind the title spends exactly the attention the cover
 * is supposed to get. A procedural network field was actually built for this slot and then
 * deleted — the feed hero already renders a real data-driven connection graph, so a
 * decorative one here would be a duplicate that says less.
 *
 * So the depth is made from the cover itself: a heavily blurred copy behind a crisp one.
 * The light in the composition comes from real content, which introduces no new hue and
 * costs no extra request — same URL, already in cache.
 *
 * TWO THINGS THAT LOOK LIKE DETAILS AND ARE NOT:
 *
 *  · The halo is suppressed when there is no image. `EventCover` falls back to a
 *    category-tinted monogram for the ~21% of events with no cover, and blurring a flat
 *    tint produces a coloured smear with no information in it — louder than the card it is
 *    meant to lift, which is the failure mode this whole design system is organised
 *    against. No image, no halo: the monogram card simply sits on the page.
 *
 *  · Load failure is shared state. Two <img>s pointing at one URL fail together, so the
 *    halo must vanish when the cover does. Tracking `failed` here and passing the cover a
 *    resolved `src` keeps one decision in one place — the alternative (each layer deciding
 *    independently) shows a blurred backdrop behind a monogram fallback, which reads as a
 *    rendering bug.
 */
export default function EventHeroCover({
  src,
  title,
  category,
  /** Overlaid on the cover, top-left — the "Happening now" pill. */
  children,
}: {
  src?: string;
  title: string;
  category?: string;
  children?: React.ReactNode;
}) {
  const [failed, setFailed] = useState(false);
  const showHalo = Boolean(src) && !failed;

  return (
    // The stage supplies the perspective. Without it the translateZ on .lift-object is
    // inert and this is just a box with a shadow.
    <div className="stage relative mb-6">
      {showHalo && (
        <div className="cover-halo" aria-hidden="true">
          {/* eslint-disable-next-line @next/next/no-img-element -- third-party CDNs, see EventCover header */}
          <img
            src={src}
            alt=""
            // Not lazy: this is above the fold and shares its URL with the crisp cover, so
            // deferring it would only stagger the two layers into a visible pop-in.
            decoding="async"
            aria-hidden="true"
            onError={() => setFailed(true)}
          />
        </div>
      )}

      {/* The crisp cover, floating. `lift-3` for the ring-plus-lift elevation and
          `lift-object` for the contact shadow and the Z offset that separates it from the
          halo plane. `spatial-rise` is opt-in scroll motion, already gated on
          prefers-reduced-motion inside globals.css. */}
      <div className="relative rounded-[20px] overflow-hidden bg-white lift-3 lift-object spatial-rise">
        <EventCover
          src={failed ? undefined : src}
          title={title}
          category={category}
          className="w-full aspect-[2/1] max-h-[380px]"
          monogramSize="text-6xl"
        />
        {children}
      </div>
    </div>
  );
}
