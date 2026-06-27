'use client';

import { useEffect, useState } from 'react';
import { format } from 'date-fns';

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

export default function Home() {
  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  
  // Filter states
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [selectedFormat, setSelectedFormat] = useState<string>('');
  const [selectedFood, setSelectedFood] = useState<string>('');
  const [selectedArea, setSelectedArea] = useState<string>('');
  const [freeOnly, setFreeOnly] = useState(false);

  useEffect(() => {
    fetchEvents();
  }, [selectedCategories, selectedFormat, selectedFood, selectedArea, freeOnly]);

  const fetchEvents = async () => {
    try {
      setLoading(true);
      
      // Build query params
      const params = new URLSearchParams();
      if (selectedCategories.length > 0) {
        params.append('category', selectedCategories.join(','));
      }
      if (selectedFormat) params.append('format', selectedFormat);
      if (selectedFood) params.append('hasFood', selectedFood);
      if (selectedArea) params.append('area', selectedArea);
      if (freeOnly) params.append('isFree', 'true');
      
      const response = await fetch(`/api/events?${params.toString()}`);
      if (!response.ok) throw new Error('Failed to fetch events');
      const data = await response.json();
      setEvents(data.events);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  const toggleCategory = (category: string) => {
    setSelectedCategories(prev =>
      prev.includes(category)
        ? prev.filter(c => c !== category)
        : [...prev, category]
    );
  };

  const clearFilters = () => {
    setSelectedCategories([]);
    setSelectedFormat('');
    setSelectedFood('');
    setSelectedArea('');
    setFreeOnly(false);
  };

  const trackEvent = async (eventId: string) => {
    try {
      const response = await fetch('/api/tracker', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId,
          status: 'Interested',
        }),
      });

      if (response.ok) {
        alert('Event added to tracker!');
      } else {
        const data = await response.json();
        alert(data.error || 'Failed to track event');
      }
    } catch (err) {
      alert('Failed to track event');
    }
  };

  const getCategoryColor = (category: string) => {
    const colors: Record<string, string> = {
      'AI/ML': 'bg-purple-100 text-purple-800',
      'Fintech': 'bg-green-100 text-green-800',
      'Cybersecurity': 'bg-red-100 text-red-800',
      'Cloud/DevOps': 'bg-blue-100 text-blue-800',
      'Web/Mobile': 'bg-yellow-100 text-yellow-800',
      'Data/Analytics': 'bg-indigo-100 text-indigo-800',
      'Hackathon': 'bg-pink-100 text-pink-800',
      'Government': 'bg-orange-100 text-orange-800',
      'Corporate': 'bg-gray-100 text-gray-800',
      'Summit/Conference': 'bg-teal-100 text-teal-800',
      'Networking/Meetup': 'bg-cyan-100 text-cyan-800',
      'Career/Job Fair': 'bg-lime-100 text-lime-800',
    };
    return colors[category] || 'bg-gray-100 text-gray-800';
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading events...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <p className="text-red-600 text-lg">Error: {error}</p>
          <button
            onClick={fetchEvents}
            className="mt-4 px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white shadow-sm sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">PulseBLR</h1>
              <p className="text-sm text-gray-600">Bangalore Tech Events Tracker</p>
            </div>
            <div className="flex gap-2">
              <a
                href="/add-event"
                className="px-4 py-2 text-sm font-medium text-white bg-purple-600 rounded-lg hover:bg-purple-700"
              >
                + Add Event
              </a>
              <button className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50">
                Feed
              </button>
              <a
                href="/calendar"
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                Calendar
              </a>
              <a
                href="/tracker"
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                Tracker
              </a>
              <a
                href="/dashboard"
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                📊
              </a>
              <a
                href="/settings"
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                ⚙️
              </a>
            </div>
          </div>
        </div>
      {/* Filters */}
      <div className="bg-white border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center justify-between mb-3">
            <button
              onClick={() => setShowFilters(!showFilters)}
              className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200"
            >
              🔍 Filters
              {(selectedCategories.length > 0 || selectedFormat || selectedFood || selectedArea || freeOnly) && (
                <span className="px-2 py-0.5 text-xs bg-purple-600 text-white rounded-full">
                  {selectedCategories.length + (selectedFormat ? 1 : 0) + (selectedFood ? 1 : 0) + (selectedArea ? 1 : 0) + (freeOnly ? 1 : 0)}
                </span>
              )}
            </button>
            {(selectedCategories.length > 0 || selectedFormat || selectedFood || selectedArea || freeOnly) && (
              <button
                onClick={clearFilters}
                className="text-sm text-purple-600 hover:text-purple-700 font-medium"
              >
                Clear all
              </button>
            )}
          </div>

          {showFilters && (
            <div className="space-y-4 pt-4 border-t border-gray-200">
              {/* Categories */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Categories</label>
                <div className="flex flex-wrap gap-2">
                  {['AI/ML', 'Fintech', 'Cybersecurity', 'Cloud/DevOps', 'Web/Mobile', 'Data/Analytics', 'Hackathon', 'Networking/Meetup'].map(cat => (
                    <button
                      key={cat}
                      onClick={() => toggleCategory(cat)}
                      className={`px-3 py-1 text-sm rounded-full transition-colors ${
                        selectedCategories.includes(cat)
                          ? 'bg-purple-600 text-white'
                          : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                      }`}
                    >
                      {cat}
                    </button>
                  ))}
                </div>
              </div>

              {/* Format, Food, Area, Price */}
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Format</label>
                  <select
                    value={selectedFormat}
                    onChange={(e) => setSelectedFormat(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500"
                  >
                    <option value="">All</option>
                    <option value="online">Online</option>
                    <option value="offline">Offline</option>
                    <option value="hybrid">Hybrid</option>
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Food</label>
                  <select
                    value={selectedFood}
                    onChange={(e) => setSelectedFood(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500"
                  >
                    <option value="">All</option>
                    <option value="yes">With Food</option>
                    <option value="no">No Food</option>
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Area</label>
                  <select
                    value={selectedArea}
                    onChange={(e) => setSelectedArea(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500"
                  >
                    <option value="">All Areas</option>
                    <option value="Koramangala">Koramangala</option>
                    <option value="Indiranagar">Indiranagar</option>
                    <option value="Whitefield">Whitefield</option>
                    <option value="HSR Layout">HSR Layout</option>
                    <option value="Electronic City">Electronic City</option>
                    <option value="MG Road">MG Road</option>
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Price</label>
                  <label className="flex items-center gap-2 px-3 py-2 border border-gray-300 rounded-lg cursor-pointer hover:bg-gray-50">
                    <input
                      type="checkbox"
                      checked={freeOnly}
                      onChange={(e) => setFreeOnly(e.target.checked)}
                      className="rounded text-purple-600 focus:ring-purple-500"
                    />
                    <span className="text-sm text-gray-700">Free only</span>
                  </label>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {events.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-gray-600 text-lg">No events found</p>
            <p className="text-gray-500 text-sm mt-2">Events will appear here once scrapers are running</p>
          </div>
        ) : (
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {events.map((event) => (
              <div
                key={event._id}
                className="bg-white rounded-lg shadow-sm hover:shadow-md transition-shadow p-6 border border-gray-200"
              >
                {/* Event Header */}
                <div className="flex items-start justify-between mb-3">
                  <div className="flex-1">
                    <h3 className="text-lg font-semibold text-gray-900 line-clamp-2">
                      {event.title}
                    </h3>
                    {event.organizer && (
                      <p className="text-sm text-gray-600 mt-1">{event.organizer}</p>
                    )}
                  </div>
                </div>

                {/* Categories */}
                <div className="flex flex-wrap gap-2 mb-3">
                  {event.category.map((cat) => (
                    <span
                      key={cat}
                      className={`px-2 py-1 text-xs font-medium rounded-full ${getCategoryColor(cat)}`}
                    >
                      {cat}
                    </span>
                  ))}
                </div>

                {/* Event Details */}
                <div className="space-y-2 mb-4">
                  <div className="flex items-center text-sm text-gray-600">
                    <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                    </svg>
                    {format(new Date(event.startDateTime), 'MMM dd, yyyy • h:mm a')}
                  </div>

                  <div className="flex items-center text-sm text-gray-600">
                    <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                    {event.format === 'online' ? 'Online' : event.format === 'offline' ? `${event.area || event.venue || 'Bangalore'}` : 'Hybrid'}
                  </div>

                  <div className="flex items-center gap-3 text-sm">
                    {event.isFree ? (
                      <span className="text-green-600 font-medium">Free</span>
                    ) : (
                      <span className="text-gray-600">₹{event.price}</span>
                    )}
                    {event.hasFood === 'yes' && (
                      <span className="text-orange-600 font-medium">🍕 Food</span>
                    )}
                  </div>
                </div>

                {/* Description */}
                <p className="text-sm text-gray-600 line-clamp-3 mb-4">
                  {event.description}
                </p>

                {/* Actions */}
                <div className="flex gap-2">
                  <a
                    href={event.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-1 px-3 py-2 text-sm font-medium text-center text-white bg-purple-600 rounded-lg hover:bg-purple-700"
                  >
                    View Details
                  </a>
                  <button
                    onClick={() => trackEvent(event._id)}
                    className="px-3 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200"
                  >
                    Track
                  </button>
                </div>

                {/* Source Badge */}
                <div className="mt-3 pt-3 border-t border-gray-100">
                  <span className="text-xs text-gray-500">
                    via {event.source}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

// Made with Bob
