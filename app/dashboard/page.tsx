'use client';

import { useEffect, useState } from 'react';
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
  details: { role?: string; company?: string; linkedin?: string };
  eventCount: number;
}

const NAV_LINKS = [
  { href: '/', label: 'Feed', icon: 'rss_feed' },
  { href: '/calendar', label: 'Calendar', icon: 'calendar_today' },
  { href: '/tracker', label: 'Tracker', icon: 'analytics' },
  { href: '/add-event', label: 'Add', icon: 'add_circle' },
  { href: '/settings', label: 'Settings', icon: 'settings' },
];

const STAT_CARDS = (stats: Stats) => [
  { label: 'Total Events',     value: stats.totalEvents,    sub: 'In database',        iconBg: 'bg-[#1D1D1F]',  textColor: 'text-[#1D1D1F]', cardBg: 'bg-white',       icon: 'event' },
  { label: 'This Month',       value: stats.eventsThisMonth, sub: 'New events',         iconBg: 'bg-[#0071E3]',  textColor: 'text-[#0071E3]', cardBg: 'bg-blue-50',     icon: 'calendar_today' },
  { label: 'Attended',         value: stats.attendedEvents, sub: `of ${stats.trackedEvents} tracked`, iconBg: 'bg-green-500',  textColor: 'text-green-600', cardBg: 'bg-green-50',    icon: 'check_circle' },
  { label: 'Connections',      value: stats.totalConnections, sub: 'Total contacts',    iconBg: 'bg-purple-500', textColor: 'text-purple-600', cardBg: 'bg-purple-50',   icon: 'group' },
  { label: 'Follow-ups',       value: stats.pendingFollowUps, sub: 'Action required',   iconBg: 'bg-orange-500', textColor: 'text-orange-600', cardBg: 'bg-orange-50',   icon: 'schedule' },
  { label: 'Target Cos',       value: stats.targetCompanyEvents, sub: 'From target list', iconBg: 'bg-red-500',  textColor: 'text-red-600',   cardBg: 'bg-red-50',      icon: 'target' },
  { label: 'Attendance Rate',  value: `${stats.trackedEvents > 0 ? Math.round((stats.attendedEvents / stats.trackedEvents) * 100) : 0}%`, sub: 'Of tracked events', iconBg: 'bg-teal-500', textColor: 'text-teal-600', cardBg: 'bg-teal-50', icon: 'trending_up' },
  { label: 'Avg Connections',  value: stats.attendedEvents > 0 ? (stats.totalConnections / stats.attendedEvents).toFixed(1) : '0', sub: 'Per event attended', iconBg: 'bg-pink-500', textColor: 'text-pink-600', cardBg: 'bg-pink-50', icon: 'people' },
];

