import type { Metadata, Viewport } from "next";
import { Inter, Inter_Tight } from "next/font/google";
import "./globals.css";
import Script from "next/script";
import AmbientField from "./components/spatial/AmbientField";
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

/*
 * TWO FACES, DELIBERATELY — Bricolage Grotesque and IBM Plex Mono were REMOVED.
 *
 * They were added for the graph headline and for tabular counts, and both were defensible in
 * isolation. Then the client supplied `pulseblr_design_system/DESIGN.md`, which names Inter for
 * every single type role. A display face and a mono face the spec does not ask for are exactly the
 * kind of flourish that makes a build feel like the designer's taste rather than the brand's, and
 * they cost two extra font downloads on a phone to boot.
 *
 * What the spec actually wants at display size is TIGHT TRACKING, not a different family — so
 * `.t-graph-title` uses Inter Tight at -0.035em, and the counts use `tabular-nums`, which fixes
 * the digit-width reflow that Plex Mono was there to solve. Same problem, no extra payload.
 */

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
      className={`${inter.variable} ${interTight.variable} h-full`}
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
        {/* The ambient 3D layer, mounted ONCE for the whole app.

            It lives here rather than per-page so the field is continuous across route
            changes - navigating does not restart the scene, which is the difference between
            "the app is a space" and "this page has an effect on it". It is also outside
            <Providers> because it needs no session and must never wait on one.

            Page grounds were changed from an opaque `bg-[#F5F5F7]` to `.ambient-above` for
            this: an opaque wrapper would paint straight over the field. The page colour is
            now painted by .ambient-field itself, beneath the canvas. */}
        <AmbientField />
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
