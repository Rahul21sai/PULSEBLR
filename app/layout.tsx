import type { Metadata, Viewport } from "next";
import { Inter, Inter_Tight } from "next/font/google";
import "./globals.css";
import Script from "next/script";
import Providers from "./providers";

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
        <Providers>
        {children}
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
