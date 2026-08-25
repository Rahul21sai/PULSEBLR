'use client';
import Link from 'next/link';

import { useEffect, useState } from 'react';
import {
  format,
  startOfMonth,
  endOfMonth,
  eachDayOfInterval,
  isSameDay,
  isToday,
  getDay,
  addMonths,
  subMonths,
} from 'date-fns';
import { DesktopNav, MobileBottomNav } from '../components/NavBar';

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
  /**
   * The grid needs COUNTS; only the selected day needs event documents.
   *
   * Fetching a page of events and grouping it client-side is what broke this page: the
   * API caps `limit` at 100 and sorts soonest-first, so for a 713-event month it
   * returned 100 rows that all fell on four consecutive days and the grid drew four
   * dots across 31 squares. /api/events/calendar aggregates in Mongo and returns ~31
   * rows however busy the month is.
   */
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [monthTotal, setMonthTotal] = useState(0);
  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [dayLoading, setDayLoading] = useState(false);
  const [currentDate, setCurrentDate] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState<Date | null>(new Date());

  /**
   * Fetch the VISIBLE MONTH, not the default page.
   *
   * This used to call `/api/events` bare. That endpoint caps `limit` at 30 and defaults
   * to it, so the calendar was dotting 30 events out of ~1050: four days in the current
   * month and none at all in any other, which read as "there are no events" rather than
   * as a bug. It now sends the month range and asks for enough rows to cover it.
   */
  const fetchCounts = async (month: Date) => {
    try {
      setLoading(true);
      const key = `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, '0')}`;
      const res = await fetch(`/api/events/calendar?month=${key}`);
      if (!res.ok) throw new Error('Failed');
      const data = await res.json();
      setCounts(data.days || {});
      setMonthTotal(data.total || 0);
    } catch (err) {
      console.error(err);
      setCounts({});
      setMonthTotal(0);
    } finally {
      setLoading(false);
    }
  };

  /** Events for one day. `includePast` because a calendar shows days already gone. */
  const fetchDay = async (day: Date) => {
    try {
      setDayLoading(true);
      const from = new Date(day);
      from.setHours(0, 0, 0, 0);
      const to = new Date(day);
      to.setHours(23, 59, 59, 999);
      const params = new URLSearchParams({
        from: from.toISOString(),
        to: to.toISOString(),
        limit: '100',
        includePast: 'true',
        sort: 'soonest',
      });
      const res = await fetch(`/api/events?${params}`);
      if (!res.ok) throw new Error('Failed');
      const data = await res.json();
      setEvents(data.events || []);
    } catch (err) {
      console.error(err);
      setEvents([]);
    } finally {
      setDayLoading(false);
    }
  };

  // Deferred by a tick: calling fetchEvents synchronously here both reads it
  // before its declaration below and sets state synchronously inside an effect.
  // Re-fetches whenever the visible month changes, which is the whole point: the
  // previous version fetched once on mount, so paging to another month showed nothing.
  useEffect(() => {
    const timer = setTimeout(() => { void fetchCounts(currentDate); }, 0);
    return () => clearTimeout(timer);
  }, [currentDate]);

  useEffect(() => {
    if (!selectedDate) return;
    const timer = setTimeout(() => { void fetchDay(selectedDate); }, 0);
    return () => clearTimeout(timer);
  }, [selectedDate]);


  const monthStart = startOfMonth(currentDate);
  const monthEnd = endOfMonth(currentDate);
  const daysInMonth = eachDayOfInterval({ start: monthStart, end: monthEnd });
  const startPadding = getDay(monthStart);

  /** IST day key, matching the buckets /api/events/calendar returns. */
  const dayKey = (day: Date) =>
    `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
  const countFor = (day: Date) => counts[dayKey(day)] ?? 0;

  // `events` now holds exactly the selected day, fetched server-side.
  const selectedDateEvents = events;

  return (
    <div className="min-h-screen ambient-above">
      <DesktopNav />

      {/* Mobile Header */}
      <header className="md:hidden fixed top-0 w-full h-14 bg-white/96 glass-nav z-50 border-b border-black/5 flex items-center justify-between px-5">
        <Link href="/" className="text-lg font-bold tracking-tight text-[#1D1D1F]">PulseBLR</Link>
        <span className="text-[#86868B] text-label-md font-semibold">Calendar</span>
      </header>

      <main className="pt-14 pb-24 md:pb-8">

        {/* Month header, in the same voice as every other page. This was a
            full-bleed `bg-black text-white` band — the one surface in the app that
            looked like it came from a different product. */}
        <div className="max-w-[1200px] mx-auto px-4 md:px-8 pt-6">
          <div className="flex flex-wrap items-end justify-between gap-4 mb-6">
            <div>
              <p className="t-label text-[#8E8E93] mb-1">{format(currentDate, 'yyyy')}</p>
              <h1 className="t-display text-[#1D1D1F]">{format(currentDate, 'MMMM')}</h1>
              <p className="mt-1.5 text-[13px] text-[#6E6E73] tracking-[0]">
                {loading ? (
                  'Counting…'
                ) : monthTotal === 0 ? (
                  'No events this month'
                ) : (
                  <>
                    <span className="tnum font-semibold text-[#1D1D1F]">{monthTotal}</span> events
                    across{' '}
                    <span className="tnum font-semibold text-[#1D1D1F]">
                      {Object.keys(counts).length}
                    </span>{' '}
                    days
                  </>
                )}
              </p>
            </div>

            <div className="flex items-center gap-1.5">
              <button
                type="button"
                aria-label="Previous month"
                onClick={() => setCurrentDate(subMonths(currentDate, 1))}
                className="pressable grid h-10 w-10 place-items-center rounded-full bg-white text-[#1D1D1F] shadow-[inset_0_0_0_1px_var(--hairline)] hover:bg-[#F7F7F9]"
              >
                <span aria-hidden="true" className="material-symbols-outlined text-[20px]">chevron_left</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  const today = new Date();
                  setCurrentDate(today);
                  setSelectedDate(today);
                }}
                className="pressable h-10 rounded-full bg-white px-4 text-[12.5px] font-semibold text-[#1D1D1F] shadow-[inset_0_0_0_1px_var(--hairline)] hover:bg-[#F7F7F9]"
              >
                Today
              </button>
              <button
                type="button"
                aria-label="Next month"
                onClick={() => setCurrentDate(addMonths(currentDate, 1))}
                className="pressable grid h-10 w-10 place-items-center rounded-full bg-white text-[#1D1D1F] shadow-[inset_0_0_0_1px_var(--hairline)] hover:bg-[#F7F7F9]"
              >
                <span aria-hidden="true" className="material-symbols-outlined text-[20px]">chevron_right</span>
              </button>
            </div>
          </div>

          <div className="flex flex-col lg:flex-row gap-6">
            <div className="flex-1 min-w-0 rounded-[18px] bg-white card-shadow p-4 md:p-5">
              {/* Weekday labels */}
              <div className="grid grid-cols-7 mb-2">
                {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
                  <div key={i} className="t-label text-center text-[#8E8E93]">
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
                  const n = countFor(day);
                  const isSelected = selectedDate && isSameDay(day, selectedDate);
                  const isCurrentDay = isToday(day);
                  // Dots encode VOLUME, not category. Category-coloured dots implied a
                  // taxonomy the eye cannot decode at 6px, and spent the palette on
                  // decoration; density is the thing a month view can actually show.
                  const dots = n === 0 ? 0 : n <= 2 ? 1 : n <= 6 ? 2 : 3;

                  return (
                    <button
                      key={day.toISOString()}
                      type="button"
                      aria-label={`${format(day, 'd MMMM')} — ${n} event${n === 1 ? '' : 's'}`}
                      aria-pressed={!!isSelected}
                      onClick={() => setSelectedDate(day)}
                      className="pressable relative flex flex-col items-center py-1.5"
                    >
                      <span
                        className={`tnum flex h-9 w-9 items-center justify-center rounded-full text-[14.5px] font-semibold transition-colors ${
                          isSelected
                            ? 'bg-[#1D1D1F] text-white'
                            : isCurrentDay
                              ? 'bg-[#EBF4FE] text-[#0071E3]'
                              : n > 0
                                ? 'text-[#1D1D1F] hover:bg-[#F7F7F9]'
                                : 'text-[#c7c7cc] hover:bg-[#F7F7F9]'
                        }`}
                      >
                        {format(day, 'd')}
                      </span>
                      <span className="mt-1 flex h-1.5 items-center justify-center gap-[3px]">
                        {Array.from({ length: dots }).map((_, i) => (
                          <span
                            key={i}
                            className={`h-1.5 w-1.5 rounded-full ${
                              isSelected ? 'bg-white/70' : 'bg-[#0071E3]'
                            }`}
                          />
                        ))}
                      </span>
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
                <p className="t-label text-[#8E8E93] mb-5">
                  {selectedDateEvents.length} event{selectedDateEvents.length !== 1 ? 's' : ''}
                </p>
              )}

              {!selectedDate ? (
                <p className="text-[13.5px] text-[#8E8E93]">Pick a date to see what is on.</p>
              ) : dayLoading ? (
                // Without this the previous day's events stay on screen while the new
                // day loads, which reads as the wrong answer rather than as loading.
                <div className="flex flex-col gap-2">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <div key={i} className="skeleton h-14 rounded-xl bg-[#EEEEF0]" />
                  ))}
                </div>
              ) : selectedDateEvents.length === 0 ? (
                <div className="py-10 text-center">
                  <span aria-hidden="true" className="material-symbols-outlined mb-2 block text-[36px] text-[#d9d9de]">
                    event_busy
                  </span>
                  <p className="text-[13.5px] text-[#8E8E93]">Nothing scheduled this day.</p>
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  {selectedDateEvents.map(event => (
                    <Link
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
                              <span aria-hidden="true" className="material-symbols-outlined text-[12px]">location_on</span>
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
                    </Link>
                  ))}
                </div>
              )}
            </div>

          </div>
        </div>
      </main>

      <MobileBottomNav />
    </div>
  );
}
