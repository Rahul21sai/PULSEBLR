'use client';
import Link from 'next/link';

import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { DesktopNav, MobileBottomNav } from '../components/NavBar';
import { CATEGORY_GROUPS } from '@/lib/event-types';



/**
 * Categories come FROM THE SCHEMA, never from a copy.
 *
 * This list used to be hardcoded and still held six values retired in the 32 -> 22
 * taxonomy consolidation — Fintech, Government, Corporate, Summit/Conference,
 * Networking/Meetup and Career/Job Fair. Choosing any of them made the submission fail
 * enum validation, so the Add Event form could not actually add an event. Deriving it
 * from CATEGORY_GROUPS also gives the picker the same tech-first ordering as the feed's
 * filter rail. */
const CATEGORY_SECTIONS = CATEGORY_GROUPS;

const AREAS = [
  'Koramangala', 'Indiranagar', 'Whitefield', 'HSR Layout',
  'Electronic City', 'MG Road', 'Jayanagar', 'Malleshwaram',
  'BTM Layout', 'Marathahalli',
];

function AddEventForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [saving, setSaving] = useState(false);
  const [autoFillUrl, setAutoFillUrl] = useState('');
  const [autoFilling, setAutoFilling] = useState(false);
  const [formData, setFormData] = useState({
    title: '',
    description: '',
    imageUrl: '',
    organizer: '',
    sourceUrl: '',
    category: [] as string[],
    format: 'offline' as 'online' | 'offline' | 'hybrid',
    hasFood: 'unknown' as 'yes' | 'no' | 'unknown',
    isFree: true,
    price: '',
    venue: '',
    area: '',
    onlineLink: '',
    startDateTime: '',
    endDateTime: '',
    applyLink: '',
    registrationDeadline: '',
  });

  // Handle PWA share target. Deferred by a tick so the effect doesn't set state
  // synchronously, which triggers a cascading render.
  useEffect(() => {
    const title = searchParams.get('title');
    const text = searchParams.get('text');
    const url = searchParams.get('url');
    if (title || text || url) {
      const timer = setTimeout(() => {
        setFormData(prev => ({
          ...prev,
          title: title || prev.title,
          description: text || prev.description,
          sourceUrl: url || prev.sourceUrl,
        }));
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [searchParams]);

  const toggleCategory = (cat: string) => {
    setFormData(prev => ({
      ...prev,
      category: prev.category.includes(cat)
        ? prev.category.filter(c => c !== cat)
        : [...prev.category, cat],
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.title || !formData.startDateTime) {
      alert('Title and start date/time are required');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...formData,
          source: 'manual',
          price: formData.price ? parseFloat(formData.price) : undefined,
          category: formData.category.length > 0 ? formData.category : ['Meetup'],
        }),
      });
      if (res.ok) {
        router.push('/');
      } else {
        const data = await res.json();
        alert(data.error || 'Failed to add event');
      }
    } catch {
      alert('Failed to add event');
    } finally {
      setSaving(false);
    }
  };

  const handleAutoFill = async () => {
    if (!autoFillUrl.trim()) return;
    setAutoFilling(true);
    try {
      const res = await fetch('/api/scrape-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: autoFillUrl.trim() }),
      });
      if (!res.ok) throw new Error('Failed to scrape');
      const data = await res.json();
      if (data.event) {
        setFormData(prev => ({
          ...prev,
          title: data.event.title || prev.title,
          description: data.event.description || prev.description,
          // The cover. `/api/scrape-url` reads schema.org `image` first and falls back to
          // og:image — for an event page the former is the event's own artwork and the latter
          // is often a site-wide banner, so the order matters.
          imageUrl: data.event.imageUrl || prev.imageUrl,
          organizer: data.event.organizer || prev.organizer,
          sourceUrl: data.event.sourceUrl || autoFillUrl.trim(),
          startDateTime: data.event.startDateTime || prev.startDateTime,
          endDateTime: data.event.endDateTime || prev.endDateTime,
          venue: data.event.venue || prev.venue,
          format: data.event.format || prev.format,
        }));
        setAutoFillUrl('');
      } else {
        setFormData(prev => ({ ...prev, sourceUrl: autoFillUrl.trim() }));
        alert('Could not auto-fill all fields — URL saved. Please fill in details manually.');
      }
    } catch {
      setFormData(prev => ({ ...prev, sourceUrl: autoFillUrl.trim() }));
      alert('Could not reach the URL — saved it as the event link. Please fill in details manually.');
    } finally {
      setAutoFilling(false);
    }
  };

  const inputCls = "w-full px-4 py-3 bg-[#f9f9fb] border border-[#e2e2e4] rounded-xl text-label-md text-[#1D1D1F] focus:outline-none focus:border-[#0071E3] focus:ring-1 focus:ring-[#0071E3]/20 transition-colors placeholder:text-[#c7c7cc]";

  return (
    <form onSubmit={handleSubmit} className="space-y-5">

      {/* Auto-fill from URL */}
      <section className="bg-white rounded-[20px] card-shadow p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-8 h-8 rounded-xl bg-[#0071E3] flex items-center justify-center shrink-0">
            <span aria-hidden="true" className="material-symbols-outlined text-white text-[16px]" style={{ fontVariationSettings: "'FILL' 1" }}>link</span>
          </div>
          <div>
            <h2 className="text-label-md font-semibold text-[#1D1D1F]">Import from Link</h2>
            {/* The importer has NO host allowlist — `/api/scrape-url` runs safeFetch on any
                http(s) URL and reads schema.org Event JSON-LD, falling back to <time datetime>.
                The old copy named three sites, which told people not to try the many others that
                work. Measured 2026-08-24 on real event pages: Meetup, Eventbrite, Luma,
                events.canonical.com and events.linuxfoundation.org all return a usable Event node;
                wearedevelopers.com and india.droidcon.com publish no structured data at all. So
                the honest promise is "any page that publishes standard event data", not a list. */}
            <p className="text-label-sm text-[#86868B]">
              Paste any event URL — works when the page publishes standard event data
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <input
            type="url"
            value={autoFillUrl}
            onChange={e => setAutoFillUrl(e.target.value)}
            placeholder="https://…  (Luma, Meetup, Eventbrite, a conference site…)"
            aria-label="Event URL to import"
            className={`flex-1 ${inputCls}`}
          />
          <button
            type="button"
            onClick={handleAutoFill}
            disabled={autoFilling || !autoFillUrl.trim()}
            className="shrink-0 bg-black text-white text-label-md px-5 py-3 rounded-xl hover:bg-gray-800 transition-colors disabled:opacity-40 flex items-center gap-2"
          >
            <span aria-hidden="true" className="material-symbols-outlined text-[16px]">auto_awesome</span>
            {autoFilling ? 'Filling…' : 'Fill'}
          </button>
        </div>
      </section>

      {/* Basic Info */}
      <section className="bg-white rounded-[20px] card-shadow p-6 space-y-5">
        <h2 className="text-label-sm uppercase tracking-widest text-[#86868B]">Event Details</h2>

        <div>
          <label className="block text-label-sm uppercase tracking-widest text-[#86868B] mb-2">
            Event Title <span className="text-red-500">*</span>
          </label>
          <input
            type="text" required value={formData.title}
            onChange={e => setFormData({ ...formData, title: e.target.value })}
            className={inputCls} placeholder="e.g., AI/ML Meetup Bangalore"
          />
        </div>

        <div>
          <label className="block text-label-sm uppercase tracking-widest text-[#86868B] mb-2">Description</label>
          <textarea
            value={formData.description}
            onChange={e => setFormData({ ...formData, description: e.target.value })}
            rows={3}
            className={`${inputCls} resize-none`}
            placeholder="What's this event about?"
          />
        </div>

        {/* Cover image. There was NO field for this at all, so even once the importer started
            returning one there was nowhere to put it, and every manually added event fell back to
            the category-tinted monogram. Editable rather than read-only: the importer gets it
            wrong sometimes — a site-wide banner instead of the event artwork — and pasting a
            better URL is faster than accepting a bad one. */}
        <div>
          <label className="block text-label-sm uppercase tracking-widest text-[#86868B] mb-2">
            Cover image URL
          </label>
          <input
            type="url"
            value={formData.imageUrl}
            onChange={e => setFormData({ ...formData, imageUrl: e.target.value })}
            className={inputCls}
            placeholder="https://… — filled automatically when you import a link"
          />
          {formData.imageUrl && (
            <div className="mt-2.5 flex items-start gap-3">
              {/* Plain <img>, matching the feed: covers come from a long and growing list of
                  third-party CDNs, and next/image's remotePatterns would break every time a
                  source changed host. onError hides it so a dead URL shows nothing rather than a
                  browser's broken-image glyph. */}
              {/* eslint-disable-next-line @next/next/no-img-element -- third-party CDNs, same
                  reason as app/components/EventCover.tsx: remotePatterns would break whenever a
                  source changes host, and this preview accepts an arbitrary pasted URL. */}
              <img
                src={formData.imageUrl}
                alt=""
                className="h-[72px] w-[128px] shrink-0 rounded-lg object-cover bg-[#f0f0f2]"
                onError={e => {
                  (e.currentTarget as HTMLImageElement).style.display = 'none';
                }}
              />
              <p className="text-[12px] leading-relaxed text-[#86868B]">
                Preview. If nothing appears the URL is not reachable or is not an image — the card
                will fall back to a category monogram.
              </p>
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-label-sm uppercase tracking-widest text-[#86868B] mb-2">Organizer</label>
            <input
              type="text" value={formData.organizer}
              onChange={e => setFormData({ ...formData, organizer: e.target.value })}
              className={inputCls} placeholder="e.g., GDG Bangalore"
            />
          </div>
          <div>
            <label className="block text-label-sm uppercase tracking-widest text-[#86868B] mb-2">Event URL</label>
            <input
              type="url" value={formData.sourceUrl}
              onChange={e => setFormData({ ...formData, sourceUrl: e.target.value })}
              className={inputCls} placeholder="https://..."
            />
          </div>
        </div>
      </section>

      {/* Categories, grouped exactly as the feed's filter rail groups them, so the
          vocabulary a user picks from is the vocabulary they later filter by. */}
      <section className="bg-white rounded-[18px] card-shadow p-6">
        <h2 className="t-label text-[#8E8E93] mb-1">Category</h2>
        <p className="text-[13px] text-[#6E6E73] mb-4">Pick up to three.</p>
        <div className="space-y-4">
          {CATEGORY_SECTIONS.map(group => (
            <div key={group.id}>
              <p className="text-[12px] font-semibold text-[#1D1D1F] mb-2">{group.label}</p>
              <div className="flex flex-wrap gap-1.5">
                {group.names.map(cat => {
                  const on = formData.category.includes(cat);
                  // Three is the cap the tagger and the schema both enforce.
                  const full = formData.category.length >= 3 && !on;
                  return (
                    <button
                      key={cat}
                      type="button"
                      disabled={full}
                      aria-pressed={on}
                      onClick={() => toggleCategory(cat)}
                      className={`pressable rounded-full px-3.5 h-9 text-[12.5px] font-semibold transition-colors ${
                        on
                          ? 'bg-[#1D1D1F] text-white'
                          : full
                            ? 'bg-white text-[#c7c7cc] shadow-[inset_0_0_0_1px_var(--hairline)] cursor-not-allowed'
                            : 'bg-white text-[#1D1D1F] shadow-[inset_0_0_0_1px_var(--hairline)] hover:bg-[#F7F7F9]'
                      }`}
                    >
                      {cat}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Date & Time */}
      <section className="bg-white rounded-[20px] card-shadow p-6">
        <h2 className="text-label-sm uppercase tracking-widest text-[#86868B] mb-4">Date & Time</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-label-sm uppercase tracking-widest text-[#86868B] mb-2">
              Start <span className="text-red-500">*</span>
            </label>
            <input
              type="datetime-local" required value={formData.startDateTime}
              onChange={e => setFormData({ ...formData, startDateTime: e.target.value })}
              className={inputCls}
            />
          </div>
          <div>
            <label className="block text-label-sm uppercase tracking-widest text-[#86868B] mb-2">End</label>
            <input
              type="datetime-local" value={formData.endDateTime}
              onChange={e => setFormData({ ...formData, endDateTime: e.target.value })}
              className={inputCls}
            />
          </div>
          <div>
            <label className="block text-label-sm uppercase tracking-widest text-[#86868B] mb-2">Registration Deadline</label>
            <input
              type="datetime-local" value={formData.registrationDeadline}
              onChange={e => setFormData({ ...formData, registrationDeadline: e.target.value })}
              className={inputCls}
            />
          </div>
          <div>
            <label className="block text-label-sm uppercase tracking-widest text-[#86868B] mb-2">Registration Link</label>
            <input
              type="url" value={formData.applyLink}
              onChange={e => setFormData({ ...formData, applyLink: e.target.value })}
              className={inputCls} placeholder="https://..."
            />
          </div>
        </div>
      </section>

      {/* Location & Format */}
      <section className="bg-white rounded-[20px] card-shadow p-6">
        <h2 className="text-label-sm uppercase tracking-widest text-[#86868B] mb-4">Location & Format</h2>

        <div className="mb-5">
          <label className="block text-label-sm uppercase tracking-widest text-[#86868B] mb-3">Format</label>
          <div className="flex bg-[#f3f3f5] rounded-xl p-1 gap-1">
            {(['offline', 'online', 'hybrid'] as const).map(fmt => (
              <button
                key={fmt} type="button"
                onClick={() => setFormData({ ...formData, format: fmt })}
                className={`flex-1 py-2.5 rounded-xl text-label-md capitalize transition-colors ${
                  formData.format === fmt
                    ? 'bg-white text-[#1D1D1F] shadow-sm font-semibold'
                    : 'text-[#86868B] hover:text-[#1D1D1F]'
                }`}
              >
                {fmt}
              </button>
            ))}
          </div>
        </div>

        {formData.format !== 'online' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
            <div>
              <label className="block text-label-sm uppercase tracking-widest text-[#86868B] mb-2">Venue</label>
              <div className="relative">
                <span aria-hidden="true" className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-[#86868B] text-[18px] pointer-events-none">location_on</span>
                <input
                  type="text" value={formData.venue}
                  onChange={e => setFormData({ ...formData, venue: e.target.value })}
                  className={`${inputCls} pl-10`} placeholder="e.g., WeWork Galaxy"
                />
              </div>
            </div>
            <div>
              <label className="block text-label-sm uppercase tracking-widest text-[#86868B] mb-2">Area</label>
              <select
                value={formData.area}
                onChange={e => setFormData({ ...formData, area: e.target.value })}
                className={inputCls}
              >
                <option value="">Select area</option>
                {AREAS.map(a => <option key={a} value={a}>{a}</option>)}
              </select>
            </div>
          </div>
        )}

        {formData.format !== 'offline' && (
          <div>
            <label className="block text-label-sm uppercase tracking-widest text-[#86868B] mb-2">Online Link</label>
            <input
              type="url" value={formData.onlineLink}
              onChange={e => setFormData({ ...formData, onlineLink: e.target.value })}
              className={inputCls} placeholder="Zoom / Meet / Teams URL"
            />
          </div>
        )}
      </section>

      {/* Additional Details */}
      <section className="bg-white rounded-[20px] card-shadow p-6">
        <h2 className="text-label-sm uppercase tracking-widest text-[#86868B] mb-4">Additional Details</h2>

        <div className="mb-5">
          <label className="block text-label-sm uppercase tracking-widest text-[#86868B] mb-3">Food Provided</label>
          <div className="flex bg-[#f3f3f5] rounded-xl p-1 gap-1">
            {(['yes', 'no', 'unknown'] as const).map(opt => (
              <button
                key={opt} type="button"
                onClick={() => setFormData({ ...formData, hasFood: opt })}
                className={`flex-1 py-2.5 rounded-xl text-label-md transition-colors ${
                  formData.hasFood === opt
                    ? 'bg-white text-[#1D1D1F] shadow-sm font-semibold'
                    : 'text-[#86868B] hover:text-[#1D1D1F]'
                }`}
              >
                {opt === 'unknown' ? 'Not sure' : opt.charAt(0).toUpperCase() + opt.slice(1)}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between py-3 border-t border-[#f0f0f0]">
          <div>
            <span className="block text-label-md font-medium text-[#1D1D1F]">Free Event</span>
            <span className="text-label-sm text-[#86868B]">Toggle off to set a price</span>
          </div>
          <button
            type="button"
            onClick={() => setFormData({ ...formData, isFree: !formData.isFree, price: !formData.isFree ? '' : formData.price })}
            className={`relative w-12 h-7 rounded-full transition-colors ${formData.isFree ? 'bg-[#0071E3]' : 'bg-[#e5e5e5]'}`}
          >
            <span className={`absolute top-1 w-5 h-5 bg-white rounded-full shadow transition-transform ${formData.isFree ? 'translate-x-6' : 'translate-x-1'}`} />
          </button>
        </div>

        {!formData.isFree && (
          <div className="mt-4">
            <label className="block text-label-sm uppercase tracking-widest text-[#86868B] mb-2">Price (₹)</label>
            <div className="relative">
              <span aria-hidden="true" className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-[#86868B] text-[18px] pointer-events-none">currency_rupee</span>
              <input
                type="number" value={formData.price} min="0"
                onChange={e => setFormData({ ...formData, price: e.target.value })}
                className={`${inputCls} pl-10`} placeholder="0"
              />
            </div>
          </div>
        )}
      </section>

      {/* Submit */}
      <div className="flex gap-3 pb-6">
        <button
          type="submit" disabled={saving}
          className="flex-1 bg-[#0071E3] text-white text-label-md font-semibold py-4 rounded-full hover:bg-blue-600 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
        >
          <span aria-hidden="true" className="material-symbols-outlined text-[18px]">save</span>
          {saving ? 'Adding Event…' : 'Save Event'}
        </button>
        <Link
          href="/"
          className="px-8 py-4 bg-[#f3f3f5] text-[#1D1D1F] text-label-md font-semibold rounded-full hover:bg-[#e8e8ea] transition-colors text-center"
        >
          Cancel
        </Link>
      </div>
    </form>
  );
}

export default function AddEventPage() {
  return (
    <div className="min-h-screen ambient-above">
      <DesktopNav />

      {/* Mobile Header */}
      <header className="md:hidden fixed top-0 w-full h-14 bg-white/96 glass-nav z-50 border-b border-black/5 flex items-center justify-center">
        <span className="text-label-md font-bold text-[#1D1D1F]">Add Event</span>
      </header>

      <main className="pt-14 pb-24 md:pb-8">
        <section className="bg-black text-white px-5 md:px-20 pt-12 pb-10">
          <div className="max-w-[760px] mx-auto">
            <h1 className="text-display-lg-mobile md:text-headline-lg mb-1">Create Event</h1>
            <p className="text-body-md text-gray-400">Fill in the details to add a new event to the feed.</p>
          </div>
        </section>

        <div className="max-w-[760px] mx-auto px-5 md:px-0 py-6">
          <Suspense fallback={<div className="flex justify-center py-12"><div className="spinner" /></div>}>
            <AddEventForm />
          </Suspense>
        </div>
      </main>

      <MobileBottomNav />
    </div>
  );
}
