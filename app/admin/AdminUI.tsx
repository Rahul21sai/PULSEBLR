/**
 * The admin console's layout vocabulary — COMPOSITIONS of `app/components/ui.tsx`, never
 * replacements for it.
 *
 * ── WHY THIS FILE IS NOT A SECOND SET OF PRIMITIVES ─────────────────────────────────────────
 *
 * `AdminDashboard.tsx` used to hand-roll its own `Card`, `Stat`, `Banner`, `Empty` and `Field` while
 * `ui.tsx` exported all five. Two sets of primitives drift — the local `Stat` had already grown an
 * `accent` and a `plain` prop that `ui.tsx`'s `tone` covers, and the local `Banner` carried a
 * built-in `mt-3` that made spacing depend on which copy you imported. That is exactly how an app
 * stops looking designed and starts looking assembled, and it is why the admin console did not feel
 * like the same product as the feed.
 *
 * `BarList` and `Sparkline` are genuinely new — `ui.tsx` has no data-display components — and they
 * live here rather than there because nothing outside the console has asked for them.
 *
 * No hooks, no `'use client'`: same property `ui.tsx` has, so a server component could render any of
 * it if one ever needed to.
 *
 * ── WHY `Panel` AND `StatCard` NO LONGER WRAP `Card` (Phase 3) ───────────────────────────────
 *
 * They used to be `Card + SectionTitle` and `Card padding="tight" + Stat`. Both now draw a ruled
 * section on the page ground instead, and the reason is that the design system moved underneath
 * `ui.tsx` rather than that a second card was wanted:
 *
 *   · **Radius.** The system is `--r-flat` (0) on containers, `--r-touch` (4px) on touchables.
 *     `Card` is `rounded-[18px]`, and a caller cannot reliably override it: Tailwind emits radius
 *     utilities ordered by VALUE, not by source order, so in one class attribute `rounded-[4px]`
 *     loses to `rounded-full` and `rounded-none` wins only by alphabetical luck. Measured against
 *     the served stylesheet, not assumed. Depending on that ordering is the same silent
 *     class-composition failure that `lib/cn.ts` exists because of.
 *   · **Elevation.** `Card` carries `card-shadow`, which composites to nothing now that `--lift-1`
 *     is `none` — so its ground is a white plane with no edge on a warm page. The console gets a
 *     hairline, which is what the recorded complaint about the old fog shadow actually asked for.
 *   · **Face.** `SectionTitle` sets `.t-sub`, and `.t-*` resolves `--font-display` to the SERIF.
 *     globals.css says outright that `.t-*` "is the previous scale and is not the target". A panel
 *     heading is the app naming a group it invented, which is the sans side of the split; an event
 *     title is the serif side. So a serif "Where events come from" is a migration artefact.
 *   · **Numbers.** `Stat` renders its value in `--font-display` too. A count is the app speaking,
 *     so it is sans with `tnum` — which is also what stops a dense column of figures shifting width
 *     as it updates.
 *
 * NONE OF THAT IS A CRITICISM OF `ui.tsx`, and none of it is fixable from here: `app/components/**`
 * is owned elsewhere. When those four move, this file should shrink back to composing them.
 */
import type { ReactNode } from 'react';

