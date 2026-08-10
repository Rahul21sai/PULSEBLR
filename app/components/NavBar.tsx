'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useSession } from 'next-auth/react';

const NAV_LINKS = [
  { href: '/', label: 'Events', icon: 'explore' },
  { href: '/companies', label: 'Companies', icon: 'domain' },
  { href: '/calendar', label: 'Calendar', icon: 'calendar_today' },
  { href: '/tracker', label: 'Tracker', icon: 'bookmarks' },
  { href: '/add-event', label: 'Add', icon: 'add_circle' },
  { href: '/settings', label: 'Settings', icon: 'settings' },
];

function useIsActive() {
  const pathname = usePathname();
  return (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href));
}

export function DesktopNav() {
  const isActive = useIsActive();
  const { data: session } = useSession();

  return (
    <nav className="hidden md:flex fixed top-0 w-full h-14 bg-white/96 glass-nav z-50 border-b border-black/5">
      <div className="flex justify-between items-center w-full max-w-[1240px] mx-auto px-8">
        <Link
          href="/"
          className="text-xl font-bold tracking-[-0.02em] text-[#1D1D1F] hover:text-[#0071E3] transition-colors select-none"
        >
          PulseBLR
        </Link>

        <div className="flex items-center gap-7">
          {NAV_LINKS.map(link => {
            const active = isActive(link.href);
            return (
              <Link
                key={link.href}
                href={link.href}
                aria-current={active ? 'page' : undefined}
                className={`text-[13.5px] font-medium transition-colors ${
                  active
                    ? 'text-[#0071E3] font-semibold'
                    : 'text-[#6E6E73] hover:text-[#1D1D1F]'
                }`}
              >
                {link.label}
              </Link>
            );
          })}
        </div>

        <div className="flex items-center gap-3">
          {session?.user?.image ? (
            <Link href="/dashboard" className="flex items-center hover:opacity-80 transition-opacity">
              {/* eslint-disable-next-line @next/next/no-img-element -- Google avatar CDN */}
              <img
                src={session.user.image}
                alt={session.user.name || 'Your account'}
                className="w-8 h-8 rounded-full object-cover border border-[#e5e5ea]"
              />
            </Link>
          ) : (
            <Link
              href="/login"
              className="text-[13px] font-semibold text-[#0071E3] hover:underline"
            >
              Sign in
            </Link>
          )}
        </div>
      </div>
    </nav>
  );
}

export function MobileHeader({ title }: { title?: string }) {
  return (
    <header className="md:hidden fixed top-0 w-full h-14 bg-white/96 glass-nav z-50 border-b border-black/5 flex items-center justify-between px-5">
      <Link href="/" className="text-lg font-bold tracking-tight text-[#1D1D1F]">
        PulseBLR
      </Link>
      {title && <span className="text-[#86868B] text-label-md font-semibold">{title}</span>}
    </header>
  );
}

export function MobileBottomNav() {
  const isActive = useIsActive();

  return (
    <nav
      className="fixed bottom-0 w-full md:hidden bg-white/96 glass-nav border-t border-black/5 flex justify-around items-center px-2 pt-1.5 z-50"
      // Keep the bar clear of the iOS home indicator.
      style={{ paddingBottom: 'max(6px, env(safe-area-inset-bottom))' }}
    >
      {NAV_LINKS.map(link => {
        const active = isActive(link.href);
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? 'page' : undefined}
            className={`flex flex-col items-center justify-center px-3 py-1 rounded-xl transition-colors active:scale-95 ${
              active ? 'bg-[#0071E3]/10' : 'hover:bg-[#f3f3f5]'
            }`}
          >
            <span
              className={`material-symbols-outlined text-[21px] ${
                active ? 'text-[#0071E3]' : 'text-[#86868B]'
              }`}
              style={{ fontVariationSettings: `'FILL' ${active ? 1 : 0}` }}
            >
              {link.icon}
            </span>
            <span
              className={`text-[10px] font-semibold mt-0.5 ${
                active ? 'text-[#0071E3]' : 'text-[#86868B]'
              }`}
            >
              {link.label}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}
