/**
 * Shared UI vocabulary.
 *
 * WHY THIS FILE EXISTS: before it, every page hand-rolled its own
 * `glass-card rounded-2xl card-shadow p-5` shell, its own heading sizes, its own button
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

/* ────────────────────────────── Page scaffolding ────────────────────────────── */

/**
 * Page title block.
 *
 * `eyebrow` is for the section a page belongs to, not decoration — it earns its place
 * only when a page sits inside a larger area of the product.
 */
export function PageHeader({
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
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 mb-5">
      <div className="min-w-0">
        {eyebrow && <p className="t-label text-[#8E8E93] mb-1.5">{eyebrow}</p>}
        <h1 className={size === 'large' ? 't-display text-[#1D1D1F]' : 't-title text-[#1D1D1F]'}>
          {title}
        </h1>
        {subtitle && (
          <p className="mt-1.5 text-[13.5px] leading-relaxed text-[#6E6E73] tracking-[0]">
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
  title,
  subtitle,
  action,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-2 pb-3">
      <div className="min-w-0">
        <h2 className="t-sub text-[#1D1D1F]">{title}</h2>
        {subtitle && <p className="mt-0.5 text-[13px] text-[#6E6E73] tracking-[0]">{subtitle}</p>}
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
      className={`rounded-[18px] glass-card card-shadow ${pad} ${
        interactive ? 'raise pressable' : ''
      } ${className}`}
    >
      {children}
    </section>
  );
}

/** A quiet inset well: for read-only detail, config notes, code. */
export function Well({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl bg-[#F7F7F9] p-4 text-[12.5px] leading-relaxed text-[#3a3a3c] ${className}`}>
      {children}
    </div>
  );
}

/* ────────────────────────────── Actions ────────────────────────────── */

type ButtonTone = 'primary' | 'secondary' | 'quiet' | 'danger';

const TONE: Record<ButtonTone, string> = {
  // Filled dark, not blue: reserving blue for links and state keeps a page from having
  // three competing "most important" colours.
  primary: 'bg-[#1D1D1F] text-white hover:bg-black',
  secondary: 'bg-[#0071E3] text-white hover:bg-[#0061C3]',
  quiet: 'bg-white text-[#1D1D1F] shadow-[inset_0_0_0_1px_var(--hairline-strong)] hover:bg-[#F7F7F9]',
  danger: 'bg-[#FFF1F0] text-[#FF3B30] hover:bg-[#ffe3e1]',
};

const SIZES = {
  sm: 'h-8 px-3.5 text-[12.5px] gap-1',
  md: 'h-10 px-5 text-[13.5px] gap-1.5',
  lg: 'h-12 px-6 text-[15px] gap-2',
};

function buttonClass(tone: ButtonTone, size: keyof typeof SIZES, full?: boolean) {
  return [
    'inline-flex items-center justify-center rounded-full font-semibold tracking-[-0.006em]',
    'pressable disabled:opacity-45 disabled:pointer-events-none',
    SIZES[size],
    TONE[tone],
    full ? 'w-full' : '',
  ].join(' ');
}

export function Button({
  children,
  tone = 'primary',
  size = 'md',
  full,
  icon,
  ...rest
}: {
  children: ReactNode;
  tone?: ButtonTone;
  size?: keyof typeof SIZES;
  full?: boolean;
  icon?: string;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className={buttonClass(tone, size, full)} {...rest}>
      {icon && <span aria-hidden="true" className="material-symbols-outlined text-[17px]">{icon}</span>}
      {children}
    </button>
  );
}

export function ButtonLink({
  children,
  href,
  tone = 'primary',
  size = 'md',
  full,
  icon,
  external,
}: {
  children: ReactNode;
  href: string;
  tone?: ButtonTone;
  size?: keyof typeof SIZES;
  full?: boolean;
  icon?: string;
  external?: boolean;
}) {
  const cls = buttonClass(tone, size, full);
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

/** Segmented control / filter chip. `pressed` is the ARIA state, not just a look. */
export function Chip({
  children,
  pressed,
  count,
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
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-3.5 h-9 text-[12.5px] font-semibold transition-colors ${
        pressed
          ? 'bg-[#1D1D1F] text-white'
          : 'bg-white text-[#1D1D1F] shadow-[inset_0_0_0_1px_var(--hairline)] hover:bg-[#F7F7F9]'
      }`}
      {...rest}
    >
      {children}
      {count !== undefined && (
        <span className={`tnum ${pressed ? 'text-white/55' : 'text-[#8E8E93]'}`}>{count}</span>
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
}: {
  label: string;
  value: ReactNode;
  sub?: string;
  tone?: 'accent' | 'warn';
}) {
  return (
    <div>
      <p className="t-label text-[#8E8E93]">{label}</p>
      <p
        className={`tnum mt-1.5 text-[26px] font-bold leading-none tracking-[-0.03em] ${
          tone === 'accent' ? 'text-[#0071E3]' : tone === 'warn' ? 'text-[#C7362D]' : 'text-[#1D1D1F]'
        }`}
        style={{ fontFamily: 'var(--font-display)' }}
      >
        {value}
      </p>
      {sub && <p className="mt-1 text-[12px] text-[#6E6E73] tracking-[0]">{sub}</p>}
    </div>
  );
}

/** Label/value row, for detail panels. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2.5">
      <dt className="shrink-0 text-[13px] text-[#8E8E93] tracking-[0]">{label}</dt>
      <dd className="min-w-0 text-right text-[13.5px] font-medium text-[#1D1D1F]">{children}</dd>
    </div>
  );
}

export function Banner({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'ok' | 'warn' | 'error';
  children: ReactNode;
}) {
  const cls = {
    info: 'bg-[#EBF4FE] text-[#0058B0]',
    ok: 'bg-[#EBF7EF] text-[#1D8A44]',
    warn: 'bg-amber-50 text-amber-900',
    error: 'bg-[#FFF1F0] text-[#C7362D]',
  }[tone];
  return (
    <div className={`rounded-xl px-4 py-3 text-[12.5px] leading-relaxed ${cls}`} role="status">
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
  icon,
  title,
  body,
  action,
}: {
  icon: string;
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-[18px] glass-card card-shadow px-6 py-14 text-center">
      <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-[#F5F5F7]">
        <span aria-hidden="true" className="material-symbols-outlined text-[24px] text-[#8E8E93]">{icon}</span>
      </span>
      <h3 className="t-sub text-[#1D1D1F]">{title}</h3>
      {body && <p className="mt-1 max-w-[38ch] text-[13.5px] leading-relaxed text-[#6E6E73]">{body}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`skeleton rounded-lg bg-[#EEEEF0] ${className}`} />;
}
