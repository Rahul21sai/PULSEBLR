/**
 * Shared UI vocabulary.
 *
 * WHY THIS FILE EXISTS: before it, every page hand-rolled its own
 * `bg-white rounded-2xl card-shadow p-5` shell, its own heading sizes, its own button
 * paddings. Nine pages, nine slightly different interpretations — which is precisely
 * how an app stops looking designed and starts looking assembled. The tokens in
 * globals.css set the vocabulary; these components make it the path of least
 * resistance.
 *
 * Everything here is a server-safe presentational component: no hooks, no 'use client'.
 * Client pages can import it freely, and server pages can too.
 */
import Link from 'next/link';
import type { ReactNode } from 'react';

import { cn } from '@/lib/cn';

/* ────────────────────────────── Page scaffolding ────────────────────────────── */

/**
 * Page title block.
 *
 * `eyebrow` is for the section a page belongs to, not decoration — it earns its place
 * only when a page sits inside a larger area of the product.
 */
export function PageHeader({
  className,
  title,
  subtitle,
  eyebrow,
  action,
  size = 'default',
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  eyebrow?: string;
  action?: ReactNode;
  /** `large` is for a page that IS its content (the feed). `default` for everything else. */
  size?: 'default' | 'large';
  className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-3 mb-5', className)}>
      <div className="min-w-0">
        {eyebrow && <p className="t-label text-[var(--ink-3)] mb-1.5">{eyebrow}</p>}
        <h1 className={size === 'large' ? 't-display text-[var(--ink)]' : 't-title text-[var(--ink)]'}>
          {title}
        </h1>
        {subtitle && (
          <p className="mt-1.5 text-[13.5px] leading-relaxed text-[var(--ink-2)] tracking-[0]">
            {subtitle}
          </p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

/** Section heading used inside a Card. */
export function SectionTitle({
  className,
  title,
  subtitle,
  action,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-2 pb-3', className)}>
      <div className="min-w-0">
        <h2 className="t-sub text-[var(--ink)]">{title}</h2>
        {subtitle && <p className="mt-0.5 text-[13px] text-[var(--ink-2)] tracking-[0]">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

/* ────────────────────────────── Surfaces ────────────────────────────── */

export function Card({
  children,
  className = '',
  padding = 'default',
  interactive = false,
}: {
  children: ReactNode;
  className?: string;
  padding?: 'default' | 'tight' | 'none';
  /** Adds the press + raise affordances. Only for cards that are themselves a target. */
  interactive?: boolean;
}) {
  const pad = padding === 'none' ? '' : padding === 'tight' ? 'p-4' : 'p-5';
  return (
    <section
      className={cn(
        'r-flat bg-[var(--surface)] rule-y',
        pad,
        interactive && 'raise pressable',
        className
      )}
    >
      {children}
    </section>
  );
}

/** A quiet inset well: for read-only detail, config notes, code. */
export function Well({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('rounded-xl bg-[var(--paper)] p-4 text-[12.5px] leading-relaxed text-[var(--ink-2)]', className)}>
      {children}
    </div>
  );
}

/* ────────────────────────────── Actions ────────────────────────────── */

type ButtonTone = 'primary' | 'secondary' | 'quiet' | 'danger';

const TONE: Record<ButtonTone, string> = {
  // Filled dark, not blue: reserving blue for links and state keeps a page from having
  // three competing "most important" colours.
  primary: 'bg-[var(--ink)] text-[var(--accent-ink)] hover:bg-[var(--ink)]',
  secondary: 'bg-[var(--accent)] text-[var(--accent-ink)] hover:bg-[var(--accent)]',
  quiet:
    'bg-[var(--surface)] text-[var(--ink)] shadow-[inset_0_0_0_1px_var(--rule)] hover:bg-[var(--paper)]',
  danger:
    'bg-[var(--paper)] text-[var(--live)] shadow-[inset_0_0_0_1px_var(--live)] hover:bg-[var(--surface)]',
};

const SIZES = {
  sm: 'h-8 px-3.5 text-[12.5px] gap-1',
  md: 'h-10 px-5 text-[13.5px] gap-1.5',
  lg: 'h-12 px-6 text-[15px] gap-2',
};

function buttonClass(tone: ButtonTone, size: keyof typeof SIZES, full?: boolean) {
  return [
    'inline-flex items-center justify-center r-touch font-semibold tracking-[-0.006em]',
    'pressable disabled:opacity-45 disabled:pointer-events-none',
    SIZES[size],
    TONE[tone],
    full ? 'w-full' : '',
  ].join(' ');
}

/**
 * A PASSED `className` USED TO BE SILENTLY DISCARDED, and the mechanism is worth stating because it
 * reads as correct.
 *
 * `className` is part of `ButtonHTMLAttributes`, so it was captured by `...rest` — and `{...rest}`
 * spread AFTER `className={buttonClass(...)}`, so it did not fail to append, it REPLACED the whole
 * thing. `<Button className="mt-2">` rendered a completely unstyled button: no height, no radius, no
 * tone. Worse than a no-op, and invisible in review because the prop is accepted by the type.
 *
 * No caller passed one, so this was latent rather than live. It surfaced from the other direction:
 * `SIZES.sm` is 32px and `SIZES.md` is 40px, both under the 44px tap-target floor (WCAG 2.5.5), and
 * there was no way for a caller to attach the `TAP_44` overlay to fix it.
 *
 * THE OVERLAY IS DELIBERATELY NOT APPLIED TO EVERY BUTTON HERE. It is tempting — one line, every
 * button compliant — and it would introduce a worse bug than the one it fixes. A 44px overlay on a
 * 32px control overhangs 6px per side, so two adjacent controls contest the same band and whichever
 * is later in the DOM wins it: a tap aimed at one button fires the other. That was measured in this
 * repo, not theorised — two icon buttons at `gap-1.5` hit-tested at 38x44 and 44x44. The gap must be
 * at least `44 - height`, which is per-layout arithmetic no shared primitive can do for its callers.
 * So the floor is opt-in via `TAP_44`, and composing it is now possible.
 */
export function Button({
  children,
  tone = 'primary',
  size = 'md',
  full,
  icon,
  className,
  ...rest
}: {
  children: ReactNode;
  tone?: ButtonTone;
  size?: keyof typeof SIZES;
  full?: boolean;
  icon?: string;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cn(buttonClass(tone, size, full), className)}
      {...rest}
    >
      {icon && <span aria-hidden="true" className="material-symbols-outlined text-[17px]">{icon}</span>}
      {children}
    </button>
  );
}

/** Same className merge as `Button`, and for the same reason — see its comment. */
export function ButtonLink({
  children,
  href,
  tone = 'primary',
  size = 'md',
  full,
  icon,
  external,
  className,
}: {
  children: ReactNode;
  href: string;
  tone?: ButtonTone;
  size?: keyof typeof SIZES;
  full?: boolean;
  icon?: string;
  external?: boolean;
  className?: string;
}) {
  const cls = cn(buttonClass(tone, size, full), className);
  if (external) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={cls}>
        {icon && <span aria-hidden="true" className="material-symbols-outlined text-[17px]">{icon}</span>}
        {children}
      </a>
    );
  }
  return (
    <Link href={href} className={cls}>
      {icon && <span aria-hidden="true" className="material-symbols-outlined text-[17px]">{icon}</span>}
      {children}
    </Link>
  );
}

/**
 * Segmented control / filter chip. `pressed` is the ARIA state, not just a look.
 *
 * `className` IS MERGED, NOT REPLACED — the identical latent defect `Button` above documents at
 * length, in the same file. `className` is part of `ButtonHTMLAttributes`, so `...rest` captured it
 * and spread AFTER the explicit `className`, which meant a passed class did not append, it replaced
 * the height, the radius and the tone: an unstyled button that the type signature happily accepts.
 * No caller passes one today (all nine call sites checked across `/admin` and `/onboarding`), so this
 * was latent and the fix cannot change any existing render — `[cls, undefined].filter(Boolean)` is
 * `cls`. It matters for the same reason it mattered on `Button`: at `h-9` a chip is 36px against the
 * 44px tap floor, and until now a caller had no way to attach `TAP_44` to fix that.
 */
export function Chip({
  children,
  pressed,
  count,
  className,
  ...rest
}: {
  children: ReactNode;
  pressed?: boolean;
  count?: number;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 r-touch px-3.5 h-9 text-[12.5px] font-semibold transition-colors',
        pressed
          ? 'bg-[var(--ink)] text-[var(--accent-ink)]'
          : 'bg-[var(--surface)] text-[var(--ink)] shadow-[inset_0_0_0_1px_var(--rule)] hover:bg-[var(--paper)]',
        className
      )}
      {...rest}
    >
      {children}
      {count !== undefined && (
        <span className={`tnum ${pressed ? 'text-[var(--accent-ink)]/55' : 'text-[var(--ink-3)]'}`}>{count}</span>
      )}
    </button>
  );
}

/* ────────────────────────────── Data display ────────────────────────────── */

export function Stat({
  label,
  value,
  sub,
  tone,
  className,
}: {
  label: string;
  value: ReactNode;
  sub?: string;
  tone?: 'accent' | 'warn';
  className?: string;
}) {
  return (
    <div className={cn(className)}>
      <p className="t-label text-[var(--ink-3)]">{label}</p>
      <p
        /* SANS, not `--font-display`. That variable now resolves to the serif, and a count is the
           product's voice — the one thing on screen that is nothing but a number. Setting it in
           Newsreader inverted the rule the whole design rests on. `tnum` so a column aligns. */
        className={`tnum mt-1.5 text-[26px] font-bold leading-none tracking-[-0.03em] font-[family-name:var(--font-sans)] ${
          tone === 'accent' ? 'text-[var(--accent)]' : tone === 'warn' ? 'text-[var(--live)]' : 'text-[var(--ink)]'
        }`}
      >
        {value}
      </p>
      {sub && <p className="mt-1 text-[12px] text-[var(--ink-2)] tracking-[0]">{sub}</p>}
    </div>
  );
}

/** Label/value row, for detail panels. */
export function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-start justify-between gap-4 py-2.5', className)}>
      <dt className="shrink-0 text-[13px] text-[var(--ink-3)] tracking-[0]">{label}</dt>
      <dd className="min-w-0 text-right text-[13.5px] font-medium text-[var(--ink)]">{children}</dd>
    </div>
  );
}

