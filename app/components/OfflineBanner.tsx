'use client';

import { useSyncExternalStore } from 'react';

import { autoDrainArmed, subscribe as subscribeOutbox } from '@/lib/scan/outbox';

/**
 * "You're offline" — the one thing the app never said.
 *
 * WHY IT EXISTS. This product is used standing in a venue with bad signal, and since `public/sw.js`
 * v3/v4 every private API path — and `/api/events` — is network-only on purpose, so offline the feed,
 * the tracker and People fail rather than serve another account's cached data. Nothing in `app/`
 * listened for connectivity (only `lib/scan/outbox.ts` does, to decide when to drain), so those
 * failures read as the app being broken rather than the phone being offline.
 *
 * THE COPY CLAIMS NO MORE THAN THE CODE DOES, and there are two claims because there are two states.
 * The outbox writes every capture to IndexedDB first and removes a record only when the server
 * confirms it, so "kept on this device until it uploads" is true in every case, including a record
 * the server refuses. "Uploads when you're back online" is stronger, and it is printed only while
 * `autoDrainArmed()` says it is true: an account is signed in AND the drain's `online` trigger is
 * attached. That used to be false on most pages — the drain was mounted only by `/scan`, `/folders`
 * and `/folders/[id]`, so reconnecting on the feed uploaded nothing — which is why this banner said
 * the weaker thing everywhere. `<OutboxOwner />` now holds the drain on every page for a signed-in
 * account, so the promise is kept wherever it is made.
 *
 * WHY IT STILL CHECKS RATHER THAN ALWAYS PROMISING. The banner is shown to signed-out visitors too,
 * and a signed-in one can become signed out WHILE offline without touching anything: `next-auth`
 * refetches the session when the page becomes visible again, the fetch fails with no network, and it
 * stores that failure as a null session. The outbox owner goes null, the drain has nobody to upload
 * as, and nothing moves until the session is back. The banner hears that through the outbox's own
 * notifications and falls back to the claim that is still true.
 *
 * CONNECTIVITY IS EXTERNAL STATE, read through `useSyncExternalStore` for the reasons
 * `InstallPrompt.tsx` sets out: the server snapshot is "online", so the server renders nothing and
 * hydration agrees with it, and the `online`/`offline` events notify through one subscription with
 * no effect ordering to get wrong. The snapshot is a boolean, so React compares it by value.
 *
 * `navigator.onLine` IS A ONE-SIDED SIGNAL, and only its reliable side is used. `true` means "might
 * be online" (a captive portal reports true), so the banner cannot promise connectivity — it only
 * ever appears on an explicit `false`, which is the browser saying it has no network at all.
 */

/**
 * Is this navigator online, for the purpose of telling the user otherwise?
 *
 * Only an explicit `false` counts as offline. A missing `navigator`, or one without `onLine` (some
 * embedded webviews), is "online": the banner makes a factual claim, and a claim needs evidence.
 */
export function isOnline(nav: { onLine?: boolean } | null | undefined): boolean {
  return nav?.onLine !== false;
}

function subscribe(onStoreChange: () => void): () => void {
  window.addEventListener('online', onStoreChange);
  window.addEventListener('offline', onStoreChange);
  return () => {
    window.removeEventListener('online', onStoreChange);
    window.removeEventListener('offline', onStoreChange);
  };
}

function getSnapshot(): boolean {
  return isOnline(navigator);
}

/** The server cannot know the visitor's connection, so it claims nothing. */
function getServerSnapshot(): boolean {
  return true;
}

/**
 * The Wi-Fi-off glyph, drawn inline — NOT a Material Symbols ligature, and this is the one
 * component where that matters.
 *
 * The icon font is a cross-origin stylesheet (`fonts.googleapis.com`, linked in `app/layout.tsx`)
 * that `public/sw.js` will not store, on two counts: it is fetched `no-cors`, so the response is
 * OPAQUE, and it is served `Cache-Control: private, max-age=86400, stale-while-revalidate=604800`
 * (measured) — `mayStore()` refuses both. Offline it therefore lives only in the browser's own HTTP
 * cache, for a day plus a week of staleness since it was last fetched; after that the `@font-face`
 * never arrives and every ligature renders as its literal name. Elsewhere that is a cosmetic glitch.
 * Here it would print "wifi_off" in the middle of the only message that exists solely for when the
 * network is gone.
 *
 * Geometry: three arcs of radius 4, 8 and 12 about (12, 17.5), each spanning 45° either side of
 * vertical (endpoints at r·√2⁄2), a dot at the centre, one diagonal. Stroke-only and `currentColor`,
 * like `Logo.tsx`, so it takes the text colour beside it.
 */
function WifiOffIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="mt-px shrink-0"
    >
      <path d="M9.17 14.67A4 4 0 0 1 14.83 14.67" />
      <path d="M6.34 11.84A8 8 0 0 1 17.66 11.84" />
      <path d="M3.51 9.01A12 12 0 0 1 20.49 9.01" />
      <circle cx="12" cy="17.5" r="1.1" fill="currentColor" stroke="none" />
      <path d="M4 4L20 20" />
    </svg>
  );
}

/**
 * What the banner says about a capture made now — see the header for why there are two sentences.
 *
 * `uploadsOnReconnect` is `autoDrainArmed()`: pass `true` only when a capture queued now really will
 * upload by itself once the `online` event fires.
 */
export function offlineNoticeCopy(uploadsOnReconnect: boolean): string {
  return uploadsOnReconnect
    ? 'Anything you scan is saved on this device and uploads when you’re back online.'
    : 'Anything you scan is kept on this device until it uploads.';
}

/**
 * The strip itself. `--surface` with a bottom `--rule`, which is exactly the treatment of the other
 * bars that sit under the header (`/people`'s and `/folders/[id]`'s sticky toolbars), so it reads as
 * part of the chrome rather than as content. `--ink-2`, not `--live`: `--live` means urgent or
 * destructive, and nothing is being lost.
 */
export function OfflineNotice({ uploadsOnReconnect }: { uploadsOnReconnect: boolean }) {
  return (
    <div className="r-flat rule-b bg-[var(--surface)]">
      <div className="mx-auto flex max-w-[1240px] items-start gap-[var(--s-2)] px-[var(--s-4)] py-[var(--s-2)] text-[var(--ink-2)] md:px-8">
        <WifiOffIcon />
        <p className="ty-meta">
          <span className="font-semibold text-[var(--ink)]">You’re offline.</span>{' '}
          {offlineNoticeCopy(uploadsOnReconnect)}
        </p>
      </div>
    </div>
  );
}

/** The server knows nothing about this browser's outbox, so it promises nothing. */
function noUploadClaim(): boolean {
  return false;
}

export default function OfflineBanner() {
  const online = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  // A second, separate store: the outbox notifies when the owner changes and when the drain's
  // triggers attach or detach, which are the two things the stronger sentence depends on.
  const uploadsOnReconnect = useSyncExternalStore(subscribeOutbox, autoDrainArmed, noUploadClaim);

  return (
    /*
     * THE LIVE REGION IS ALWAYS IN THE DOM, EMPTY WHILE ONLINE. A region inserted together with its
     * text is not reliably announced — several screen readers only report CHANGES to a region they
     * already know about — so the container exists from the first render and only its contents come
     * and go. Empty, it is a zero-height box: nothing to see and nothing to intercept a tap.
     *
     * WHERE IT SITS, and why each neighbour is where it is:
     *   · `top` is the 56px header (`--topbar-h`, the same `fixed top-0 h-14` on mobile and desktop)
     *     plus `env(safe-area-inset-top)`, so in an iOS standalone window with the
     *     `black-translucent` status bar it can never slide under the clock or the notch. The inset
     *     is 0 in a browser tab and in the Android TWA, where this is flush with the header.
     *   · `z-[45]`: above the feed's fixed command bar (`z-40`, also at the header's bottom edge — at
     *     a lower value it would be hidden on the home page) and the sticky toolbars (`z-20`); below
     *     the header and bottom nav (`z-50`), `Sheet` (`z-70`) and `/scan`'s toast (`z-[80]`). It
     *     never touches the bottom of the screen, which the install prompt (`z-40` at
     *     `--bottomnav-h`), the event page's action bar and `/scan`'s controls already share.
     */
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-0 z-[45]"
      style={{ top: 'calc(var(--topbar-h) + env(safe-area-inset-top, 0px))' }}
    >
      {online ? null : <OfflineNotice uploadsOnReconnect={uploadsOnReconnect} />}
    </div>
  );
}
