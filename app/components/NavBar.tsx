'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useSession } from 'next-auth/react';
import Logo from './Logo';

/**
 * The full navigation, as shown on desktop where there is room for all of it.
 *
 * `mobile: false` keeps an entry OUT of the phone's bottom bar. The bar gives every entry
 * `flex-1`, so at 390px six entries are already ~65px each and "Companies" sits close to
 * truncating; a seventh would drop every slot to ~56px. Since "People" is the surface you
 * reach for while standing at an event, and adding an event by hand is a desk task, `Add`
 * yields its slot rather than shrinking everything.
 */
const NAV_LINKS = [
  { href: '/', label: 'Events', icon: 'explore', mobile: true },
  { href: '/companies', label: 'Companies', icon: 'domain', mobile: true },
  { href: '/calendar', label: 'Calendar', icon: 'calendar_today', mobile: true },
  { href: '/tracker', label: 'Tracker', icon: 'bookmarks', mobile: true },
  { href: '/folders', label: 'People', icon: 'groups', mobile: true },
  { href: '/add-event', label: 'Add', icon: 'add_circle', mobile: false },
  { href: '/settings', label: 'Settings', icon: 'settings', mobile: true },
];

/** Six entries at most, which is what the bar can hold legibly. */
const MOBILE_NAV_LINKS = NAV_LINKS.filter(link => link.mobile);

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
        {/* The mark inherits this link's colour, so it goes ink -> blue on hover with the
            wordmark rather than carrying a brand colour of its own. See app/components/Logo.tsx. */}
        <Link
          href="/"
          className="flex items-center gap-2 text-xl font-bold tracking-[-0.02em] text-[#1D1D1F] hover:text-[#0071E3] transition-colors select-none"
        >
          <Logo className="w-[22px] h-[22px] shrink-0" />
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

          {/* Admin, for admins only. `isAdmin` comes from the session and is a COURTESY
              -- it decides whether to draw a link, nothing more. /admin re-checks on the
              server and every admin API route is gated by requireAdmin(), so editing this
              flag in devtools buys a 403, not access. */}
          {session?.user?.isAdmin && (
            <Link
              href="/admin"
              aria-current={isActive('/admin') ? 'page' : undefined}
              className={`flex items-center gap-1 text-[13.5px] font-semibold transition-colors ${
                isActive('/admin') ? 'text-[#0071E3]' : 'text-[#1D1D1F] hover:text-[#0071E3]'
              }`}
            >
              <span aria-hidden="true" className="material-symbols-outlined text-[16px]">shield_person</span>
              Admin
            </Link>
          )}
        </div>

        <div className="flex items-center gap-3">
          {/**
           * Branch on whether there IS a user, not on whether they have an avatar.
           *
           * Branching on `image` showed a "Sign in" link to anybody signed in without a picture —
           * every dev-login session, and any Google account with no photo — while the Admin link
           * sat right next to it. A monogram fallback covers the missing image.
           */}
          {session?.user ? (
            <Link href="/dashboard" className="flex items-center hover:opacity-80 transition-opacity">
              {session.user.image ? (
                // eslint-disable-next-line @next/next/no-img-element -- Google avatar CDN
                <img
                  src={session.user.image}
                  alt={session.user.name || 'Your account'}
                  className="w-8 h-8 rounded-full object-cover border border-[#e5e5ea]"
                />
              ) : (
                <span
                  aria-label={session.user.name || 'Your account'}
                  className="grid h-8 w-8 place-items-center rounded-full border border-[#e5e5ea] bg-[#F5F5F7] text-[12px] font-bold text-[#6E6E73]"
                >
                  {(session.user.name || session.user.email || '?').trim().charAt(0).toUpperCase()}
                </span>
              )}
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
      <Link
        href="/"
        className="flex items-center gap-1.5 text-lg font-bold tracking-tight text-[#1D1D1F]"
      >
        <Logo className="w-[19px] h-[19px] shrink-0" />
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
      {MOBILE_NAV_LINKS.map(link => {
        const active = isActive(link.href);
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? 'page' : undefined}
            className={`flex min-w-0 flex-1 flex-col items-center justify-center px-1 py-1 rounded-xl transition-colors active:scale-95 ${
              active ? 'bg-[#0071E3]/10' : 'hover:bg-[#f3f3f5]'
            }`}
          >
            <span aria-hidden="true"
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
