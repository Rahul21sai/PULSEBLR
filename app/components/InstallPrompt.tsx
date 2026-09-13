'use client';

import { useCallback, useState, useSyncExternalStore } from 'react';
import { usePathname } from 'next/navigation';
import Sheet from './Sheet';
import { Button } from './ui';

/**
 * "Is there an app?" — the question people asked at events, answered in the product.
 *
 * The app has been installable for as long as it has had a manifest and a service worker, and
 * nothing has ever said so. A visitor had to know to open a browser menu and find "Install" or
 * "Add to Home Screen". This is the affordance.
 *
 * THE TWO PLATFORMS NEED OPPOSITE THINGS, which is why this is not one banner.
 *
 * Android/Chrome fires `beforeinstallprompt` and hands over an object whose `prompt()` opens
 * the real OS install dialog. So there we show a banner with a button that does the thing.
 *
 * iOS fires no such event and exposes no API: installing is Share -> Add to Home Screen, done
 * by hand. So there the only honest move is to show those instructions. Two constraints that
 * are easy to get wrong:
 *
 *   - iPadOS 13+ reports itself as a Mac. `navigator.platform === 'MacIntel'` with
 *     `maxTouchPoints > 1` is the standard way to tell an iPad from a desktop, and without it
 *     every iPad is missed.
 *   - ONLY SAFARI CAN DO IT. Chrome, Firefox and Edge on iOS all run WebKit but none of them
 *     has "Add to Home Screen" in its share sheet. Showing those instructions there is not a
 *     small inaccuracy, it is an instruction the user cannot follow — so we tell them to open
 *     Safari instead.
 *
 * WHY IT DOES NOT APPEAR INSIDE THE INSTALLED APP, including the Play Store TWA. A TWA renders
 * in real Chrome and reports `display-mode: standalone`, exactly like an installed PWA, so the
 * media query below suppresses both with one check. That is deliberate: an installed app
 * advertising installation is the most obviously broken thing this component could do.
 *
 * `--bottomnav-h` positions the banner rather than a measured constant. `MobileBottomNav` is
 * `fixed bottom-0 z-50 md:hidden` and its height CONTAINS `env(safe-area-inset-bottom)`, which
 * is 0 in headless Chromium and ~34px on a notched iPhone — so a literal would be correct
 * exactly where nobody looks. This is the rule CLAUDE.md states for sticky bars.
 */

/** The slice of `BeforeInstallPromptEvent` we use. It is not in TypeScript's DOM lib. */
type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

declare global {
  interface Window {
    /** Stashed by the `capture-install-prompt` script in `app/layout.tsx`. */
    __pblrInstall?: InstallPromptEvent | null;
  }
}

/**
 * Where the prompt may appear. Deliberately not everywhere: an install banner on a page
 * somebody arrived at from a shared link is noise. `/scan` earns its place most of all,
 * because it is the surface that genuinely needs to work offline at a venue.
 */
const PROMPT_ON = ['/', '/scan', '/tracker'];

const DISMISSED_KEY = 'pblr-install-dismissed';
/** A dismissal is respected for this long; after that we may ask once more. */
const DISMISS_DAYS = 30;

/** localStorage throws in a private window and in some embedded webviews. Never let it break. */
function readStore(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeStore(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* no persistence available; the in-memory state still suppresses for this session */
  }
}

type Platform = 'installable' | 'ios-safari' | 'ios-other' | 'none';

/**
 * Installability is EXTERNAL state — it lives in `display-mode`, in the user agent, in a
 * browser-fired event and in localStorage, none of which React owns. So it is read through
 * `useSyncExternalStore` rather than mirrored into component state by an effect.
 *
 * That is not a style preference, it settles two real problems at once:
 *
 *   - `getServerSnapshot` returns 'none', so the server renders nothing and the client's first
 *     paint agrees with it. Mirroring `window` into state via an effect instead means either a
 *     hydration mismatch or a `mounted` flag whose only job is to set state in an effect.
 *   - Every signal that can change (the event arriving late, the app being installed, the user
 *     dismissing) notifies through one subscription, so there is no ordering between effects.
 *
 * `getSnapshot` returns a plain string, so React's identity check compares by value and cannot
 * loop. It must therefore stay CHEAP and free of side effects — in particular it must never
 * write to localStorage, which is why the "how many times have we asked" counter this component
 * originally carried is gone. A 30-day dismissal is the anti-nag mechanism, and it is
 * user-driven rather than something we tick up behind them.
 */
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  window.addEventListener('beforeinstallprompt', onStoreChange);
  window.addEventListener('appinstalled', onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
    window.removeEventListener('beforeinstallprompt', onStoreChange);
    window.removeEventListener('appinstalled', onStoreChange);
  };
}

/** True while a dismissal is still inside its window. */
function dismissedRecently(): boolean {
  const at = Number(readStore(DISMISSED_KEY) ?? 0);
  return at > 0 && Date.now() - at < DISMISS_DAYS * 86_400_000;
}

function getSnapshot(): Platform {
  if (dismissedRecently()) return 'none';
  return detectPlatform();
}

/** The server knows nothing about the visitor's device, so it offers nothing. */
function getServerSnapshot(): Platform {
  return 'none';
}

