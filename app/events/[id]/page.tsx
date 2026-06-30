'use client';

import { useEffect, useState } from 'react';
import { format } from 'date-fns';
import { useParams } from 'next/navigation';

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

function getCategoryGradient(category: string): string {
  const map: Record<string, string> = {
    'AI/ML': 'from-[#0071E3] to-[#00C6FF]',
    'Fintech': 'from-[#34C759] to-[#30D158]',
    'Networking/Meetup': 'from-[#FF9500] to-[#FFCC00]',
    'Cybersecurity': 'from-[#FF3B30] to-[#FF6B6B]',
    'Cloud/DevOps': 'from-[#5AC8FA] to-[#007AFF]',
    'Data/Analytics': 'from-[#5856D6] to-[#AF52DE]',
    'Hackathon': 'from-[#FF2D55] to-[#FF6CAB]',
  };
  return map[category] || 'from-[#8E8E93] to-[#636366]';
}

function getCategoryBadgeStyle(category: string): string {
  const map: Record<string, string> = {
    'AI/ML': 'bg-blue-100 text-blue-700',
    'Fintech': 'bg-green-100 text-green-700',
    'Networking/Meetup': 'bg-orange-100 text-orange-700',
    'Cybersecurity': 'bg-red-100 text-red-700',
    'Cloud/DevOps': 'bg-sky-100 text-sky-700',
    'Data/Analytics': 'bg-purple-100 text-purple-700',
    'Hackathon': 'bg-pink-100 text-pink-700',
    'Web/Mobile': 'bg-yellow-100 text-yellow-700',
  };
  return map[category] || 'bg-gray-100 text-gray-600';
}

