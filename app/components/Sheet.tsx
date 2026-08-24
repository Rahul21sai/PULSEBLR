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
 */
export default function Sheet({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  labelledBy = 'sheet-title',
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  /** Pinned below the scrollport, so primary actions never scroll away. */
  footer?: ReactNode;
  labelledBy?: string;
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

  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center p-0 sm:items-center sm:p-4">
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
         */
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
      />

      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        className="relative flex max-h-[92dvh] w-full max-w-[560px] flex-col rounded-t-[22px] bg-white card-shadow-lg sm:rounded-[22px]"
      >
        {/* Header sits outside the scrollport so it cannot overlay content. */}
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-[color:var(--hairline)] p-5">
          <div className="min-w-0">
            <h2 id={labelledBy} className="t-sub text-[#1D1D1F]">
              {title}
            </h2>
            {subtitle && <p className="mt-0.5 truncate text-[13px] text-[#6E6E73]">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[#F5F5F7] text-[#6E6E73] hover:bg-[#EEEEF0] [touch-action:manipulation]"
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
