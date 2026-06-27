'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

interface Source {
  _id: string;
  name: string;
  type: 'ical' | 'rss' | 'api' | 'scrape';
  url: string;
  enabled: boolean;
  lastScrapedAt?: string;
  scrapeFrequency: string;
}

export default function SettingsPage() {
  const [sources, setSources] = useState<Source[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notificationTime, setNotificationTime] = useState('08:00');
  const [notificationEmail, setNotificationEmail] = useState('');

  useEffect(() => {
    fetchSources();
    loadSettings();
  }, []);

  const fetchSources = async () => {
    try {
      setLoading(true);
      const response = await fetch('/api/sources');
      if (response.ok) {
        const data = await response.json();
        setSources(data.sources || []);
      }
    } catch (err) {
      console.error('Failed to fetch sources:', err);
    } finally {
      setLoading(false);
    }
  };

  const loadSettings = () => {
    // Load from localStorage
    const savedEmail = localStorage.getItem('notificationEmail');
    const savedTime = localStorage.getItem('notificationTime');
    if (savedEmail) setNotificationEmail(savedEmail);
    if (savedTime) setNotificationTime(savedTime);
  };

  const saveSettings = async () => {
    setSaving(true);
    try {
      // Save to localStorage
      localStorage.setItem('notificationEmail', notificationEmail);
      localStorage.setItem('notificationTime', notificationTime);
      alert('Settings saved successfully!');
    } catch (err) {
      alert('Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  const toggleSource = async (sourceId: string, enabled: boolean) => {
    try {
      const response = await fetch(`/api/sources/${sourceId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });

      if (response.ok) {
        setSources(sources.map(s => 
          s._id === sourceId ? { ...s, enabled } : s
        ));
      }
    } catch (err) {
      alert('Failed to update source');
    }
  };

  const triggerScrape = async () => {
    if (!confirm('This will manually trigger the scraper. Continue?')) return;
    
    try {
      const response = await fetch('/api/scrape', { method: 'POST' });
      if (response.ok) {
        alert('Scraper triggered successfully! Check back in a few minutes.');
        fetchSources();
      } else {
        alert('Failed to trigger scraper');
      }
    } catch (err) {
      alert('Failed to trigger scraper');
    }
  };

  const getSourceTypeColor = (type: string) => {
    const colors: Record<string, string> = {
      rss: 'bg-orange-100 text-orange-800',
      ical: 'bg-blue-100 text-blue-800',
      api: 'bg-green-100 text-green-800',
      scrape: 'bg-purple-100 text-purple-800',
    };
    return colors[type] || 'bg-gray-100 text-gray-800';
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white shadow-sm sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Settings</h1>
              <p className="text-sm text-gray-600">Manage sources and preferences</p>
            </div>
            <div className="flex gap-2">
              <Link
                href="/"
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                ← Back to Feed
              </Link>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="space-y-8">
          {/* Notification Settings */}
          <section className="bg-white rounded-lg shadow-sm p-6">
            <h2 className="text-xl font-semibold text-gray-900 mb-4">Notification Settings</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Email Address
                </label>
                <input
                  type="email"
                  value={notificationEmail}
                  onChange={(e) => setNotificationEmail(e.target.value)}
                  placeholder="your.email@example.com"
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                />
                <p className="mt-1 text-sm text-gray-500">
                  Daily digest will be sent to this email
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Daily Digest Time
                </label>
                <input
                  type="time"
                  value={notificationTime}
                  onChange={(e) => setNotificationTime(e.target.value)}
                  className="px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                />
                <p className="mt-1 text-sm text-gray-500">
                  Currently set to 8:00 AM IST via GitHub Actions
                </p>
              </div>

              <button
                onClick={saveSettings}
                disabled={saving}
                className="px-6 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Save Settings'}
              </button>
            </div>
          </section>

          {/* Event Sources */}
          <section className="bg-white rounded-lg shadow-sm p-6">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-xl font-semibold text-gray-900">Event Sources</h2>
                <p className="text-sm text-gray-600 mt-1">
                  Manage where events are scraped from
                </p>
              </div>
              <button
                onClick={triggerScrape}
                className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 text-sm font-medium"
              >
                🔄 Run Scraper Now
              </button>
            </div>

            {loading ? (
              <div className="text-center py-8">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-purple-600 mx-auto"></div>
                <p className="mt-2 text-gray-600">Loading sources...</p>
              </div>
            ) : sources.length === 0 ? (
              <div className="text-center py-8 text-gray-500">
                <p>No sources configured yet</p>
                <p className="text-sm mt-1">Sources will appear here once the scraper runs</p>
              </div>
            ) : (
              <div className="space-y-3">
                {sources.map((source) => (
                  <div
                    key={source._id}
                    className="flex items-center justify-between p-4 border border-gray-200 rounded-lg hover:bg-gray-50"
                  >
                    <div className="flex-1">
                      <div className="flex items-center gap-3 mb-2">
                        <h3 className="font-medium text-gray-900">{source.name}</h3>
                        <span className={`px-2 py-1 text-xs font-medium rounded-full ${getSourceTypeColor(source.type)}`}>
                          {source.type.toUpperCase()}
                        </span>
                      </div>
                      <p className="text-sm text-gray-600 mb-1">{source.url}</p>
                      {source.lastScrapedAt && (
                        <p className="text-xs text-gray-500">
                          Last scraped: {new Date(source.lastScrapedAt).toLocaleString()}
                        </p>
                      )}
                    </div>
                    <label className="flex items-center cursor-pointer">
                      <input
                        type="checkbox"
                        checked={source.enabled}
                        onChange={(e) => toggleSource(source._id, e.target.checked)}
                        className="sr-only peer"
                      />
                      <div className="relative w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-purple-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-purple-600"></div>
                    </label>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* About */}
          <section className="bg-white rounded-lg shadow-sm p-6">
            <h2 className="text-xl font-semibold text-gray-900 mb-4">About PulseBLR</h2>
            <div className="space-y-2 text-sm text-gray-600">
              <p>
                <strong>Version:</strong> 1.0.0
              </p>
              <p>
                <strong>Description:</strong> Your personal hub for discovering and tracking tech events in Bangalore
              </p>
              <p>
                <strong>Features:</strong> Event aggregation, personal tracker, networking log, daily digest
              </p>
              <p className="pt-4 text-xs text-gray-500">
                Built with Next.js, MongoDB, and Claude AI • Made with ❤️ for Bangalore tech community
              </p>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}

// Made with Bob
