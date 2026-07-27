'use client';

import { usePathname } from 'next/navigation';
import { useSession, signOut } from 'next-auth/react';

const NAV_LINKS = [
  { href: '/', label: 'Feed', icon: 'rss_feed' },
  { href: '/calendar', label: 'Calendar', icon: 'calendar_today' },
  { href: '/tracker', label: 'Tracker', icon: 'analytics' },
  { href: '/add-event', label: 'Add', icon: 'add_circle' },
  { href: '/settings', label: 'Settings', icon: 'settings' },
];

export function DesktopNav() {
  const pathname = usePathname();
  const { data: session } = useSession();

  return (
    <nav className="hidden md:flex fixed top-0 w-full h-14 bg-white/70 glass-nav z-50 border-b border-black/5">
      <div className="flex justify-between items-center w-full max-w-[1200px] mx-auto px-20">
        <a href="/" className="text-xl font-bold tracking-tight text-[#1D1D1F] hover:text-[#0071E3] transition-colors select-none">
          PulseBLR
        </a>
        <div className="flex items-center gap-8">
          {NAV_LINKS.map(link => {
            const isActive = link.href === '/'
              ? pathname === '/'
              : pathname.startsWith(link.href);
            return (
              <a
                key={link.href}
                href={link.href}
                className={`text-label-md font-medium transition-all duration-200 active:scale-95 ${
                  isActive
                    ? 'text-[#0071E3] font-semibold border-b-2 border-[#0071E3] pb-0.5'
                    : 'text-[#86868B] hover:text-[#1D1D1F]'
                }`}
              >
                {link.label}
              </a>
            );
          })}
        </div>
        <div className="flex items-center gap-3">
          {session?.user?.image ? (
            <a href="/dashboard" className="flex items-center gap-2 hover:opacity-80 transition-opacity">
              <img
                src={session.user.image}
                alt={session.user.name || 'User'}
                className="w-8 h-8 rounded-full object-cover border-2 border-[#e5e5e5]"
              />
            </a>
          ) : (
            <a href="/login" className="text-[#86868B] hover:text-[#0071E3] transition-colors">
              <span className="material-symbols-outlined text-[24px]">account_circle</span>
            </a>
          )}
        </div>
      </div>
    </nav>
  );
}

export function MobileHeader({ title }: { title?: string }) {
  return (
    <header className="md:hidden fixed top-0 w-full h-14 bg-white/70 glass-nav z-50 border-b border-black/5 flex items-center justify-between px-5">
      <a href="/" className="text-lg font-bold tracking-tight text-[#1D1D1F]">PulseBLR</a>
      {title && <span className="text-[#86868B] text-label-md font-semibold">{title}</span>}
    </header>
  );
}

export function MobileBottomNav() {
  const pathname = usePathname();

  return (
    <nav className="fixed bottom-0 w-full md:hidden bg-white/80 glass-nav border-t border-black/5 flex justify-around items-center px-2 py-2 z-50 rounded-t-2xl">
      {NAV_LINKS.map(link => {
        const isActive = link.href === '/'
          ? pathname === '/'
          : pathname.startsWith(link.href);
        return (
          <a
            key={link.href}
            href={link.href}
            className={`flex flex-col items-center justify-center px-3 py-1 rounded-full transition-all duration-150 active:scale-90 ${
              isActive ? 'bg-[#0071E3]/10' : 'hover:bg-[#f3f3f5]'
            }`}
          >
            <span
              className={`material-symbols-outlined text-[22px] ${isActive ? 'text-[#0071E3]' : 'text-[#86868B]'}`}
              style={{ fontVariationSettings: isActive ? "'FILL' 1" : "'FILL' 0" }}
            >
              {link.icon}
            </span>
            <span className={`text-[10px] font-semibold mt-0.5 ${isActive ? 'text-[#0071E3]' : 'text-[#86868B]'}`}>
              {link.label}
            </span>
          </a>
        );
      })}
    </nav>
  );
}