export function Panel({
  title,
  subtitle,
  action,
  children,
  className = '',
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-[var(--r-flat)] border border-[var(--rule)] p-[var(--s-4)] md:p-[var(--s-6)] ${className}`}>
      <div className="flex flex-wrap items-start justify-between gap-2 pb-[var(--s-3)]">
        <div className="min-w-0">
          {/* Sans, at console density. NOT `.ty-section` — that is 26px, and because globals.css is
              UNLAYERED its font-size outranks any Tailwind size utility, so `ty-section text-[16px]`
              silently renders 26px. A heading needing a different size gets plain utilities. */}
          <h2 className="text-[16px] font-semibold leading-tight tracking-[-0.012em] text-[var(--ink)]">
            {title}
          </h2>
          {subtitle && <p className="ty-meta mt-[var(--s-1)]">{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function StatCard({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: ReactNode;
  sub?: string;
  /** `accent` = healthy or actionable, `warn` = wants attention. Nothing else has a colour. */
  tone?: 'accent' | 'warn';
}) {
  return (
    <div className="rounded-[var(--r-flat)] border border-[var(--rule)] p-[var(--s-4)]">
      <p className="ty-meta">{label}</p>
      <p
        className={`tnum mt-[var(--s-2)] text-[26px] font-semibold leading-none tracking-[-0.02em] ${
          tone === 'accent'
            ? 'text-[var(--accent)]'
            : tone === 'warn'
              ? 'text-[var(--live)]'
              : 'text-[var(--ink)]'
        }`}
      >
        {value}
      </p>
      {sub && <p className="mt-[var(--s-1)] text-[12px] leading-snug text-[var(--ink-2)]">{sub}</p>}
    </div>
  );
}

/** Numbers read as numbers: grouped, tabular, and never a bare `toString()`. */
export function num(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  return n.toLocaleString('en-IN');
}

/**
 * Horizontal bar list.
 *
 * Widths are relative to the LARGEST value, not the total. A share-of-total bar for a long-tail
 * distribution renders every row as an invisible sliver, which is how a chart manages to hide the
 * data it was added to show.
 */
export function BarList({
  items,
  labelWidth = 'w-[132px]',
}: {
  items: Array<{ name: string; count: number }>;
  labelWidth?: string;
}) {
  const max = Math.max(1, ...items.map(i => i.count));
  return (
    <ul className="space-y-1.5">
      {items.map(i => (
        <li key={i.name} className="flex items-center gap-2.5">
          <span className={`${labelWidth} shrink-0 truncate text-[12.5px] text-[var(--ink-2)]`} title={i.name}>
            {i.name}
          </span>
          <span className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--paper)]">
            <span
              className="block h-full rounded-full bg-[var(--accent)]"
              style={{ width: `${(i.count / max) * 100}%` }}
            />
          </span>
          <span className="tnum w-10 shrink-0 text-right text-[12px] font-semibold text-[var(--ink)]">
            {i.count}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * A daily series as bars.
 *
 * GREYSCALE with the most recent day in blue — the design rule is one rationed accent meaning "you
 * can act on this", and on a time series the only actionable point is the current one. Colouring the
 * whole series blue would make the accent decoration, which is what the rule exists to prevent.
 *
 * An all-zero series still renders (flat, at the baseline) rather than collapsing to nothing: "no
 * signups in 30 days" is a real and important answer, and an empty box reads as a broken chart.
 */
export function Sparkline({
  series,
  height = 44,
  label,
}: {
  series: Array<{ day: string; count: number }>;
  height?: number;
  label: string;
}) {
  const max = Math.max(1, ...series.map(s => s.count));
  const total = series.reduce((n, s) => n + s.count, 0);
  return (
    <div>
      <div
        className="flex items-end gap-[2px]"
        style={{ height }}
        role="img"
        aria-label={`${label}: ${total} over ${series.length} days`}
      >
        {series.map((s, i) => {
          const isLast = i === series.length - 1;
          return (
            <span
              key={s.day}
              title={`${s.day}: ${s.count}`}
              className={`flex-1 rounded-t-[2px] ${isLast ? 'bg-[var(--accent)]' : 'bg-[var(--ink)]/15'}`}
              // A zero day gets 1px so the axis is legible as an axis rather than a gap.
              style={{ height: `${Math.max(1, (s.count / max) * height)}px` }}
            />
          );
        })}
      </div>
      <div className="mt-1.5 flex justify-between text-[11px] text-[var(--ink-2)]">
        <span>{series[0]?.day ?? ''}</span>
        <span className="tnum">peak {max}</span>
        <span>today</span>
      </div>
    </div>
  );
}

/** A quiet in-card line for "nothing here". Whole-panel empties use `EmptyState` from ui.tsx. */
export function NoRows({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-[13px] text-[var(--ink-2)]">{children}</p>;
}

/**
 * Skeleton grid for the first paint.
 *
 * Deliberately the SAME box as `StatCard` — same border, same padding, same two line heights — so
 * the grid does not resize when the numbers land. A skeleton that is a different shape from the
 * thing it stands in for is a layout shift with extra steps.
 */
export function StatSkeletons({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="rounded-[var(--r-flat)] border border-[var(--rule)] p-[var(--s-4)]">
          <div className="skeleton h-3 w-20 bg-[var(--rule)]" />
          <div className="skeleton mt-[var(--s-2)] h-[26px] w-16 bg-[var(--rule)]" />
        </div>
      ))}
    </div>
  );
}

/**
 * A severity pill for an impact verdict.
 *
 * Red is reserved for `blocked`. The design system rations colour hard, and a dashboard where every
 * warning is red teaches the operator to click through all of them — which is the failure mode an
 * impact preview exists to prevent.
 */
export function SeverityPill({ severity }: { severity: 'safe' | 'caution' | 'blocked' }) {
  const style =
    severity === 'blocked'
      ? 'bg-[var(--paper)] text-[var(--live)]'
      : severity === 'caution'
        ? 'bg-[var(--paper)] text-[var(--ink-2)]'
        : 'bg-[var(--paper)] text-[var(--accent)]';
  const text = severity === 'blocked' ? 'Someone acted on this' : severity === 'caution' ? 'Check first' : 'Unreferenced';
  return (
    <span className={`shrink-0 rounded-[var(--r-flat)] px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide ${style}`}>
      {text}
    </span>
  );
}