/**
 * AN ERROR IS `role="alert"`, EVERYTHING ELSE IS `role="status"`, and the difference is not cosmetic.
 *
 * Every tone used to be `role="status"`, which maps to `aria-live="polite"` — announced only once the
 * screen reader finishes whatever it is already saying, and dropped entirely if the user is mid-typing
 * or navigating. That is correct for "Saved." and wrong for "Could not reach the server. Nothing was
 * changed.": a failure a user does not hear is a failure they retype into. `alert` is assertive, which
 * is the whole reason the role exists.
 *
 * Class output is untouched, so this changes nothing visually on any of the surfaces that consume it.
 */
export function Banner({
  className,
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'ok' | 'warn' | 'error';
  children: ReactNode;
  className?: string;
}) {
  // A tone is a LEFT RULE plus a text colour, on the same paper ground as everything else. There is
  // no tint layer in a nine-value palette, and inventing four washes to carry four tones is exactly
  // the "one more grey" move that made the old palette 212 raw hexes across 53 files.
  //
  // `info` and `ok` share the accent because they are the same claim to a reader — the app is fine.
  // `warn` is deliberately the QUIETEST of the four: --ink-2 with an --ink-2 rule. It used to be
  // amber, which made a routine caution louder than a failure.
  const cls = {
    info: 'border-l-[var(--accent)] text-[var(--ink)]',
    ok: 'border-l-[var(--accent)] text-[var(--ink)]',
    warn: 'border-l-[var(--ink-2)] text-[var(--ink-2)]',
    error: 'border-l-[var(--live)] text-[var(--live)]',
  }[tone];
  return (
    <div
      className={cn(
        'border-l-2 bg-[var(--paper)] px-4 py-3 text-[13px] leading-relaxed',
        cls,
        className
      )}
      role={tone === 'error' ? 'alert' : 'status'}
    >
      {children}
    </div>
  );
}

/**
 * Empty state.
 *
 * An empty screen is an invitation to act, so `action` is strongly encouraged — a
 * dead-end empty state is a bug, not a state.
 */
export function EmptyState({
  className,
  icon,
  title,
  body,
  action,
}: {
  icon: string;
  title: string;
  body?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn(
        'flex flex-col items-center justify-center r-flat bg-[var(--surface)] rule-y px-6 py-14',
        className
      )}>
      <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--paper)]">
        <span aria-hidden="true" className="material-symbols-outlined text-[24px] text-[var(--ink-3)]">{icon}</span>
      </span>
      <h3 className="t-sub text-[var(--ink)]">{title}</h3>
      {body && <p className="mt-1 max-w-[38ch] text-[13.5px] leading-relaxed text-[var(--ink-2)]">{body}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={cn('skeleton rounded-lg bg-[var(--rule)]', className)} />;
}
