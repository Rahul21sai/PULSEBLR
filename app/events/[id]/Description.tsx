'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * The scraped description, clamped, with an expander.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS CLAMPED AT ALL. Measured over the 277 upcoming tech events on 2026-09-12:
 * description length is p50 **1222** characters, p75 1878, p95 **3709**, max 4000. At 15px on a
 * 390px phone that p95 row is ~82 lines — a little over **2000px** of scraped boilerplate. Below
 * it sit the agenda, the speaker bill, the companies, the provenance line and "Similar events",
 * so an unclamped description does not merely look long: it puts five sections past the point
 * where anybody keeps scrolling. Fourteen lines caps it at ~350px.
 *
 * THE BUTTON APPEARS ONLY WHEN THE TEXT IS ACTUALLY TRUNCATED, and that has to be MEASURED
 * rather than guessed from a character count. The same 900-character description is ten lines in
 * the 648px desktop column and twenty on a phone, so any threshold is wrong at one of the two
 * widths — and a "Read the full description" button that expands nothing is worse than no button.
 * `scrollHeight > clientHeight` is the truncation test; a `ResizeObserver` re-runs it because a
 * phone rotating is exactly the case a mount-time check misses.
 *
 * THE OVERFLOW FLAG IS NEVER RECOMPUTED WHILE OPEN. Removing the clamp makes `scrollHeight ===
 * clientHeight`, so an unguarded effect would conclude the text fits and take its own button
 * away mid-read, leaving no way back. The effect returns early when open and the last measured
 * value stands.
 *
 * NO-SCRIPT READS THE WHOLE THING. The clamp is CSS, so the full text is in the HTML either way
 * — which is what the crawlers and the WhatsApp preview see — but a reader with no JavaScript
 * would get a truncated page and no control. The `<noscript>` rule lifts the clamp for them.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */
export default function Description({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    // See the header: measuring while expanded would always report "fits" and retract the button.
    if (open) return;
    const el = ref.current;
    if (!el) return;

    const measure = () => setOverflows(el.scrollHeight > el.clientHeight + 1);
    measure();

    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [open]);

  return (
    <div>
      <noscript>
        {/* A static literal, no interpolation — nothing untrusted reaches this string. */}
        <style dangerouslySetInnerHTML={{ __html: '.evt-desc{-webkit-line-clamp:unset!important}' }} />
      </noscript>
      <p
        ref={ref}
        /* max-w in `ch` keeps the measure under 80 characters in the 648px desktop column, which
           is wider than comfortable prose. On a phone the viewport is the constraint. */
        className={`evt-desc max-w-[64ch] text-[15px] leading-[1.65] text-[#3a3a3c] whitespace-pre-line ${
          open ? '' : 'line-clamp-[14]'
        }`}
      >
        {text}
      </p>
      {(overflows || open) && (
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          aria-expanded={open}
          /* 44px tall, painted as a text link: the direction doc's hit-area floor, and nothing
             sits beside it to contest the band. */
          className="pressable mt-1 inline-flex min-h-[44px] items-center text-[13.5px] font-semibold text-[color:var(--blue)] hover:text-[color:var(--blue-press)] transition-colors"
        >
          {open ? 'Show less' : 'Read the full description'}
        </button>
      )}
    </div>
  );
}
