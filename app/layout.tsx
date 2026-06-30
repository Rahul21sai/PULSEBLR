import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import Script from "next/script";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
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
  themeColor: "#000000",
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
    <html lang="en" className={`${inter.variable} h-full`}>
      <head>
        <link rel="icon" href="/icon-192.svg" />
        <link rel="apple-touch-icon" href="/icon-192.svg" />
        {/* Material Symbols — loaded globally for all pages */}
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap"
        />
      </head>
      <body className="min-h-full antialiased">
        {children}
        <Script id="register-sw" strategy="afterInteractive">
          {`
            if ('serviceWorker' in navigator) {
              window.addEventListener('load', function() {
                navigator.serviceWorker.register('/sw.js');
              });
            }
          `}
        </Script>
      </body>
    </html>
  );
}
