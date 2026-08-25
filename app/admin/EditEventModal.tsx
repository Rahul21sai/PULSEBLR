'use client';

/**
 * The admin event editor — the "U" that was missing from the admin CRUD.
 *
 * Before this, `/admin` could LIST and DELETE an event and flip two booleans. Everything else was
 * uncorrectable through the product: a mis-scraped title, a wrong venue, a bad cover image or a
 * time that drifted stayed wrong forever, because re-scraping only ever fills gaps
 * (`mergeInto()` never blanks a value) and the only alternative was a mongo shell.
 *
 * THREE THINGS HERE ARE LOAD-BEARING.
 *
 * 1. It fetches the FULL event on open. The list rows carry a projection (title, date, venue,
 *    organizer, source, category, score) — saving a form built from that would blank
 *    `description`, which the schema marks required, and the save would fail as a 500.
 *
 * 2. Times go through `lib/ist-datetime-input.ts`, not `toISOString().slice(0,16)`. A
 *    datetime-local field holds wall-clock text with no zone; this app pins display to
 *    Asia/Kolkata and builds `clusterKey` from the IST calendar day. The naive conversion shows
 *    UTC in a field the admin reads as IST and shifts every saved event by 5.5 hours.
 *
 * 3. Field errors from the 400 are shown ON the field. `PUT /api/events/[id]` now answers
 *    `{ error, fields: [{ field, message }] }`, so "unknown categories: …" lands next to the
 *    category chips rather than as one opaque banner the admin has to decode.
 *
 * What it does NOT offer is deliberate: `clusterKey`, `dedupHash`, `source`, `lastSeenAt`,
 * `companies`, `connectionScore` and `tagConfidence` are identity, provenance or derived. The
 * route's allowlist drops them anyway (`lib/events/admin-validate.ts`); not drawing an input is
 * how the admin learns that without having to try.
 */

import { useCallback, useEffect, useState } from 'react';
import { EVENT_CATEGORIES } from '@/lib/event-types';
import { toISTInputValue, fromISTInputValue } from '@/lib/ist-datetime-input';

const FORMATS = ['offline', 'online', 'hybrid'] as const;
const FOOD = ['unknown', 'yes', 'no'] as const;

interface Draft {
  title: string;
  description: string;
  startDateTime: string;
  endDateTime: string;
  venue: string;
  address: string;
  area: string;
  city: string;
  organizer: string;
  format: string;
  hasFood: string;
  isFree: boolean;
  price: string;
  currency: string;
  imageUrl: string;
  applyLink: string;
  sourceUrl: string;
  category: string[];
  isTechEvent: boolean;
  soldOut: boolean;
}

const EMPTY: Draft = {
  title: '',
  description: '',
  startDateTime: '',
  endDateTime: '',
  venue: '',
  address: '',
  area: '',
  city: '',
  organizer: '',
  format: 'offline',
  hasFood: 'unknown',
  isFree: true,
  price: '',
  currency: '',
  imageUrl: '',
  applyLink: '',
  sourceUrl: '',
  category: [],
  isTechEvent: true,
  soldOut: false,
};

type FieldErrors = Record<string, string>;

