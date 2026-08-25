'use client';

import { motion, useReducedMotion } from 'framer-motion';

/**
 * Route continuity — the fourth motion type in docs/MASTER-PROMPT-3D.md §5.3.
 *
 * `template.tsx` rather than `layout.tsx` on purpose: a layout persists across navigations and
 * would animate once ever, while a template remounts on every route change, which is exactly the
 * event worth marking. The ambient field stays in `layout.tsx` for the opposite reason — it must
 * NOT restart, because a continuous background is what makes the app read as one space rather than
 * a series of pages.
 *
 * ── WHY THIS IS OPACITY-ONLY, WHICH LOOKS LIKE UNDER-DESIGN AND IS NOT ──────────────────────────
 *
 * The obvious version animates `y` and `scale`, or blurs the incoming page. All three are
 * unusable here, for one shared reason: `transform` and `filter` on an element make it a
 * CONTAINING BLOCK for `position: fixed` descendants. Every page in this app renders `DesktopNav`,
 * `MobileBottomNav` and (on the feed) the command bar as fixed children — so a transformed
 * wrapper would silently reposition all of the app's chrome relative to this div instead of the
 * viewport. It does not stop when the animation ends, either: framer-motion settles on
 * `transform: translateY(0px) scale(1)`, which still creates the containing block, so the nav
 * would stay broken for the life of the page.
 *
 * Opacity creates no containing block. A cross-fade on the app's own easing curve reads as one
 * space resolving rather than a page being replaced, and it cannot break layout. If a future
 * version wants translation, it has to animate something that does not wrap the fixed chrome —
 * an overlay veil, or a wrapper inside each page below its nav — not this element.
 *
 * ── REDUCED MOTION ──────────────────────────────────────────────────────────────────────────────
 *
 * `useReducedMotion()` returns true when the user has asked for less, and then there is no
 * animation at all: `initial` matches `animate`, so the page simply appears. A shortened fade is
 * still a fade; the setting asks for none.
 */
export default function Template({ children }: { children: React.ReactNode }) {
  const reduced = useReducedMotion();

  return (
    <motion.div
      // Keyed remount is handled by Next: template.tsx is a fresh instance per navigation, so
      // `initial` runs every time without an AnimatePresence or a pathname key.
      initial={reduced ? { opacity: 1 } : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={
        reduced
          ? { duration: 0 }
          : // 260ms and the app's single easing curve (--ease). Long enough to register as a
            // transition, short enough that it never delays reading — the brief's rule is that
            // motion must serve finding an event faster, never slower.
            { duration: 0.26, ease: [0.32, 0.72, 0, 1] }
      }
    >
      {children}
    </motion.div>
  );
}