export default function DashboardPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [followUps, setFollowUps] = useState<FollowUp[]>([]);
  const [repeatConnections, setRepeatConnections] = useState<RepeatConnection[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => { fetchData(); }, []);

  const fetchData = async () => {
    try {
      setLoading(true);
      const [statsRes, followUpsRes, repeatRes] = await Promise.all([
        fetch('/api/phase6/stats'),
        fetch('/api/phase6/follow-ups'),
        fetch('/api/phase6/repeat-connections'),
      ]);
      if (statsRes.ok) setStats((await statsRes.json()).stats);
      if (followUpsRes.ok) setFollowUps((await followUpsRes.json()).followUps);
      if (repeatRes.ok) setRepeatConnections((await repeatRes.json()).repeatConnections);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const markFollowUpComplete = async (trackerEntryId: string, connectionName: string) => {
    await fetch('/api/phase6/follow-ups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trackerEntryId, connectionName }),
    });
    fetchData();
  };

  return (
    <div className="min-h-screen bg-[#F5F5F7]">
      <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap" rel="stylesheet" />

      {/* Desktop Nav */}
      <nav className="hidden md:flex fixed top-0 w-full h-14 bg-white/70 glass-nav z-50 border-b border-black/5">
        <div className="flex justify-between items-center w-full max-w-[1200px] mx-auto px-20">
          <a href="/" className="text-xl font-bold tracking-tight text-[#1D1D1F]">PulseBLR</a>
          <div className="flex items-center gap-8">
            {NAV_LINKS.map(link => (
              <a key={link.href} href={link.href}
                className={`text-sm font-medium transition-colors ${link.href === '/dashboard' ? 'text-[#0071E3] font-semibold border-b-2 border-[#0071E3] pb-0.5' : 'text-[#86868B] hover:text-[#1D1D1F]'}`}>
                {link.label}
              </a>
            ))}
          </div>
          <span className="text-[#86868B] text-sm">Dashboard</span>
        </div>
      </nav>

      {/* Mobile Header */}
      <header className="md:hidden fixed top-0 w-full h-14 bg-white/70 glass-nav z-50 border-b border-black/5 flex items-center justify-between px-5">
        <a href="/" className="text-lg font-bold tracking-tight text-[#1D1D1F]">PulseBLR</a>
        <span className="text-[#86868B] text-sm font-medium">Dashboard</span>
      </header>

      <main className="pt-14 pb-24 md:pb-8">
        {/* Hero */}
        <section className="bg-black text-white px-5 md:px-20 pt-12 pb-10">
          <div className="max-w-[1200px] mx-auto">
            <h1 className="text-[32px] md:text-[40px] font-bold tracking-tight mb-1">Dashboard</h1>
            <p className="text-gray-400 text-[15px]">Your networking & event stats</p>
          </div>
        </section>

        <div className="max-w-[1200px] mx-auto px-5 md:px-20 py-8">
          {loading ? (
            <div className="flex justify-center items-center py-24">
              <div className="spinner" />
            </div>
          ) : (
            <>
              {/* Stats grid */}
              {stats && (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
                  {STAT_CARDS(stats).map(card => (
                    <div key={card.label} className={`${card.cardBg} rounded-2xl p-5 card-shadow`}>
                      {/* Icon badge */}
                      <div className={`w-9 h-9 rounded-xl ${card.iconBg} flex items-center justify-center mb-3`}>
                        <span className="material-symbols-outlined text-white text-[18px]"
                          style={{ fontVariationSettings: "'FILL' 1" }}>
                          {card.icon}
                        </span>
                      </div>
                      <p className={`text-[28px] font-bold leading-none ${card.textColor}`}>{card.value}</p>
                      <p className="text-[11px] font-semibold text-[#86868B] mt-1">{card.label}</p>
                      <p className="text-[10px] text-[#86868B] mt-0.5">{card.sub}</p>
                    </div>
                  ))}
                </div>
              )}

              {/* Two-column panels */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* Pending follow-ups */}
                <section className="bg-white rounded-2xl card-shadow p-6">
                  <div className="flex items-center gap-2 mb-5">
                    <span className="material-symbols-outlined text-orange-500" style={{ fontVariationSettings: "'FILL' 1" }}>schedule</span>
                    <h2 className="text-[17px] font-bold text-[#1D1D1F]">Pending Follow-ups</h2>
                    {followUps.length > 0 && (
                      <span className="ml-auto bg-orange-100 text-orange-700 text-[11px] font-bold px-2 py-0.5 rounded-full">
                        {followUps.length}
                      </span>
                    )}
                  </div>

                  {followUps.length === 0 ? (
                    <div className="text-center py-8">
                      <span className="material-symbols-outlined text-[40px] text-[#e5e5e5]">check_circle</span>
                      <p className="text-[#86868B] text-sm mt-2">All caught up!</p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {followUps.map((fu, idx) => (
                        <div key={idx} className="flex items-start justify-between p-4 rounded-xl bg-[#f7f7f7] hover:bg-orange-50/50 transition-colors">
                          <div className="flex-1">
                            <p className="text-[13px] font-semibold text-[#1D1D1F]">{fu.connection.name}</p>
                            {fu.connection.role && (
                              <p className="text-[12px] text-[#86868B]">
                                {fu.connection.role}{fu.connection.company ? ` @ ${fu.connection.company}` : ''}
                              </p>
                            )}
                            <p className="text-[11px] text-[#86868B] mt-1">From: {fu.eventTitle}</p>
                            <p className="text-[11px] text-orange-600 font-medium mt-0.5">
                              Due: {format(new Date(fu.connection.followUpAt), 'MMM d, yyyy')}
                            </p>
                          </div>
                          <button
                            onClick={() => markFollowUpComplete(fu.trackerEntryId, fu.connection.name)}
                            className="ml-4 bg-green-500 text-white text-[11px] font-bold px-3 py-1.5 rounded-full hover:bg-green-600 transition-colors shrink-0"
                          >
                            Done
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </section>

                {/* Repeat connections */}
                <section className="bg-white rounded-2xl card-shadow p-6">
                  <div className="flex items-center gap-2 mb-5">
                    <span className="material-symbols-outlined text-purple-500" style={{ fontVariationSettings: "'FILL' 1" }}>group</span>
                    <h2 className="text-[17px] font-bold text-[#1D1D1F]">Repeat Connections</h2>
                    {repeatConnections.length > 0 && (
                      <span className="ml-auto bg-purple-100 text-purple-700 text-[11px] font-bold px-2 py-0.5 rounded-full">
                        {repeatConnections.length}
                      </span>
                    )}
                  </div>

                  {repeatConnections.length === 0 ? (
                    <div className="text-center py-8">
                      <span className="material-symbols-outlined text-[40px] text-[#e5e5e5]">group_add</span>
                      <p className="text-[#86868B] text-sm mt-2">No repeat connections yet</p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {repeatConnections.slice(0, 8).map((conn, idx) => (
                        <div key={idx} className="flex items-center justify-between p-4 rounded-xl bg-[#f7f7f7]">
                          <div>
                            <p className="text-[13px] font-semibold text-[#1D1D1F]">{conn.name}</p>
                            {conn.details.role && (
                              <p className="text-[12px] text-[#86868B]">
                                {conn.details.role}{conn.details.company ? ` @ ${conn.details.company}` : ''}
                              </p>
                            )}
                            <p className="text-[11px] text-purple-600 font-medium mt-0.5">
                              Met at {conn.eventCount} events
                            </p>
                          </div>
                          {conn.details.linkedin && (
                            <a href={conn.details.linkedin} target="_blank" rel="noopener noreferrer"
                              className="text-[#0071E3] hover:text-blue-700 ml-4">
                              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                                <path d="M19 0h-14c-2.761 0-5 2.239-5 5v14c0 2.761 2.239 5 5 5h14c2.762 0 5-2.239 5-5v-14c0-2.761-2.238-5-5-5zm-11 19h-3v-11h3v11zm-1.5-12.268c-.966 0-1.75-.79-1.75-1.764s.784-1.764 1.75-1.764 1.75.79 1.75 1.764-.783 1.764-1.75 1.764zm13.5 12.268h-3v-5.604c0-3.368-4-3.113-4 0v5.604h-3v-11h3v1.765c1.396-2.586 7-2.777 7 2.476v6.759z" />
                              </svg>
                            </a>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              </div>
            </>
          )}
        </div>
      </main>

      {/* Mobile Bottom Nav */}
      <nav className="fixed bottom-0 w-full md:hidden bg-white/70 glass-nav border-t border-black/5 flex justify-around items-center px-4 py-2 z-50 rounded-t-2xl">
        {NAV_LINKS.map(link => {
          const isActive = link.href === '/dashboard';
          return (
            <a key={link.href} href={link.href}
              className={`flex flex-col items-center px-3 py-1 rounded-full transition-colors ${isActive ? 'bg-[#0071E3]/10' : 'hover:bg-[#f3f3f5]'}`}>
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
