/**
 * The one true origin for URLs that leave this app.
 *
 * WHY THIS IS NOT `request.headers.get('host')` OR `request.nextUrl.origin`.
 *
 * `auth.ts` sets `trustHost: true` — it has to, because Auth.js v5 auto-trusts only
 * Vercel and without it every `/api/auth/*` route returns 500 with `UntrustedHost` on any
 * other host. The cost of that is that the `Host` / `X-Forwarded-Host` header is
 * attacker-controllable: anyone can send a request with `Host: evil.example` and any URL
 * built from it points there.
 *
 * For a login redirect that is bad. For a QR CODE it is worse, because the code gets
 * screenshotted, printed on a badge, or stuck on a poster — a spoofed origin baked into
 * one keeps working long after the request that generated it. So every shareable URL is
 * built from `NEXTAUTH_URL`, the pinned canonical origin that `auth.ts` already demands in
 * production and logs an error about when missing.
 */

/**
 * Canonical origin with no trailing slash, e.g. `https://pulseblr.vercel.app`.
 *
 * Falls back to localhost in development only. In production a missing `NEXTAUTH_URL`
 * throws rather than silently minting codes that point at localhost: a QR code is
 * long-lived, and one pointing at `http://localhost:3000` is worse than an error at the
 * moment of creation.
 */
export function canonicalOrigin(): string {
  const configured = process.env.NEXTAUTH_URL?.trim();
  if (configured) return configured.replace(/\/+$/, '');

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'NEXTAUTH_URL is not set, so no shareable link or QR code can be generated. ' +
        'Set it to the canonical origin of this deployment, e.g. https://pulseblr.example.com'
    );
  }
  return 'http://localhost:3000';
}

/** Absolute URL for a path, built from the canonical origin. */
export function absoluteUrl(path: string): string {
  return `${canonicalOrigin()}${path.startsWith('/') ? path : `/${path}`}`;
}

/** The public URL a personal card QR encodes. */
export function cardUrl(token: string): string {
  return absoluteUrl(`/c/${token}`);
}

/** The public URL a folder self-registration QR encodes. */
export function intakeUrl(token: string): string {
  return absoluteUrl(`/f/${token}`);
}
