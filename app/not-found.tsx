import type { Metadata } from 'next';
import AppShell from './components/AppShell';
import { ButtonLink } from './components/ui';

/**
 * The 404 for every URL no route matches (and any `notFound()` without a nearer boundary).
 *
 * Without this file Next falls back to its bare built-in 404: no nav, no brand, no way back — on a
 * phone, in an installed app with no address bar, that is a dead end whose only exit is killing the
 * app. `app/events/[id]/not-found.tsx` already solved this for one segment; this is the same shape
 * for the rest, wrapped in `AppShell` so the header and bottom nav are both there.
 *
 * `metadata` here is honoured: `collectMetadata()` in `next/dist/lib/metadata/resolve-metadata.js`
 * reads the error-convention module's export when it renders this. Next adds `noindex` itself.
 *
 * No icon, deliberately: the heading carries the message, and the Material Symbols font is exactly
 * what goes missing in the degraded states a fallback page gets shown in (see OfflineBanner.tsx).
 */
export const metadata: Metadata = {
  title: 'Page not found · PulseBLR',
};

export default function NotFound() {
  return (
    <AppShell>
      <div className="mx-auto max-w-[520px] px-[var(--s-4)] pt-[var(--s-16)] text-center">
        <p className="ty-meta">404</p>
        <h1 className="ty-section mt-[var(--s-2)] text-[var(--ink)]">We couldn’t find that page</h1>
        <p className="ty-body mx-auto mt-[var(--s-2)] text-[var(--ink-2)]">
          The link may be out of date, or the page has moved.
        </p>
        {/* `lg` is 48px tall: the 44px floor is painted, not an overlay. */}
        <ButtonLink href="/" size="lg" className="mt-[var(--s-6)]">
          Browse events
        </ButtonLink>
      </div>
    </AppShell>
  );
}
