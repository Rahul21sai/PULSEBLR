'use client';

import { useEffect, useState } from 'react';
import { format, startOfMonth, endOfMonth, eachDayOfInterval, isSameDay, isToday, getDay } from 'date-fns';

interface Event {
  _id: string;
  title: string;
  startDateTime: string;
  category: string[];
  format: string;
  venue?: string;
  area?: string;
  hasFood: string;
  isFree: boolean;
  sourceUrl: string;
}

const NAV_LINKS = [
  { href: '/', label: 'Feed', icon: 'rss_feed' },
  { href: '/calendar', label: 'Calendar', icon: 'calendar_today' },
  { href: '/tracker', label: 'Tracker', icon: 'analytics' },
  { href: '/add-event', label: 'Add', icon: 'add_circle' },
  { href: '/settings', label: 'Settings', icon: 'settings' },
];

const CAT_DOT: Record<string, string> = {
  'AI/ML': 'bg-blue-500',
  'Fintech': 'bg-green-500',
  'Networking/Meetup': 'bg-orange-500',
  'Cybersecurity': 'bg-red-500',
  'Cloud/DevOps': 'bg-sky-500',
  'Data/Analytics': 'bg-purple-500',
  'Hackathon': 'bg-pink-500',
};

const CAT_BAR: Record<string, string> = {
  'AI/ML': 'bg-blue-500',
  'Fintech': 'bg-green-500',
  'Networking/Meetup': 'bg-orange-500',
  'Cybersecurity': 'bg-red-500',
  'Cloud/DevOps': 'bg-sky-500',
  'Data/Analytics': 'bg-purple-500',
  'Hackathon': 'bg-pink-500',
};

