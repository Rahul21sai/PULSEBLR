'use client';

import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

const NAV_LINKS = [
  { href: '/', label: 'Feed', icon: 'rss_feed' },
  { href: '/calendar', label: 'Calendar', icon: 'calendar_today' },
  { href: '/tracker', label: 'Tracker', icon: 'analytics' },
  { href: '/add-event', label: 'Add', icon: 'add_circle' },
  { href: '/settings', label: 'Settings', icon: 'settings' },
];

const CATEGORIES = [
  'AI/ML', 'Fintech', 'Cybersecurity', 'Cloud/DevOps', 'Web/Mobile',
  'Data/Analytics', 'Hackathon', 'Government', 'Corporate',
  'Summit/Conference', 'Networking/Meetup', 'Career/Job Fair',
];

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

  // Handle PWA share target
  useEffect(() => {
    const title = searchParams.get('title');
    const text = searchParams.get('text');
    const url = searchParams.get('url');
    if (title || text || url) {
      setFormData(prev => ({
        ...prev,
        title: title || prev.title,
        description: text || prev.description,
        sourceUrl: url || prev.sourceUrl,
      }));
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
          category: formData.category.length > 0 ? formData.category : ['Networking/Meetup'],
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
            <span className="material-symbols-outlined text-white text-[16px]" style={{ fontVariationSettings: "'FILL' 1" }}>link</span>
          </div>
          <div>
            <h2 className="text-label-md font-semibold text-[#1D1D1F]">Import from Link</h2>
            <p className="text-label-sm text-[#86868B]">Paste a Luma, Meetup, or Hasgeek URL</p>
          </div>
        </div>
        <div className="flex gap-2">
          <input
            type="url"
            value={autoFillUrl}
            onChange={e => setAutoFillUrl(e.target.value)}
            placeholder="https://lu.ma/…"
            className={`flex-1 ${inputCls}`}
          />
          <button
            type="button"
            onClick={handleAutoFill}
            disabled={autoFilling || !autoFillUrl.trim()}
            className="shrink-0 bg-black text-white text-label-md px-5 py-3 rounded-xl hover:bg-gray-800 transition-colors disabled:opacity-40 flex items-center gap-2"
          >
            <span className="material-symbols-outlined text-[16px]">auto_awesome</span>
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

      {/* Categories */}
      <section className="bg-white rounded-[20px] card-shadow p-6">
        <h2 className="text-label-sm uppercase tracking-widest text-[#86868B] mb-4">Category</h2>
        <div className="flex flex-wrap gap-2">
          {CATEGORIES.map(cat => (
            <button
              key={cat} type="button" onClick={() => toggleCategory(cat)}
              className={`px-4 py-2 rounded-full text-label-md transition-colors ${
                formData.category.includes(cat)
                  ? 'bg-[#0071E3] text-white border border-[#0071E3]'
                  : 'bg-[#f3f3f5] text-[#1D1D1F] border border-transparent hover:bg-[#e8e8ea]'
              }`}
            >
              {cat}
            </button>
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
                <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-[#86868B] text-[18px] pointer-events-none">location_on</span>
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
              <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-[#86868B] text-[18px] pointer-events-none">currency_rupee</span>
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
          <span className="material-symbols-outlined text-[18px]">save</span>
          {saving ? 'Adding Event…' : 'Save Event'}
        </button>
        <a
          href="/"
          className="px-8 py-4 bg-[#f3f3f5] text-[#1D1D1F] text-label-md font-semibold rounded-full hover:bg-[#e8e8ea] transition-colors text-center"
        >
          Cancel
        </a>
      </div>
    </form>
  );
}

export default function AddEventPage() {
  return (
    <div className="min-h-screen bg-[#F5F5F7]">

      {/* Desktop Nav */}
      <nav className="hidden md:flex fixed top-0 w-full h-14 bg-white/70 glass-nav z-50 border-b border-black/5">
        <div className="flex justify-between items-center w-full max-w-[1200px] mx-auto px-20">
          <a href="/" className="text-xl font-bold tracking-tight text-[#1D1D1F] hover:text-[#0071E3] transition-colors">PulseBLR</a>
          <div className="flex items-center gap-8">
            {NAV_LINKS.map(link => (
              <a key={link.href} href={link.href}
                className={`text-label-md font-medium transition-colors ${
                  link.href === '/add-event'
                    ? 'text-[#0071E3] font-semibold border-b-2 border-[#0071E3] pb-0.5'
                    : 'text-[#86868B] hover:text-[#1D1D1F]'
                }`}>
                {link.label}
              </a>
            ))}
          </div>
          <span className="text-[#86868B] text-label-md">Add Event</span>
        </div>
      </nav>

      {/* Mobile Header */}
      <header className="md:hidden fixed top-0 w-full h-14 bg-white/70 glass-nav z-50 border-b border-black/5 flex items-center justify-center">
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

      {/* Mobile Bottom Nav */}
      <nav className="fixed bottom-0 w-full md:hidden bg-white/70 glass-nav border-t border-black/5 flex justify-around items-center px-4 py-2 z-50 rounded-t-2xl">
        {NAV_LINKS.map(link => {
          const isActive = link.href === '/add-event';
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
