'use client';

import { useEffect, useState } from 'react';
import { format } from 'date-fns';
import EditTrackerModal from './components/EditTrackerModal';
import { DesktopNav, MobileBottomNav } from '../components/NavBar';

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
  { id: 'New',         label: 'New',         accent: 'border-l-gray-400',    headerColor: 'text-gray-500' },
  { id: 'Interested',  label: 'Interested',  accent: 'border-l-blue-400',    headerColor: 'text-blue-500' },
  { id: 'Applied',     label: 'Applied',     accent: 'border-l-yellow-400',  headerColor: 'text-yellow-600' },
  { id: 'Shortlisted', label: 'Shortlisted', accent: 'border-l-purple-400',  headerColor: 'text-purple-500' },
  { id: 'Confirmed',   label: 'Confirmed',   accent: 'border-l-green-400',   headerColor: 'text-green-500' },
  { id: 'Attended',    label: 'Attended',    accent: 'border-l-teal-400',    headerColor: 'text-teal-500' },
  { id: 'Skipped',     label: 'Skipped',     dot: 'bg-gray-300',              accent: 'border-l-gray-300',   headerColor: 'text-gray-400' },
];

const CAT_PILL: Record<string, string> = {
  'AI/ML': 'bg-blue-50 text-blue-700',
  'Fintech': 'bg-green-50 text-green-700',
  'Networking/Meetup': 'bg-orange-50 text-orange-700',
  'Cybersecurity': 'bg-red-50 text-red-700',
  'Cloud/DevOps': 'bg-sky-50 text-sky-700',
  'Data/Analytics': 'bg-purple-50 text-purple-700',
  'Hackathon': 'bg-pink-50 text-pink-700',
};

