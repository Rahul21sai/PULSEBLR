'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { format, isToday, isThisWeek, isWeekend, isFuture, startOfDay } from 'date-fns';

interface Event {
  _id: string;
  title: string;
  description: string;
  source: string;
  sourceUrl: string;
  organizer?: string;
  category: string[];
  format: 'online' | 'offline' | 'hybrid';
  hasFood: 'yes' | 'no' | 'unknown';
  isFree: boolean;
  price?: number;
  venue?: string;
  area?: string;
  onlineLink?: string;
  startDateTime: string;
  endDateTime?: string;
  applyLink?: string;
  registrationDeadline?: string;
  createdAt: string;
}

const NAV_LINKS = [
  { href: '/', label: 'Feed', icon: 'rss_feed' },
  { href: '/calendar', label: 'Calendar', icon: 'calendar_today' },
  { href: '/tracker', label: 'Tracker', icon: 'analytics' },
  { href: '/add-event', label: 'Add', icon: 'add_circle' },
  { href: '/settings', label: 'Settings', icon: 'settings' },
];

const CATEGORY_FILTERS = [
  'AI/ML', 'Fintech', 'Cybersecurity', 'Cloud/DevOps',
  'Web/Mobile', 'Data/Analytics', 'Hackathon', 'Networking/Meetup',
];
const TIME_FILTERS = ['Today', 'This Week', 'This Weekend', 'All Upcoming'];

function getCategoryGradientClass(category: string): string {
  const map: Record<string, string> = {
    'AI/ML': 'gradient-ai',
    'Fintech': 'gradient-fintech',
    'Networking/Meetup': 'gradient-networking',
    'Cybersecurity': 'gradient-cyber',
    'Cloud/DevOps': 'gradient-cloud',
    'Data/Analytics': 'gradient-data',
    'Hackathon': 'gradient-hackathon',
  };
  return map[category] || 'gradient-default';
}

function getCategoryBadgeStyle(category: string): string {
  const map: Record<string, string> = {
    'AI/ML': 'bg-blue-50 text-blue-700',
    'Fintech': 'bg-green-50 text-green-700',
    'Networking/Meetup': 'bg-orange-50 text-orange-700',
    'Cybersecurity': 'bg-red-50 text-red-700',
    'Cloud/DevOps': 'bg-sky-50 text-sky-700',
    'Data/Analytics': 'bg-purple-50 text-purple-700',
    'Hackathon': 'bg-pink-50 text-pink-700',
    'Web/Mobile': 'bg-yellow-50 text-yellow-700',
  };
  return map[category] || 'bg-gray-100 text-gray-600';
}

