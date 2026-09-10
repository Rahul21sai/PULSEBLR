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
 * So everything below is `ui.tsx` arranged, not re-drawn:
 *
 *   · `Panel`    = `Card` + `SectionTitle`. `ui.tsx` deliberately separates the surface from the
 *                  heading so a card can hold something other than a titled section; the console
 *                  always wants both, and this saves repeating the pair 30 times.
 *   · `StatCard` = `Card padding="tight"` + `Stat`. `Stat` on its own is the number; this is the
 *                  number on a surface, which is what a dashboard grid needs.
 *
 * `BarList` and `Sparkline` are genuinely new — `ui.tsx` has no data-display components — and they
 * live here rather than there because nothing outside the console has asked for them.
 *
 * No hooks, no `'use client'`: same property `ui.tsx` has, so a server component could render any of
 * it if one ever needed to.
 */
import type { ReactNode } from 'react';
import { Card, SectionTitle, Stat } from '../components/ui';

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
    <Card className={className}>
      <SectionTitle title={title} subtitle={subtitle} action={action} />
      {children}
    </Card>
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
  tone?: 'accent' | 'warn';
}) {
  return (
    <Card padding="tight">
      <Stat label={label} value={value} sub={sub} tone={tone} />
    </Card>
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
          <span className={`${labelWidth} shrink-0 truncate text-[12.5px] text-[#3a3a3c]`} title={i.name}>
            {i.name}
          </span>
          <span className="h-2 flex-1 overflow-hidden rounded-full bg-[#f0f0f2]">
            <span
              className="block h-full rounded-full bg-[#0071E3]"
              style={{ width: `${(i.count / max) * 100}%` }}
            />
          </span>
          <span className="tnum w-10 shrink-0 text-right text-[12px] font-semibold text-[#1D1D1F]">
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
              className={`flex-1 rounded-t-[2px] ${isLast ? 'bg-[#0071E3]' : 'bg-[#1D1D1F]/15'}`}
              // A zero day gets 1px so the axis is legible as an axis rather than a gap.
              style={{ height: `${Math.max(1, (s.count / max) * height)}px` }}
            />
          );
        })}
      </div>
      <div className="mt-1.5 flex justify-between text-[11px] text-[#8E8E93]">
        <span>{series[0]?.day ?? ''}</span>
        <span className="tnum">peak {max}</span>
        <span>today</span>
      </div>
    </div>
  );
}

/** A quiet in-card line for "nothing here". Whole-panel empties use `EmptyState` from ui.tsx. */
export function NoRows({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-[13px] text-[#8E8E93]">{children}</p>;
}

/** Skeleton grid for the first paint, built on `ui.tsx`'s `Skeleton`. */
export function StatSkeletons({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      {Array.from({ length: count }).map((_, i) => (
        <Card key={i} padding="tight">
          <div className="skeleton h-3 w-20 rounded bg-[#EEEEF0]" />
          <div className="skeleton mt-2 h-7 w-16 rounded bg-[#EEEEF0]" />
        </Card>
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
      ? 'bg-[#FFF1F0] text-[#C7362D]'
      : severity === 'caution'
        ? 'bg-amber-50 text-amber-900'
        : 'bg-[#EBF7EF] text-[#1D8A44]';
  const text = severity === 'blocked' ? 'Someone acted on this' : severity === 'caution' ? 'Check first' : 'Unreferenced';
  return (
    <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide ${style}`}>
      {text}
    </span>
  );
}
