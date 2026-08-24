'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { DesktopNav, MobileBottomNav } from './NavBar';

/**
 * The standard page frame: desktop nav, mobile header, bottom nav, and the top/bottom
 * padding that keeps content clear of both fixed bars.
 *
 * Extracted because `app/tracker/page.tsx` had a local `Shell` and every other page
 * hand-rolled the same markup with slightly different padding. A fourth copy for the scan
 * surfaces would be the point at which the drift becomes permanent.
 *
 * `bare` renders NO chrome at all. The camera screen needs that: the nav is `bg-white/96`
 * and looks wrong over a viewfinder, and a full-bleed dark surface has nothing to align to.
 */
export default function AppShell({
  children,
  title,
  bare = false,
}: {
  children: ReactNode;
  /** Shown on the right of the mobile header, naming the current section. */
  title?: string;
  bare?: boolean;
}) {
  if (bare) return <>{children}</>;

  return (
    <div className="min-h-screen bg-[#F5F5F7]">
      <DesktopNav />
      <header className="md:hidden fixed top-0 w-full h-14 bg-white/96 glass-nav z-50 border-b border-black/5 flex items-center justify-between px-5">
        <Link href="/" className="text-lg font-bold tracking-tight text-[#1D1D1F]">
          PulseBLR
        </Link>
        {title && <span className="text-[#86868B] text-label-md font-semibold">{title}</span>}
      </header>
      <main className="pt-14 pb-24 md:pb-10">{children}</main>
      <MobileBottomNav />
    </div>
  );
}
