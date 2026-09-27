import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * The one frame every legal page is drawn in: /privacy, /terms and /cookies.
 *
 * Not a route file (it is not `page.tsx`), so it may export a component. It lives beside the
 * privacy page because that page is the pattern the other two copy; putting it under
 * `app/components/` would put legal copy in a directory another stream owns.
 *
 * The three pages link to each other from the header, because a reader who opens one of them is
 * usually looking for one of the others next, and the only other way back is the feed.
 */

export interface LegalSection {
  /** Stable anchor, so another page can link straight to a section (`/privacy#rights`). */
  id: string;
  title: string;
  body: ReactNode;
}

export const LEGAL_PAGES = [
  { href: '/privacy', label: 'Privacy' },
  { href: '/terms', label: 'Terms' },
  { href: '/cookies', label: 'Cookies' },
] as const;

export const linkClass = 'font-semibold text-[var(--accent)] hover:underline';

export function LegalShell({
  route,
  effective,
  title,
  intro,
  sections,
  footer,
}: {
  route: string;
  effective: string;
  title: string;
  intro: ReactNode;
  sections: LegalSection[];
  footer: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-[var(--paper)] text-[var(--ink)]" data-pulseblr-route={route}>
      <header className="rule-b">
        <div className="mx-auto flex h-14 max-w-[900px] items-center justify-between gap-4 px-5 md:px-8">
          <Link href="/" className="text-[15px] font-bold tracking-[-0.02em] text-[var(--ink)]">
            PulseBLR
          </Link>
          <nav aria-label="Legal pages" className="flex items-center gap-4">
            {LEGAL_PAGES.map(page => (
              <Link
                key={page.href}
                href={page.href}
                aria-current={`/${route}` === page.href ? 'page' : undefined}
                className={
                  `/${route}` === page.href
                    ? 'text-[13px] font-semibold text-[var(--ink)]'
                    : 'text-[13px] font-semibold text-[var(--accent)] hover:underline'
                }
              >
                {page.label}
              </Link>
            ))}
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-[900px] px-5 py-10 md:px-8 md:py-16">
        <div className="rule-b pb-[var(--s-6)]">
          <p className="ty-meta">Effective {effective}</p>
          <h1 className="t-display mt-[var(--s-2)] text-[var(--ink)]">{title}</h1>
          <div className="ty-body mt-[var(--s-3)] max-w-[66ch] space-y-3 text-[var(--ink-2)]">{intro}</div>
        </div>

        <article className="divide-y divide-[var(--rule)]">
          {sections.map(section => (
            <section
              key={section.id}
              id={section.id}
              className="grid scroll-mt-6 gap-3 py-7 md:grid-cols-[220px_1fr] md:gap-10"
            >
              <h2 className="ty-section text-[var(--ink)]">{section.title}</h2>
              <div className="space-y-3 text-[14px] leading-7 text-[var(--ink-2)]">{section.body}</div>
            </section>
          ))}
        </article>

        <div className="rule-t space-y-2 pt-6 text-[12.5px] leading-relaxed text-[var(--ink-2)]">{footer}</div>

        <p className="mt-6">
          <Link href="/" className="text-[13px] font-semibold text-[var(--accent)] hover:underline">
            Back to events
          </Link>
        </p>
      </main>
    </div>
  );
}

/** A bulleted list in the legal body style. Itemised on purpose: DPDP Rule 3 asks for an itemised notice. */
export function Items({ children }: { children: ReactNode }) {
  return <ul className="list-disc space-y-1.5 pl-5 marker:text-[var(--ink-3)]">{children}</ul>;
}
