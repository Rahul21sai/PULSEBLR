import type { Metadata, Viewport } from "next";
import { Plus_Jakarta_Sans, Newsreader } from "next/font/google";
import "./globals.css";
import Script from "next/script";
import Providers from "./providers";
import ProtectedRouteGate from "./components/ProtectedRouteGate";
import InstallPrompt from "./components/InstallPrompt";

/*
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * TWO FACES, AND THE SPLIT BETWEEN THEM IS SEMANTIC RATHER THAN DECORATIVE.
 *
 *     Serif is the city's content. Sans is the product's voice.
 *
 * Event titles, venue names, people's names and page-defining headlines are the world OUTSIDE this
 * app — they are set in the serif. Everything the system says ABOUT that content — dates, counts,
 * areas, tiers, buttons, filters, empty-state copy, admin chrome — is the sans. A reader should be
 * able to tell "a thing in the world" from "the app talking" without reading a word.
 *
 * That is the one rule carrying the whole design, which is why it is a rule about MEANING and not
 * about size. A serif used for emphasis, or for whichever text happened to be large, would be
 * decoration and would read as such.
 *
 * WHY THESE TWO. The lane is editorial-technical: a precise instrument for engineers, closer to a
 * well-set listings page than to a SaaS dashboard. Anthropic's own faces (Styrene, Tiempos,
 * Copernicus) are commercially licensed and cannot ship here, so these are the open equivalents of
 * those two roles — Plus Jakarta Sans for the Styrene role, Newsreader for the Tiempos role. Both
 * variable, both on Google Fonts.
 *
 * ── THE BUG THIS FILE HAS ALREADY SHIPPED ONCE. DO NOT REINTRODUCE IT. ────────────────────────
 *
 * `next/font` registers a HASHED family name and exposes it ONLY through the CSS variable. Naming
 * the family literally — `--font-sans: 'Inter'` — never matches, falls through to `system-ui`, and
 * renders Segoe UI on Windows. This app did exactly that: it downloaded Inter on every visit and
 * rendered a face it never used, with every tracking value in the type scale calibrated against
 * Inter and applied to something else.
 *
 * So: assign from `.variable` (below), consume `var(--font-sans)` / `var(--font-serif)` in
 * globals.css, and **verify the computed `font-family` in a screenshot rather than in source.**
 * The failure is invisible in the source, which is the entire reason it survived.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
const sans = Plus_Jakarta_Sans({
  subsets: ["latin"],
  variable: "--font-jakarta",
  display: "swap",
});

/*
 * Editorial content only, at large sizes. `display: 'swap'` matters more here than on the sans:
 * these are the largest glyphs on the page, so a blocking load would hold the one thing a reader
 * is trying to read.
 */
const serif = Newsreader({
  subsets: ["latin"],
  variable: "--font-newsreader",
  display: "swap",
});

