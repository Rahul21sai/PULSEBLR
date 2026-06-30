'use client';

import { useEffect, useState } from 'react';

interface Source {
  _id: string;
  name: string;
  type: 'ical' | 'rss' | 'api' | 'scrape';
  url: string;
  enabled: boolean;
  lastScrapedAt?: string;
  scrapeFrequency: string;
}

const NAV_LINKS = [
  { href: '/', label: 'Feed', icon: 'rss_feed' },
  { href: '/calendar', label: 'Calendar', icon: 'calendar_today' },
  { href: '/tracker', label: 'Tracker', icon: 'analytics' },
  { href: '/add-event', label: 'Add', icon: 'add_circle' },
  { href: '/settings', label: 'Settings', icon: 'settings' },
];

export default function SettingsPage() {
  const [sources, setSources] = useState<Source[]>([]);
  const [loading, setLoading] = useState(true);
  const [scraping, setScraping] = useState(false);
  const [notificationEmail, setNotificationEmail] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchSources();
    const saved = localStorage.getItem('notificationEmail');
    if (saved) setNotificationEmail(saved);
  }, []);

  const fetchSources = async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/sources');
      if (res.ok) setSources((await res.json()).sources || []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const saveSettings = async () => {
    setSaving(true);
    localStorage.setItem('notificationEmail', notificationEmail);
    await new Promise(r => setTimeout(r, 400));
    setSaving(false);
    // toast-like feedback without alert
  };

  const toggleSource = async (sourceId: string, enabled: boolean) => {
    await fetch(`/api/sources/${sourceId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    setSources(prev => prev.map(s => s._id === sourceId ? { ...s, enabled } : s));
  };

  const triggerScrape = async () => {
    if (!confirm('Run scraper now?')) return;
    setScraping(true);
    try {
      const res = await fetch('/api/scrape', { method: 'POST' });
      if (res.ok) { alert('Scraper triggered! Check back in a few minutes.'); fetchSources(); }
      else alert('Failed to trigger scraper');
    } catch {
      alert('Failed to trigger scraper');
    } finally {
      setScraping(false);
    }
  };

  const sourceIcon = (type: string) => {
    if (type === 'rss') return { icon: 'rss_feed', bg: 'bg-orange-500' };
    if (type === 'ical') return { icon: 'event', bg: 'bg-blue-500' };
    if (type === 'api') return { icon: 'api', bg: 'bg-green-500' };
    return { icon: 'travel_explore', bg: 'bg-purple-500' };
  };

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
                  link.href === '/settings'
                    ? 'text-[#0071E3] font-semibold border-b-2 border-[#0071E3] pb-0.5'
                    : 'text-[#86868B] hover:text-[#1D1D1F]'
                }`}>
                {link.label}
              </a>
            ))}
          </div>
          <a href="/dashboard" className="text-[#86868B] hover:text-[#0071E3] transition-colors">
            <span className="material-symbols-outlined text-[24px]">account_circle</span>
          </a>
        </div>
      </nav>

      {/* Mobile Header */}
      <header className="md:hidden fixed top-0 w-full h-14 bg-white/70 glass-nav z-50 border-b border-black/5 flex items-center justify-between px-5">
        <a href="/" className="text-lg font-bold tracking-tight text-[#1D1D1F]">PulseBLR</a>
        <span className="text-[#86868B] text-label-md font-semibold">Settings</span>
      </header>

      <main className="pt-14 pb-24 md:pb-8">

        {/* Hero */}
        <section className="bg-black text-white px-5 md:px-20 pt-12 pb-10">
          <div className="max-w-[760px] mx-auto">
            <h1 className="text-display-lg-mobile md:text-display-lg mb-1">Settings</h1>
            <p className="text-body-md text-gray-400">Manage sources and preferences</p>
          </div>
        </section>

        <div className="max-w-[760px] mx-auto px-5 md:px-0 py-6 space-y-5">

          {/* ── Account section (iOS style) ── */}
          <section className="bg-white rounded-[20px] card-shadow overflow-hidden">
            <div className="flex items-center px-5 py-4 hover:bg-[#f7f7f7] transition-colors cursor-pointer group">
              <div className="w-14 h-14 rounded-full bg-[#f3f3f5] flex items-center justify-center mr-4 shrink-0 overflow-hidden">
                <span className="material-symbols-outlined text-[#86868B] text-[32px]" style={{ fontVariationSettings: "'FILL' 1" }}>person</span>
              </div>
              <div className="flex-1">
                <p className="text-body-md font-semibold text-[#1D1D1F]">User Profile</p>
                <p className="text-label-md text-[#86868B]">Apple ID, iCloud, Media & Purchases</p>
              </div>
              <span className="material-symbols-outlined text-[#c7c7cc] group-hover:text-[#86868B] transition-colors">chevron_right</span>
            </div>
          </section>

          {/* ── Data Sources ── */}
          <section className="bg-white rounded-[20px] card-shadow overflow-hidden">
            <div className="flex items-center justify-between px-5 pt-5 pb-4 border-b border-[#f0f0f0]">
              <div className="flex items-center gap-3">
                <div className="w-7 h-7 rounded-lg bg-[#34C759] flex items-center justify-center shrink-0">
                  <span className="material-symbols-outlined text-white text-[14px]" style={{ fontVariationSettings: "'FILL' 1" }}>dataset</span>
                </div>
                <div>
                  <h2 className="text-label-md font-semibold text-[#1D1D1F]">Event Sources</h2>
                  <p className="text-label-sm text-[#86868B]">Manage scraper sources</p>
                </div>
              </div>
              <button
                onClick={triggerScrape}
                disabled={scraping}
                className="flex items-center gap-1.5 bg-black text-white text-label-sm font-semibold px-4 py-2 rounded-full hover:bg-gray-800 transition-colors disabled:opacity-50"
              >
                <span className={`material-symbols-outlined text-[14px] ${scraping ? 'animate-spin' : ''}`}>sync</span>
                {scraping ? 'Running…' : 'Run Now'}
              </button>
            </div>

            {loading ? (
              <div className="flex justify-center py-8">
                <div className="spinner" />
              </div>
            ) : sources.length === 0 ? (
              <div className="text-center py-10 px-5">
                <span className="material-symbols-outlined text-[40px] text-[#e5e5e5] block mb-2">cloud_off</span>
                <p className="text-[#86868B] text-body-md">No sources configured yet</p>
                <p className="text-label-sm text-[#86868B] mt-1">Sources appear after the scraper runs</p>
              </div>
            ) : (
              <div>
                {sources.map((source, idx) => {
                  const { icon, bg } = sourceIcon(source.type);
                  return (
                    <div key={source._id} className={`flex items-center gap-4 px-5 py-4 hover:bg-[#f7f7f7] transition-colors ${idx < sources.length - 1 ? 'border-b border-[#f0f0f0]' : ''}`}>
                      <div className={`w-7 h-7 rounded-lg ${bg} flex items-center justify-center shrink-0`}>
                        <span className="material-symbols-outlined text-white text-[14px]" style={{ fontVariationSettings: "'FILL' 1" }}>{icon}</span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-label-md font-semibold text-[#1D1D1F] truncate">{source.name}</p>
                        <p className="text-label-sm text-[#86868B] truncate">{source.url}</p>
                        {source.lastScrapedAt && (
                          <p className="text-[11px] text-[#86868B] mt-0.5">
                            Last: {new Date(source.lastScrapedAt).toLocaleString()}
                          </p>
                        )}
                      </div>
                      {/* iOS toggle */}
                      <label className="relative shrink-0 ml-2 inline-flex items-center cursor-pointer">
                        <input
                          type="checkbox"
                          checked={source.enabled}
                          onChange={e => toggleSource(source._id, e.target.checked)}
                          className="sr-only peer"
                        />
                        <div className="w-11 h-6 bg-[#e5e5e5] rounded-full peer peer-checked:after:translate-x-[20px] peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[3px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[#0071E3]" />
                      </label>
                      <span className="material-symbols-outlined text-[18px] text-[#c7c7cc] shrink-0">chevron_right</span>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* ── Notifications ── */}
          <section className="bg-white rounded-[20px] card-shadow overflow-hidden">
            <div className="flex items-center gap-3 px-5 pt-5 pb-4 border-b border-[#f0f0f0]">
              <div className="w-7 h-7 rounded-lg bg-[#0071E3] flex items-center justify-center shrink-0">
                <span className="material-symbols-outlined text-white text-[14px]" style={{ fontVariationSettings: "'FILL' 1" }}>notifications</span>
              </div>
              <h2 className="text-label-md font-semibold text-[#1D1D1F]">Notifications</h2>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <label className="block text-label-sm uppercase tracking-widest text-[#86868B] mb-2">Digest Email</label>
                <input
                  type="email"
                  value={notificationEmail}
                  onChange={e => setNotificationEmail(e.target.value)}
                  placeholder="your.email@example.com"
                  className="w-full px-4 py-3 border border-[#e5e5e5] rounded-xl text-label-md text-[#1D1D1F] focus:outline-none focus:border-[#0071E3] transition-colors bg-[#f9f9fb]"
                />
                <p className="text-label-sm text-[#86868B] mt-1.5">Daily digest sent at 8 AM IST via GitHub Actions</p>
              </div>
              <button
                onClick={saveSettings}
                disabled={saving}
                className="bg-black text-white text-label-md font-semibold px-6 py-2.5 rounded-full hover:bg-gray-800 transition-colors disabled:opacity-50 flex items-center gap-2"
              >
                {saving ? (
                  <>
                    <span className="material-symbols-outlined text-[14px] animate-spin">sync</span>
                    Saving…
                  </>
                ) : (
                  <>
                    <span className="material-symbols-outlined text-[14px]">save</span>
                    Save Settings
                  </>
                )}
              </button>
            </div>
          </section>

          {/* ── Preferences toggles ── */}
          <section className="bg-white rounded-[20px] card-shadow overflow-hidden">
            {[
              { icon: 'sync', bg: 'bg-[#34C759]', label: 'Background Refresh', description: 'Auto-fetch new events', defaultChecked: true },
              { icon: 'location_on', bg: 'bg-[#007AFF]', label: 'Location Services', description: 'Prioritize nearby events' },
            ].map((item, idx, arr) => (
              <div key={item.label} className={`flex items-center justify-between px-5 py-4 ${idx < arr.length - 1 ? 'border-b border-[#f0f0f0]' : ''}`}>
                <div className="flex items-center gap-3">
                  <div className={`w-7 h-7 rounded-lg ${item.bg} flex items-center justify-center shrink-0`}>
                    <span className="material-symbols-outlined text-white text-[14px]" style={{ fontVariationSettings: "'FILL' 1" }}>{item.icon}</span>
                  </div>
                  <div>
                    <span className="block text-label-md text-[#1D1D1F]">{item.label}</span>
                    <span className="text-label-sm text-[#86868B]">{item.description}</span>
                  </div>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input type="checkbox" defaultChecked={item.defaultChecked} className="sr-only peer" />
                  <div className="w-11 h-6 bg-[#e5e5e5] rounded-full peer peer-checked:after:translate-x-[20px] peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[3px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[#34C759]" />
                </label>
              </div>
            ))}
          </section>

          {/* ── Support / About ── */}
          <section className="bg-white rounded-[20px] card-shadow overflow-hidden">
            {[
              { icon: 'help', bg: 'bg-[#FF9500]', label: 'Help & Support', chevron: true },
              { icon: 'info', bg: 'bg-[#86868B]', label: 'About PulseBLR', chevron: true },
            ].map((item, idx, arr) => (
              <div key={item.label} className={`flex items-center px-5 py-4 hover:bg-[#f7f7f7] transition-colors cursor-pointer group ${idx < arr.length - 1 ? 'border-b border-[#f0f0f0]' : ''}`}>
                <div className={`w-7 h-7 rounded-lg ${item.bg} flex items-center justify-center mr-3 shrink-0`}>
                  <span className="material-symbols-outlined text-white text-[14px]" style={{ fontVariationSettings: "'FILL' 1" }}>{item.icon}</span>
                </div>
                <span className="flex-1 text-label-md text-[#1D1D1F]">{item.label}</span>
                <span className="material-symbols-outlined text-[#c7c7cc] group-hover:text-[#86868B] transition-colors">chevron_right</span>
              </div>
            ))}
          </section>

          {/* Stack info */}
          <section className="bg-white rounded-[20px] card-shadow overflow-hidden">
            {[
              { icon: 'tag', bg: 'bg-[#5856D6]', label: 'Version', value: '1.0.0' },
              { icon: 'layers', bg: 'bg-[#007AFF]', label: 'Stack', value: 'Next.js 16 · MongoDB · Claude AI' },
              { icon: 'star', bg: 'bg-[#FF9500]', label: 'Features', value: 'Events · Tracker · Networking · Digest' },
            ].map((row, idx, arr) => (
              <div key={row.label} className={`flex items-center gap-4 px-5 py-4 ${idx < arr.length - 1 ? 'border-b border-[#f0f0f0]' : ''}`}>
                <div className={`w-7 h-7 rounded-lg ${row.bg} flex items-center justify-center shrink-0`}>
                  <span className="material-symbols-outlined text-white text-[14px]" style={{ fontVariationSettings: "'FILL' 1" }}>{row.icon}</span>
                </div>
                <div className="flex-1">
                  <p className="text-label-md font-semibold text-[#1D1D1F]">{row.label}</p>
                  <p className="text-label-sm text-[#86868B]">{row.value}</p>
                </div>
              </div>
            ))}
            <div className="px-5 py-4 border-t border-[#f0f0f0] text-center">
              <p className="text-label-sm text-[#86868B]">Built with ❤️ for the Bangalore tech community</p>
            </div>
          </section>

          {/* Sign out */}
          <div className="text-center pb-4">
            <button className="text-[#FF3B30] text-label-md font-medium hover:opacity-70 transition-opacity">
              Sign Out
            </button>
          </div>

        </div>
      </main>

      {/* Mobile Bottom Nav */}
      <nav className="fixed bottom-0 w-full md:hidden bg-white/70 glass-nav border-t border-black/5 flex justify-around items-center px-4 py-2 z-50 rounded-t-2xl">
        {NAV_LINKS.map(link => {
          const isActive = link.href === '/settings';
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
