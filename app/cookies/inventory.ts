/**
 * Every cookie and every piece of on-device storage PulseBLR's own code (or Auth.js on its behalf)
 * creates in a production browser. Rendered by `app/cookies/page.tsx`; checked against the code by
 * `tests/legal-pages.test.ts`, which fails if this list and the source disagree in EITHER direction.
 *
 * WHY THERE IS NO CONSENT BANNER. Everything below is strictly necessary for a feature the person
 * is using (staying signed in, protecting the sign-in flow, keeping a scan they have not uploaded
 * yet, remembering they dismissed the install card). There is no analytics, advertising or
 * cross-site tracking code in this repository — the same test pins that too. A banner asking
 * permission for storage the app cannot work without is noise, and it teaches people to click
 * "accept" without reading. If a non-essential tracker is ever added, THAT is when a consent
 * prompt is needed, and the drift test is what will say so.
 *
 * Names are the PRODUCTION names. Auth.js prefixes them with `__Secure-` / `__Host-` on https;
 * in local development over http the prefixes are absent.
 */

export interface StorageItem {
  name: string;
  kind: 'Cookie' | 'Local storage' | 'IndexedDB' | 'Cache storage';
  set: string;
  purpose: string;
  lasts: string;
}

/**
 * Auth.js cookie suffixes this app uses (after `authjs.`). The test reads them out of `@auth/core`.
 *
 * NOT `state` or `nonce`: the Google provider sets no `checks`, so Auth.js defaults to PKCE alone
 * (`lib/utils/providers.js`), and adds `state` only when `AUTH_REDIRECT_PROXY_URL` is configured,
 * which this app does not do. `tests/legal-pages.test.ts` pins all three facts.
 */
export const AUTH_COOKIE_SUFFIXES = [
  'session-token',
  'csrf-token',
  'callback-url',
  'pkce.code_verifier',
] as const;

export const COOKIES: StorageItem[] = [
  {
    name: '__Secure-authjs.session-token',
    kind: 'Cookie',
    set: 'When you sign in with Google',
    purpose:
      'Keeps you signed in. An encrypted token holding your account id, name, email and picture. A very large session may be split into numbered parts (.0, .1, …).',
    lasts: 'Until you sign out, or 30 days without use',
  },
  {
    name: '__Host-authjs.csrf-token',
    kind: 'Cookie',
    set: 'When a sign-in or sign-out form is shown',
    purpose: 'Stops another website from signing you in or out without your action.',
    lasts: 'Until you close the browser',
  },
  {
    name: '__Secure-authjs.callback-url',
    kind: 'Cookie',
    set: 'During sign-in',
    purpose: 'Remembers which PulseBLR page to return you to after Google sign-in.',
    lasts: 'Until you close the browser',
  },
  {
    name: '__Secure-authjs.pkce.code_verifier',
    kind: 'Cookie',
    set: 'During Google sign-in',
    purpose: 'A one-time security check that the Google sign-in response is for this browser.',
    lasts: '15 minutes',
  },
];

export const DEVICE_STORAGE: StorageItem[] = [
  {
    name: 'pulseblr-outbox',
    kind: 'IndexedDB',
    set: 'When you scan or add a contact, or create a folder',
    purpose:
      'Holds each capture on your device first, so a person you scanned is not lost on a bad venue connection. Removed once it uploads, when you discard it, or when you delete your account from this device.',
    lasts: 'Until it uploads or you discard it',
  },
  {
    name: 'pblr-install-dismissed',
    kind: 'Local storage',
    set: 'When you dismiss the “Install PulseBLR” card',
    purpose: 'Remembers the time you dismissed it, so the card is not shown again for 30 days.',
    lasts: 'Until you clear site data',
  },
  {
    name: 'pulseblr-static-*, pulseblr-assets-*, pulseblr-dynamic-*',
    kind: 'Cache storage',
    set: 'By the app’s service worker as you browse',
    purpose:
      'Copies of PulseBLR’s own pages, icons and code so the app opens quickly and shows an offline page. Never holds your private data: every /api response is excluded. Cleared when you sign out.',
    lasts: 'Until the next app version, sign-out, or you clear site data',
  },
];

/**
 * Keys the source uses that are deliberately NOT on the public list, with the reason. The drift
 * test accepts these and nothing else.
 */
export const UNLISTED_KEYS: Record<string, string> = {
  // Set only by the development-mode service-worker cleanup script in `app/layout.tsx`.
  'sw-cleaned': 'development builds only; production never sets it',
};