function detectPlatform(): Platform {
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: minimal-ui)').matches ||
    // iOS Safari's own pre-standard flag, still the only signal there.
    (navigator as Navigator & { standalone?: boolean }).standalone === true;

  // Already installed, or running as the TWA. Nothing to offer.
  if (standalone) return 'none';

  const ua = navigator.userAgent;
  const isIOS =
    /iPad|iPhone|iPod/.test(ua) ||
    // iPadOS 13+ masquerades as macOS; touch points are what separate it from a desktop.
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  if (isIOS) {
    // Every iOS browser is WebKit, but only Safari's share sheet has Add to Home Screen.
    return /CriOS|FxiOS|EdgiOS|OPiOS/.test(ua) ? 'ios-other' : 'ios-safari';
  }

  // Anywhere else, an install is only possible if the browser gave us the event.
  return window.__pblrInstall ? 'installable' : 'none';
}

export default function InstallPrompt() {
  const pathname = usePathname();
  const platform = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const [sheetOpen, setSheetOpen] = useState(false);

  const dismiss = useCallback(() => {
    setSheetOpen(false);
    writeStore(DISMISSED_KEY, String(Date.now()));
    // The store has changed in a way no browser event announces, so say so. Without this the
    // snapshot is only re-read on the next unrelated event and the banner lingers after a tap.
    notify();
  }, []);

  const install = useCallback(async () => {
    const event = window.__pblrInstall;
    if (!event) return;
    await event.prompt();
    await event.userChoice;
    // The event is single-use — a second prompt() on it throws — so it is spent whatever the
    // user chose. Dropping it makes the next snapshot return 'none'.
    window.__pblrInstall = null;
    notify();
  }, []);

  if (platform === 'none') return null;
  if (!PROMPT_ON.includes(pathname)) return null;

  const isIOS = platform === 'ios-safari' || platform === 'ios-other';

  return (
    <>
      <div
        role="complementary"
        aria-label="Install PulseBLR"
        // z-40 sits below MobileBottomNav (z-50) and below Sheet (z-70), so it can never
        // cover navigation or a dialog.
        className="fixed inset-x-0 z-40 px-[var(--s-4)] pb-[var(--s-3)] md:left-auto md:right-[var(--s-4)] md:max-w-sm md:px-0"
        style={{
          // Clears the mobile bottom nav; on md+ that nav is hidden, so sit at the corner.
          bottom: 'var(--bottomnav-h)',
        }}
      >
        <div className="r-touch flex items-center gap-[var(--s-3)] border border-[var(--hairline)] bg-[var(--surface)] p-[var(--s-3)] shadow-[var(--lift-2)]">
          <span
            aria-hidden="true"
            className="material-symbols-outlined shrink-0 text-[var(--accent)]"
            style={{ fontSize: 22 }}
          >
            install_mobile
          </span>
          <div className="min-w-0 flex-1">
            {/* Kept to two or three words on purpose. At 390px the icon, action and close button
                leave ~215px for this column, and "Add PulseBLR to your phone" wrapped to two
                lines there — measured, it took the card to 124px tall. The subtitle carries the
                per-platform nuance instead, where a wrap is cheap. */}
            <p className="ty-body font-semibold text-[var(--ink)]">Install PulseBLR</p>
            <p className="ty-meta text-[var(--ink-2)]">
              {isIOS ? 'Two taps from the share menu.' : 'Opens full screen, works offline.'}
            </p>
          </div>
          <Button
            size="sm"
            onClick={isIOS ? () => setSheetOpen(true) : install}
            aria-haspopup={isIOS ? 'dialog' : undefined}
          >
            {isIOS ? 'How' : 'Install'}
          </Button>
          <button
            type="button"
            onClick={dismiss}
            aria-label="Not now"
            // 44px minimum touch target. The icon is 20px, so the button carries the rest as
            // padding rather than relying on the glyph.
            className="r-touch -mr-1 grid h-11 w-11 shrink-0 place-items-center text-[var(--ink-3)] transition-colors hover:text-[var(--ink)]"
          >
            <span aria-hidden="true" className="material-symbols-outlined" style={{ fontSize: 20 }}>
              close
            </span>
          </button>
        </div>
      </div>

      {isIOS && (
        <Sheet
          open={sheetOpen}
          onClose={() => setSheetOpen(false)}
          title="Add to your home screen"
          subtitle={
            platform === 'ios-other'
              ? 'This needs Safari on iPhone and iPad.'
              : 'It opens full screen, with no browser bar.'
          }
          footer={
            <Button full onClick={dismiss}>
              Got it
            </Button>
          }
        >
          {platform === 'ios-other' ? (
            <p className="ty-body text-[var(--ink-2)]">
              Only Safari can add a site to the iPhone home screen &mdash; the option is missing
              from other browsers&rsquo; share menus. Open{' '}
              <span className="font-semibold text-[var(--ink)]">pulseblr</span> in Safari, then
              follow the same two steps.
            </p>
          ) : (
            <ol className="flex flex-col gap-[var(--s-4)]">
              {[
                { icon: 'ios_share', text: 'Tap the Share button in the Safari toolbar.' },
                { icon: 'add_box', text: 'Choose "Add to Home Screen" from the list.' },
                { icon: 'check_circle', text: 'Tap Add. PulseBLR appears with your other apps.' },
              ].map((step, i) => (
                <li key={step.icon} className="flex items-start gap-[var(--s-3)]">
                  <span className="ty-meta grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[var(--accent)]/10 font-semibold text-[var(--accent)]">
                    {i + 1}
                  </span>
                  <span className="ty-body flex-1 text-[var(--ink-2)]">{step.text}</span>
                  <span
                    aria-hidden="true"
                    className="material-symbols-outlined shrink-0 text-[var(--ink-3)]"
                    style={{ fontSize: 20 }}
                  >
                    {step.icon}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </Sheet>
      )}
    </>
  );
}
