'use client';

import { useCallback, useEffect, useState } from 'react';
import { fullDateIST } from '@/lib/format';
import { EVENT_CATEGORIES } from '@/lib/event-types';
import { toISTInputValue, fromISTInputValue } from '@/lib/ist-datetime-input';

/**
 * Events users have asked to put in the shared feed, and machine-extracted candidates awaiting the
 * same judgement.
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
 * ── THE THIRD OPTION: CORRECT IT ────────────────────────────────────────────────────────────
 *
 * Approve and reject were the only two, and between them they had no answer for a submission that
 * was NEARLY right — approving published the flaw, rejecting threw the event away. That gap is what
 * keeps the microsite extraction half switched off: its one live extraction would enter the public
 * feed titled "Open Source India | India's #1 Open Source Event", because the model took the page's
 * `<title>`. So the reviewer can now fix the title, date, venue, area, organiser, link, description
 * and categories, and then approve.
 *
 * The editor is INLINE and REPLACES the read view, rather than a modal. Two reasons, and the first is
 * the real one: the judgement depends on reading the submitter's address and the raw registration
 * link WHILE correcting the title, and a modal covers exactly the context the decision needs. The
 * second is that the list response already carries every editable field, so unlike
 * `EditEventModal` there is nothing to fetch on open. Replacing the read view rather than expanding
 * below it keeps the queue scannable — a row never doubles in height.
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
  endDateTime?: string;
  category?: string[];
  isFree?: boolean;
  price?: number;
  applyLink?: string;
  sourceUrl?: string;
  isTechEvent?: boolean;
  /** Absent = in the shared feed. See the route: approve `$unset`s the key, it never stores 'public'. */
  visibility?: 'private' | 'pending' | 'public';
  createdAt: string;
  /**
   * Who produced the row. `'extracted'` means a model read it off a company page and nobody owns
   * it — which is why `submitter` is null for those, and why saying "an account with no user record"
   * about them was wrong and alarming.
   */
  origin?: 'user' | 'extracted';
  submitter?: { email: string; name: string } | null;
}

/** The eight fields `lib/events/submission-edit.ts` accepts, as form state. */
interface Draft {
  title: string;
  description: string;
  startDateTime: string;
  venue: string;
  area: string;
  organizer: string;
  applyLink: string;
  category: string[];
}

type FieldErrors = Record<string, string>;

function draftFrom(row: Submission): Draft {
  return {
    title: row.title ?? '',
    description: row.description ?? '',
    // IST wall clock, not `toISOString().slice(0,16)`. A datetime-local input holds text with no
    // zone, so the naive conversion shows UTC in a field the reviewer reads as IST and moves every
    // saved event 5.5 hours. See `lib/ist-datetime-input.ts`.
    startDateTime: toISTInputValue(row.startDateTime),
    venue: row.venue ?? '',
    area: row.area ?? '',
    organizer: row.organizer ?? '',
    applyLink: row.applyLink ?? '',
    category: Array.isArray(row.category) ? row.category : [],
  };
}

function statusOf(row: Submission): { label: string; className: string } {
  if (row.visibility === 'pending') {
    return { label: 'Waiting', className: 'bg-white text-[#6E6E73]' };
  }
  if (row.visibility === 'private') {
    return { label: 'Kept private', className: 'bg-white text-[#6E6E73]' };
  }
  return { label: 'In the feed', className: 'bg-[#EBF7EF] text-[#1D8A44]' };
}

