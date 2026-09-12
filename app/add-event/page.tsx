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
  /**
   * WHO THIS EVENT IS FOR — the choice this page previously could not offer.
   *
   * `POST /api/events` was admin-only while `/add-event` was merely signed-in, so for everybody
   * else this form was a dead end that 403'd on submit. Now the answer to "who is it for" decides
   * what happens: 'private' is yours alone, 'pending' goes to review before it reaches the shared
   * feed.
   *
   * DEFAULTS TO 'private', deliberately. The safe option is the one that does not publish, and it
   * is also the common case — most events somebody types in by hand are ones the scraper cannot
   * know about and nobody else needs.
   */
  const [visibility, setVisibility] = useState<'private' | 'pending'>('private');
  const [submitted, setSubmitted] = useState<null | 'private' | 'pending'>(null);
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
      // `source` is NOT sent: the route forces `'manual'`, and a body that claims to be scraped
      // would make the row look like corpus data to every diagnostic in scripts/.
      const res = await fetch('/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...formData,
          visibility,
          price: formData.price ? parseFloat(formData.price) : undefined,
          category: formData.category.length > 0 ? formData.category : ['Meetup'],
        }),
      });
      if (res.ok) {
        // A private event is in the feed immediately, so going there shows the result. A submission
        // is NOT, so redirecting to a feed that does not contain it reads as a failed save —
        // confirm in place instead.
        if (visibility === 'private') {
          router.push('/');
        } else {
          setSubmitted('pending');
        }
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

  // `--r-touch`, because a field IS touchable — that is what the 4px radius means in this system.
  // `focus:ring-1 ... /20` is dropped for a solid 2px inset border on focus: a 20%-alpha ring is not
  // a visible focus indicator, and visible keyboard focus is a definition-of-done item here.
  const inputCls = "w-full px-4 py-3 bg-[var(--paper)] border border-[var(--rule)] rounded-[var(--r-touch)] text-[14px] text-[var(--ink)] focus:outline-none focus:border-[var(--accent)] focus:shadow-[inset_0_0_0_1px_var(--accent)] transition-colors placeholder:text-[var(--ink-2)]";

  /**
   * The confirmation for a submission, shown in place.
   *
   * Not a redirect: a submitted event is `pending`, so it is NOT in the shared feed yet. Sending
   * somebody to a feed that does not contain what they just added is indistinguishable from the
   * save having failed. Their own copy IS visible to them, which is what the link offers.
   */
  if (submitted === 'pending') {
    return (
      <section className="rounded-[var(--r-flat)] border border-[var(--rule)] p-8 text-center">
        <span
          aria-hidden="true"
          className="material-symbols-outlined text-[32px] text-[var(--accent)]"
          style={{ fontVariationSettings: "'FILL' 1" }}
        >
          how_to_reg
        </span>
        <h2 className="mt-2 text-[19px] font-bold tracking-[-0.02em] text-[var(--ink)]">
          Sent for review
        </h2>
        <p className="mx-auto mt-2 max-w-[420px] text-[13.5px] leading-relaxed text-[var(--ink-2)]">
          It will appear in everyone&apos;s feed once an admin has looked at it. You can see it in
          your own feed straight away, and you can track it and scan people into it now — approval
          only affects who else sees it.
        </p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <Link
            href="/"
            className="inline-flex h-11 items-center rounded-full bg-[var(--accent)] px-6 text-[14px] font-semibold text-[var(--accent-ink)] pressable"
          >
            See it in my feed
          </Link>
          <button
            type="button"
            onClick={() => setSubmitted(null)}
            className="inline-flex h-11 items-center rounded-full bg-[var(--paper)] px-6 text-[14px] font-semibold text-[var(--ink)] pressable"
          >
            Add another
          </button>
        </div>
      </section>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">

      {/*
        WHO IS IT FOR — first, because it changes what the rest of the form means.
        Putting it at the end, next to the submit button, would have people fill in twenty fields
        under one assumption and discover the choice at the moment of committing.
      */}
      <section className="rounded-[var(--r-flat)] border border-[var(--rule)] p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-8 h-8 rounded-xl bg-[var(--ink)] flex items-center justify-center shrink-0">
            <span
              aria-hidden="true"
              className="material-symbols-outlined text-[var(--accent-ink)] text-[16px]"
              style={{ fontVariationSettings: "'FILL' 1" }}
            >
              visibility
            </span>
          </div>
          <div>
            <h2 className="text-[14px] font-semibold text-[var(--ink)]" style={{ fontFamily: 'var(--font-sans)' }}>Who is this for?</h2>
            <p className="text-label-sm text-[var(--ink-2)]">
              You can track it and scan people into it either way
            </p>
          </div>
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          {([
            {
              value: 'private' as const,
              icon: 'lock',
              title: 'Just for me',
              body: 'Only you can see it. Right for an internal hackathon, a reading group, or anything the scraper cannot know about.',
            },
            {
              value: 'pending' as const,
              icon: 'public',
              title: 'Add for everyone',
              body: 'Goes to an admin for review before it joins the shared feed. Yours to use immediately either way.',
            },
          ]).map(option => {
            const active = visibility === option.value;
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={active}
                onClick={() => setVisibility(option.value)}
                className={`rounded-xl p-4 text-left transition-colors ${
                  active
                    ? 'bg-[var(--paper)] shadow-[inset_0_0_0_2px_var(--blue)]'
                    : 'bg-[var(--paper)] shadow-[inset_0_0_0_1px_var(--hairline)]'
                }`}
              >
                <span className="flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className={`material-symbols-outlined text-[18px] ${active ? 'text-[var(--accent)]' : 'text-[var(--ink-3)]'}`}
                  >
                    {option.icon}
                  </span>
                  <span
                    className={`text-[14px] font-semibold ${active ? 'text-[var(--accent)]' : 'text-[var(--ink)]'}`}
                  >
                    {option.title}
                  </span>
                </span>
                <span className="mt-1 block text-[12.5px] leading-relaxed text-[var(--ink-2)]">
                  {option.body}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {/* Auto-fill from URL */}
      <section className="rounded-[var(--r-flat)] border border-[var(--rule)] p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-8 h-8 rounded-xl bg-[var(--accent)] flex items-center justify-center shrink-0">
            <span aria-hidden="true" className="material-symbols-outlined text-[var(--accent-ink)] text-[16px]" style={{ fontVariationSettings: "'FILL' 1" }}>link</span>
          </div>
          <div>
            <h2 className="text-[14px] font-semibold text-[var(--ink)]" style={{ fontFamily: 'var(--font-sans)' }}>Import from a link</h2>
            {/* The importer has NO host allowlist — `/api/scrape-url` runs safeFetch on any
                http(s) URL and reads schema.org Event JSON-LD, falling back to <time datetime>.
                The old copy named three sites, which told people not to try the many others that
                work. Measured 2026-08-24 on real event pages: Meetup, Eventbrite, Luma,
                events.canonical.com and events.linuxfoundation.org all return a usable Event node;
                wearedevelopers.com and india.droidcon.com publish no structured data at all. So
                the honest promise is "any page that publishes standard event data", not a list. */}
            <p className="text-label-sm text-[var(--ink-2)]">
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
            className="pressable shrink-0 bg-[var(--ink)] text-[var(--accent-ink)] text-[14px] font-semibold px-5 py-3 rounded-[var(--r-touch)] transition-colors disabled:opacity-40 flex items-center gap-2"
          >
            <span aria-hidden="true" className="material-symbols-outlined text-[16px]">auto_awesome</span>
            {autoFilling ? 'Filling…' : 'Fill'}
          </button>
        </div>
      </section>

      {/* Basic Info */}
      <section className="rounded-[var(--r-flat)] border border-[var(--rule)] p-6 space-y-5">
        <h2 className="ty-meta">Event Details</h2>

        <div>
          <label className="block ty-meta mb-2">
            Event Title <span className="text-[var(--live)]">*</span>
          </label>
          <input
            type="text" required value={formData.title}
            onChange={e => setFormData({ ...formData, title: e.target.value })}
            className={inputCls} placeholder="e.g., AI/ML Meetup Bangalore"
          />
        </div>

        <div>
          <label className="block ty-meta mb-2">Description</label>
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
          <label className="block ty-meta mb-2">
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
                className="h-[72px] w-[128px] shrink-0 rounded-lg object-cover bg-[var(--paper)]"
                onError={e => {
                  (e.currentTarget as HTMLImageElement).style.display = 'none';
                }}
              />
              <p className="text-[12px] leading-relaxed text-[var(--ink-2)]">
                Preview. If nothing appears the URL is not reachable or is not an image — the card
                will fall back to a category monogram.
              </p>
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block ty-meta mb-2">Organizer</label>
            <input
              type="text" value={formData.organizer}
              onChange={e => setFormData({ ...formData, organizer: e.target.value })}
              className={inputCls} placeholder="e.g., GDG Bangalore"
            />
          </div>
          <div>
            <label className="block ty-meta mb-2">Event URL</label>
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
      <section className="rounded-[var(--r-flat)] border border-[var(--rule)] p-6">
        <h2 className="t-label text-[var(--ink-2)] mb-1">Category</h2>
        <p className="text-[13px] text-[var(--ink-2)] mb-4">Pick up to three.</p>
        <div className="space-y-4">
          {CATEGORY_SECTIONS.map(group => (
            <div key={group.id}>
              <p className="text-[12px] font-semibold text-[var(--ink)] mb-2">{group.label}</p>
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
                          ? 'bg-[var(--ink)] text-[var(--accent-ink)]'
                          : full
                            ? 'bg-[var(--surface)] text-[var(--ink-3)] shadow-[inset_0_0_0_1px_var(--hairline)] cursor-not-allowed'
                            : 'bg-[var(--surface)] text-[var(--ink)] shadow-[inset_0_0_0_1px_var(--hairline)] hover:bg-[var(--paper)]'
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
      <section className="rounded-[var(--r-flat)] border border-[var(--rule)] p-6">
        <h2 className="ty-meta mb-4">Date & Time</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block ty-meta mb-2">
              Start <span className="text-[var(--live)]">*</span>
            </label>
            <input
              type="datetime-local" required value={formData.startDateTime}
              onChange={e => setFormData({ ...formData, startDateTime: e.target.value })}
              className={inputCls}
            />
          </div>
          <div>
            <label className="block ty-meta mb-2">End</label>
            <input
              type="datetime-local" value={formData.endDateTime}
              onChange={e => setFormData({ ...formData, endDateTime: e.target.value })}
              className={inputCls}
            />
          </div>
          <div>
            <label className="block ty-meta mb-2">Registration Deadline</label>
            <input
              type="datetime-local" value={formData.registrationDeadline}
              onChange={e => setFormData({ ...formData, registrationDeadline: e.target.value })}
              className={inputCls}
            />
          </div>
          <div>
            <label className="block ty-meta mb-2">Registration Link</label>
            <input
              type="url" value={formData.applyLink}
              onChange={e => setFormData({ ...formData, applyLink: e.target.value })}
              className={inputCls} placeholder="https://..."
            />
          </div>
        </div>
      </section>

      {/* Location & Format */}
      <section className="rounded-[var(--r-flat)] border border-[var(--rule)] p-6">
        <h2 className="ty-meta mb-4">Location & Format</h2>

        <div className="mb-5">
          <label className="block ty-meta mb-3">Format</label>
          <div className="flex bg-[var(--paper)] rounded-xl p-1 gap-1">
            {(['offline', 'online', 'hybrid'] as const).map(fmt => (
              <button
                key={fmt} type="button"
                onClick={() => setFormData({ ...formData, format: fmt })}
                className={`flex-1 py-2.5 rounded-xl text-label-md capitalize transition-colors ${
                  formData.format === fmt
                    ? 'bg-[var(--surface)] text-[var(--ink)] shadow-[inset_0_0_0_1px_var(--rule)] font-semibold'
                    : 'text-[var(--ink-2)] hover:text-[var(--ink)]'
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
              <label className="block ty-meta mb-2">Venue</label>
              <div className="relative">
                <span aria-hidden="true" className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-[var(--ink-3)] text-[18px] pointer-events-none">location_on</span>
                <input
                  type="text" value={formData.venue}
                  onChange={e => setFormData({ ...formData, venue: e.target.value })}
                  className={`${inputCls} pl-10`} placeholder="e.g., WeWork Galaxy"
                />
              </div>
            </div>
            <div>
              <label className="block ty-meta mb-2">Area</label>
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
            <label className="block ty-meta mb-2">Online Link</label>
            <input
              type="url" value={formData.onlineLink}
              onChange={e => setFormData({ ...formData, onlineLink: e.target.value })}
              className={inputCls} placeholder="Zoom / Meet / Teams URL"
            />
          </div>
        )}
      </section>

      {/* Additional Details */}
      <section className="rounded-[var(--r-flat)] border border-[var(--rule)] p-6">
        <h2 className="ty-meta mb-4">Additional Details</h2>

        <div className="mb-5">
          <label className="block ty-meta mb-3">Food Provided</label>
          <div className="flex bg-[var(--paper)] rounded-xl p-1 gap-1">
            {(['yes', 'no', 'unknown'] as const).map(opt => (
              <button
                key={opt} type="button"
                onClick={() => setFormData({ ...formData, hasFood: opt })}
                className={`flex-1 py-2.5 rounded-xl text-label-md transition-colors ${
                  formData.hasFood === opt
                    ? 'bg-[var(--surface)] text-[var(--ink)] shadow-[inset_0_0_0_1px_var(--rule)] font-semibold'
                    : 'text-[var(--ink-2)] hover:text-[var(--ink)]'
                }`}
              >
                {opt === 'unknown' ? 'Not sure' : opt.charAt(0).toUpperCase() + opt.slice(1)}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between py-3 border-t border-[var(--rule)]">
          <div>
            <span className="block text-label-md font-medium text-[var(--ink)]">Free Event</span>
            <span className="text-label-sm text-[var(--ink-2)]">Toggle off to set a price</span>
          </div>
          <button
            type="button"
            onClick={() => setFormData({ ...formData, isFree: !formData.isFree, price: !formData.isFree ? '' : formData.price })}
            className={`relative w-12 h-7 rounded-full transition-colors ${formData.isFree ? 'bg-[var(--accent)]' : 'bg-[var(--ink-3)]'}`}
          >
            {/* The knob KEEPS `rounded-full` — it is a circle, not a container, so the flat-container
                rule does not reach it. Its bare Tailwind `shadow` becomes an inset hairline ring: the
                system allows exactly one box-shadow (`--shadow-sticky`) and this was a second one. */}
            <span className={`absolute top-1 w-5 h-5 bg-[var(--surface)] rounded-full shadow-[inset_0_0_0_1px_var(--rule)] transition-transform ${formData.isFree ? 'translate-x-6' : 'translate-x-1'}`} />
          </button>
        </div>

        {!formData.isFree && (
          <div className="mt-4">
            <label className="block ty-meta mb-2">Price (₹)</label>
            <div className="relative">
              <span aria-hidden="true" className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-[var(--ink-3)] text-[18px] pointer-events-none">currency_rupee</span>
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
          className="flex-1 bg-[var(--accent)] text-[var(--accent-ink)] text-label-md font-semibold py-4 rounded-full hover:bg-[var(--accent)] transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
        >
          <span aria-hidden="true" className="material-symbols-outlined text-[18px]">save</span>
          {saving ? 'Adding Event…' : 'Save Event'}
        </button>
        <Link
          href="/"
          className="px-8 py-4 bg-[var(--paper)] text-[var(--ink)] text-label-md font-semibold rounded-full transition-colors text-center"
        >
          Cancel
        </Link>
      </div>
    </form>
  );
}

export default function AddEventPage() {
  return (
    <div className="min-h-screen bg-[var(--paper)]">
      <DesktopNav />

      {/* Mobile Header */}
      <header className="md:hidden fixed top-0 w-full h-14 bg-[var(--surface)]/96 glass-nav z-50 border-b border-[var(--rule)] flex items-center justify-center">
        <span className="text-label-md font-bold text-[var(--ink)]">Add Event</span>
      </header>

      <main className="pt-14 pb-24 md:pb-8">
        {/*
          THE RULED HEADER, replacing a full-bleed `bg-black text-white` hero.

          CLAUDE.md §6 already records this exact pattern as a defect on `/dashboard`: a solid black
          band is the loudest possible element in a product whose whole colour budget is spent on
          cover images, and it appeared on one page, which is what made that screen read as a
          different app. This page had the same band, down to the mid-grey subtitle on it.

          What replaces it is the treatment every other surface here now uses — the page ground, a
          sans title (the app naming its own screen, so sans by the semantic rule; a serif `.ty-h1`
          is for a thing in the world, which "add an event" is not), a `.ty-meta` subtitle, and a
          single hairline to close the header. No ground, no radius, no shadow.
        */}
        <header className="rule-b px-5 md:px-8 pt-[var(--s-8)] pb-[var(--s-4)]">
          <div className="max-w-[760px] mx-auto">
            <h1 className="ty-section text-[var(--ink)]">Add an event</h1>
            <p className="ty-meta mt-[var(--s-1)]">
              Something the scraper cannot know about — an internal hackathon, a reading group, an
              invite-only evening.
            </p>
          </div>
        </header>

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
