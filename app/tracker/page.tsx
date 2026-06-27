'use client';

import { useEffect, useState } from 'react';
import { format } from 'date-fns';
import EditTrackerModal from './components/EditTrackerModal';

interface Connection {
  name: string;
  role?: string;
  company?: string;
  linkedin?: string;
  context?: string;
  followUpAt?: string;
}

interface TrackerEntry {
  _id: string;
  eventId: {
    _id: string;
    title: string;
    description: string;
    startDateTime: string;
    venue?: string;
    area?: string;
    format: string;
    category: string[];
    sourceUrl: string;
  };
  status: string;
  notes?: string;
  appliedAt?: string;
  outcome?: string;
  connections: Connection[];
  updatedAt: string;
}

const STATUS_COLUMNS = [
  { id: 'New', label: 'New', color: 'bg-gray-100' },
  { id: 'Interested', label: 'Interested', color: 'bg-blue-100' },
  { id: 'Applied', label: 'Applied', color: 'bg-yellow-100' },
  { id: 'Shortlisted', label: 'Shortlisted', color: 'bg-purple-100' },
  { id: 'Confirmed', label: 'Confirmed', color: 'bg-green-100' },
  { id: 'Attended', label: 'Attended', color: 'bg-teal-100' },
];

export default function TrackerPage() {
  const [entries, setEntries] = useState<Record<string, TrackerEntry[]>>({});
  const [loading, setLoading] = useState(true);
  const [selectedEntry, setSelectedEntry] = useState<TrackerEntry | null>(null);
  const [showDetailModal, setShowDetailModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);

  useEffect(() => {
    fetchTrackerEntries();
  }, []);

  const fetchTrackerEntries = async () => {
    try {
      setLoading(true);
      const response = await fetch('/api/tracker');
      if (!response.ok) throw new Error('Failed to fetch tracker entries');
      const data = await response.json();
      
      // Group by status
      const grouped: Record<string, TrackerEntry[]> = {};
      STATUS_COLUMNS.forEach(col => {
        grouped[col.id] = [];
      });
      
      data.entries.forEach((entry: TrackerEntry) => {
        if (grouped[entry.status]) {
          grouped[entry.status].push(entry);
        }
      });
      
      setEntries(grouped);
    } catch (err) {
      console.error('Error fetching tracker entries:', err);
    } finally {
      setLoading(false);
    }
  };

  const updateStatus = async (entryId: string, newStatus: string) => {
    try {
      const response = await fetch(`/api/tracker/${entryId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      
      if (!response.ok) throw new Error('Failed to update status');
      
      await fetchTrackerEntries();
    } catch (err) {
      console.error('Error updating status:', err);
    }
  };

  const openDetailModal = (entry: TrackerEntry) => {
    setSelectedEntry(entry);
    setShowDetailModal(true);
  };

  const openEditModal = (entry: TrackerEntry) => {
    setSelectedEntry(entry);
    setShowEditModal(true);
    setShowDetailModal(false);
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading tracker...</p>
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
              <h1 className="text-2xl font-bold text-gray-900">Event Tracker</h1>
              <p className="text-sm text-gray-600">Manage your event pipeline</p>
            </div>
            <div className="flex gap-2">
              <a
                href="/"
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                Feed
              </a>
              <button className="px-4 py-2 text-sm font-medium text-white bg-purple-600 rounded-lg hover:bg-purple-700">
                Tracker
              </button>
              <button className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50">
                Calendar
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Kanban Board */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex gap-4 overflow-x-auto pb-4">
          {STATUS_COLUMNS.map((column) => (
            <div key={column.id} className="flex-shrink-0 w-80">
              <div className={`${column.color} rounded-lg p-3 mb-3`}>
                <h3 className="font-semibold text-gray-900">
                  {column.label}
                  <span className="ml-2 text-sm text-gray-600">
                    ({entries[column.id]?.length || 0})
                  </span>
                </h3>
              </div>
              
              <div className="space-y-3">
                {entries[column.id]?.map((entry) => (
                  <div
                    key={entry._id}
                    className="bg-white rounded-lg shadow-sm p-4 border border-gray-200 hover:shadow-md transition-shadow cursor-pointer"
                    onClick={() => openDetailModal(entry)}
                  >
                    <h4 className="font-semibold text-gray-900 mb-2 line-clamp-2">
                      {entry.eventId.title}
                    </h4>
                    
                    <div className="text-sm text-gray-600 mb-2">
                      {format(new Date(entry.eventId.startDateTime), 'MMM dd, yyyy')}
                    </div>
                    
                    <div className="flex flex-wrap gap-1 mb-2">
                      {entry.eventId.category.slice(0, 2).map((cat) => (
                        <span
                          key={cat}
                          className="px-2 py-1 text-xs font-medium bg-gray-100 text-gray-700 rounded"
                        >
                          {cat}
                        </span>
                      ))}
                    </div>
                    
                    {entry.notes && (
                      <p className="text-xs text-gray-500 line-clamp-2 mb-2">
                        📝 {entry.notes}
                      </p>
                    )}
                    
                    {entry.connections.length > 0 && (
                      <div className="text-xs text-purple-600 font-medium">
                        👥 {entry.connections.length} connection{entry.connections.length > 1 ? 's' : ''}
                      </div>
                    )}
                    
                    {/* Status change buttons */}
                    <div className="mt-3 flex gap-1">
                      {column.id !== 'Attended' && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            const nextStatusIndex = STATUS_COLUMNS.findIndex(c => c.id === column.id) + 1;
                            if (nextStatusIndex < STATUS_COLUMNS.length) {
                              updateStatus(entry._id, STATUS_COLUMNS[nextStatusIndex].id);
                            }
                          }}
                          className="text-xs px-2 py-1 bg-gray-100 hover:bg-gray-200 rounded"
                        >
                          →
                        </button>
                      )}
                    </div>
                  </div>
                ))}
                
                {entries[column.id]?.length === 0 && (
                  <div className="text-center text-gray-400 text-sm py-8">
                    No events
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </main>

      {/* Detail Modal */}
      {showDetailModal && selectedEntry && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg max-w-2xl w-full max-h-[90vh] overflow-y-auto">
            <div className="p-6">
              <div className="flex justify-between items-start mb-4">
                <h2 className="text-2xl font-bold text-gray-900">
                  {selectedEntry.eventId.title}
                </h2>
                <button
                  onClick={() => setShowDetailModal(false)}
                  className="text-gray-400 hover:text-gray-600"
                >
                  ✕
                </button>
              </div>
              
              <div className="space-y-4">
                <div>
                  <label className="text-sm font-medium text-gray-700">Status</label>
                  <select
                    value={selectedEntry.status}
                    onChange={(e) => {
                      updateStatus(selectedEntry._id, e.target.value);
                      setShowDetailModal(false);
                    }}
                    className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-purple-500 focus:ring-purple-500"
                  >
                    {STATUS_COLUMNS.map(col => (
                      <option key={col.id} value={col.id}>{col.label}</option>
                    ))}
                  </select>
                </div>
                
                <div>
                  <label className="text-sm font-medium text-gray-700">Event Details</label>
                  <p className="mt-1 text-sm text-gray-600">{selectedEntry.eventId.description}</p>
                </div>
                
                <div>
                  <label className="text-sm font-medium text-gray-700">Date & Location</label>
                  <p className="mt-1 text-sm text-gray-600">
                    {format(new Date(selectedEntry.eventId.startDateTime), 'PPP p')}
                    {selectedEntry.eventId.venue && ` • ${selectedEntry.eventId.venue}`}
                  </p>
                </div>
                
                {selectedEntry.notes && (
                  <div>
                    <label className="text-sm font-medium text-gray-700">Notes</label>
                    <p className="mt-1 text-sm text-gray-600">{selectedEntry.notes}</p>
                  </div>
                )}
                
                {selectedEntry.connections.length > 0 && (
                  <div>
                    <label className="text-sm font-medium text-gray-700 mb-2 block">
                      Connections ({selectedEntry.connections.length})
                    </label>
                    <div className="space-y-2">
                      {selectedEntry.connections.map((conn, idx) => (
                        <div key={idx} className="p-3 bg-gray-50 rounded-lg">
                          <div className="font-medium text-gray-900">{conn.name}</div>
                          {conn.role && <div className="text-sm text-gray-600">{conn.role}</div>}
                          {conn.company && <div className="text-sm text-gray-600">{conn.company}</div>}
                          {conn.context && <div className="text-sm text-gray-500 mt-1">{conn.context}</div>}
                          {conn.linkedin && (
                            <a
                              href={conn.linkedin}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-sm text-purple-600 hover:underline mt-1 inline-block"
                            >
                              LinkedIn →
                            </a>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                
                <div className="flex gap-2 pt-4">
                  <a
                    href={selectedEntry.eventId.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-1 px-4 py-2 text-center text-white bg-purple-600 rounded-lg hover:bg-purple-700"
                  >
                    View Event
                  </a>
                  <button
                    onClick={() => setShowDetailModal(false)}
                    className="px-4 py-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200"
                  >
                    Close
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Made with Bob