export default function TrackerPage() {
  const [entries, setEntries] = useState<Record<string, TrackerEntry[]>>({});
  const [loading, setLoading] = useState(true);
  const [selectedEntry, setSelectedEntry] = useState<TrackerEntry | null>(null);
  const [showDetailModal, setShowDetailModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);

  useEffect(() => { fetchTrackerEntries(); }, []);

  const fetchTrackerEntries = async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/tracker');
      if (!res.ok) throw new Error('Failed to fetch');
      const data = await res.json();
      const grouped: Record<string, TrackerEntry[]> = {};
      STATUS_COLUMNS.forEach(col => { grouped[col.id] = []; });
      data.entries.forEach((entry: TrackerEntry) => {
        if (grouped[entry.status]) grouped[entry.status].push(entry);
        else grouped['New'] = [...(grouped['New'] || []), entry];
      });
      setEntries(grouped);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const updateStatus = async (entryId: string, newStatus: string) => {
    try {
      await fetch(`/api/tracker/${entryId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      await fetchTrackerEntries();
    } catch (err) {
      console.error(err);
    }
  };

  const totalTracked = Object.values(entries).reduce((acc, arr) => acc + arr.length, 0);

  return (
    <div className="min-h-screen bg-[#F5F5F7]">
      <DesktopNav />

      {/* Mobile Header */}
      <header className="md:hidden fixed top-0 w-full h-14 bg-white/70 glass-nav z-50 border-b border-black/5 flex items-center justify-between px-5">
        <a href="/" className="text-lg font-bold tracking-tight text-[#1D1D1F]">PulseBLR</a>
        <span className="text-[#86868B] text-label-md font-semibold">Tracker</span>
      </header>

      {/* Hero */}
      <div className="pt-14">
        <section className="bg-black text-white px-5 md:px-20 pt-10 pb-8">
          <div className="max-w-[1200px] mx-auto flex items-end justify-between">
            <div>
              <h1 className="text-display-lg-mobile md:text-display-lg mb-1">My Tracker</h1>
              <p className="text-body-md text-gray-400">Your personal event pipeline</p>
            </div>
            <div className="text-right">
              <p className="text-[40px] font-bold text-white leading-none">{totalTracked}</p>
              <p className="text-gray-400 text-label-md mt-1">events tracked</p>
            </div>
          </div>
        </section>
      </div>

      {loading ? (
        <div className="flex justify-center items-center py-24">
          <div className="spinner" />
        </div>
      ) : (
        <>
          {/* Pipeline summary chips */}
          <div className="max-w-[1200px] mx-auto px-5 md:px-20 pt-5 pb-2">
            <div className="flex items-center gap-2 overflow-x-auto no-scrollbar">
              {STATUS_COLUMNS.map(col => (
                <div key={col.id} className="flex items-center gap-1.5 shrink-0 bg-white px-4 py-2 rounded-full card-shadow text-label-md text-[#1D1D1F]">
                  <span className={`w-2 h-2 rounded-full border-l-4 ${col.accent} inline-block opacity-80`} />
                  {col.label}
                  <span className="text-[#86868B] ml-0.5">({entries[col.id]?.length || 0})</span>
                </div>
              ))}
            </div>
          </div>

          {/* Kanban Board — Stitch spec: full height, columns with bg-surface-container-low */}
          <div className="overflow-x-auto no-scrollbar pb-24 md:pb-8">
            <div
              className="flex gap-5 px-5 md:px-20 pt-4 pb-6"
              style={{ minWidth: 'max-content', minHeight: 'calc(100vh - 280px)' }}
            >
              {STATUS_COLUMNS.map(col => (
                <div key={col.id} className="w-72 flex flex-col flex-shrink-0 bg-[#f3f3f5] rounded-xl overflow-hidden">

                  {/* Column Header — sticky with glassmorphism, Stitch spec */}
                  <div className="sticky top-14 z-20 bg-[#f3f3f5]/90 backdrop-blur-md px-4 py-3 border-b border-[#e5e5e5] flex items-center justify-between">
                    <h2 className={`text-label-md font-bold ${col.headerColor}`}>{col.label}</h2>
                    <span className="bg-white text-[#86868B] font-label-sm text-[11px] px-2 py-0.5 rounded-full border border-[#e5e5e5]">
                      {entries[col.id]?.length || 0}
                    </span>
                  </div>

                  {/* Cards area */}
                  <div className="flex flex-col gap-3 p-3 flex-1">
                    {entries[col.id]?.map(entry => (
                      <div
                        key={entry._id}
                        onClick={() => { setSelectedEntry(entry); setShowDetailModal(true); }}
                        className={`bg-white rounded-[20px] shadow-[0_4px_30px_rgba(0,0,0,0.04)] p-4 cursor-pointer hover:scale-[1.02] transition-transform duration-200 border-l-[3px] ${col.accent}`}
                      >
                        {/* Category tags */}
                        <div className="flex flex-wrap gap-1 mb-2">
                          {entry.eventId.category.slice(0, 2).map(cat => (
                            <span key={cat} className={`text-[10px] font-semibold px-2 py-0.5 rounded-full uppercase tracking-wide ${CAT_PILL[cat] || 'bg-gray-100 text-gray-600'}`}>
                              {cat}
                            </span>
                          ))}
                        </div>

                        <h4 className="text-label-md font-semibold text-[#1D1D1F] line-clamp-2 leading-snug mb-2">
                          {entry.eventId.title}
                        </h4>

                        <div className="flex items-center gap-1 text-[11px] text-[#86868B] mb-3">
                          <span className="material-symbols-outlined text-[12px]">calendar_today</span>
                          {format(new Date(entry.eventId.startDateTime), 'MMM d, yyyy')}
                        </div>

                        {entry.connections.length > 0 && (
                          <div className="flex items-center gap-1 text-[11px] text-[#0071E3] font-medium mb-3">
                            <span className="material-symbols-outlined text-[13px]">group</span>
                            {entry.connections.length} connection{entry.connections.length > 1 ? 's' : ''}
                          </div>
                        )}

                        {/* Advance button */}
                        {col.id !== 'Attended' && col.id !== 'Skipped' && (
                          <div className="pt-3 border-t border-[#f0f0f0]">
                            <button
                              onClick={e => {
                                e.stopPropagation();
                                const nextIdx = STATUS_COLUMNS.findIndex(c => c.id === col.id) + 1;
                                if (nextIdx < STATUS_COLUMNS.length) {
                                  updateStatus(entry._id, STATUS_COLUMNS[nextIdx].id);
                                }
                              }}
                              className="w-full text-[11px] font-semibold text-[#0071E3] bg-blue-50 hover:bg-blue-100 py-1.5 rounded-full transition-colors"
                            >
                              Move to {STATUS_COLUMNS[STATUS_COLUMNS.findIndex(c => c.id === col.id) + 1]?.label} →
                            </button>
                          </div>
                        )}
                      </div>
                    ))}

                    {entries[col.id]?.length === 0 && (
                      <div className="flex flex-col items-center justify-center h-32 text-[#86868B]">
                        <span className="material-symbols-outlined text-[28px] text-[#d5d5d5] block mb-1">
                          {col.id === 'Attended' ? 'history' : col.id === 'Skipped' ? 'block' : 'inbox'}
                        </span>
                        <span className="text-label-sm text-[#c7c7cc]">Empty</span>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {/* ── Detail Modal ── */}
      {showDetailModal && selectedEntry && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-end md:items-center justify-center z-50 p-0 md:p-4">
          <div className="bg-white rounded-t-3xl md:rounded-[20px] w-full md:max-w-xl max-h-[90vh] overflow-y-auto">
            <div className="flex justify-center pt-3 pb-1 md:hidden">
              <div className="w-10 h-1 bg-[#e5e5e5] rounded-full" />
            </div>
            <div className="p-6">
              <div className="flex items-start justify-between mb-5">
                <h2 className="text-headline-md text-[#1D1D1F] leading-snug flex-1 pr-4">
                  {selectedEntry.eventId.title}
                </h2>
                <button
                  onClick={() => setShowDetailModal(false)}
                  className="w-8 h-8 rounded-full bg-[#f3f3f5] flex items-center justify-center hover:bg-[#e8e8ea] transition-colors shrink-0"
                >
                  <span className="material-symbols-outlined text-[18px]">close</span>
                </button>
              </div>

              <div className="mb-5">
                <label className="block text-label-sm uppercase tracking-widest text-[#86868B] mb-2">Status</label>
                <select
                  value={selectedEntry.status}
                  onChange={e => { updateStatus(selectedEntry._id, e.target.value); setShowDetailModal(false); }}
                  className="w-full px-4 py-2.5 border border-[#e5e5e5] rounded-xl text-label-md text-[#1D1D1F] focus:outline-none focus:border-[#0071E3] bg-white"
                >
                  {STATUS_COLUMNS.map(col => (
                    <option key={col.id} value={col.id}>{col.label}</option>
                  ))}
                </select>
              </div>

              <div className="bg-[#f7f7f7] rounded-xl p-4 mb-5 space-y-2 text-label-md text-[#86868B]">
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-[16px]">calendar_month</span>
                  {format(new Date(selectedEntry.eventId.startDateTime), 'PPP p')}
                </div>
                {selectedEntry.eventId.venue && (
                  <div className="flex items-center gap-2">
                    <span className="material-symbols-outlined text-[16px]">location_on</span>
                    {selectedEntry.eventId.venue}
                  </div>
                )}
              </div>

              {selectedEntry.notes && (
                <div className="mb-5">
                  <label className="block text-label-sm uppercase tracking-widest text-[#86868B] mb-2">Notes</label>
                  <p className="text-label-md text-[#1D1D1F] bg-[#f7f7f7] rounded-xl p-4">{selectedEntry.notes}</p>
                </div>
              )}

              {selectedEntry.connections.length > 0 && (
                <div className="mb-5">
                  <label className="block text-label-sm uppercase tracking-widest text-[#86868B] mb-2">
                    Connections ({selectedEntry.connections.length})
                  </label>
                  <div className="space-y-2">
                    {selectedEntry.connections.map((conn, idx) => (
                      <div key={idx} className="bg-[#f7f7f7] rounded-xl p-3">
                        <p className="text-label-md font-semibold text-[#1D1D1F]">{conn.name}</p>
                        {conn.role && (
                          <p className="text-label-sm text-[#86868B]">
                            {conn.role}{conn.company ? ` @ ${conn.company}` : ''}
                          </p>
                        )}
                        {conn.linkedin && (
                          <a href={conn.linkedin} target="_blank" rel="noopener noreferrer"
                            className="text-label-sm text-[#0071E3] mt-1 inline-block">
                            LinkedIn →
                          </a>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex gap-3">
                <a href={selectedEntry.eventId.sourceUrl} target="_blank" rel="noopener noreferrer"
                  className="flex-1 bg-black text-white text-label-md font-semibold py-3 rounded-full text-center hover:bg-gray-800 transition-colors">
                  View Event
                </a>
                <button
                  onClick={() => { setShowDetailModal(false); setShowEditModal(true); }}
                  className="px-6 py-3 bg-[#f3f3f5] text-[#1D1D1F] text-label-md font-semibold rounded-full hover:bg-[#e8e8ea] transition-colors">
                  Edit
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showEditModal && selectedEntry && (
        <EditTrackerModal
          entryId={selectedEntry._id}
          currentNotes={selectedEntry.notes}
          currentConnections={selectedEntry.connections}
          onClose={() => setShowEditModal(false)}
          onSave={() => { setShowEditModal(false); fetchTrackerEntries(); }}
        />
      )}

      <MobileBottomNav />
    </div>
  );
}