export default function EditEventModal({
  eventId,
  onClose,
  onSaved,
}: {
  eventId: string;
  onClose: () => void;
  onSaved: (updatedTitle: string) => void;
}) {
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/events/${eventId}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const { event } = await res.json();
        if (cancelled) return;
        setDraft({
          title: event.title ?? '',
          description: event.description ?? '',
          startDateTime: toISTInputValue(event.startDateTime),
          endDateTime: toISTInputValue(event.endDateTime),
          venue: event.venue ?? '',
          address: event.address ?? '',
          area: event.area ?? '',
          city: event.city ?? '',
          organizer: event.organizer ?? '',
          format: event.format ?? 'offline',
          hasFood: event.hasFood ?? 'unknown',
          isFree: event.isFree !== false,
          price: event.price === undefined || event.price === null ? '' : String(event.price),
          currency: event.currency ?? '',
          imageUrl: event.imageUrl ?? '',
          applyLink: event.applyLink ?? '',
          sourceUrl: event.sourceUrl ?? '',
          category: Array.isArray(event.category) ? event.category : [],
          isTechEvent: event.isTechEvent !== false,
          soldOut: Boolean(event.soldOut),
        });
      } catch {
        if (!cancelled) setError('Could not load this event.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [eventId]);

  // Escape closes, which is the one keyboard affordance a modal must have.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const set = useCallback(<K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft(prev => ({ ...prev, [key]: value }));
    // Clear this field's error as soon as it is touched: leaving a stale message next to a value
    // the admin has already corrected reads as the fix not having worked.
    setFieldErrors(prev => (key in prev ? { ...prev, [key]: '' } : prev));
  }, []);

  function toggleCategory(name: string) {
    setDraft(prev => ({
      ...prev,
      category: prev.category.includes(name)
        ? prev.category.filter(c => c !== name)
        : [...prev.category, name],
    }));
    setFieldErrors(prev => ({ ...prev, category: '' }));
  }

  async function save() {
    setSaving(true);
    setError(null);
    setFieldErrors({});
    try {
      /*
       * The whole editable set is sent, not just the dirty fields, so the form has
       * what-you-see-is-what-you-save semantics: clearing an optional input clears the value.
       * Empty strings become null/undefined in the validator, which is what unsets them.
       */
      const payload: Record<string, unknown> = {
        title: draft.title,
        description: draft.description,
        startDateTime: fromISTInputValue(draft.startDateTime),
        endDateTime: fromISTInputValue(draft.endDateTime),
        venue: draft.venue,
        address: draft.address,
        area: draft.area,
        city: draft.city,
        organizer: draft.organizer,
        format: draft.format,
        hasFood: draft.hasFood,
        isFree: draft.isFree,
        price: draft.price,
        currency: draft.currency,
        imageUrl: draft.imageUrl,
        applyLink: draft.applyLink,
        sourceUrl: draft.sourceUrl,
        category: draft.category,
        isTechEvent: draft.isTechEvent,
        soldOut: draft.soldOut,
      };

      const res = await fetch(`/api/events/${eventId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
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

      const { event } = await res.json();
      onSaved(event?.title || draft.title);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Edit event"
      className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto bg-black/40 p-4 py-10 backdrop-blur-sm"
      onClick={e => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-[680px] rounded-[22px] bg-white card-shadow-lg">
        <div className="flex items-center justify-between border-b border-[color:var(--hairline)] px-6 py-4">
          <h2 className="t-head text-[#1D1D1F]">Edit event</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid h-9 w-9 place-items-center rounded-full text-[#86868B] hover:bg-[#f3f3f5]"
          >
            <span aria-hidden="true" className="material-symbols-outlined text-[20px]">close</span>
          </button>
        </div>

        {loading ? (
          <p className="px-6 py-10 text-center text-[13px] text-[#86868B]">Loading…</p>
        ) : (
          <div className="space-y-4 px-6 py-5">
            {error && (
              <p role="alert" className="rounded-xl bg-[#FFF1F0] px-3.5 py-2.5 text-[12.5px] text-[#C7362D]">
                {error}
              </p>
            )}

            <Text label="Title" value={draft.title} onChange={v => set('title', v)} error={fieldErrors.title} />
            <Area label="Description" value={draft.description} onChange={v => set('description', v)} error={fieldErrors.description} />

            <div className="grid gap-4 sm:grid-cols-2">
              <Text type="datetime-local" label="Starts (IST)" value={draft.startDateTime} onChange={v => set('startDateTime', v)} error={fieldErrors.startDateTime} />
              <Text type="datetime-local" label="Ends (IST)" value={draft.endDateTime} onChange={v => set('endDateTime', v)} error={fieldErrors.endDateTime} />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Text label="Organiser" value={draft.organizer} onChange={v => set('organizer', v)} error={fieldErrors.organizer} />
              <Text label="Venue" value={draft.venue} onChange={v => set('venue', v)} error={fieldErrors.venue} />
            </div>

            <Text label="Address" value={draft.address} onChange={v => set('address', v)} error={fieldErrors.address} />

            <div className="grid gap-4 sm:grid-cols-2">
              <Text label="Area" value={draft.area} onChange={v => set('area', v)} error={fieldErrors.area} />
              <Text label="City" value={draft.city} onChange={v => set('city', v)} error={fieldErrors.city} />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Select label="Format" value={draft.format} options={FORMATS} onChange={v => set('format', v)} error={fieldErrors.format} />
              <Select label="Food" value={draft.hasFood} options={FOOD} onChange={v => set('hasFood', v)} error={fieldErrors.hasFood} />
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
              <Toggle label="Free" checked={draft.isFree} onChange={v => set('isFree', v)} />
              <Text label="Price" value={draft.price} onChange={v => set('price', v)} error={fieldErrors.price} />
              <Text label="Currency" value={draft.currency} onChange={v => set('currency', v)} error={fieldErrors.currency} />
            </div>

            <Text label="Cover image URL" value={draft.imageUrl} onChange={v => set('imageUrl', v)} error={fieldErrors.imageUrl} />
            <Text label="Registration link" value={draft.applyLink} onChange={v => set('applyLink', v)} error={fieldErrors.applyLink} />
            <Text label="Source URL" value={draft.sourceUrl} onChange={v => set('sourceUrl', v)} error={fieldErrors.sourceUrl} />

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
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Toggle label="Counts as a tech event" checked={draft.isTechEvent} onChange={v => set('isTechEvent', v)} />
              <Toggle label="Sold out" checked={draft.soldOut} onChange={v => set('soldOut', v)} />
            </div>
          </div>
        )}

        <div className="flex items-center justify-end gap-3 border-t border-[color:var(--hairline)] px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            className="pressable h-10 rounded-full px-5 text-[13px] font-semibold text-[#6E6E73] hover:bg-[#f3f3f5]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving || loading}
            className="pressable h-10 rounded-full bg-[#0071E3] px-6 text-[13px] font-semibold text-white hover:bg-blue-600 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ────────────────────────────── field primitives ────────────────────────────── */

function fieldClass(error?: string) {
  return `h-10 w-full rounded-xl border bg-white px-3 text-[13px] text-[#1D1D1F] focus:outline-none ${
    error ? 'border-[#C7362D]' : 'border-[#e5e5ea] focus:border-[#0071E3]'
  }`;
}

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
      <input type={type} value={value} onChange={e => onChange(e.target.value)} className={fieldClass(error)} />
      {error && <span className="mt-1 block text-[12px] text-[#C7362D]">{error}</span>}
    </label>
  );
}

function Area({
  label,
  value,
  onChange,
  error,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
}) {
  return (
    <label className="block">
      <span className="t-label mb-1.5 block text-[#6E6E73]">{label}</span>
      <textarea
        value={value}
        onChange={e => onChange(e.target.value)}
        rows={5}
        className={`w-full rounded-xl border bg-white px-3 py-2 text-[13px] leading-relaxed text-[#1D1D1F] focus:outline-none ${
          error ? 'border-[#C7362D]' : 'border-[#e5e5ea] focus:border-[#0071E3]'
        }`}
      />
      {error && <span className="mt-1 block text-[12px] text-[#C7362D]">{error}</span>}
    </label>
  );
}

function Select({
  label,
  value,
  options,
  onChange,
  error,
}: {
  label: string;
  value: string;
  options: readonly string[];
  onChange: (v: string) => void;
  error?: string;
}) {
  return (
    <label className="block">
      <span className="t-label mb-1.5 block text-[#6E6E73]">{label}</span>
      <select value={value} onChange={e => onChange(e.target.value)} className={fieldClass(error)}>
        {options.map(o => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
      {error && <span className="mt-1 block text-[12px] text-[#C7362D]">{error}</span>}
    </label>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex h-10 items-center gap-2.5 self-end">
      <input
        type="checkbox"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
        className="h-4 w-4 rounded border-[#c7c7cc] text-[#0071E3] focus:ring-[#0071E3]"
      />
      <span className="text-[13px] text-[#1D1D1F]">{label}</span>
    </label>
  );
}
