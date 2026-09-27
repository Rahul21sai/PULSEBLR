'use client';

import { useEffect, useRef, type RefObject } from 'react';

/**
 * The keyboard contract every modal in this app owes: Escape closes, Tab is trapped inside, focus
 * moves in on open, and focus RETURNS to whatever opened it on close.
 *
 * Lifted out of `Sheet.tsx` verbatim, because three hand-built dialogs (the tracker's detail sheet,
 * its "who did you meet" modal and the admin event editor) each re-implemented a different subset —
 * one had Escape and no trap, one had focus-in and no restore, one had none of it and no
 * `role="dialog"` either. A fourth copy is how that drift becomes permanent.
 *
 * ONLY THE TOPMOST OPEN DIALOG HANDLES A KEY. Each instance used to listen on `document` on its own,
 * so with one dialog opened from another a single Escape closed both, and both fought over Tab.
 * The stack is module-level because it has to span components that know nothing of each other.
 */
const stack: Array<RefObject<HTMLElement | null>> = [];

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useModalDialog(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  onClose: () => void,
  /** What receives focus on open: the first match inside the dialog. */
  initialFocus = 'input, textarea, select, button'
) {
  // The latest `onClose` without re-subscribing. Callers pass inline arrows, so depending on it
  // would re-run the effect on every render — and each re-run would pop this dialog off the stack
  // and push it back on TOP, letting a re-rendering parent dialog steal the keyboard from its child.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    stack.push(ref);
    function onKeyDown(event: KeyboardEvent) {
      if (stack[stack.length - 1] !== ref) return;
      if (event.key === 'Escape') {
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;

      // Query on each keypress rather than caching: the capture sheet reveals and hides fields as
      // you type, so a cached list goes stale immediately.
      const focusable = ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
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
      } else if (!ref.current?.contains(active)) {
        // Focus had escaped the dialog (a click on the backdrop, say): bring it back in.
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      const at = stack.lastIndexOf(ref);
      if (at !== -1) stack.splice(at, 1);
    };
  }, [ref, open]);

  // Move focus in on open, and RESTORE it on close — otherwise focus jumps to the top of the
  // document and a keyboard user loses their place.
  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const timer = setTimeout(() => {
      ref.current?.querySelector<HTMLElement>(initialFocus)?.focus();
    }, 0);
    return () => {
      clearTimeout(timer);
      previouslyFocused?.focus?.();
    };
  }, [ref, open, initialFocus]);
}