export default function EventDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [event, setEvent] = useState<Event | null>(null);
  const [loading, setLoading] = useState(true);
  const [tracking, setTracking] = useState(false);
  const [tracked, setTracked] = useState(false);

  useEffect(() => {
    if (!id) return;
    const fetchEvent = async () => {
      try {
        setLoading(true);
        const res = await fetch(`/api/events/${id}`);
        if (!res.ok) throw new Error('Not found');
        const data = await res.json();
        setEvent(data.event);
      } catch {
        setEvent(null);
      } finally {
        setLoading(false);
      }
    };
    fetchEvent();
  }, [id]);

  const trackEvent = async () => {
    if (!event || tracked) return;
    setTracking(true);
    try {
      const res = await fetch('/api/tracker', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId: event._id, status: 'Interested' }),
      });
      if (res.ok) {
        setTracked(true);
      } else {
        const data = await res.json();
        alert(data.error || 'Failed to track event');
      }
    } catch {
      alert('Failed to track event');
    } finally {
      setTracking(false);
    }
  };

  const primaryCat = event?.category[0] || 'default';
  const gradientClass = getCategoryGradient(primaryCat);

  return (
    <div className="min-h-screen bg-[#F5F5F7]">

      {/* Back header — consistent on mobile and desktop */}
      <header className="fixed top-0 w-full h-14 bg-white/80 glass-nav z-50 border-b border-black/5 flex items-center px-5 gap-3">
        <a
          href="/"
          className="w-9 h-9 rounded-full bg-[#f3f3f5] flex items-center justify-center hover:bg-[#e8e8ea] transition-colors shrink-0"
        >
          <span className="material-symbols-outlined text-[20px] text-[#1D1D1F]">arrow_back</span>
        </a>
        <span className="text-label-md font-semibold text-[#1D1D1F] truncate flex-1">
          {event ? event.title : 'Event Detail'}
        </span>
        {event && (
          <button
            onClick={trackEvent}
            disabled={tracking || tracked}
            className="w-9 h-9 rounded-full border border-[#e5e5e5] flex items-center justify-center hover:bg-[#f3f3f5] transition-colors shrink-0"
            title={tracked ? 'Already tracking' : 'Add to tracker'}
          >
            <span
              className={`material-symbols-outlined text-[20px] ${tracked ? 'text-[#0071E3]' : 'text-[#86868B]'}`}
              style={{ fontVariationSettings: tracked ? "'FILL' 1" : "'FILL' 0" }}
            >
              bookmark
            </span>
          </button>
        )}
      </header>

      <main className="pt-14 pb-32">
        {loading ? (
          <div className="flex justify-center items-center py-32">
            <div className="spinner" />
          </div>
        ) : !event ? (
          <div className="text-center py-32 px-5">
            <span className="material-symbols-outlined text-[56px] text-[#e5e5e5] block mb-3">event_busy</span>
            <p className="text-[#1D1D1F] font-semibold text-body-lg">Event not found</p>
            <p className="text-[#86868B] text-body-md mt-1 mb-6">This event may have been removed.</p>
            <a href="/" className="inline-block bg-black text-white text-label-md font-semibold px-6 py-3 rounded-full hover:bg-gray-800 transition-colors">
              Back to Feed
            </a>
          </div>
        ) : (
          <>
            {/* Hero gradient section */}
            <section className={`bg-gradient-to-br ${gradientClass} px-5 md:px-20 pt-10 pb-14 relative overflow-hidden`}>
              <div className="absolute inset-0 pointer-events-none opacity-25"
                style={{ background: 'radial-gradient(ellipse at 70% 50%, rgba(255,255,255,0.15) 0%, transparent 70%)' }}
              />
              <div className="max-w-[760px] mx-auto relative z-10">
                {/* Category badges */}
                <div className="flex flex-wrap gap-2 mb-5">
                  {event.category.slice(0, 3).map(cat => (
                    <span key={cat} className="bg-white/20 text-white text-label-sm uppercase px-3 py-1 rounded-full backdrop-blur-sm">
                      {cat}
                    </span>
                  ))}
                  {(Date.now() - new Date(event.createdAt).getTime()) < 48 * 3600 * 1000 && (
                    <span className="bg-white text-[#1D1D1F] text-label-sm uppercase px-3 py-1 rounded-full flex items-center gap-1">
                      <span className="material-symbols-outlined text-[11px]" style={{ fontVariationSettings: "'FILL' 1" }}>auto_awesome</span>
                      New
                    </span>
                  )}
                </div>

                {/* Title */}
                <h1 className="text-display-lg-mobile md:text-display-lg text-white leading-tight tracking-tight mb-3">
                  {event.title}
                </h1>
                {event.organizer && (
                  <p className="text-white/80 text-body-md">by {event.organizer}</p>
                )}
              </div>
            </section>

            <div className="max-w-[760px] mx-auto px-5 md:px-0 py-5 space-y-4">

              {/* Meta info card */}
              <div className="bg-white rounded-[20px] card-shadow p-6">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                  {/* Date & Time */}
                  <div className="flex items-start gap-3">
                    <span className="material-symbols-outlined text-[#0071E3] text-[22px] mt-0.5 shrink-0" style={{ fontVariationSettings: "'FILL' 1" }}>calendar_today</span>
                    <div>
                      <p className="text-label-sm text-[#86868B] uppercase tracking-widest mb-1">Date & Time</p>
                      <p className="text-label-md font-semibold text-[#1D1D1F]">
                        {format(new Date(event.startDateTime), 'EEEE, MMM d, yyyy')}
                      </p>
                      <p className="text-label-md text-[#86868B]">
                        {format(new Date(event.startDateTime), 'h:mm a')}
                        {event.endDateTime && ` – ${format(new Date(event.endDateTime), 'h:mm a')}`}
                      </p>
                      {event.registrationDeadline && (
                        <p className="text-label-sm text-orange-600 mt-1 flex items-center gap-1">
                          <span className="material-symbols-outlined text-[13px]">timer</span>
                          Reg closes {format(new Date(event.registrationDeadline), 'MMM d')}
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Venue */}
                  <div className="flex items-start gap-3">
                    <span className="material-symbols-outlined text-[#0071E3] text-[22px] mt-0.5 shrink-0" style={{ fontVariationSettings: "'FILL' 1" }}>location_on</span>
                    <div>
                      <p className="text-label-sm text-[#86868B] uppercase tracking-widest mb-1">Venue</p>
                      <p className="text-label-md font-semibold text-[#1D1D1F]">
                        {event.format === 'online' ? 'Online Event' : event.venue || 'TBA'}
                      </p>
                      {event.area && (
                        <p className="text-label-md text-[#86868B]">{event.area}, Bangalore</p>
                      )}
                      {event.onlineLink && event.format !== 'offline' && (
                        <a href={event.onlineLink} target="_blank" rel="noopener noreferrer"
                          className="text-label-sm text-[#0071E3] mt-1 inline-block hover:underline">
                          Join Link →
                        </a>
                      )}
                    </div>
                  </div>
                </div>

                {/* Tag chips */}
                <div className="flex flex-wrap gap-2 mt-5 pt-4 border-t border-[#f0f0f0]">
                  <span className={`text-label-sm px-3 py-1 rounded-full uppercase ${getCategoryBadgeStyle(primaryCat)}`}>
                    {primaryCat}
                  </span>
                  <span className="bg-[#f3f3f5] text-[#86868B] text-label-sm px-3 py-1 rounded-full uppercase">
                    {event.format}
                  </span>
                  {event.isFree ? (
                    <span className="bg-green-50 text-green-700 text-label-sm px-3 py-1 rounded-full uppercase">Free</span>
                  ) : (
                    <span className="bg-[#f3f3f5] text-[#86868B] text-label-sm px-3 py-1 rounded-full uppercase">₹{event.price}</span>
                  )}
                  {event.hasFood === 'yes' && (
                    <span className="bg-orange-50 text-orange-700 text-label-sm px-3 py-1 rounded-full uppercase">Food</span>
                  )}
                </div>
              </div>

              {/* Description */}
              {event.description && (
                <div className="bg-white rounded-[20px] card-shadow p-6">
                  <h2 className="text-headline-md text-[#1D1D1F] mb-4">About this Event</h2>
                  <p className="text-body-md text-[#1D1D1F] leading-relaxed whitespace-pre-line">
                    {event.description}
                  </p>
                </div>
              )}

              {/* Organizer */}
              {event.organizer && (
                <div className="bg-white rounded-[20px] card-shadow p-6 flex items-center gap-4">
                  <div className="w-12 h-12 rounded-full bg-[#f3f3f5] flex items-center justify-center shrink-0">
                    <span className="material-symbols-outlined text-[20px] text-[#86868B]" style={{ fontVariationSettings: "'FILL' 1" }}>group</span>
                  </div>
                  <div>
                    <p className="text-label-sm text-[#86868B] uppercase tracking-widest mb-0.5">Organized By</p>
                    <p className="text-body-md font-semibold text-[#1D1D1F]">{event.organizer}</p>
                    <a href={event.sourceUrl} target="_blank" rel="noopener noreferrer"
                      className="text-label-sm text-[#0071E3] hover:underline">
                      View on {event.source.charAt(0).toUpperCase() + event.source.slice(1)} →
                    </a>
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </main>

      {/* Sticky bottom action bar */}
      {event && (
        <div className="fixed bottom-0 w-full bg-white/85 glass-nav border-t border-black/5 px-5 py-4 z-50 shadow-[0_-10px_40px_rgba(0,0,0,0.06)]">
          <div className="max-w-[760px] mx-auto flex items-center gap-3">
            <div className="hidden sm:block flex-1">
              <p className="text-headline-md text-[#1D1D1F]">
                {event.isFree ? 'Free Registration' : `₹${event.price}`}
              </p>
              <p className="text-label-md text-[#86868B]">
                {event.registrationDeadline
                  ? `Closes ${format(new Date(event.registrationDeadline), 'MMM d')}`
                  : 'Register now'}
              </p>
            </div>
            <button
              onClick={trackEvent}
              disabled={tracking || tracked}
              className={`flex items-center gap-2 px-6 py-3 rounded-full border text-label-md font-semibold transition-colors disabled:opacity-60 ${
                tracked
                  ? 'border-[#0071E3] text-[#0071E3] bg-blue-50'
                  : 'border-[#1D1D1F] text-[#1D1D1F] bg-white hover:bg-[#f3f3f5]'
              }`}
            >
              <span className="material-symbols-outlined text-[18px]" style={{ fontVariationSettings: tracked ? "'FILL' 1" : "'FILL' 0" }}>
                bookmark
              </span>
              {tracked ? 'Tracking' : tracking ? 'Adding…' : 'Track'}
            </button>
            <a
              href={event.applyLink || event.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex-1 sm:flex-none px-8 py-3 rounded-full bg-black text-white text-label-md font-semibold text-center hover:bg-gray-900 transition-colors"
            >
              {event.isFree ? 'RSVP Now' : 'Register'}
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
