'use client';

import { useEffect, useState } from 'react';
import { format, startOfMonth, endOfMonth, eachDayOfInterval, isSameMonth, isSameDay, isToday } from 'date-fns';

interface Event {
  _id: string;
  title: string;
  startDateTime: string;
  category: string[];
  format: string;
  venue?: string;
  area?: string;
  hasFood: string;
  sourceUrl: string;
}

export default function CalendarPage() {
  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [currentDate, setCurrentDate] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);

  useEffect(() => {
    fetchEvents();
  }, []);

  const fetchEvents = async () => {
    try {
      setLoading(true);
      const response = await fetch('/api/events');
      if (!response.ok) throw new Error('Failed to fetch events');
      const data = await response.json();
      setEvents(data.events);
    } catch (err) {
      console.error('Error fetching events:', err);
    } finally {
      setLoading(false);
    }
  };

  const monthStart = startOfMonth(currentDate);
  const monthEnd = endOfMonth(currentDate);
  const daysInMonth = eachDayOfInterval({ start: monthStart, end: monthEnd });

  // Get events for a specific day
  const getEventsForDay = (day: Date) => {
    return events.filter(event => 
      isSameDay(new Date(event.startDateTime), day)
    );
  };

  // Get events for selected date
  const selectedDateEvents = selectedDate ? getEventsForDay(selectedDate) : [];

  const previousMonth = () => {
    setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() - 1));
  };

  const nextMonth = () => {
    setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() + 1));
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading calendar...</p>
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
              <h1 className="text-2xl font-bold text-gray-900">Event Calendar</h1>
              <p className="text-sm text-gray-600">View events by date</p>
            </div>
            <div className="flex gap-2">
              <a
                href="/"
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                Feed
              </a>
              <button className="px-4 py-2 text-sm font-medium text-white bg-purple-600 rounded-lg hover:bg-purple-700">
                Calendar
              </button>
              <a
                href="/tracker"
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                Tracker
              </a>
            </div>
          </div>
        </div>
      </header>

      {/* Calendar */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="bg-white rounded-lg shadow-sm p-6">
          {/* Month Navigation */}
          <div className="flex items-center justify-between mb-6">
            <button
              onClick={previousMonth}
              className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg"
            >
              ← Previous
            </button>
            <h2 className="text-2xl font-bold text-gray-900">
              {format(currentDate, 'MMMM yyyy')}
            </h2>
            <button
              onClick={nextMonth}
              className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg"
            >
              Next →
            </button>
          </div>

          {/* Calendar Grid */}
          <div className="grid grid-cols-7 gap-2">
            {/* Day Headers */}
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(day => (
              <div key={day} className="text-center font-semibold text-gray-700 py-2">
                {day}
              </div>
            ))}

            {/* Calendar Days */}
            {daysInMonth.map(day => {
              const dayEvents = getEventsForDay(day);
              const isSelected = selectedDate && isSameDay(day, selectedDate);
              const isCurrentDay = isToday(day);

              return (
                <div
                  key={day.toISOString()}
                  onClick={() => setSelectedDate(day)}
                  className={`
                    min-h-24 p-2 border rounded-lg cursor-pointer transition-colors
                    ${isSelected ? 'border-purple-500 bg-purple-50' : 'border-gray-200 hover:border-purple-300'}
                    ${isCurrentDay ? 'bg-blue-50' : ''}
                    ${!isSameMonth(day, currentDate) ? 'opacity-50' : ''}
                  `}
                >
                  <div className={`text-sm font-medium mb-1 ${isCurrentDay ? 'text-blue-600' : 'text-gray-700'}`}>
                    {format(day, 'd')}
                  </div>
                  {dayEvents.length > 0 && (
                    <div className="space-y-1">
                      {dayEvents.slice(0, 2).map(event => (
                        <div
                          key={event._id}
                          className="text-xs bg-purple-100 text-purple-800 px-2 py-1 rounded truncate"
                        >
                          {event.title}
                        </div>
                      ))}
                      {dayEvents.length > 2 && (
                        <div className="text-xs text-gray-500">
                          +{dayEvents.length - 2} more
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Selected Date Events */}
        {selectedDate && (
          <div className="mt-8 bg-white rounded-lg shadow-sm p-6">
            <h3 className="text-xl font-bold text-gray-900 mb-4">
              Events on {format(selectedDate, 'MMMM d, yyyy')}
            </h3>

            {selectedDateEvents.length === 0 ? (
              <p className="text-gray-500">No events on this date</p>
            ) : (
              <div className="space-y-4">
                {selectedDateEvents.map(event => (
                  <div
                    key={event._id}
                    className="border border-gray-200 rounded-lg p-4 hover:shadow-md transition-shadow"
                  >
                    <h4 className="font-semibold text-gray-900 mb-2">{event.title}</h4>
                    
                    <div className="flex flex-wrap gap-2 mb-2">
                      {event.category.map(cat => (
                        <span
                          key={cat}
                          className="px-2 py-1 text-xs font-medium bg-purple-100 text-purple-800 rounded"
                        >
                          {cat}
                        </span>
                      ))}
                    </div>

                    <div className="text-sm text-gray-600 space-y-1">
                      <div>
                        🕐 {format(new Date(event.startDateTime), 'h:mm a')}
                      </div>
                      <div>
                        {event.format === 'online' ? '🌐 Online' : 
                         event.area ? `📍 ${event.area}` : '📍 Bangalore'}
                      </div>
                      {event.hasFood === 'yes' && <div>🍕 Food provided</div>}
                    </div>

                    <div className="mt-3">
                      <a
                        href={event.sourceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm text-purple-600 hover:text-purple-700 font-medium"
                      >
                        View Details →
                      </a>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

// Made with Bob