export default function Home() {
  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeCategories, setActiveCategories] = useState<string[]>([]);
  const [selectedFormat, setSelectedFormat] = useState('');
  const [selectedFood, setSelectedFood] = useState('');
  const [freeOnly, setFreeOnly] = useState(false);
  const [showFilterPanel, setShowFilterPanel] = useState(false);
  const [activeTime, setActiveTime] = useState('All Upcoming');

  const fetchEvents = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const params = new URLSearchParams();
      if (activeCategories.length > 0) params.append('category', activeCategories.join(','));
      if (selectedFormat) params.append('format', selectedFormat);
      if (selectedFood) params.append('hasFood', selectedFood);
      if (freeOnly) params.append('isFree', 'true');
      const res = await fetch(`/api/events?${params.toString()}`);
      if (!res.ok) throw new Error('Failed to fetch events');
      const data = await res.json();
      setEvents(data.events || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, [activeCategories, selectedFormat, selectedFood, freeOnly]);

  useEffect(() => { fetchEvents(); }, [fetchEvents]);

  const toggleCategory = (cat: string) => {
    setActiveCategories(prev =>
      prev.includes(cat) ? prev.filter(c => c !== cat) : [...prev, cat]
    );
  };

  const trackEvent = async (eventId: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      const res = await fetch('/api/tracker', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId, status: 'Interested' }),
      });
      if (res.ok) {
        // Subtle feedback — no alert
        const btn = e.currentTarget as HTMLElement;
        btn.style.color = '#0071E3';
        setTimeout(() => { btn.style.color = ''; }, 1200);
      }
    } catch { /* silent fail */ }
  };

  const activeFilterCount =
    activeCategories.length +
    (selectedFormat ? 1 : 0) +
    (selectedFood ? 1 : 0) +
    (freeOnly ? 1 : 0);

  const filteredByTime = useMemo(() => {
    if (activeTime === 'All Upcoming') return events;
    return events.filter(event => {
      const d = new Date(event.startDateTime);
      if (activeTime === 'Today') return isToday(d);
      if (activeTime === 'This Week') return isThisWeek(d, { weekStartsOn: 1 }) && isFuture(startOfDay(d));
      if (activeTime === 'This Weekend') return isWeekend(d) && isThisWeek(d, { weekStartsOn: 1 }) && isFuture(startOfDay(d));
      return true;
    });
  }, [events, activeTime]);

  return (
    <div className="min-h-screen bg-[#F5F5F7]">

      {/* ── Desktop Top Nav ── */}
      <nav className="hidden md:flex fixed top-0 w-full h-14 bg-white/70 glass-nav z-50 border-b border-black/5">
        <div className="flex justify-between items-center w-full max-w-[1200px] mx-auto px-20">
          <a href="/" className="text-xl font-bold tracking-tight text-[#1D1D1F] hover:text-[#0071E3] transition-colors">
            PulseBLR
          </a>
          <div className="flex items-center gap-8">
            {NAV_LINKS.map(link => (
              <a
                key={link.href}
                href={link.href}
                className={`text-sm font-medium transition-colors ${
                  link.href === '/'
                    ? 'text-[#0071E3] font-semibold border-b-2 border-[#0071E3] pb-0.5'
                    : 'text-[#86868B] hover:text-[#1D1D1F]'
                }`}
              >
                {link.label}
              </a>
            ))}
          </div>
          <a href="/dashboard" className="text-[#86868B] hover:text-[#0071E3] transition-colors">
            <span className="material-symbols-outlined text-[24px]">account_circle</span>
          </a>
        </div>
      </nav>

      {/* ── Mobile Top Bar ── */}
      <header className="md:hidden fixed top-0 w-full h-14 bg-white/70 glass-nav z-50 border-b border-black/5 flex items-center justify-between px-5">
        <span className="text-lg font-bold tracking-tight text-[#1D1D1F]">PulseBLR</span>
        <a href="/dashboard" className="text-[#86868B] hover:text-[#0071E3] transition-colors">
          <span className="material-symbols-outlined text-[24px]">account_circle</span>
        </a>
      </header>

      <main className="pt-14 pb-24 md:pb-0">

        {/* ── Hero ── */}
        <section className="bg-black text-white pt-16 md:pt-20 pb-14 px-5 md:px-20 relative overflow-hidden">
          <div
            className="absolute inset-0 pointer-events-none opacity-20"
            style={{ background: 'radial-gradient(ellipse at center, #374151 0%, #000 70%)' }}
          />
          <div className="max-w-[1200px] mx-auto relative z-10 text-center">
            <h1 className="text-display-lg-mobile md:text-display-lg mb-3">
              Today in Bangalore Tech
            </h1>
            <p className="text-body-lg text-gray-400 max-w-xl mx-auto">
              Your curated pipeline for AI, Fintech, and Networking.
            </p>
          </div>
        </section>

        {/* ── Filter chips — overlapping hero ── */}
        <div className="max-w-[1200px] mx-auto px-5 md:px-20 -mt-6 relative z-20">
          <div className="flex gap-3 overflow-x-auto no-scrollbar pb-3">
            {/* Category filter */}
            <button
              onClick={() => setShowFilterPanel(!showFilterPanel)}
              className="shrink-0 bg-white text-[#1D1D1F] px-5 py-2 rounded-full text-label-sm shadow-md border border-black/10 flex items-center gap-1.5 hover:bg-gray-50 transition-colors active:scale-95"
            >
              Category
              {activeFilterCount > 0 && (
                <span className="bg-[#0071E3] text-white text-[10px] font-bold rounded-full w-4 h-4 flex items-center justify-center leading-none">
                  {activeFilterCount}
                </span>
              )}
              <span className="material-symbols-outlined text-[16px]">expand_more</span>
            </button>

            {/* Format chips */}
            {(['offline', 'online', 'hybrid'] as const).map(fmt => (
              <button
                key={fmt}
                onClick={() => setSelectedFormat(prev => prev === fmt ? '' : fmt)}
                className={`shrink-0 px-5 py-2 rounded-full text-label-sm shadow-md border transition-colors capitalize active:scale-95 ${
                  selectedFormat === fmt
                    ? 'bg-[#0071E3] text-white border-[#0071E3]'
                    : 'bg-black text-white border-black/20 hover:bg-gray-900'
                }`}
              >
                {fmt}
              </button>
            ))}

            <button
              onClick={() => setSelectedFood(prev => prev === 'yes' ? '' : 'yes')}
              className={`shrink-0 px-5 py-2 rounded-full text-label-sm shadow-md border transition-colors active:scale-95 ${
                selectedFood === 'yes'
                  ? 'bg-[#0071E3] text-white border-[#0071E3]'
                  : 'bg-black text-white border-black/20 hover:bg-gray-900'
              }`}
            >
              Food
            </button>

            <button
              onClick={() => setFreeOnly(prev => !prev)}
              className={`shrink-0 px-5 py-2 rounded-full text-label-sm shadow-md border transition-colors active:scale-95 ${
                freeOnly
                  ? 'bg-[#0071E3] text-white border-[#0071E3]'
                  : 'bg-black text-white border-black/20 hover:bg-gray-900'
              }`}
            >
              Free
            </button>

            {/* Area placeholder */}
            <button className="shrink-0 bg-black text-white px-5 py-2 rounded-full text-label-sm shadow-md border border-black/20 hover:bg-gray-900 transition-colors active:scale-95">
              Area
            </button>
          </div>

          {/* Expanded category panel */}
          {showFilterPanel && (
            <div className="bg-white rounded-2xl shadow-lg p-5 mb-3 border border-black/5">
              <div className="flex flex-wrap gap-2">
                {CATEGORY_FILTERS.map(cat => (
                  <button
                    key={cat}
                    onClick={() => toggleCategory(cat)}
                    className={`px-4 py-1.5 rounded-full text-label-sm transition-colors ${
                      activeCategories.includes(cat)
                        ? 'bg-[#0071E3] text-white'
                        : 'bg-[#f3f3f5] text-[#1D1D1F] hover:bg-[#e8e8ea]'
                    }`}
                  >
                    {cat}
                  </button>
                ))}
                {activeCategories.length > 0 && (
                  <button
                    onClick={() => setActiveCategories([])}
                    className="px-4 py-1.5 rounded-full text-label-sm text-red-600 bg-red-50 hover:bg-red-100 transition-colors"
                  >
                    Clear all
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        {/* ── Time sub-nav ── */}
        <div className="sticky top-14 bg-[#F5F5F7]/90 glass-nav z-40 border-b border-black/5 mb-8">
          <div className="max-w-[1200px] mx-auto px-5 md:px-20">
            <div className="flex gap-8 overflow-x-auto no-scrollbar py-4 text-label-md">
              {TIME_FILTERS.map(tf => (
                <button
                  key={tf}
                  onClick={() => setActiveTime(tf)}
                  className={`shrink-0 pb-0.5 transition-colors ${
                    activeTime === tf
                      ? 'text-[#1D1D1F] font-semibold border-b-2 border-[#1D1D1F]'
                      : 'text-[#86868B] hover:text-[#1D1D1F]'
                  }`}
                >
                  {tf}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* ── Event grid ── */}
        <div className="max-w-[1200px] mx-auto px-5 md:px-20 pb-12">
          {loading ? (
            <div className="flex justify-center items-center py-24">
              <div className="spinner" />
            </div>
          ) : error ? (
            <div className="text-center py-24 px-5">
              <span className="material-symbols-outlined text-[48px] text-[#e5e5e5] block mb-3">wifi_off</span>
              <p className="text-[#86868B] text-body-md mb-4">{error}</p>
              <button
                onClick={fetchEvents}
                className="px-6 py-2 bg-[#0071E3] text-white rounded-full text-label-md hover:bg-blue-600 transition-colors"
              >
                Retry
              </button>
            </div>
          ) : events.length === 0 ? (
            <div className="text-center py-24 px-5">
              <span className="material-symbols-outlined text-[56px] text-[#e5e5e5] block mb-3">rss_feed</span>
              <p className="text-[#1D1D1F] font-semibold text-body-lg">No events yet</p>
              <p className="text-[#86868B] text-body-md mt-2">Events appear here once scrapers have run.</p>
              <a
                href="/add-event"
                className="inline-block mt-6 px-6 py-3 bg-black text-white rounded-full text-label-md hover:bg-gray-800 transition-colors"
              >
                + Add Event Manually
              </a>
            </div>
          ) : (
            <>
              {filteredByTime.length === 0 && (
                <div className="col-span-full text-center py-20">
                  <span className="material-symbols-outlined text-[48px] text-[#e5e5e5] block mb-3">calendar_today</span>
                  <p className="text-[#86868B] text-body-md">
                    No events for <span className="font-semibold text-[#1D1D1F]">{activeTime}</span>
                  </p>
                  <button
                    onClick={() => setActiveTime('All Upcoming')}
                    className="mt-4 text-label-md text-[#0071E3] font-semibold hover:underline"
                  >
                    Show all upcoming →
                  </button>
                </div>
              )}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {filteredByTime.map(event => {
                  const primaryCat = event.category[0] || 'default';
                  const gradClass = getCategoryGradientClass(primaryCat);
                  const isNew = (Date.now() - new Date(event.createdAt).getTime()) < 48 * 3600 * 1000;

                  return (
                    <article
                      key={event._id}
                      className="bg-white rounded-[20px] card-shadow overflow-hidden hover-lift flex flex-col group"
                    >
                      {/* Gradient accent bar */}
                      <div className={`h-2 w-full ${gradClass}`} />

                      <div className="p-8 flex-1 flex flex-col">
                        {/* Category + New badge */}
                        <div className="flex items-start justify-between mb-4">
                          <span className={`px-3 py-1 rounded-full text-label-sm uppercase tracking-wider ${getCategoryBadgeStyle(primaryCat)}`}>
                            {primaryCat}
                          </span>
                          {isNew && (
                            <span className="bg-[#0071E3] text-white text-[11px] font-bold px-2 py-0.5 rounded flex items-center gap-1 shrink-0">
                              <span className="material-symbols-outlined text-[11px]" style={{ fontVariationSettings: "'FILL' 1" }}>auto_awesome</span>
                              New
                            </span>
                          )}
                        </div>

                        {/* Title */}
                        <a href={`/events/${event._id}`}>
                          <h2 className="text-headline-md mb-3 line-clamp-2 group-hover:text-[#0071E3] transition-colors">
                            {event.title}
                          </h2>
                        </a>

                        {/* Date + Location */}
                        <div className="text-label-md text-[#86868B] flex flex-col gap-1.5 mb-4">
                          <span className="flex items-center gap-1.5">
                            <span className="material-symbols-outlined text-[15px]">calendar_month</span>
                            {format(new Date(event.startDateTime), 'MMM d • h:mm a')}
                          </span>
                          <span className="flex items-center gap-1.5">
                            <span className="material-symbols-outlined text-[15px]">location_on</span>
                            {event.format === 'online'
                              ? 'Online'
                              : event.venue
                              ? `${event.venue}${event.area ? `, ${event.area}` : ''}`
                              : event.area || 'Bangalore'}
                          </span>
                        </div>

                        {/* Tags row */}
                        <div className="flex flex-wrap gap-2 mt-auto mb-5 pt-4 border-t border-[#f0f0f0]">
                          <span className="bg-[#f3f3f5] text-[#86868B] text-label-sm px-3 py-1 rounded-full uppercase">
                            {event.format === 'online' ? 'Online' : event.format === 'hybrid' ? 'Hybrid' : 'Offline'}
                          </span>
                          {event.hasFood === 'yes' && (
                            <span className="bg-[#f3f3f5] text-[#86868B] text-label-sm px-3 py-1 rounded-full uppercase">Food</span>
                          )}
                          {event.isFree ? (
                            <span className="bg-green-50 text-green-700 text-label-sm px-3 py-1 rounded-full uppercase">Free</span>
                          ) : (
                            <span className="bg-[#f3f3f5] text-[#86868B] text-label-sm px-3 py-1 rounded-full uppercase">₹{event.price}</span>
                          )}
                        </div>

                        {/* CTA buttons */}
                        <div className="flex gap-2">
                          <a
                            href={event.applyLink || event.sourceUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex-1 bg-black text-white text-label-md py-2.5 rounded-full text-center hover:bg-gray-800 transition-colors active:scale-95"
                          >
                            {event.isFree ? 'RSVP Now' : `Register · ₹${event.price}`}
                          </a>
                          <a
                            href={`/events/${event._id}`}
                            className="w-11 h-11 bg-white border border-[#e5e5e5] rounded-full flex items-center justify-center hover:bg-[#f3f3f5] transition-colors active:scale-95 shrink-0"
                            title="View details"
                          >
                            <span className="material-symbols-outlined text-[16px] text-[#1D1D1F]">open_in_new</span>
                          </a>
                          <button
                            onClick={(e) => trackEvent(event._id, e)}
                            className="w-11 h-11 bg-white border border-[#e5e5e5] rounded-full flex items-center justify-center hover:bg-[#f3f3f5] transition-colors active:scale-95 shrink-0"
                            title="Track this event"
                          >
                            <span className="material-symbols-outlined text-[16px] text-[#1D1D1F]" style={{ fontVariationSettings: "'FILL' 0" }}>bookmark_border</span>
                          </button>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </main>

      {/* ── Mobile Bottom Nav ── */}
      <nav className="fixed bottom-0 w-full md:hidden bg-white/70 glass-nav border-t border-black/5 flex justify-around items-center px-4 py-2 z-50 rounded-t-2xl">
        {NAV_LINKS.map(link => {
          const isActive = link.href === '/';
          return (
            <a
              key={link.href}
              href={link.href}
              className={`flex flex-col items-center justify-center px-3 py-1 rounded-full transition-colors ${
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
    </div>
  );
}
