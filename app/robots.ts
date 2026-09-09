import type { MetadataRoute } from 'next';

import { PROTECTED_PATHS } from '@/lib/protected-routes';
import { absoluteUrl, canonicalOrigin } from '@/lib/canonical-origin';

/**
 * robots.txt.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE DISALLOW LIST IS DERIVED FROM `PROTECTED_PATHS`, NOT RETYPED. That array is already the one
 * definition of "pages that require a signed-in user" (`/dashboard`, `/tracker`, `/add-event`,
 * `/settings`, `/admin`, `/folders`, `/people`, `/scan`, `/card`), and a second hand-maintained copy
 * here would go stale the first time a private page is added — silently, because nothing fails when
 * robots.txt is merely incomplete. Every one of those pages is a client component behind
 * `ProtectedRouteGate`, so a crawler gets a sign-in wall: nothing to index, and crawl budget spent
 * on it is crawl budget not spent on event pages.
 *
 * `/c/` AND `/f/` ARE ADDED BY HAND, and they are the two entries that are NOT protected paths —
 * that is precisely why they need naming. They are public by design (a stranger scans a QR code and
 * opens one with no account), so no gate will ever exclude them, and both set
 * `robots: { index: false }` at the page. Disallowing them as well means a crawler does not fetch a
 * token-addressed URL at all, which is what keeps a shared card link from becoming permanently
 * public. Note the trailing slashes: `/c/` and `/f/` cannot match `/calendar` or `/folders`.
 *
 * `/api/` is disallowed because a JSON endpoint has nothing to index and several of them are
 * expensive. `/login` is disallowed because it is a redirect target, never a landing page.
 *
 * A DISALLOW IS NOT AN ACCESS CONTROL, and nothing here is relied on as one. The real boundary is
 * `requireUser()` / `requireAdmin()` on each route plus `/admin`'s own server-side allowlist check.
 * This file only decides what a well-behaved crawler spends its time on.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */
export default function robots(): MetadataRoute.Robots {
  const disallow = [
    '/api/',
    // Public-by-design, token-addressed, and noindex at the page. See the header.
    '/c/',
    '/f/',
    '/login',
    ...PROTECTED_PATHS,
  ];

  return {
    rules: [{ userAgent: '*', allow: '/', disallow }],
    sitemap: absoluteUrl('/sitemap.xml'),
    host: canonicalOrigin(),
  };
}
