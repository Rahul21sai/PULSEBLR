'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Record what happened at an event: your notes, and the people you met.
 *
 * This is the funnel for the ENTIRE networking half of the product — the only screen
 * where a person can be written down — and it was the least finished UI in the app:
 * purple-600 on gray-300 while everything else is the system palette, `bg-black
 * bg-opacity-50` (deprecated), rounded-lg against 18px everywhere else, failures reported
 * through a native `alert()`, and a `// Made with Bob` scaffold marker at the bottom.
 *
 * Three functional problems mattered more than the styling:
 *
 *  1. NO EDIT. It could only add and remove, so fixing a typo in a name or adding a
 *     LinkedIn URL later meant deleting the person and retyping every field.
 *  2. NO followedUp CONTROL. Repo-wide, `followedUp` had exactly one writer —
 *     POST /api/phase6/follow-ups, reachable only from /dashboard, which is absent from
 *     the mobile nav. So a follow-up was a one-way ratchet: it could become due and never
 *     be cleared from the screen most people use.
 *  3. `context` WAS WRITE-ONLY. "What you discussed" is the most valuable thing a
 *     networker records, and it was captured here and rendered nowhere else.
 */

interface Connection {
  name: string;
  role?: string;
  company?: string;
  linkedin?: string;
  context?: string;
  followUpAt?: string;
  followedUp?: boolean;
}

interface EditTrackerModalProps {
  entryId: string;
  eventTitle?: string;
  currentNotes?: string;
  currentConnections: Connection[];
  onClose: () => void;
  onSave: () => void;
}

const EMPTY: Connection = {
  name: '',
  role: '',
  company: '',
  linkedin: '',
  context: '',
  followUpAt: '',
  followedUp: false,
};