export default function SubmissionsPanel() {
  const [rows, setRows] = useState<Submission[]>([]);
  const [view, setView] = useState<'pending' | 'all'>('pending');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // `includeDecided` lists everything ever submitted, decided or not — which is why the tab says
      // "All submissions" rather than "Decided".
      const res = await fetch(
        view === 'all' ? '/api/admin/submissions?includeDecided=true' : '/api/admin/submissions'
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setRows(data.submissions ?? []);
      setError(null);
    } catch {
      setError('Could not load submissions.');
    } finally {
      setLoading(false);
    }
  }, [view]);

  useEffect(() => {
    // Deferred a tick so the effect does not setState synchronously — the pattern the rest of the
    // app uses.
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  function openEditor(row: Submission) {
    setEditing(row._id);
    setDraft(draftFrom(row));
    setFieldErrors({});
    setError(null);
  }

  function closeEditor() {
    setEditing(null);
    setDraft(null);
    setFieldErrors({});
  }

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft(prev => (prev ? { ...prev, [key]: value } : prev));
    // Clear this field's error as soon as it is touched: a stale message beside a value the reviewer
    // has already corrected reads as the fix not having worked.
    setFieldErrors(prev => (key in prev ? { ...prev, [key]: '' } : prev));
  }

  function toggleCategory(name: string) {
    setDraft(prev =>
      prev
        ? {
            ...prev,
            category: prev.category.includes(name)
              ? prev.category.filter(c => c !== name)
              : [...prev.category, name],
          }
        : prev
    );
    setFieldErrors(prev => ({ ...prev, category: '' }));
  }

  async function saveEdit(id: string) {
    if (!draft) return;
    setBusy(id);
    setFieldErrors({});
    try {
      const res = await fetch('/api/admin/submissions', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id,
          // The whole editable set, not just the dirty fields, so clearing an input clears the
          // value. Empty strings become unsets in the validator; an empty required field comes back
          // as a field error rather than being silently ignored.
          edit: {
            title: draft.title,
            description: draft.description,
            startDateTime: fromISTInputValue(draft.startDateTime),
            venue: draft.venue,
            area: draft.area,
            organizer: draft.organizer,
            applyLink: draft.applyLink,
            category: draft.category,
          },
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        if (Array.isArray(data?.fields)) {
          const next: FieldErrors = {};
          for (const f of data.fields as Array<{ field: string; message: string }>) {
            next[f.field] = f.message;
          }
          setFieldErrors(next);
          setError(data.error || 'Some fields need fixing.');
        } else {
          setError(data?.error || `Could not save (HTTP ${res.status}).`);
        }
        return;
      }

      // Re-render from the SERVER's version of the row, not from the local draft. A silent
      // divergence between the two is how a reviewer approves what they think they typed rather
      // than what was stored.
      const data = await res.json();
      const saved = data.submission as Partial<Submission> | undefined;
      if (saved) {
        setRows(current =>
          current.map(r => (r._id === id ? { ...r, ...saved, _id: id } : r))
        );
      }
      closeEditor();
      const changed: string[] = Array.isArray(data.edited) ? data.edited : [];
      setNote(
        changed.length === 0
          ? 'Nothing had changed, so nothing was saved.'
          : `Saved ${changed.join(', ')}. Read it once more, then add it to the feed.`
      );
      setTimeout(() => setNote(null), 6000);
    } catch {
      setError('Could not save that correction.');
    } finally {
      setBusy(null);
    }
  }

  async function decide(id: string, decision: 'approve' | 'reject') {
    setBusy(id);
    try {
      const res = await fetch('/api/admin/submissions', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, decision }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setRows(current =>
        view === 'pending'
          ? // Removed rather than reloaded: the row is no longer pending either way, and a reviewer
            // working through a queue should not have it jump under them.
            current.filter(r => r._id !== id)
          : // In the "all" view the row stays and takes its new status, so the decision is visible.
            current.map(r =>
              r._id === id
                ? { ...r, visibility: decision === 'approve' ? undefined : 'private' }
                : r
            )
      );
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
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-label-md font-semibold text-[#1D1D1F]">
              {view === 'pending' ? 'Waiting for review' : 'All submissions'}
            </h2>
            <p className="mt-1 text-label-sm text-[#86868B]">
              {view === 'pending'
                ? 'Events asked into everyone’s feed, and candidates read off company pages. Approving publishes the link to every visitor — read it, or correct it, before you do.'
                : 'Everything ever submitted, with the decision that was made. Anything still waiting can be corrected or decided here.'}
            </p>
          </div>
          <div className="flex shrink-0 gap-1 rounded-full bg-[#f3f3f5] p-1">
            {(['pending', 'all'] as const).map(key => (
              <button
                key={key}
                type="button"
                onClick={() => {
                  closeEditor();
                  setView(key);
                }}
                aria-pressed={view === key}
                className={`h-8 rounded-full px-3.5 text-[12.5px] font-semibold transition-colors ${
                  view === key
                    ? 'bg-white text-[#1D1D1F] shadow-[inset_0_0_0_1px_var(--hairline)]'
                    : 'text-[#6E6E73] hover:text-[#1D1D1F]'
                }`}
              >
                {key === 'pending' ? 'Waiting' : 'All'}
              </button>
            ))}
          </div>
        </div>

        {rows.length === 0 ? (
          <p className="mt-4 rounded-xl bg-[#f9f9fb] px-4 py-6 text-center text-[13px] text-[#86868B]">
            {view === 'pending'
              ? 'Nothing waiting. Submissions appear here when somebody picks “Add for everyone”.'
              : 'No submissions yet.'}
          </p>
        ) : (
          <div className="mt-4 space-y-2">
            {rows.map(row => {
              const isEditing = editing === row._id;
              const pending = row.visibility === 'pending';
              const status = statusOf(row);

              return (
                <div
                  key={row._id}
                  className="rounded-xl bg-[#f9f9fb] p-4 shadow-[inset_0_0_0_1px_var(--hairline)]"
                >
                  {isEditing && draft ? (
                    <div className="space-y-3.5">
                      <div className="flex items-center justify-between gap-3">
                        <p className="t-label text-[#6E6E73]">Correcting this submission</p>
                        <span className="text-[11.5px] text-[#8E8E93]">
                          Nothing is published until you add it to the feed.
                        </span>
                      </div>

                      <Text
                        label="Title"
                        value={draft.title}
                        onChange={v => set('title', v)}
                        error={fieldErrors.title}
                      />

                      <div className="grid gap-3.5 sm:grid-cols-2">
                        <Text
                          type="datetime-local"
                          label="Starts (IST)"
                          value={draft.startDateTime}
                          onChange={v => set('startDateTime', v)}
                          error={fieldErrors.startDateTime}
                        />
                        <Text
                          label="Organiser"
                          value={draft.organizer}
                          onChange={v => set('organizer', v)}
                          error={fieldErrors.organizer}
                        />
                      </div>

                      <div className="grid gap-3.5 sm:grid-cols-2">
                        <Text
                          label="Venue"
                          value={draft.venue}
                          onChange={v => set('venue', v)}
                          error={fieldErrors.venue}
                        />
                        <Text
                          label="Area"
                          value={draft.area}
                          onChange={v => set('area', v)}
                          error={fieldErrors.area}
                        />
                      </div>

                      <Text
                        label="Registration link"
                        value={draft.applyLink}
                        onChange={v => set('applyLink', v)}
                        error={fieldErrors.applyLink}
                      />

                      <label className="block">
                        <span className="t-label mb-1.5 block text-[#6E6E73]">Description</span>
                        <textarea
                          value={draft.description}
                          onChange={e => set('description', e.target.value)}
                          rows={4}
                          className={`w-full rounded-xl border bg-white px-3 py-2 text-[13px] leading-relaxed text-[#1D1D1F] focus:outline-none ${
                            fieldErrors.description
                              ? 'border-[#C7362D]'
                              : 'border-[#e5e5ea] focus:border-[#0071E3]'
                          }`}
                        />
                        {fieldErrors.description && (
                          <span className="mt-1 block text-[12px] text-[#C7362D]">
                            {fieldErrors.description}
                          </span>
                        )}
                      </label>

                      <div>
                        <p className="t-label mb-2 text-[#6E6E73]">Categories</p>
                        <div className="flex flex-wrap gap-1.5">
                          {EVENT_CATEGORIES.map(name => {
                            const on = draft.category.includes(name);
                            return (
                              <button
                                key={name}
                                type="button"
                                onClick={() => toggleCategory(name)}
                                aria-pressed={on}
                                className={`rounded-full px-3 py-1.5 text-[12px] font-semibold transition-colors ${
                                  on
                                    ? 'bg-[#0071E3] text-white'
                                    : 'border border-[#e5e5ea] bg-white text-[#6E6E73] hover:bg-[#f3f3f5]'
                                }`}
                              >
                                {name}
                              </button>
                            );
                          })}
                        </div>
                        {fieldErrors.category && (
                          <p className="mt-1.5 text-[12px] text-[#C7362D]">{fieldErrors.category}</p>
                        )}
                        <p className="mt-2 text-[11.5px] text-[#8E8E93]">
                          {/* Stated, because it is derived and the reviewer cannot set it here. */}
                          Whether this counts as a tech event follows from these categories.
                        </p>
                      </div>

                      <div className="flex items-center gap-2 pt-0.5">
                        <button
                          type="button"
                          disabled={busy === row._id}
                          onClick={() => void saveEdit(row._id)}
                          className="pressable h-9 rounded-full bg-[#0071E3] px-4 text-[12.5px] font-semibold text-white hover:bg-blue-600 disabled:opacity-50"
                        >
                          {busy === row._id ? 'Saving…' : 'Save corrections'}
                        </button>
                        <button
                          type="button"
                          onClick={closeEditor}
                          className="pressable h-9 rounded-full px-4 text-[12.5px] font-semibold text-[#6E6E73] hover:bg-[#f3f3f5]"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
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
                          {/* Who — or what — is asking is part of the judgement being made. */}
                          {row.origin === 'extracted'
                            ? 'read off a company page by the extractor'
                            : `from ${row.submitter?.email ?? 'an account with no user record'}`}
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

                      <div className="flex shrink-0 flex-col items-stretch gap-2">
                        {view === 'all' && (
                          <span
                            className={`rounded-full px-2.5 py-1 text-center text-[10.5px] font-bold shadow-[inset_0_0_0_1px_var(--hairline)] ${status.className}`}
                          >
                            {status.label}
                          </span>
                        )}
                        {pending && (
                          <>
                            <button
                              type="button"
                              disabled={busy === row._id}
                              onClick={() => void decide(row._id, 'approve')}
                              className="pressable h-9 rounded-full bg-[#1D8A44] px-4 text-[12.5px] font-semibold text-white hover:bg-[#166F37] disabled:opacity-50"
                            >
                              {busy === row._id ? '…' : 'Add to feed'}
                            </button>
                            <button
                              type="button"
                              disabled={busy === row._id}
                              onClick={() => openEditor(row)}
                              className="pressable h-9 rounded-full bg-white px-4 text-[12.5px] font-semibold text-[#0071E3] shadow-[inset_0_0_0_1px_var(--hairline)] hover:bg-[#f3f3f5] disabled:opacity-50"
                            >
                              Correct it
                            </button>
                            <button
                              type="button"
                              disabled={busy === row._id}
                              onClick={() => void decide(row._id, 'reject')}
                              className="pressable h-9 rounded-full bg-white px-4 text-[12.5px] font-semibold text-[#1D1D1F] shadow-[inset_0_0_0_1px_var(--hairline)] hover:bg-[#f3f3f5] disabled:opacity-50"
                            >
                              Keep private
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

/* ────────────────────────────── field primitive ────────────────────────────── */

function Text({
  label,
  value,
  onChange,
  error,
  type = 'text',
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  type?: string;
}) {
  return (
    <label className="block">
      <span className="t-label mb-1.5 block text-[#6E6E73]">{label}</span>
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        className={`h-10 w-full rounded-xl border bg-white px-3 text-[13px] text-[#1D1D1F] focus:outline-none ${
          error ? 'border-[#C7362D]' : 'border-[#e5e5ea] focus:border-[#0071E3]'
        }`}
      />
      {error && <span className="mt-1 block text-[12px] text-[#C7362D]">{error}</span>}
    </label>
  );
}
