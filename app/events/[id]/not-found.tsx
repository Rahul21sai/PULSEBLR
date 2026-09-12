import Link from 'next/link';
import { DesktopNav, MobileBottomNav } from '../../components/NavBar';

/**
 * What `notFound()` renders for an event that is missing, deleted, or somebody else's private one.
 *
 * IT EXISTS TO PRESERVE BEHAVIOUR, not to add a feature. The page used to be a client component
 * holding its own `notFound` state, which drew this panel inside the app chrome. Converting the page
 * to a Server Component moved that decision to `notFound()`, and with no boundary in this segment
 * Next would fall back to its bare built-in 404 — no nav, no brand, no way back to the feed.
 *
 * THE WORDING IS IDENTICAL FOR ALL THREE CAUSES, and that is a security property rather than
 * laziness: a distinct "you are not allowed to see this" would confirm the row exists, and an
 * ObjectId embeds a timestamp and a counter, so one known id makes its neighbours enumerable.
 */
export default function EventNotFound() {
  return (
    <div className="min-h-screen bg-[var(--paper)]">
      <DesktopNav />
      <header className="md:hidden fixed top-0 w-full h-14 bg-[var(--surface)]/96 glass-nav z-50 border-b border-black/5 flex items-center px-5">
        <Link href="/" className="text-lg font-bold tracking-tight text-[var(--ink)]">
          PulseBLR
        </Link>
      </header>
      <main className="pt-14 pb-24 md:pb-10">
        <div className="max-w-[600px] mx-auto px-4 pt-20">
          <span aria-hidden="true" className="material-symbols-outlined text-[48px] text-[var(--ink-3)] block mb-3">
            search_off
          </span>
          <h1 className="text-[22px] font-bold text-[var(--ink)]">We couldn’t find that event</h1>
          <p className="text-[14px] text-[var(--ink-2)] mt-2">
            It may have been removed by the organiser, or the link is out of date.
          </p>
          <Link
            href="/"
            className="pressable r-touch inline-flex items-center min-h-[44px] mt-[var(--s-6)] px-6 bg-[var(--accent)] text-[var(--accent-ink)] text-[15px] font-semibold transition-colors"
          >
            Browse all events
          </Link>
        </div>
      </main>
      <MobileBottomNav />
    </div>
  );
}