export default function EditTrackerModal({
  entryId,
  eventTitle,
  currentNotes = '',
  currentConnections,
  onClose,
  onSave,
}: EditTrackerModalProps) {
  const [notes, setNotes] = useState(currentNotes);
  const [connections, setConnections] = useState<Connection[]>(currentConnections);
  const [draft, setDraft] = useState<Connection>(EMPTY);
  const [adding, setAdding] = useState(currentConnections.length === 0);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dialogRef = useRef<HTMLDivElement>(null);

  // Escape closes, which every dialog should do and this one did not.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Move focus into the dialog on open so a keyboard user is not left behind on the page.
  useEffect(() => {
    const timer = setTimeout(() => {
      dialogRef.current?.querySelector<HTMLElement>('input, textarea, button')?.focus();
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  function commitDraft() {
    const name = draft.name.trim();
    if (!name) return;
    const cleaned: Connection = { ...draft, name };
    setConnections(prev =>
      editingIndex === null
        ? [...prev, cleaned]
        : prev.map((c, i) => (i === editingIndex ? cleaned : c))
    );
    setDraft(EMPTY);
    setAdding(false);
    setEditingIndex(null);
  }

  function startEdit(index: number) {
    setDraft({ ...EMPTY, ...connections[index] });
    setEditingIndex(index);
    setAdding(true);
  }

  function remove(index: number) {
    setConnections(prev => prev.filter((_, i) => i !== index));
    if (editingIndex === index) {
      setDraft(EMPTY);
      setAdding(false);
      setEditingIndex(null);
    }
  }

  /** Toggle followedUp locally; persisted with the rest on save. */
  function toggleFollowedUp(index: number) {
    setConnections(prev =>
      prev.map((c, i) => (i === index ? { ...c, followedUp: !c.followedUp } : c))
    );
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/tracker/${entryId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes, connections }),
      });
      if (!res.ok) {
        // An inline banner, not alert(): a native dialog blocks the page, cannot be
        // styled, and on save failure the user's typing is still on screen behind it.
        setError(
          res.status === 401
            ? 'Your session expired. Sign in again and retry — nothing has been lost.'
            : `Could not save (HTTP ${res.status}). Your changes are still here.`
        );
        return;
      }
      onSave();
      onClose();
    } catch {
      setError('Could not reach the server. Your changes are still here.');
    } finally {
      setSaving(false);
    }
  }

  const dueCount = connections.filter(
    c => c.followUpAt && !c.followedUp && new Date(c.followUpAt) <= new Date()
  ).length;

  return (
    <div className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center p-0 sm:p-4">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
      />

      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-tracker-title"
        className="relative flex max-h-[92vh] w-full max-w-[560px] flex-col rounded-t-[22px] bg-white sm:rounded-[22px] card-shadow-lg"
      >
        {/* Header stays out of the scrollport so it cannot overlay the content. */}
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-[color:var(--hairline)] p-5">
          <div className="min-w-0">
            <h2 id="edit-tracker-title" className="t-sub text-[#1D1D1F]">
              Who did you meet?
            </h2>
            {eventTitle && (
              <p className="mt-0.5 truncate text-[13px] text-[#6E6E73]">{eventTitle}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close without saving"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[#F5F5F7] text-[#6E6E73] hover:bg-[#EEEEF0] [touch-action:manipulation]"
          >
            <span className="material-symbols-outlined text-[18px]">close</span>
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {error && (
            <div className="mb-4 rounded-xl bg-[#FFF1F0] px-4 py-3 text-[12.5px] text-[#C7362D]" role="alert">
              {error}
            </div>
          )}

          {/* ── People ─────────────────────────────────────────────────── */}
          <div className="mb-2 flex items-center justify-between">
            <h3 className="t-label text-[#8E8E93]">
              People {connections.length > 0 && `· ${connections.length}`}
            </h3>
            {dueCount > 0 && (
              <span className="rounded-full bg-[#FFF4E5] px-2 py-0.5 text-[11px] font-bold text-[#A85B00]">
                {dueCount} follow-up{dueCount === 1 ? '' : 's'} due
              </span>
            )}
          </div>

          {connections.length === 0 && !adding && (
            <p className="py-4 text-[13px] text-[#8E8E93]">
              Nobody logged yet. Names fade fast — add them while you remember.
            </p>
          )}

          <ul className="space-y-2">
            {connections.map((conn, index) => {
              const due =
                conn.followUpAt && !conn.followedUp && new Date(conn.followUpAt) <= new Date();
              return (
                <li
                  key={`${conn.name}-${index}`}
                  className="rounded-xl bg-[#F7F7F9] p-3.5"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[14px] font-semibold text-[#1D1D1F]">{conn.name}</p>
                      {(conn.role || conn.company) && (
                        <p className="text-[12.5px] text-[#6E6E73]">
                          {[conn.role, conn.company].filter(Boolean).join(' · ')}
                        </p>
                      )}
                      {/* `context` is what you actually talked about — the single most
                          useful thing here, and previously invisible after saving. */}
                      {conn.context && (
                        <p className="mt-1.5 text-[12.5px] leading-relaxed text-[#3a3a3c]">
                          {conn.context}
                        </p>
                      )}
                      {conn.followUpAt && (
                        <p
                          className={`mt-1.5 inline-flex items-center gap-1 text-[12px] font-semibold ${
                            conn.followedUp
                              ? 'text-[#1D8A44]'
                              : due
                                ? 'text-[#C7362D]'
                                : 'text-[#6E6E73]'
                          }`}
                        >
                          <span className="material-symbols-outlined text-[14px]" aria-hidden="true">
                            {conn.followedUp ? 'check_circle' : 'alarm'}
                          </span>
                          {conn.followedUp
                            ? 'Followed up'
                            : `Follow up ${new Date(conn.followUpAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`}
                        </p>
                      )}
                      {conn.linkedin && (
                        <a
                          href={conn.linkedin}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="mt-1.5 block text-[12px] font-semibold text-[#0071E3] hover:underline"
                        >
                          LinkedIn
                        </a>
                      )}
                    </div>

                    <div className="flex shrink-0 flex-col items-end gap-1.5">
                      {conn.followUpAt && (
                        <button
                          type="button"
                          onClick={() => toggleFollowedUp(index)}
                          aria-pressed={!!conn.followedUp}
                          className={`rounded-full px-2.5 py-1 text-[11.5px] font-semibold [touch-action:manipulation] ${
                            conn.followedUp
                              ? 'bg-[#EBF7EF] text-[#1D8A44]'
                              : 'bg-white text-[#1D1D1F] shadow-[inset_0_0_0_1px_var(--hairline-strong)] hover:bg-[#F0F0F2]'
                          }`}
                        >
                          {conn.followedUp ? 'Done' : 'Mark done'}
                        </button>
                      )}
                      <div className="flex gap-1">
                        <button
                          type="button"
                          onClick={() => startEdit(index)}
                          aria-label={`Edit ${conn.name}`}
                          className="grid h-7 w-7 place-items-center rounded-full text-[#6E6E73] hover:bg-white [touch-action:manipulation]"
                        >
                          <span className="material-symbols-outlined text-[16px]">edit</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => remove(index)}
                          aria-label={`Remove ${conn.name}`}
                          className="grid h-7 w-7 place-items-center rounded-full text-[#FF3B30] hover:bg-white [touch-action:manipulation]"
                        >
                          <span className="material-symbols-outlined text-[16px]">delete</span>
                        </button>
                      </div>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>

          {/* ── Add / edit a person ────────────────────────────────────── */}
          {adding ? (
            <div className="mt-3 rounded-xl bg-white p-4 shadow-[inset_0_0_0_1px_var(--hairline-strong)]">
              <p className="t-label mb-3 text-[#8E8E93]">
                {editingIndex === null ? 'New person' : `Editing ${connections[editingIndex]?.name}`}
              </p>
              <div className="space-y-2.5">
                <Input
                  label="Name"
                  value={draft.name}
                  onChange={v => setDraft({ ...draft, name: v })}
                  placeholder="Priya Raman"
                  required
                  autoComplete="off"
                />
                <div className="grid grid-cols-2 gap-2.5">
                  <Input
                    label="Role"
                    value={draft.role ?? ''}
                    onChange={v => setDraft({ ...draft, role: v })}
                    placeholder="Staff Engineer"
                  />
                  <Input
                    label="Company"
                    value={draft.company ?? ''}
                    onChange={v => setDraft({ ...draft, company: v })}
                    placeholder="Razorpay"
                  />
                </div>
                <Input
                  label="What you talked about"
                  value={draft.context ?? ''}
                  onChange={v => setDraft({ ...draft, context: v })}
                  placeholder="Hiring for their platform team; wants a Rust write-up"
                />
                <div className="grid grid-cols-2 gap-2.5">
                  <Input
                    label="LinkedIn"
                    type="url"
                    value={draft.linkedin ?? ''}
                    onChange={v => setDraft({ ...draft, linkedin: v })}
                    placeholder="linkedin.com/in/…"
                  />
                  <Input
                    label="Follow up on"
                    type="date"
                    value={(draft.followUpAt ?? '').slice(0, 10)}
                    onChange={v => setDraft({ ...draft, followUpAt: v })}
                  />
                </div>
              </div>

              <div className="mt-3.5 flex gap-2">
                <button
                  type="button"
                  onClick={commitDraft}
                  disabled={!draft.name.trim()}
                  className="pressable h-9 flex-1 rounded-full bg-[#1D1D1F] text-[13px] font-semibold text-white hover:bg-black disabled:opacity-40"
                >
                  {editingIndex === null ? 'Add person' : 'Save person'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setDraft(EMPTY);
                    setAdding(false);
                    setEditingIndex(null);
                  }}
                  className="pressable h-9 rounded-full bg-white px-4 text-[13px] font-semibold text-[#1D1D1F] shadow-[inset_0_0_0_1px_var(--hairline-strong)] hover:bg-[#F7F7F9]"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                setDraft(EMPTY);
                setEditingIndex(null);
                setAdding(true);
              }}
              className="pressable mt-3 flex h-10 w-full items-center justify-center gap-1.5 rounded-full bg-white text-[13px] font-semibold text-[#0071E3] shadow-[inset_0_0_0_1px_var(--hairline-strong)] hover:bg-[#F7F7F9]"
            >
              <span className="material-symbols-outlined text-[17px]">person_add</span>
              Add someone you met
            </button>
          )}

          {/* ── Notes ─────────────────────────────────────────────────── */}
          <div className="mt-6">
            <label htmlFor="tracker-notes" className="t-label mb-2 block text-[#8E8E93]">
              Notes on the event
            </label>
            <textarea
              id="tracker-notes"
              name="notes"
              value={notes}
              onChange={e => setNotes(e.target.value)}
              rows={3}
              placeholder="Worth going again? What was actually useful?"
              className="w-full resize-y rounded-xl bg-white px-3.5 py-2.5 text-[13.5px] text-[#1D1D1F] placeholder:text-[#a1a1a6] shadow-[inset_0_0_0_1px_var(--hairline-strong)] focus:outline-none focus-visible:shadow-[inset_0_0_0_2px_#0071E3]"
            />
          </div>
        </div>

        {/* Footer outside the scrollport, for the same reason as the header. */}
        <div className="flex shrink-0 gap-2 border-t border-[color:var(--hairline)] p-4">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="pressable h-11 flex-1 rounded-full bg-[#1D1D1F] text-[14px] font-semibold text-white hover:bg-black disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="pressable h-11 rounded-full bg-white px-5 text-[14px] font-semibold text-[#1D1D1F] shadow-[inset_0_0_0_1px_var(--hairline-strong)] hover:bg-[#F7F7F9]"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/** Labelled field. The label is clickable via htmlFor, which several of these lacked. */
function Input({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
  required,
  autoComplete,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  required?: boolean;
  autoComplete?: string;
}) {
  const id = `conn-${label.toLowerCase().replace(/[^a-z]+/g, '-')}`;
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-[12px] font-semibold text-[#3a3a3c]">
        {label}
        {required && <span className="text-[#FF3B30]"> *</span>}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        className="h-9 w-full rounded-lg bg-white px-3 text-[13px] text-[#1D1D1F] placeholder:text-[#a1a1a6] shadow-[inset_0_0_0_1px_var(--hairline-strong)] focus:outline-none focus-visible:shadow-[inset_0_0_0_2px_#0071E3]"
      />
    </div>
  );
}
