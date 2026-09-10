'use client';

/**
 * THE faceted chip rail — one implementation, used by every faceted list.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS. `app/people/page.tsx` had grown its OWN `FilterRail` and its own `Toggle`, a
 * second interpretation of the pattern `app/components/FilterRail.tsx` already implements for the
 * events feed. Two copies of a chip rail is exactly how a product stops looking designed and starts
 * looking assembled — `app/components/ui.tsx`'s own header records the same lesson from nine pages
 * with nine different card shells, and `/dashboard` records the worse version of it, where a second
 * copy of the NAV went stale and dropped links the rest of the app had.
 *
 * The events rail is NOT folded into this one, and that is a judgement rather than an omission: it is
 * a domain component (category GROUPS with per-group disclosure, multi-select, formats, a `techOnly`
 * invariant it enforces by making the state unrepresentable). Generalising it would mean making the
 * generic thing carry all of that. What is genuinely shared is the CHIP — one dimension, single
 * select, a live count — and that is what lives here.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * HIT AREAS ARE 44px, GROWN WITH `::after` AND NOT WITH THE PAINTED SIZE. A 36px chip is the right
 * size on screen and the wrong size under a thumb. The pseudo-element is part of the button, so it
 * takes the tap; the paint does not change. `gap-y-2` on the container is measured against it: rows
 * pitch at 36 + 8 = 44px, exactly the overlay height, so two rows of chips cannot steal each other's
 * taps. Change one of those numbers and change the other.
 */

export interface FacetBucket {
  value: string;
  count: number;
  /** Shown instead of `value` — for an id-keyed facet whose label is a name. */
  label?: string;
  /** Company buckets only: on the user's target list. */
  isTarget?: boolean;
}

/**
 * The one chip. `aria-pressed` is the state, not just the look — a screen reader has no access to
 * "this one is dark".
 */
const CHIP_BASE =
  "relative inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-[12.5px] font-semibold transition-colors [touch-action:manipulation] after:absolute after:inset-x-0 after:top-1/2 after:h-11 after:-translate-y-1/2 after:content-['']";

const CHIP_IDLE =
  'bg-white text-[#1D1D1F] shadow-[inset_0_0_0_1px_var(--hairline)] hover:bg-[#F7F7F9]';
/** Zero-count chips stay CLICKABLE and merely quiet — see `FacetRail`'s note on empty buckets. */
const CHIP_EMPTY = 'bg-white text-[#A1A1A6] shadow-[inset_0_0_0_1px_var(--hairline)]';

/**
 * A boolean facet: "target companies", "follow-up due".
 *
 * Filled DARK when on, where a dimensional chip fills blue. The distinction is deliberate and matches
 * `ui.tsx`'s `Chip`: blue means "you can act on this" and is rationed, so a rail of eight blue chips
 * would spend the one accent the design system has on decoration.
 */
export function FacetToggle({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`${CHIP_BASE} ${active ? 'bg-[#1D1D1F] text-white' : CHIP_IDLE}`}
    >
      {label}
      {typeof count === 'number' && (
        <span className={`tnum ${active ? 'text-white/60' : 'text-[#8E8E93]'}`}>{count}</span>
      )}
    </button>
  );
}

/**
 * One dimension of single-select chips with live counts.
 *
 * The counts must come from a facet endpoint that DROPS THE DIMENSION IT IS COUNTING, so with
 * "Razorpay" selected every other company still shows what switching to it would give. Counted with
 * the filter applied, every other chip reads zero — the rail then asserts there is nobody anywhere
 * else, which is false and makes it useless for the only thing a filter rail is for: changing your
 * mind. This component cannot enforce that; `/api/people/facets` and `/api/contacts/facets` do.
 */
export default function FacetRail({
  title,
  hint,
  buckets,
  extra = [],
  selected,
  onSelect,
}: {
  title: string;
  hint?: string;
  buckets: FacetBucket[];
  /**
   * Buckets to append that the aggregate cannot produce — a tag created but not yet applied to
   * anybody, an event folder with nobody scanned into it. They render at zero rather than being
   * hidden, because a thing the user just made must be visible or the button that made it looks
   * broken. That regression has happened here twice.
   */
  extra?: FacetBucket[];
  selected: string | null;
  onSelect: (value: string | null) => void;
}) {
  const all = [...buckets, ...extra];
  if (!all.length) return null;

  return (
    <div className="mb-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="t-label text-[#8E8E93]">{title}</span>
        {hint && <span className="text-[12px] text-[#A1A1A6]">{hint}</span>}
      </div>
      {/* `gap-y-2` is measured against the 44px overlay — see the file header. */}
      <div className="mt-1.5 flex flex-wrap gap-x-1.5 gap-y-2">
        {all.map(bucket => {
          const active = selected === bucket.value;
          return (
            <button
              key={bucket.value}
              type="button"
              aria-pressed={active}
              onClick={() => onSelect(active ? null : bucket.value)}
              className={`${CHIP_BASE} ${
                active ? 'bg-[#0071E3] text-white' : bucket.count === 0 ? CHIP_EMPTY : CHIP_IDLE
              }`}
            >
              {bucket.label ?? bucket.value}
              {bucket.isTarget && !active && (
                <span title="On your target list" aria-hidden="true" className="text-[#1D8A44]">
                  ●
                </span>
              )}
              <span className={`tnum ${active ? 'text-white/60' : 'text-[#8E8E93]'}`}>
                {bucket.count}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
