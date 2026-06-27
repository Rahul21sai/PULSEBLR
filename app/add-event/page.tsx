'use client';

import { useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';

export default function AddEventPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [saving, setSaving] = useState(false);
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

  // Handle PWA share target - pre-fill form from URL parameters
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

  const categories = [
    'AI/ML',
    'Fintech',
    'Cybersecurity',
    'Cloud/DevOps',
    'Web/Mobile',
    'Data/Analytics',
    'Hackathon',
    'Government',
    'Corporate',
    'Summit/Conference',
    'Networking/Meetup',
    'Career/Job Fair',
  ];

  const areas = [
    'Koramangala',
    'Indiranagar',
    'Whitefield',
    'HSR Layout',
    'Electronic City',
    'MG Road',
    'Jayanagar',
    'Malleshwaram',
    'BTM Layout',
    'Marathahalli',
  ];

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
      const eventData = {
        ...formData,
        source: 'manual',
        price: formData.price ? parseFloat(formData.price) : undefined,
        category: formData.category.length > 0 ? formData.category : ['Networking/Meetup'],
      };

      const response = await fetch('/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(eventData),
      });

      if (response.ok) {
        alert('Event added successfully!');
        router.push('/');
      } else {
        const data = await response.json();
        alert(data.error || 'Failed to add event');
      }
    } catch (err) {
      alert('Failed to add event');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white shadow-sm sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Add Event</h1>
              <p className="text-sm text-gray-600">Manually add an event to your feed</p>
            </div>
            <Link
              href="/"
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
            >
              ← Cancel
            </Link>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <form onSubmit={handleSubmit} className="bg-white rounded-lg shadow-sm p-6 space-y-6">
          {/* Basic Info */}
          <section>
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Basic Information</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Event Title <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  required
                  value={formData.title}
                  onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                  placeholder="e.g., AI/ML Meetup Bangalore"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Description
                </label>
                <textarea
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  rows={4}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                  placeholder="What's this event about?"
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Organizer
                  </label>
                  <input
                    type="text"
                    value={formData.organizer}
                    onChange={(e) => setFormData({ ...formData, organizer: e.target.value })}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                    placeholder="e.g., Google Developer Group"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Event URL
                  </label>
                  <input
                    type="url"
                    value={formData.sourceUrl}
                    onChange={(e) => setFormData({ ...formData, sourceUrl: e.target.value })}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                    placeholder="https://..."
                  />
                </div>
              </div>
            </div>
          </section>

          {/* Categories */}
          <section>
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Categories</h2>
            <div className="flex flex-wrap gap-2">
              {categories.map(cat => (
                <button
                  key={cat}
                  type="button"
                  onClick={() => toggleCategory(cat)}
                  className={`px-3 py-1 text-sm rounded-full transition-colors ${
                    formData.category.includes(cat)
                      ? 'bg-purple-600 text-white'
                      : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  }`}
                >
                  {cat}
                </button>
              ))}
            </div>
          </section>

          {/* Date & Time */}
          <section>
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Date & Time</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Start Date & Time <span className="text-red-500">*</span>
                </label>
                <input
                  type="datetime-local"
                  required
                  value={formData.startDateTime}
                  onChange={(e) => setFormData({ ...formData, startDateTime: e.target.value })}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  End Date & Time
                </label>
                <input
                  type="datetime-local"
                  value={formData.endDateTime}
                  onChange={(e) => setFormData({ ...formData, endDateTime: e.target.value })}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Registration Deadline
                </label>
                <input
                  type="datetime-local"
                  value={formData.registrationDeadline}
                  onChange={(e) => setFormData({ ...formData, registrationDeadline: e.target.value })}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Apply/Register Link
                </label>
                <input
                  type="url"
                  value={formData.applyLink}
                  onChange={(e) => setFormData({ ...formData, applyLink: e.target.value })}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                  placeholder="https://..."
                />
              </div>
            </div>
          </section>

          {/* Location & Format */}
          <section>
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Location & Format</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Format</label>
                <div className="flex gap-4">
                  {(['online', 'offline', 'hybrid'] as const).map(fmt => (
                    <label key={fmt} className="flex items-center cursor-pointer">
                      <input
                        type="radio"
                        name="format"
                        value={fmt}
                        checked={formData.format === fmt}
                        onChange={(e) => setFormData({ ...formData, format: e.target.value as any })}
                        className="mr-2"
                      />
                      <span className="text-sm text-gray-700 capitalize">{fmt}</span>
                    </label>
                  ))}
                </div>
              </div>

              {formData.format !== 'online' && (
                <>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Venue
                    </label>
                    <input
                      type="text"
                      value={formData.venue}
                      onChange={(e) => setFormData({ ...formData, venue: e.target.value })}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                      placeholder="e.g., WeWork Galaxy, Residency Road"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Area
                    </label>
                    <select
                      value={formData.area}
                      onChange={(e) => setFormData({ ...formData, area: e.target.value })}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                    >
                      <option value="">Select area</option>
                      {areas.map(area => (
                        <option key={area} value={area}>{area}</option>
                      ))}
                    </select>
                  </div>
                </>
              )}

              {formData.format !== 'offline' && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Online Link
                  </label>
                  <input
                    type="url"
                    value={formData.onlineLink}
                    onChange={(e) => setFormData({ ...formData, onlineLink: e.target.value })}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                    placeholder="Zoom/Meet/Teams link"
                  />
                </div>
              )}
            </div>
          </section>

          {/* Additional Details */}
          <section>
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Additional Details</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Food</label>
                <div className="flex gap-4">
                  {(['yes', 'no', 'unknown'] as const).map(opt => (
                    <label key={opt} className="flex items-center cursor-pointer">
                      <input
                        type="radio"
                        name="hasFood"
                        value={opt}
                        checked={formData.hasFood === opt}
                        onChange={(e) => setFormData({ ...formData, hasFood: e.target.value as any })}
                        className="mr-2"
                      />
                      <span className="text-sm text-gray-700 capitalize">{opt}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div>
                <label className="flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={formData.isFree}
                    onChange={(e) => setFormData({ ...formData, isFree: e.target.checked, price: e.target.checked ? '' : formData.price })}
                    className="mr-2 rounded text-purple-600 focus:ring-purple-500"
                  />
                  <span className="text-sm font-medium text-gray-700">Free Event</span>
                </label>
              </div>

              {!formData.isFree && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Price (₹)
                  </label>
                  <input
                    type="number"
                    value={formData.price}
                    onChange={(e) => setFormData({ ...formData, price: e.target.value })}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                    placeholder="0"
                    min="0"
                  />
                </div>
              )}
            </div>
          </section>

          {/* Submit */}
          <div className="flex gap-4 pt-4">
            <button
              type="submit"
              disabled={saving}
              className="flex-1 px-6 py-3 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-50 font-medium"
            >
              {saving ? 'Adding Event...' : 'Add Event'}
            </button>
            <Link
              href="/"
              className="px-6 py-3 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 font-medium text-center"
            >
              Cancel
            </Link>
          </div>
        </form>
      </main>
    </div>
  );
}

// Made with Bob
