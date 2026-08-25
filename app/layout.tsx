import type { Metadata, Viewport } from "next";
import { Inter, Inter_Tight, Bricolage_Grotesque, IBM_Plex_Mono } from "next/font/google";
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
 * Display face, headings only.
 *
 * Inter Tight sets appreciably tighter than Inter at large sizes, which is the closest
 * a web-served face gets to SF Pro Display's fit — and fit is what makes Apple
 * typography read as Apple. Only the two weights the type scale actually uses are
 * requested, so this costs one small extra file rather than a whole family.
 */
const interTight = Inter_Tight({
  subsets: ["latin"],
  weight: ["600", "700"],
  variable: "--font-inter-tight",
  display: "swap",
});

/**
 * The graph headline, and nothing else.
 *
 * Bricolage Grotesque has real character at display sizes — slightly irregular widths, a
 * grotesque that does not read as the geometric sans every developer tool reaches for. That
 * only works as a contrast, so it is scoped to `.t-graph-title`: one headline per page. Used
 * more widely it would fight Inter, which is doing the actual work of making 1200 dense rows
 * scannable.
 *
 * One weight, because one weight is all a single headline needs — the whole family would be
 * several files for no benefit.
 */
const bricolage = Bricolage_Grotesque({
  subsets: ["latin"],
  weight: ["700"],
  variable: "--font-display-alt",
  display: "swap",
});

/**
 * Counts, timestamps, connection scores, badges.
 *
 * A mono face here is functional rather than stylistic: these are TABULAR values that update
 * live ("341 tech events", a ticking count), and a proportional face makes the surrounding
 * layout shift by a pixel or two on every change. Plex Mono also sets narrower than JetBrains
 * Mono, so it fits inside a pill without shrinking the label.
 */
const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-mono",
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
      className={`${inter.variable} ${interTight.variable} ${bricolage.variable} ${plexMono.variable} h-full`}
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
