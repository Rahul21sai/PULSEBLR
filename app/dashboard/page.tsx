'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { format } from 'date-fns';

interface Stats {
  totalEvents: number;
  eventsThisMonth: number;
  trackedEvents: number;
  attendedEvents: number;
  totalConnections: number;
  pendingFollowUps: number;
  targetCompanyEvents: number;
}

interface FollowUp {
  eventTitle: string;
  connection: {
    name: string;
    role?: string;
    company?: string;
    followUpAt: string;
  };
  trackerEntryId: string;
}

interface RepeatConnection {
  name: string;
  details: {
    role?: string;
    company?: string;
    linkedin?: string;
  };
  eventCount: number;
}

export default function DashboardPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [followUps, setFollowUps] = useState<FollowUp[]>([]);
  const [repeatConnections, setRepeatConnections] = useState<RepeatConnection[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    try {
      setLoading(true);
      
      const [statsRes, followUpsRes, repeatRes] = await Promise.all([
        fetch('/api/phase6/stats'),
        fetch('/api/phase6/follow-ups'),
        fetch('/api/phase6/repeat-connections'),
      ]);

      if (statsRes.ok) {
        const data = await statsRes.json();
        setStats(data.stats);
      }

      if (followUpsRes.ok) {
        const data = await followUpsRes.json();
        setFollowUps(data.followUps);
      }

      if (repeatRes.ok) {
        const data = await repeatRes.json();
        setRepeatConnections(data.repeatConnections);
      }
    } catch (err) {
      console.error('Failed to fetch dashboard data:', err);
    } finally {
      setLoading(false);
    }
  };

  const markFollowUpComplete = async (trackerEntryId: string, connectionName: string) => {
    try {
      const response = await fetch('/api/phase6/follow-ups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trackerEntryId, connectionName }),
      });

      if (response.ok) {
        fetchData(); // Refresh data
      }
    } catch (err) {
      alert('Failed to mark follow-up complete');
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading dashboard...</p>
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
              <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
              <p className="text-sm text-gray-600">Your event networking stats</p>
            </div>
            <Link
              href="/"
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
            >
              ← Back to Feed
            </Link>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Stats Grid */}
        {stats && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
            <div className="bg-white rounded-lg shadow-sm p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-600">Total Events</p>
                  <p className="text-3xl font-bold text-gray-900 mt-2">{stats.totalEvents}</p>
                </div>
                <div className="text-4xl">📅</div>
              </div>
              <p className="text-xs text-gray-500 mt-2">All time</p>
            </div>

            <div className="bg-white rounded-lg shadow-sm p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-600">This Month</p>
                  <p className="text-3xl font-bold text-purple-600 mt-2">{stats.eventsThisMonth}</p>
                </div>
                <div className="text-4xl">🆕</div>
              </div>
              <p className="text-xs text-gray-500 mt-2">New events added</p>
            </div>

            <div className="bg-white rounded-lg shadow-sm p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-600">Events Attended</p>
                  <p className="text-3xl font-bold text-green-600 mt-2">{stats.attendedEvents}</p>
                </div>
                <div className="text-4xl">✅</div>
              </div>
              <p className="text-xs text-gray-500 mt-2">Out of {stats.trackedEvents} tracked</p>
            </div>

            <div className="bg-white rounded-lg shadow-sm p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-600">Connections Made</p>
                  <p className="text-3xl font-bold text-blue-600 mt-2">{stats.totalConnections}</p>
                </div>
                <div className="text-4xl">🤝</div>
              </div>
              <p className="text-xs text-gray-500 mt-2">Total networking contacts</p>
            </div>

            <div className="bg-white rounded-lg shadow-sm p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-600">Pending Follow-ups</p>
                  <p className="text-3xl font-bold text-orange-600 mt-2">{stats.pendingFollowUps}</p>
                </div>
                <div className="text-4xl">⏰</div>
              </div>
              <p className="text-xs text-gray-500 mt-2">Action required</p>
            </div>

            <div className="bg-white rounded-lg shadow-sm p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-600">Target Companies</p>
                  <p className="text-3xl font-bold text-indigo-600 mt-2">{stats.targetCompanyEvents}</p>
                </div>
                <div className="text-4xl">🎯</div>
              </div>
              <p className="text-xs text-gray-500 mt-2">Events from target companies</p>
            </div>

            <div className="bg-white rounded-lg shadow-sm p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-600">Attendance Rate</p>
                  <p className="text-3xl font-bold text-teal-600 mt-2">
                    {stats.trackedEvents > 0 ? Math.round((stats.attendedEvents / stats.trackedEvents) * 100) : 0}%
                  </p>
                </div>
                <div className="text-4xl">📊</div>
              </div>
              <p className="text-xs text-gray-500 mt-2">Of tracked events</p>
            </div>

            <div className="bg-white rounded-lg shadow-sm p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-600">Avg Connections</p>
                  <p className="text-3xl font-bold text-pink-600 mt-2">
                    {stats.attendedEvents > 0 ? (stats.totalConnections / stats.attendedEvents).toFixed(1) : 0}
                  </p>
                </div>
                <div className="text-4xl">👥</div>
              </div>
              <p className="text-xs text-gray-500 mt-2">Per event attended</p>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          {/* Pending Follow-ups */}
          <section className="bg-white rounded-lg shadow-sm p-6">
            <h2 className="text-xl font-semibold text-gray-900 mb-4">⏰ Pending Follow-ups</h2>
            {followUps.length === 0 ? (
              <p className="text-gray-500 text-center py-8">No pending follow-ups! 🎉</p>
            ) : (
              <div className="space-y-3">
                {followUps.map((followUp, idx) => (
                  <div key={idx} className="border border-gray-200 rounded-lg p-4 hover:bg-gray-50">
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <h3 className="font-medium text-gray-900">{followUp.connection.name}</h3>
                        {followUp.connection.role && (
                          <p className="text-sm text-gray-600">
                            {followUp.connection.role}
                            {followUp.connection.company && ` @ ${followUp.connection.company}`}
                          </p>
                        )}
                        <p className="text-xs text-gray-500 mt-1">
                          From: {followUp.eventTitle}
                        </p>
                        <p className="text-xs text-orange-600 mt-1">
                          Due: {format(new Date(followUp.connection.followUpAt), 'MMM dd, yyyy')}
                        </p>
                      </div>
                      <button
                        onClick={() => markFollowUpComplete(followUp.trackerEntryId, followUp.connection.name)}
                        className="ml-4 px-3 py-1 text-sm bg-green-600 text-white rounded hover:bg-green-700"
                      >
                        Done
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Repeat Connections */}
          <section className="bg-white rounded-lg shadow-sm p-6">
            <h2 className="text-xl font-semibold text-gray-900 mb-4">🔄 Repeat Connections</h2>
            {repeatConnections.length === 0 ? (
              <p className="text-gray-500 text-center py-8">No repeat connections yet</p>
            ) : (
              <div className="space-y-3">
                {repeatConnections.slice(0, 10).map((connection, idx) => (
                  <div key={idx} className="border border-gray-200 rounded-lg p-4">
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <h3 className="font-medium text-gray-900">{connection.name}</h3>
                        {connection.details.role && (
                          <p className="text-sm text-gray-600">
                            {connection.details.role}
                            {connection.details.company && ` @ ${connection.details.company}`}
                          </p>
                        )}
                        <p className="text-xs text-purple-600 mt-1 font-medium">
                          Met at {connection.eventCount} events
                        </p>
                      </div>
                      {connection.details.linkedin && (
                        <a
                          href={connection.details.linkedin}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="ml-4 text-blue-600 hover:text-blue-700"
                        >
                          <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                            <path d="M19 0h-14c-2.761 0-5 2.239-5 5v14c0 2.761 2.239 5 5 5h14c2.762 0 5-2.239 5-5v-14c0-2.761-2.238-5-5-5zm-11 19h-3v-11h3v11zm-1.5-12.268c-.966 0-1.75-.79-1.75-1.764s.784-1.764 1.75-1.764 1.75.79 1.75 1.764-.783 1.764-1.75 1.764zm13.5 12.268h-3v-5.604c0-3.368-4-3.113-4 0v5.604h-3v-11h3v1.765c1.396-2.586 7-2.777 7 2.476v6.759z"/>
                          </svg>
                        </a>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}

// Made with Bob
