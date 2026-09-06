'use client';

import { useCallback, useEffect, useState } from 'react';
import { fullDateIST } from '@/lib/format';

/**
 * Events users have asked to put in the shared feed.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A SEPARATE PANEL AND NOT PART OF THE EVENTS PANEL. That one lists through
 * `GET /api/events`, which now scopes to the caller — public, or no visibility key, or owned by the
 * viewer. A pending submission belongs to somebody else, so it matches none of those arms and is
 * invisible there. Offering users an "add for everyone" button with no review surface would be
 * offering a queue that silently goes nowhere.
 *
 * WHAT A REVIEWER IS ACTUALLY DECIDING. Approving publishes a stranger's `applyLink` to every
 * visitor, and `app/events/[id]/page.tsx` renders that value straight into an `href`. That is
 * precisely the phishing vector the admin guard on `POST /api/events` exists to close — which is why
 * the URL is shown here as monospace TEXT rather than as a link. A reviewer should read it; making
 * it clickable turns the review step into the attack it exists to prevent.
 *
 * REJECT DOES NOT DELETE, and the button says so. The user typed the event in, so it becomes their
 * private event again and they keep whatever they tracked or scanned against it. Rejecting is a
 * decision about the SHARED feed, not permission to destroy somebody's own record — hence "Keep
 * private" rather than "Reject".
 *
 * Its own file because `AdminDashboard.tsx` is already past 950 lines; a fifth panel inlined there
 * is the point where the file stops being readable.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */

export interface Submission {
  _id: string;
  title: string;
  description?: string;
  organizer?: string;
  venue?: string;
  area?: string;
  city?: string;
  format?: string;
  startDateTime: string;
  category?: string[];
  isFree?: boolean;
  price?: number;
  applyLink?: string;
  sourceUrl?: string;
  isTechEvent?: boolean;
  createdAt: string;
  submitter?: { email: string; name: string } | null;
}

export default function SubmissionsPanel() {
  const [rows, setRows] = useState<Submission[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/submissions');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setRows(data.submissions ?? []);
      setError(null);
    } catch {
      setError('Could not load submissions.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Deferred a tick so the effect does not setState synchronously — the pattern the rest of the
    // app uses.
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  async function decide(id: string, decision: 'approve' | 'reject') {
    setBusy(id);
    try {
      const res = await fetch('/api/admin/submissions', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, decision }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Removed from the list rather than reloading: the row is no longer pending either way, and a
      // reviewer working through a queue should not have it jump under them.
      setRows(current => current.filter(r => r._id !== id));
      setNote(
        decision === 'approve'
          ? 'Approved — it is in the shared feed now.'
          : 'Kept private — it stays the submitter’s own event.'
      );
      setTimeout(() => setNote(null), 4000);
    } catch {
      setError('Could not record that decision.');
      setTimeout(() => setError(null), 4000);
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        {[0, 1].map(i => (
          <div key={i} className="rounded-[20px] bg-white p-6 card-shadow">
            <div className="h-4 w-1/2 rounded bg-[#EEEEF0]" />
            <div className="mt-3 h-3 w-1/3 rounded bg-[#F3F3F5]" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {error && (
        <div className="rounded-xl bg-[#FFF1F0] px-4 py-3 text-[12.5px] text-[#C7362D]" role="status">
          {error}
        </div>
      )}
      {note && (
        <div className="rounded-xl bg-[#EBF7EF] px-4 py-3 text-[12.5px] text-[#1D8A44]" role="status">
          {note}
        </div>
      )}

      <section className="rounded-[20px] bg-white p-6 card-shadow">
        <h2 className="text-label-md font-semibold text-[#1D1D1F]">Waiting for review</h2>
        <p className="mt-1 text-label-sm text-[#86868B]">
          Events users asked to add to everyone&apos;s feed. Approving publishes their link to every
          visitor — read it before you do.
        </p>

        {rows.length === 0 ? (
          <p className="mt-4 rounded-xl bg-[#f9f9fb] px-4 py-6 text-center text-[13px] text-[#86868B]">
            Nothing waiting. Submissions appear here when somebody picks “Add for everyone”.
          </p>
        ) : (
          <div className="mt-4 space-y-2">
            {rows.map(row => (
              <div
                key={row._id}
                className="rounded-xl bg-[#f9f9fb] p-4 shadow-[inset_0_0_0_1px_var(--hairline)]"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-[14px] font-semibold text-[#1D1D1F]">{row.title}</p>
                    <p className="mt-0.5 text-[12.5px] text-[#6E6E73]">
                      {fullDateIST(row.startDateTime)}
                      {row.venue ? ` · ${row.venue}` : ''}
                      {row.area ? `, ${row.area}` : ''}
                      {row.format ? ` · ${row.format}` : ''}
                    </p>
                    <p className="mt-0.5 text-[12px] text-[#8E8E93]">
                      {/* Who is asking is part of the judgement being made. */}
                      from {row.submitter?.email ?? 'an account with no user record'}
                      {row.organizer ? ` · host: ${row.organizer}` : ''}
                      {row.isTechEvent ? ' · flagged tech' : ' · not flagged tech'}
                    </p>

                    {row.description && (
                      <p className="mt-2 line-clamp-3 text-[12.5px] leading-relaxed text-[#6E6E73]">
                        {row.description}
                      </p>
                    )}

                    {(row.applyLink || row.sourceUrl) && (
                      <p className="mt-2 break-all font-mono text-[11.5px] text-[#6E6E73]">
                        {/* Deliberately NOT a link — see the header. */}
                        {row.applyLink || row.sourceUrl}
                      </p>
                    )}

                    {row.category && row.category.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {row.category.map(c => (
                          <span
                            key={c}
                            className="rounded-full bg-white px-2 py-0.5 text-[10.5px] font-bold text-[#6E6E73] shadow-[inset_0_0_0_1px_var(--hairline)]"
                          >
                            {c}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="flex shrink-0 flex-col gap-2">
                    <button
                      type="button"
                      disabled={busy === row._id}
                      onClick={() => void decide(row._id, 'approve')}
                      className="h-9 rounded-full bg-[#1D8A44] px-4 text-[12.5px] font-semibold text-white hover:bg-[#166F37] disabled:opacity-50"
                    >
                      {busy === row._id ? '…' : 'Add to feed'}
                    </button>
                    <button
                      type="button"
                      disabled={busy === row._id}
                      onClick={() => void decide(row._id, 'reject')}
                      className="h-9 rounded-full bg-white px-4 text-[12.5px] font-semibold text-[#1D1D1F] shadow-[inset_0_0_0_1px_var(--hairline)] hover:bg-[#f3f3f5] disabled:opacity-50"
                    >
                      Keep private
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
