/**
 * Join class names, dropping anything falsy.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS RATHER THAN EACH PRIMITIVE DOING IT INLINE.
 *
 * `ui.tsx`'s `Button` silently DISCARDED a passed `className` for the life of the file: `className`
 * is part of `ButtonHTMLAttributes`, so it was captured by `...rest`, and `{...rest}` spread AFTER
 * `className={buttonClass(...)}`. It did not fail to append — it REPLACED the lot, so
 * `<Button className="mt-2">` rendered a completely unstyled button. `Chip` had the identical
 * defect. Both were invisible in review because the type accepts the prop, and latent in practice
 * because no caller happened to pass one.
 *
 * They were then fixed one at a time, in two different sessions, with two different inline
 * expressions. That is the actual problem this file solves: a convention that each primitive
 * re-implements is a convention that some primitive will get wrong, and the failure mode is silent
 * in exactly the way that makes a design system impossible to style from the outside.
 *
 * NO `clsx`, NO `tailwind-merge`. Nine lines against two dependencies, and `tailwind-merge` in
 * particular would be the wrong tool here: it resolves Tailwind conflicts by *dropping* the earlier
 * class, which hides a caller fighting a primitive instead of surfacing it. Last-wins in the
 * cascade is the behaviour to keep, because it is the behaviour a reader can predict from the
 * source order.
 *
 * Ordering is the contract: BASE FIRST, CALLER LAST. A caller must be able to override, which is
 * the whole point of accepting the prop.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