export const metadata: Metadata = {
  title: "PulseBLR - Bangalore Tech Events",
  description: "Your curated pipeline for AI, Fintech, and Networking events in Bangalore.",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "PulseBLR",
  },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  // A LITERAL on purpose, mirroring `--paper` in globals.css. This is serialised into a
  // `<meta name="theme-color">`, where a `var()` would resolve to nothing — so it cannot be a
  // token, and it is the one place a stale value repaints the browser's own chrome rather than
  // the page. It was #F5F5F7, the retired cool grey, which left an installed PWA framed in cool
  // grey around a warm page. Keep it in step with --paper by hand.
  themeColor: "#FAF9F5",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  /**
   * `cover` is what makes `env(safe-area-inset-*)` resolve to a real value.
   *
   * Without it those variables are 0 on every device, so the ONE existing use of them —
   * `max(6px, env(safe-area-inset-bottom))` on the mobile bottom nav — was always just 6px, and
   * the bar sat under the iOS home indicator. The scan and card screens are full-bleed and need
   * the real insets.
   *
   * THIS IS A GLOBAL CHANGE: it activates the inset on every page at once and lets content
   * extend under the notch, so the feed and tracker need re-checking after any edit here.
   * `appleWebApp.statusBarStyle` is already `black-translucent`, which assumed this all along.
   */
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      translate="no"
      className={`${sans.variable} ${serif.variable} h-full`}
    >
      <head>
        <meta name="google" content="notranslate" />
        {/*
          NO HAND-WRITTEN ICON LINKS HERE. Two used to sit on this line and both were wrong:

            <link rel="icon" href="/icon-192.svg" />
            <link rel="apple-touch-icon" href="/icon-192.svg" />

          The first COMPETED with `app/favicon.ico`, which Next's file convention already emits a
          tag for — two `rel="icon"` links, and the browser picks whichever it likes. Worse, that
          favicon.ico was still the untouched Create-Next-App default, so the app was shipping the
          Next.js logo in the browser tab.

          The second was inert: `apple-touch-icon` does not support SVG, so iOS ignored it and
          screenshotted the page for the home screen instead of using the brand mark.

          Both are now generated from `app/favicon.ico` and `app/apple-icon.png` (see
          `scripts/generate-icons.js`), whose tags Next writes itself with the right `type` and
          `sizes` attributes read off the actual files. Do not re-add a manual link: it would
          reintroduce the duplicate rather than override it.
        */}
        {/* Material Symbols — loaded globally for all pages */}
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap"
        />
        {/*
          Catch `beforeinstallprompt` before React exists.

          Chrome fires it as soon as it decides the app is installable, which is routinely
          BEFORE hydration, and it does not fire again for the life of the page. A listener
          added inside a component's effect therefore misses it on a cold load — and the event
          object is the only way to open the OS install dialog, so missing it means the Install
          button cannot work at all. `preventDefault()` suppresses Chrome's own mini-infobar so
          our banner is the single affordance rather than the second one.

          `beforeInteractive` is required here: `afterInteractive` runs too late to be a
          reliable catch, which is the whole point of this script.
        */}
        <Script id="capture-install-prompt" strategy="beforeInteractive">
          {`
            window.__pblrInstall = null;
            window.addEventListener('beforeinstallprompt', function (e) {
              e.preventDefault();
              window.__pblrInstall = e;
            });
            window.addEventListener('appinstalled', function () {
              window.__pblrInstall = null;
            });
          `}
        </Script>
      </head>
      <body className="min-h-full antialiased">
        <Providers>
        {/* Inside Providers because it needs the SessionProvider. This replaced the cookie-name
            check in proxy.ts, which had no secret to verify a token with and so could only ask
            "is a cookie present" — no security, and it locked out users whose session was
            demonstrably valid. See lib/protected-routes.ts. */}
        <ProtectedRouteGate>{children}</ProtectedRouteGate>
        {/* A SIBLING of the gate, not a child, and that matters. For a protected path with a
            settled `unauthenticated` status the gate returns a sign-in panel INSTEAD of its
            children — so nested here the prompt would be swallowed on exactly the pages a
            signed-out visitor sees. It needs no session of its own; it decides what to draw
            from `display-mode` and `beforeinstallprompt`. */}
        <InstallPrompt />
        </Providers>
        <Script id="register-sw" strategy="afterInteractive">
          {process.env.NODE_ENV === "production"
            ? `
            if ('serviceWorker' in navigator) {
              window.addEventListener('load', function() {
                navigator.serviceWorker.register('/sw.js');
              });
            }
          `
            : `
            // Development: never run a caching service worker (it serves stale
            // Next.js dev chunks and hangs the app). Unregister any installed
            // SW and wipe its caches so a previously-poisoned browser recovers.
            if ('serviceWorker' in navigator) {
              navigator.serviceWorker.getRegistrations().then(function(regs) {
                var had = regs.length > 0;
                Promise.all(regs.map(function(r) { return r.unregister(); })).then(function() {
                  if (window.caches) {
                    caches.keys().then(function(keys) {
                      return Promise.all(keys.map(function(k) { return caches.delete(k); }));
                    }).then(function() {
                      if (had && !sessionStorage.getItem('sw-cleaned')) {
                        sessionStorage.setItem('sw-cleaned', '1');
                        location.reload();
                      }
                    });
                  }
                });
              });
            }
          `}
        </Script>
      </body>
    </html>
  );
}
