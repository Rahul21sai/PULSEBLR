import type { Metadata, Viewport } from "next";
import { Inter, Familjen_Grotesk } from "next/font/google";
import "./globals.css";
import Script from "next/script";
import Providers from "./providers";
import ProtectedRouteGate from "./components/ProtectedRouteGate";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

/**
 * Display face — headings, and the date tile a coverless event shows.
 *
 * ─── WAS INTER TIGHT. CHANGED AFTER LOOKING, WITH THE ALTERNATIVES MEASURED ────────────────────
 *
 * Inter is genuinely excellent for dense interfaces and keeps the body and UI role. Inter *Tight*
 * in the display role was the problem: it is Inter, so the app's largest type — the one place
 * character is cheap — carried none, and Inter is the most default choice in tech UI.
 *
 * Three candidates were rendered in a static harness at the sizes this app actually uses (the
 * 76px and 104px date tile, a 15.5px title inside the real 167px phone text column, `.t-display`
 * at 40px, and tabular figures), then compared by eye AND by measured advance width against Inter
 * Tight:
 *
 *   | face             | 15.5px title | .t-display | verdict                                     |
 *   | ---------------- | ------------ | ---------- | ------------------------------------------- |
 *   | Inter Tight      | 100%         | 100%       | competent, no voice — the thing to replace   |
 *   | Instrument Sans  | 105.4%       | 104.6%     | REJECTED on measurement, see below          |
 *   | Chivo            | 108.5%       | 106.0%     | widest and heaviest; masthead, not a tool    |
 *   | Familjen Grotesk | 98.3%        | 97.1%      | chosen                                       |
 *
 * INSTRUMENT SANS LOOKED BEST AND THE MEASUREMENT KILLED IT. Being 5.4% wider is not abstract: in
 * the real 167px phone column it clamped `BLR Kubernetes & Cloud Native Meetup #42` to
 * "…Cloud Native Meetup…" while the other two fitted the whole thing — and the `#42` is the part
 * that distinguishes one instalment of a series from the next, which is why `clusterKey` preserves
 * digits. A display face that eats a title is not a display face for a feed.
 *
 * Familjen Grotesk is a Swedish grotesque with a single-storey `g`, angular figures and flat
 * terminals: real voice at 40px, and at tile size its `2`, `3` and `1` are the most designed of the
 * four, which matters now that the date tile is the feed's largest type. It is also NARROWER than
 * the face it replaces at every text size tested, which is the property that makes this safe to
 * land under three other agents: a narrower face can only relieve wrapping pressure on their
 * headings, never create it. That is also why the type scale's tracking values are untouched — they
 * were calibrated against Inter Tight and this face sets 2.9% narrower at the same tracking, which
 * reads correctly in the harness.
 *
 * Only the two weights the type scale asks of the display role are requested (600 and 700), so
 * this is one small file rather than a family. `.t-label`'s 650 is unaffected — it carries no
 * font-family, so it inherits Inter, which is loaded variable.
 */
const displayFace = Familjen_Grotesk({
  subsets: ["latin"],
  weight: ["600", "700"],
  variable: "--font-display-face",
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
  themeColor: "#F5F5F7",
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
      className={`${inter.variable} ${displayFace.variable} h-full`}
    >
      <head>
        <meta name="google" content="notranslate" />
        <link rel="icon" href="/icon-192.svg" />
        <link rel="apple-touch-icon" href="/icon-192.svg" />
        {/* Material Symbols — loaded globally for all pages */}
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap"
        />
      </head>
      <body className="min-h-full antialiased">
        <Providers>
        {/* Inside Providers because it needs the SessionProvider. This replaced the cookie-name
            check in proxy.ts, which had no secret to verify a token with and so could only ask
            "is a cookie present" — no security, and it locked out users whose session was
            demonstrably valid. See lib/protected-routes.ts. */}
        <ProtectedRouteGate>{children}</ProtectedRouteGate>
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