export default function CalendarPage() {
  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [currentDate, setCurrentDate] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState<Date | null>(new Date());

  useEffect(() => { fetchEvents(); }, []);

  const fetchEvents = async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/events');
      if (!res.ok) throw new Error('Failed');
      const data = await res.json();
      setEvents(data.events || []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const monthStart = startOfMonth(currentDate);
  const monthEnd = endOfMonth(currentDate);
  const daysInMonth = eachDayOfInterval({ start: monthStart, end: monthEnd });
  const startPadding = getDay(monthStart);

  const getEventsForDay = (day: Date) =>
    events.filter(e => isSameDay(new Date(e.startDateTime), day));

  const selectedDateEvents = selectedDate ? getEventsForDay(selectedDate) : [];

  return (
    <div className="min-h-screen bg-[#F5F5F7]">

      {/* Desktop Nav */}
      <nav className="hidden md:flex fixed top-0 w-full h-14 bg-white/70 glass-nav z-50 border-b border-black/5">
        <div className="flex justify-between items-center w-full max-w-[1200px] mx-auto px-20">
          <a href="/" className="text-xl font-bold tracking-tight text-[#1D1D1F] hover:text-[#0071E3] transition-colors">
            PulseBLR
          </a>
          <div className="flex items-center gap-8">
            {NAV_LINKS.map(link => (
              <a key={link.href} href={link.href}
                className={`text-label-md font-medium transition-colors ${
                  link.href === '/calendar'
                    ? 'text-[#0071E3] font-semibold border-b-2 border-[#0071E3] pb-0.5'
                    : 'text-[#86868B] hover:text-[#1D1D1F]'
                }`}>
                {link.label}
              </a>
            ))}
          </div>
          <a href="/dashboard" className="text-[#86868B] hover:text-[#0071E3] transition-colors">
            <span className="material-symbols-outlined text-[24px]">account_circle</span>
          </a>
        </div>
      </nav>

      {/* Mobile Header */}
      <header className="md:hidden fixed top-0 w-full h-14 bg-white/70 glass-nav z-50 border-b border-black/5 flex items-center justify-between px-5">
        <a href="/" className="text-lg font-bold tracking-tight text-[#1D1D1F]">PulseBLR</a>
        <span className="text-[#86868B] text-label-md font-semibold">Calendar</span>
      </header>

      <main className="pt-14 pb-24 md:pb-8">

        {/* Hero */}
        <section className="bg-black text-white px-5 md:px-20 pt-12 pb-10">
          <div className="max-w-[1200px] mx-auto flex items-end justify-between">
            <div>
              <h1 className="text-display-lg-mobile md:text-display-lg mb-1">
                {format(currentDate, 'MMMM')}
              </h1>
              <p className="text-body-md text-gray-400">{format(currentDate, 'yyyy')}</p>
            </div>
            <div className="flex gap-3 mb-2">
              <button
                onClick={() => setCurrentDate(d => new Date(d.getFullYear(), d.getMonth() - 1))}
                className="w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white transition-colors"
              >
                <span className="material-symbols-outlined text-[20px]">chevron_left</span>
              </button>
              <button
                onClick={() => setCurrentDate(d => new Date(d.getFullYear(), d.getMonth() + 1))}
                className="w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white transition-colors"
              >
                <span className="material-symbols-outlined text-[20px]">chevron_right</span>
              </button>
            </div>
          </div>
        </section>

        <div className="max-w-[1200px] mx-auto px-5 md:px-20 py-6">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

            {/* ── Calendar panel ── */}
            <div className="lg:col-span-2 bg-white rounded-[20px] card-shadow p-6">

              {/* Day headers */}
              <div className="grid grid-cols-7 mb-3">
                {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => (
                  <div key={d} className="text-center text-label-sm text-[#86868B] py-1.5 uppercase tracking-widest">
                    {d}
                  </div>
                ))}
              </div>

              {/* Date grid */}
              <div className="grid grid-cols-7 gap-y-1">
                {Array.from({ length: startPadding }).map((_, i) => (
                  <div key={`pad-${i}`} />
                ))}

                {daysInMonth.map(day => {
                  const dayEvents = getEventsForDay(day);
                  const isSelected = selectedDate && isSameDay(day, selectedDate);
                  const isCurrentDay = isToday(day);

                  return (
                    <button
                      key={day.toISOString()}
                      onClick={() => setSelectedDate(day)}
                      className="relative flex flex-col items-center py-1 transition-colors"
                    >
                      <span className={`w-9 h-9 flex items-center justify-center rounded-full text-body-md font-semibold transition-colors ${
                        isSelected
                          ? 'bg-[#0071E3] text-white shadow-md'
                          : isCurrentDay
                          ? 'bg-[#0071E3]/10 text-[#0071E3] font-bold'
                          : 'hover:bg-[#f3f3f5] text-[#1D1D1F]'
                      }`}>
                        {format(day, 'd')}
                      </span>
                      {dayEvents.length > 0 && (
                        <div className="flex gap-0.5 mt-0.5 justify-center">
                          {dayEvents.slice(0, 3).map((ev, i) => (
                            <span
                              key={i}
                              className={`w-1.5 h-1.5 rounded-full ${
                                isSelected ? 'bg-white/70' : (CAT_DOT[ev.category[0]] || 'bg-gray-400')
                              }`}
                            />
                          ))}
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>

              {loading && (
                <div className="flex justify-center mt-6">
                  <div className="spinner" />
                </div>
              )}
            </div>

            {/* ── Day events panel ── */}
            <div className="bg-white rounded-[20px] card-shadow p-6">
              <h3 className="text-headline-md text-[#1D1D1F] mb-1">
                {selectedDate ? format(selectedDate, 'MMMM d') : 'Select a date'}
              </h3>
              {selectedDate && (
                <p className="text-label-sm text-[#86868B] uppercase tracking-wider mb-5">
                  {selectedDateEvents.length} event{selectedDateEvents.length !== 1 ? 's' : ''}
                </p>
              )}

              {!selectedDate ? (
                <p className="text-[#86868B] text-body-md">Tap a date to see events</p>
              ) : selectedDateEvents.length === 0 ? (
                <div className="text-center py-10">
                  <span className="material-symbols-outlined text-[40px] text-[#e5e5e5] block mb-2">event_busy</span>
                  <p className="text-[#86868B] text-body-md">No events on this day</p>
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  {selectedDateEvents.map(event => (
                    <a
                      key={event._id}
                      href={`/events/${event._id}`}
                      className="flex items-stretch gap-3 group"
                    >
                      {/* Time column */}
                      <div className="flex flex-col items-center w-14 shrink-0 pt-1 pb-1">
                        <span className="text-label-md font-bold text-[#1D1D1F]">
                          {format(new Date(event.startDateTime), 'h:mm')}
                        </span>
                        <span className="text-label-sm text-[#86868B]">
                          {format(new Date(event.startDateTime), 'a')}
                        </span>
                        <div className="flex-1 w-px bg-[#e5e5e5] mt-1" />
                      </div>
                      {/* Card */}
                      <div className="flex-1 relative overflow-hidden rounded-xl border border-[#f0f0f0] group-hover:border-[#0071E3]/30 group-hover:bg-[#f7faff] transition-colors mb-1">
                        <div className={`absolute left-0 top-0 bottom-0 w-1.5 ${CAT_BAR[event.category[0]] || 'bg-gray-400'}`} />
                        <div className="pl-4 pr-3 py-3">
                          <p className="text-label-md font-semibold text-[#1D1D1F] line-clamp-2 leading-snug">
                            {event.title}
                          </p>
                          {(event.area || event.venue) && (
                            <div className="flex items-center gap-1 mt-1 text-label-sm text-[#86868B]">
                              <span className="material-symbols-outlined text-[12px]">location_on</span>
                              {event.area || event.venue}
                            </div>
                          )}
                          <div className="flex gap-1.5 mt-2 flex-wrap">
                            {event.isFree && (
                              <span className="bg-green-50 text-green-700 text-[10px] font-semibold px-2 py-0.5 rounded-full">Free</span>
                            )}
                            {event.hasFood === 'yes' && (
                              <span className="bg-orange-50 text-orange-700 text-[10px] font-semibold px-2 py-0.5 rounded-full">Food</span>
                            )}
                          </div>
                        </div>
                      </div>
                    </a>
                  ))}
                </div>
              )}
            </div>

          </div>
        </div>
      </main>

      {/* Mobile Bottom Nav */}
      <nav className="fixed bottom-0 w-full md:hidden bg-white/70 glass-nav border-t border-black/5 flex justify-around items-center px-4 py-2 z-50 rounded-t-2xl">
        {NAV_LINKS.map(link => {
          const isActive = link.href === '/calendar';
          return (
            <a key={link.href} href={link.href}
              className={`flex flex-col items-center justify-center px-3 py-1 rounded-full transition-colors ${isActive ? 'bg-[#0071E3]/10' : 'hover:bg-[#f3f3f5]'}`}>
              <span className={`material-symbols-outlined text-[22px] ${isActive ? 'text-[#0071E3]' : 'text-[#86868B]'}`}
                style={{ fontVariationSettings: isActive ? "'FILL' 1" : "'FILL' 0" }}>
                {link.icon}
              </span>
              <span className={`text-[10px] font-semibold mt-0.5 ${isActive ? 'text-[#0071E3]' : 'text-[#86868B]'}`}>{link.label}</span>
            </a>
          );
        })}
      </nav>
    </div>
  );
}
