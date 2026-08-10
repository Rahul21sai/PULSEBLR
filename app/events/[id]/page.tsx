'use client';

import Link from 'next/link';

import { useEffect, useState, use } from 'react';
import { DesktopNav, MobileBottomNav } from '../../components/NavBar';
import EventCover from '../../components/EventCover';
import EventPills from '../../components/EventPills';
import SaveButton from '../../components/SaveButton';
import { FeedEvent } from '@/lib/event-types';
import {
  timeIST,
  fullDateIST,
  relativeTime,
  durationLabel,
  locationLabel,
  categoryAccent,
  priceLabel,
  dayLabelIST,
  isHappeningNow,
} from '@/lib/format';

export default function EventDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [event, setEvent] = useState<FeedEvent | null>(null);
  const [related, setRelated] = useState<FeedEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch(`/api/events/${id}`);
        if (res.status === 404) {
          if (active) setNotFound(true);
          return;
        }
        if (!res.ok) throw new Error('Failed to load');
        const data = await res.json();
        if (!active) return;
        setEvent(data.event);
        setRelated(data.related || []);
      } catch {
        if (active) setNotFound(true);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [id]);

  async function share() {
    const url = window.location.href;
    const title = event?.title || 'Event on PulseBLR';
    // Prefer the native share sheet on mobile; fall back to the clipboard, which is
    // the only thing that works reliably on desktop browsers.
    if (navigator.share) {
      try {
        await navigator.share({ title, url });
        return;
      } catch {
        // Sheet dismissed — fall through to copy.
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked — nothing useful to do */
    }
  }

  if (loading) {
    return (
      <Shell>
        <div className="max-w-[880px] mx-auto px-4 md:px-8 pt-6">
          <div className="skeleton aspect-[2/1] rounded-2xl mb-6" />
          <div className="skeleton h-8 w-3/4 rounded mb-3" />
          <div className="skeleton h-4 w-1/2 rounded mb-8" />
          <div className="skeleton h-32 rounded-2xl" />
        </div>
      </Shell>
    );
  }

  if (notFound || !event) {
    return (
      <Shell>
        <div className="max-w-[600px] mx-auto px-4 pt-20 text-center">
          <span className="material-symbols-outlined text-[48px] text-[#d5d5da] block mb-3">
            search_off
          </span>
          <h1 className="text-[22px] font-bold text-[#1D1D1F]">We couldn’t find that event</h1>
          <p className="text-[14px] text-[#6E6E73] mt-2">
            It may have been removed by the organiser, or the link is out of date.
          </p>
          <Link
            href="/"
            className="inline-block mt-6 px-6 py-2.5 rounded-full bg-[#1D1D1F] text-white text-label-md font-semibold hover:bg-black transition-colors"
          >
            Browse all events
          </Link>
        </div>
      </Shell>
    );
  }

  const accent = categoryAccent(event.category?.[0]);
  const live = isHappeningNow(event.startDateTime, event.endDateTime);
  const duration = durationLabel(event.startDateTime, event.endDateTime);
  const mapsQuery = encodeURIComponent(
    [event.venue, event.address, event.area, 'Bengaluru'].filter(Boolean).join(', ')
  );

  return (
    <Shell>
      <div className="max-w-[1100px] mx-auto px-4 md:px-8 pt-4 md:pt-6">
        <Link
          href="/"
          className="inline-flex items-center gap-1 text-[13px] font-semibold text-[#6E6E73] hover:text-[#1D1D1F] transition-colors mb-4"
        >
          <span className="material-symbols-outlined text-[16px]">arrow_back</span>
          All events
        </Link>

        <div className="flex flex-col lg:flex-row gap-8">
          {/* ── Main column ─────────────────────────────────────────────── */}
          <div className="flex-1 min-w-0">
            <div className="relative rounded-2xl overflow-hidden mb-6 bg-white card-shadow">
              <EventCover
                src={event.imageUrl}
                title={event.title}
                category={event.category?.[0]}
                className="w-full aspect-[2/1] max-h-[380px]"
                monogramSize="text-6xl"
              />
              {live && (
                <span className="absolute left-4 top-4 pill pill-live shadow-sm bg-white">
                  <span className="live-dot w-1.5 h-1.5 rounded-full bg-[#FF3B30]" />
                  Happening now
                </span>
              )}
            </div>

            <div className="flex flex-wrap gap-1.5 mb-3">
              {(event.category || []).map(category => (
                <span
                  key={category}
                  className="pill text-white"
                  style={{ background: categoryAccent(category) }}
                >
                  {category}
                </span>
              ))}
            </div>

            <h1 className="text-[26px] md:text-[36px] font-bold leading-[1.15] tracking-[-0.025em] text-[#1D1D1F] mb-4">
              {event.title}
            </h1>

            <EventPills event={event} />

            {event.description && event.description !== event.title && (
              <section className="mt-8">
                <h2 className="text-label-sm uppercase tracking-widest text-[#86868B] mb-3">
                  About this event
                </h2>
                <div className="bg-white rounded-2xl card-shadow p-5 md:p-6">
                  <p className="text-[15px] leading-[1.65] text-[#3a3a3c] whitespace-pre-line">
                    {event.description}
                  </p>
                </div>
              </section>
            )}

            {event.tags && event.tags.length > 0 && (
              <section className="mt-6">
                <div className="flex flex-wrap gap-1.5">
                  {event.tags.map(tag => (
                    <span key={tag} className="pill pill-quiet">
                      {tag}
                    </span>
                  ))}
                </div>
              </section>
            )}

            {/* Provenance — builds trust and routes the user to the authoritative page. */}
            <section className="mt-6 text-[12.5px] text-[#86868B]">
              Listed on{' '}
              <a
                href={event.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="font-semibold text-[#0071E3] hover:underline capitalize"
              >
                {event.source}
              </a>
              {event.seenInSources && event.seenInSources.length > 1 && (
                <> · also seen on {event.seenInSources.filter(s => s !== event.source).join(', ')}</>
              )}
            </section>

            {related.length > 0 && (
              <section className="mt-10">
                <h2 className="text-[17px] font-bold tracking-[-0.01em] text-[#1D1D1F] mb-3">
                  Similar events
                </h2>
                <div className="flex flex-col gap-2">
                  {related.map(item => (
                    <Link
                      key={item._id}
                      href={`/events/${item._id}`}
                      className="group flex items-center gap-3 bg-white rounded-xl card-shadow p-3 hover:shadow-[0_6px_24px_rgba(0,0,0,0.07)] transition-shadow"
                    >
                      <EventCover
                        src={item.imageUrl}
                        title={item.title}
                        category={item.category?.[0]}
                        className="w-14 h-14 rounded-lg shrink-0"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="text-[14px] font-semibold text-[#1D1D1F] truncate group-hover:text-[#0071E3] transition-colors">
                          {item.title}
                        </p>
                        <p className="text-[12px] text-[#86868B] tnum">
                          {dayLabelIST(item.startDateTime)} · {timeIST(item.startDateTime)} ·{' '}
                          {locationLabel(item)}
                        </p>
                      </div>
                      <span className="material-symbols-outlined text-[18px] text-[#c7c7cc] shrink-0">
                        chevron_right
                      </span>
                    </Link>
                  ))}
                </div>
              </section>
            )}
          </div>

          {/* ── Sticky action card ──────────────────────────────────────── */}
          <aside className="lg:w-[336px] shrink-0">
            <div className="lg:sticky lg:top-[84px] flex flex-col gap-4 pb-8">
              <div className="bg-white rounded-2xl card-shadow overflow-hidden">
                <div className="h-1" style={{ background: accent }} />
                <div className="p-5 flex flex-col gap-4">
                  <div className="flex gap-3">
                    <span className="material-symbols-outlined text-[20px] text-[#86868B] shrink-0 mt-0.5">
                      calendar_month
                    </span>
                    <div className="min-w-0">
                      <p className="text-[14px] font-semibold text-[#1D1D1F]">
                        {fullDateIST(event.startDateTime)}
                      </p>
                      <p className="text-[13px] text-[#6E6E73] tnum">
                        {timeIST(event.startDateTime)}
                        {event.endDateTime && ` – ${timeIST(event.endDateTime)}`}
                        {duration && ` · ${duration}`}
                      </p>
                      <p className="text-[12px] text-[#0071E3] font-semibold mt-0.5">
                        {relativeTime(event.startDateTime)}
                      </p>
                    </div>
                  </div>

                  <div className="flex gap-3">
                    <span className="material-symbols-outlined text-[20px] text-[#86868B] shrink-0 mt-0.5">
                      {event.format === 'online' ? 'videocam' : 'location_on'}
                    </span>
                    <div className="min-w-0">
                      <p className="text-[14px] font-semibold text-[#1D1D1F]">
                        {locationLabel(event)}
                      </p>
                      {event.address && event.address !== event.venue && (
                        <p className="text-[12.5px] text-[#6E6E73] mt-0.5">{event.address}</p>
                      )}
                      {event.format !== 'online' && (
                        <a
                          href={`https://www.google.com/maps/search/?api=1&query=${mapsQuery}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[12px] font-semibold text-[#0071E3] hover:underline mt-1 inline-block"
                        >
                          Open in Maps
                        </a>
                      )}
                    </div>
                  </div>

                  {event.organizer && (
                    <div className="flex gap-3 items-center">
                      {event.hostAvatarUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element -- third-party avatar CDN
                        <img
                          src={event.hostAvatarUrl}
                          alt=""
                          className="w-8 h-8 rounded-full object-cover shrink-0"
                        />
                      ) : (
                        <span className="material-symbols-outlined text-[20px] text-[#86868B] shrink-0">
                          person
                        </span>
                      )}
                      <div className="min-w-0">
                        <p className="text-[11px] uppercase tracking-widest text-[#86868B]">Host</p>
                        <p className="text-[14px] font-semibold text-[#1D1D1F] truncate">
                          {event.organizer}
                        </p>
                      </div>
                    </div>
                  )}

                  <div className="flex gap-3 items-center">
                    <span className="material-symbols-outlined text-[20px] text-[#86868B] shrink-0">
                      confirmation_number
                    </span>
                    <p className="text-[14px] font-semibold text-[#1D1D1F]">
                      {event.soldOut ? 'Sold out' : priceLabel(event)}
                    </p>
                  </div>

                  {event.registrationDeadline && (
                    <div className="flex gap-3 items-center">
                      <span className="material-symbols-outlined text-[20px] text-[#FF9500] shrink-0">
                        schedule
                      </span>
                      <p className="text-[13px] text-[#1D1D1F]">
                        Registration closes {relativeTime(event.registrationDeadline)}
                      </p>
                    </div>
                  )}

                  <div className="flex flex-col gap-2 pt-1">
                    <a
                      href={event.applyLink || event.sourceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="w-full text-center bg-[#1D1D1F] text-white text-label-md font-semibold py-3 rounded-full hover:bg-black transition-colors active:scale-[0.98]"
                    >
                      {event.soldOut ? `View on ${event.source}` : 'Register'}
                    </a>
                    <div className="flex gap-2">
                      <SaveButton eventId={event._id} variant="full" />
                      <a
                        href={`/api/events/${event._id}/ics`}
                        title="Add to calendar"
                        aria-label="Add to calendar"
                        className="w-11 h-11 rounded-full bg-[#f3f3f5] flex items-center justify-center text-[#1D1D1F] hover:bg-[#e8e8ea] transition-colors shrink-0"
                      >
                        <span className="material-symbols-outlined text-[18px]">event_available</span>
                      </a>
                      <button
                        type="button"
                        onClick={share}
                        title={copied ? 'Link copied' : 'Share'}
                        aria-label="Share event"
                        className="w-11 h-11 rounded-full bg-[#f3f3f5] flex items-center justify-center text-[#1D1D1F] hover:bg-[#e8e8ea] transition-colors shrink-0"
                      >
                        <span className="material-symbols-outlined text-[18px]">
                          {copied ? 'check' : 'ios_share'}
                        </span>
                      </button>
                    </div>
                    {copied && (
                      <p className="text-[12px] text-center text-[#34C759] font-semibold">
                        Link copied
                      </p>
                    )}
                  </div>
                </div>
              </div>

              {event.recruiterMentioned && (
                <div className="bg-[#0071E3]/[0.06] border border-[#0071E3]/15 rounded-2xl p-4">
                  <p className="text-[13px] font-semibold text-[#0060C0] flex items-center gap-1.5">
                    <span className="material-symbols-outlined text-[16px]">work</span>
                    Hiring signal
                  </p>
                  <p className="text-[12.5px] text-[#3a3a3c] mt-1">
                    This listing mentions recruiting or open roles. Worth logging who you meet.
                  </p>
                </div>
              )}
            </div>
          </aside>
        </div>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[#F5F5F7]">
      <DesktopNav />
      <header className="md:hidden fixed top-0 w-full h-14 bg-white/96 glass-nav z-50 border-b border-black/5 flex items-center px-5">
        <Link href="/" className="text-lg font-bold tracking-tight text-[#1D1D1F]">
          PulseBLR
        </Link>
      </header>
      <main className="pt-14 pb-24 md:pb-10">{children}</main>
      <MobileBottomNav />
    </div>
  );
}
