'use client';

import { useEffect, useRef, type ReactNode } from 'react';

/**
 * A bottom sheet on a phone, a centred dialog on a desktop.
 *
 * WHY THIS IS A SHARED PRIMITIVE. `app/tracker/components/EditTrackerModal.tsx` is the only
 * file in this repo with `role="dialog"` and `aria-modal`, and the filter sheet in
 * `app/page.tsx` has the better layout but none of the semantics. Rather than write a third
 * variant, this takes the semantics from the first and the layout from the second, and adds
 * the two things neither has:
 *
 *   - A FOCUS TRAP. Without one, tabbing out of an `aria-modal` dialog lands on the page
 *     behind it, which a screen reader has been told does not exist.
 *   - A BODY SCROLL LOCK. On iOS the page behind a sheet scrolls under your finger
 *     otherwise, which is how a full-screen sheet ends up showing the middle of the feed.
 *
 * It is a client component and therefore deliberately NOT in `ui.tsx`, whose header states
 * it is server-safe with no hooks so server pages can import it freely.
 *
 * `--dur-med` / `--ease` are not used for an entrance animation on purpose: `globals.css`
 * kills every animation under `prefers-reduced-motion` with
 * `animation-duration: 0.001ms !important` on `*`, so any state conveyed only by movement
 * is invisible to those users. The sheet's position IS the signal.
 *
 * ── THE HOME FEED'S FILTER SHEET NOW USES THIS, which is what it was built to replace. ──────────
 * That sheet was a hand-built `fixed` panel with none of the semantics above: no `role="dialog"`,
 * no Escape, no trap, no scroll lock, no focus restore. Two props were added for it, and both
 * default to exactly what every existing caller already rendered, so no caller changes:
 *
 *   - `dialogFrom` — where the bottom sheet turns into a centred dialog. `sm` (640px) is the
 *     default. The feed passes `lg`, because its sheet only exists BELOW `lg` — from 1024px the
 *     filter rail is always on screen — and between 640 and 1023 a tablet has always had a
 *     bottom sheet there, not a floating card.
 *   - `id` — on the dialog element, so a trigger can carry `aria-controls`.
 *
 * Two changes do reach every caller, and neither alters a layout: the scrim is `--ink` at 45%
 * rather than Tailwind's `black` at 40% (the filter sheet's recorded decision — `black` is neutral
 * where `--ink` is warm, which is visible against `--paper`, and a palette colour is outside the
 * nine), and the close button's HIT AREA reaches the 44px floor through an overlay while its painted
 * 32px circle is unchanged.
 */

/**
 * Literal class strings per breakpoint, never interpolated: Tailwind finds utilities by scanning
 * source text, so `${bp}:items-center` would compile to nothing.
 */
const DIALOG_FROM = {
  sm: { frame: 'sm:items-center sm:p-4', panel: 'sm:rounded-[22px]' },
  lg: { frame: 'lg:items-center lg:p-4', panel: 'lg:rounded-[22px]' },
} as const;

export default function Sheet({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  labelledBy = 'sheet-title',
  id,
  dialogFrom = 'sm',
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  /** Pinned below the scrollport, so primary actions never scroll away. */
  footer?: ReactNode;
  labelledBy?: string;
  /** On the dialog element, for a trigger's `aria-controls`. */
  id?: string;
  /** The breakpoint at which the bottom sheet becomes a centred dialog. See the header. */
  dialogFrom?: keyof typeof DIALOG_FROM;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);

  // Escape closes. Every dialog should, and the pattern this replaces did not until it was
  // fixed by hand.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      // Focus trap. Query on each keypress rather than caching: the capture sheet reveals
      // and hides fields as you type, so a cached list goes stale immediately.
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  // Move focus in on open, and RESTORE it on close — otherwise focus jumps to the top of
  // the document and a keyboard user loses their place.
  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const timer = setTimeout(() => {
      dialogRef.current
        ?.querySelector<HTMLElement>('input, textarea, select, button')
        ?.focus();
    }, 0);
    return () => {
      clearTimeout(timer);
      previouslyFocused?.focus?.();
    };
  }, [open]);

  // Lock the page behind the sheet.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  if (!open) return null;

  const layout = DIALOG_FROM[dialogFrom];

  return (
    <div className={`fixed inset-0 z-[70] flex items-end justify-center p-0 ${layout.frame}`}>
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        /**
         * A near-opaque background is the real legibility guarantee and the blur is a bonus.
         * `globals.css` records that Lightning CSS in this toolchain SILENTLY STRIPS a bare
         * `backdrop-filter` — `.glass-nav` compiled to an empty rule and the bars had no
         * blur at all — so the blur is applied via a utility that survives, and nothing
         * depends on it.
         *
         * `--ink` at 45%, not `black` at 40%: see the header. 45 rather than 40 because `--ink`
         * is not #000, so the same alpha darkens slightly less.
         */
        className="absolute inset-0 bg-[var(--ink)]/45 backdrop-blur-sm"
      />

      <div
        ref={dialogRef}
        id={id}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        className={`relative flex max-h-[92dvh] w-full max-w-[560px] flex-col rounded-t-[22px] bg-[var(--surface)] card-shadow-lg ${layout.panel}`}
      >
        {/* Header sits outside the scrollport so it cannot overlay content. */}
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-[color:var(--hairline)] p-5">
          <div className="min-w-0">
            <h2 id={labelledBy} className="t-sub text-[var(--ink)]">
              {title}
            </h2>
            {subtitle && <p className="mt-0.5 truncate text-[13px] text-[var(--ink-2)]">{subtitle}</p>}
          </div>
          {/* The painted circle stays 32px; the `::after` overlay makes the TARGET 44px (6px a
              side). Safe here, unlike between two adjacent controls: the only neighbour is the title
              text across a 12px gap, and the header's 20px padding holds the overhang, so the band
              contests nothing — the failure `docs/design-direction.md` warns about needs a second
              control inside it. */}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="relative grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[var(--paper)] text-[var(--ink-2)] [touch-action:manipulation] after:absolute after:-inset-1.5 after:content-['']"
          >
            <span aria-hidden="true" className="material-symbols-outlined text-[18px]">close</span>
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">{children}</div>

        {footer && (
          <div
            className="shrink-0 border-t border-[color:var(--hairline)] p-4"
            // Clear of the iOS home indicator, which a sheet flush to the bottom edge sits under.
            style={{ paddingBottom: 'max(16px, env(safe-area-inset-bottom))' }}
          >
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
