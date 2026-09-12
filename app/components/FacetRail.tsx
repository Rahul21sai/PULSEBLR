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
  'bg-[var(--surface)] text-[color:var(--ink)] shadow-[inset_0_0_0_1px_var(--hairline)] hover:bg-[var(--paper)]';
/** Zero-count chips stay CLICKABLE and merely quiet — see `FacetRail`'s note on empty buckets. */
const CHIP_EMPTY = 'bg-[var(--surface)] text-[color:var(--ink-3)] shadow-[inset_0_0_0_1px_var(--hairline)]';

/**
 * TWO KINDS OF FACT NEED TWO KINDS OF CHIP, and the axis is STRUCTURE rather than hue.
 *
 * `/people` shows a registry-resolved employer beside a label the user typed, and CLAUDE.md is explicit
 * that one rail for both "would be less code and would destroy the distinction between *the registry
 * recognised this employer* and *somebody typed this*". So `kind` picks the idle treatment:
 *
 *   · `registry` — BOUNDED: white, hairline ring, full-strength ink. An edge means "this came from a
 *     defined list", which is exactly what `strength`-gated resolution guarantees.
 *   · `own`      — FILLED and PREFIXED: soft grey, secondary ink, a leading `#`. Free text, softly held.
 *
 * Colour is deliberately not the axis. `--blue` means "you can act on this" and is rationed, so a rail
 * of blue chips would spend the app's one accent on saying "employer". Blue stays for the ACTIVE chip,
 * where it does mean something. The filled-grey treatment also matches how own-tags are already drawn in
 * the person edit sheet, so the card, the rail and the editor agree instead of offering three looks.
 *
 * `registry` is the DEFAULT, so an existing caller that passes no `kind` keeps the treatment it had.
 * (The idle greys did move onto `--ink` / `--ink-3` rather than the hexes they were pinned to, because
 * the ramp was darkened in `globals.css` while this was being written and a hardcoded grey would
 * now render lighter than the rest of the app. `/people` is this component's only consumer.)
 */
export type FacetKind = 'registry' | 'own';

const CHIP_OWN_IDLE = 'bg-[var(--paper)] text-[color:var(--ink-2)] hover:bg-[var(--paper)]';
const CHIP_OWN_EMPTY = 'bg-[var(--paper)] text-[color:var(--ink-3)]';

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
      className={`${CHIP_BASE} ${active ? 'bg-[var(--ink)] text-[var(--accent-ink)]' : CHIP_IDLE}`}
    >
      {label}
      {typeof count === 'number' && (
        <span className={`tnum ${active ? 'text-[var(--accent-ink)]/60' : 'text-[color:var(--ink-3)]'}`}>{count}</span>
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
  kind = 'registry',
}: {
  title: string;
  hint?: string;
  /** Which kind of fact these chips carry — see `FacetKind`. Defaults to `registry`. */
  kind?: FacetKind;
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

  const own = kind === 'own';

  return (
    <div className="mb-3">
      {/*
        THE TITLE STAYS, THE SHOUT DOES NOT.
        `docs/design-direction.md` names the tracked-out ALL-CAPS eyebrow as a pattern to remove because
        it announces content that needs no announcing — but this title genuinely does need announcing and
        cannot be dropped: "Company" versus "Your tags" is the whole distinction the two rails exist to
        keep, and a reader cannot infer it from the chips alone. `.t-label` was de-capsed in `globals.css`
        while this was being written, so the class now IS the sentence-case small label and using it beats
        a second definition of the same style here. It carries the ink colour rather than the usual grey
        because it is the rail's heading, not a caption.
      */}
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="t-label text-[color:var(--ink)]">{title}</span>
        {hint && <span className="text-[12px] text-[color:var(--ink-3)] tracking-[0]">{hint}</span>}
      </div>
      {/* `gap-y-2` is measured against the 44px overlay — see the file header. */}
      <div className="mt-2 flex flex-wrap gap-x-1.5 gap-y-2">
        {all.map(bucket => {
          const active = selected === bucket.value;
          const idle = own
            ? bucket.count === 0
              ? CHIP_OWN_EMPTY
              : CHIP_OWN_IDLE
            : bucket.count === 0
              ? CHIP_EMPTY
              : CHIP_IDLE;
          return (
            <button
              key={bucket.value}
              type="button"
              aria-pressed={active}
              onClick={() => onSelect(active ? null : bucket.value)}
              className={`${CHIP_BASE} ${active ? 'bg-[var(--accent)] text-[var(--accent-ink)]' : idle}`}
            >
              {/*
                ONE SPAN, because `CHIP_BASE` sets `gap-1.5` and the `#` must sit AGAINST its word —
                as two children it renders "# hardware", which reads as a stray glyph rather than a
                tag. The mark is quieter than the word so it says "kind of thing" instead of competing
                as a character, and it is `aria-hidden` because "hash hardware" tells a screen-reader
                user nothing the rail's own title has not already said.
              */}
              <span>
                {own && (
                  <span aria-hidden="true" className={active ? 'text-[var(--accent-ink)]/55' : 'text-[color:var(--ink-3)]'}>
                    #
                  </span>
                )}
                {bucket.label ?? bucket.value}
              </span>
              {bucket.isTarget && !active && (
                <span title="On your target list" aria-hidden="true" className="text-[color:var(--good)]">
                  ●
                </span>
              )}
              <span className={`tnum ${active ? 'text-[var(--accent-ink)]/60' : 'text-[color:var(--ink-3)]'}`}>
                {bucket.count}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
