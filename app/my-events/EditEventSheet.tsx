'use client';

import { useState } from 'react';
import Sheet from '../components/Sheet';
import { Banner, Button, Chip } from '../components/ui';
import { CATEGORY_GROUPS, isTechFromCategories } from '@/lib/event-types';
import { toISTInputValue, fromISTInputValue } from '@/lib/ist-datetime-input';
import { isPlaceholderSourceUrl } from '@/lib/events/placeholder';
import { OWNER_DESCRIPTION_MAX } from '@/lib/events/owner-edit';
import type { EventDetail } from '@/lib/events/serialize';

/**
 * The owner's edit form for a hand-added event — used from the event page and from `/my-events`.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE FIELDS ARE EXACTLY `OWNER_EDIT_FIELDS` (lib/events/owner-edit.ts). Drawing an input the route
 * drops would be a form that appears to save and does not. Host, food and cover credits are absent
 * for the reasons written there.
 *
 * TIMES GO THROUGH `lib/ist-datetime-input.ts`, never `toISOString().slice(0,16)` — the admin
 * editor's documented trap: a datetime-local field is wall-clock text, and the naive conversion shows
 * UTC in a field the reader takes as IST and moves the event 5.5 hours on every save.
 *
 * THE PLACEHOLDER SOURCE URL IS SHOWN AS EMPTY. The row stores `https://pulseblr.local/manual` when no
 * link was given; printing that in an input invites the owner to "fix" a link they never set. Sent
 * back empty, the route writes the placeholder again.
 *
 * WHAT SAVING A PUBLIC EVENT DOES IS SAID BEFORE THE BUTTON, not after: it goes back to review, and
 * until then its page is gone for everyone who saved it. An owner finding that out from a banner
 * after the fact would reasonably feel the app did it behind their back.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */

interface Draft {
  title: string;
  description: string;
  startDateTime: string;
  endDateTime: string;
  format: 'offline' | 'online' | 'hybrid';
  venue: string;
  address: string;
  area: string;
  onlineLink: string;
  applyLink: string;
  sourceUrl: string;
  imageUrl: string;
  category: string[];
  isFree: boolean;
  price: string;
}

/**
 * Suggestions only — the route accepts any area text. A short local list rather than importing
 * `BENGALURU_AREAS`, which would pull the whole geo gazetteer (regex tables and all) into the browser
 * bundle for a datalist.
 */
const AREA_SUGGESTIONS = [
  'Koramangala', 'Indiranagar', 'Whitefield', 'HSR Layout', 'Electronic City', 'MG Road',
  'Jayanagar', 'Malleshwaram', 'BTM Layout', 'Marathahalli', 'Outer Ring Road', 'Hebbal',
];

const FORMATS: Array<{ value: Draft['format']; label: string }> = [
  { value: 'offline', label: 'In person' },
  { value: 'online', label: 'Online' },
  { value: 'hybrid', label: 'Hybrid' },
];

function draftFrom(event: EventDetail): Draft {
  return {
    title: event.title ?? '',
    description: event.description && event.description !== event.title ? event.description : '',
    startDateTime: toISTInputValue(event.startDateTime),
    endDateTime: toISTInputValue(event.endDateTime),
    format: event.format ?? 'offline',
    venue: event.venue ?? '',
    address: event.address ?? '',
    area: event.area ?? '',
    onlineLink: event.onlineLink ?? '',
    applyLink: event.applyLink ?? '',
    sourceUrl: isPlaceholderSourceUrl(event.sourceUrl) ? '' : event.sourceUrl ?? '',
    imageUrl: event.imageUrl ?? '',
    category: Array.isArray(event.category) ? event.category : [],
    isFree: event.isFree !== false,
    price: typeof event.price === 'number' && event.price > 0 ? String(event.price) : '',
  };
}

type FieldErrors = Record<string, string>;

export interface EditResult {
  event: EventDetail;
  reReview: boolean;
  changed: string[];
}

export default function EditEventSheet({
  event,
  open,
  onClose,
  onSaved,
}: {
  event: EventDetail;
  open: boolean;
  onClose: () => void;
  onSaved: (result: EditResult) => void;
}) {
  // Re-seeded on every open by the caller's `key`, so a cancelled edit never leaks into the next.
  const [draft, setDraft] = useState<Draft>(() => draftFrom(event));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft(prev => ({ ...prev, [key]: value }));
    setFieldErrors(prev => (prev[key] ? { ...prev, [key]: '' } : prev));
  }

  function toggleCategory(name: string) {
    set(
      'category',
      draft.category.includes(name) ? draft.category.filter(c => c !== name) : [...draft.category, name]
    );
  }

  async function save() {
    setSaving(true);
    setError(null);
    setFieldErrors({});
    try {
      // The WHOLE editable set, so what you see is what is saved: clearing an input clears the value.
      // The route diffs against the stored row, so re-sending unchanged fields changes nothing.
      const payload = {
        title: draft.title,
        description: draft.description,
        startDateTime: fromISTInputValue(draft.startDateTime),
        endDateTime: fromISTInputValue(draft.endDateTime),
        format: draft.format,
        venue: draft.venue,
        address: draft.address,
        area: draft.area,
        onlineLink: draft.onlineLink,
        applyLink: draft.applyLink,
        sourceUrl: draft.sourceUrl,
        imageUrl: draft.imageUrl,
        category: draft.category,
        isFree: draft.isFree,
        price: draft.isFree ? '' : draft.price,
      };
      const res = await fetch(`/api/events/${event._id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        if (Array.isArray(data?.fields)) {
          const next: FieldErrors = {};
          for (const f of data.fields as Array<{ field: string; message: string }>) next[f.field] = f.message;
          setFieldErrors(next);
        }
        setError(
          res.status === 404
            ? 'This event is no longer available to edit.'
            : // The route's same-origin refusal answers a bare "Forbidden", which told the user
              // nothing they could act on.
              res.status === 403
              ? 'This page could not be verified. Reload it and try again — nothing was changed.'
              : data?.error || 'Could not save your changes. Nothing was changed.'
        );
        return;
      }
      onSaved({ event: data.event, reReview: Boolean(data.reReview), changed: data.changed ?? [] });
    } catch {
      setError('Could not reach the server. Nothing was changed.');
    } finally {
      setSaving(false);
    }
  }

  const isPublic = event.visibility === 'public';
  const others = event.savedByOthers ?? 0;
  const noTechTopic = draft.category.length > 0 && !isTechFromCategories(draft.category);

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Edit event"
      subtitle={event.title}
      labelledBy="edit-event-title"
      footer={
        <div className="flex gap-[var(--s-3)]">
          <Button tone="quiet" onClick={onClose} className="min-h-11 flex-1">
            Cancel
          </Button>
          <Button tone="secondary" onClick={save} disabled={saving} className="min-h-11 flex-1">
            {saving ? 'Saving…' : isPublic ? 'Save and send for review' : 'Save changes'}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-[var(--s-4)]">
        {isPublic && (
          <Banner tone="warn">
            This event is public. Saving any change sends it back for review, and until an admin
            approves it only you can see it
            {others > 0
              ? ` — including the ${others} ${others === 1 ? 'person' : 'people'} who saved it.`
              : '.'}
          </Banner>
        )}
        {error && <Banner tone="error">{error}</Banner>}

        <TextField label="Title" value={draft.title} onChange={v => set('title', v)} error={fieldErrors.title} />

        <div className="grid gap-[var(--s-4)] sm:grid-cols-2">
          <TextField
            type="datetime-local"
            label="Starts (IST)"
            value={draft.startDateTime}
            onChange={v => set('startDateTime', v)}
            error={fieldErrors.startDateTime}
          />
          <TextField
            type="datetime-local"
            label="Ends (IST, optional)"
            value={draft.endDateTime}
            onChange={v => set('endDateTime', v)}
            error={fieldErrors.endDateTime}
          />
        </div>

        <fieldset>
          <legend className="mb-[var(--s-2)] text-[13px] font-semibold text-[var(--ink-2)]">Format</legend>
          <div className="flex flex-wrap gap-[var(--s-2)]">
            {FORMATS.map(option => (
              <Chip
                key={option.value}
                pressed={draft.format === option.value}
                onClick={() => set('format', option.value)}
                className="min-h-11"
              >
                {option.label}
              </Chip>
            ))}
          </div>
        </fieldset>

        {draft.format !== 'online' && (
          <>
            <TextField label="Venue" value={draft.venue} onChange={v => set('venue', v)} error={fieldErrors.venue} />
            <div className="grid gap-[var(--s-4)] sm:grid-cols-2">
              <TextField
                label="Area"
                value={draft.area}
                onChange={v => set('area', v)}
                error={fieldErrors.area}
                list="edit-event-areas"
              />
              <TextField label="Address" value={draft.address} onChange={v => set('address', v)} error={fieldErrors.address} />
            </div>
            <datalist id="edit-event-areas">
              {AREA_SUGGESTIONS.map(area => (
                <option key={area} value={area} />
              ))}
            </datalist>
          </>
        )}

        {draft.format !== 'offline' && (
          <TextField
            type="url"
            label="Online link"
            value={draft.onlineLink}
            onChange={v => set('onlineLink', v)}
            error={fieldErrors.onlineLink}
          />
        )}

        <TextField
          type="url"
          label="Registration link"
          value={draft.applyLink}
          onChange={v => set('applyLink', v)}
          error={fieldErrors.applyLink}
          hint="Where the Register button goes. Leave empty if there is nowhere to register."
        />
        <TextField
          type="url"
          label="Organiser's page (optional)"
          value={draft.sourceUrl}
          onChange={v => set('sourceUrl', v)}
          error={fieldErrors.sourceUrl}
        />
        <TextField
          type="url"
          label="Cover image link (optional)"
          value={draft.imageUrl}
          onChange={v => set('imageUrl', v)}
          error={fieldErrors.imageUrl}
        />

        <fieldset>
          <legend className="mb-[var(--s-2)] text-[13px] font-semibold text-[var(--ink-2)]">Ticket</legend>
          <div className="flex flex-wrap items-start gap-[var(--s-2)]">
            <Chip pressed={draft.isFree} onClick={() => set('isFree', true)} className="min-h-11">
              Free
            </Chip>
            <Chip pressed={!draft.isFree} onClick={() => set('isFree', false)} className="min-h-11">
              Paid
            </Chip>
          </div>
          {!draft.isFree && (
            <div className="mt-[var(--s-3)] max-w-[220px]">
              <TextField
                type="number"
                label="Price (₹)"
                value={draft.price}
                onChange={v => set('price', v)}
                error={fieldErrors.price}
              />
            </div>
          )}
          {draft.isFree && fieldErrors.price && (
            <p className="mt-1 text-[12.5px] text-[var(--live)]">{fieldErrors.price}</p>
          )}
        </fieldset>

        <fieldset>
          <legend className="mb-[var(--s-2)] text-[13px] font-semibold text-[var(--ink-2)]">Categories</legend>
          <div className="flex flex-col gap-[var(--s-3)]">
            {CATEGORY_GROUPS.map(group => (
              <div key={group.id}>
                <p className="mb-[var(--s-2)] text-[12.5px] text-[var(--ink-2)]">{group.label}</p>
                <div className="flex flex-wrap gap-[var(--s-2)]">
                  {group.names.map(name => (
                    <Chip
                      key={name}
                      pressed={draft.category.includes(name)}
                      onClick={() => toggleCategory(name)}
                      className="min-h-11"
                    >
                      {name}
                    </Chip>
                  ))}
                </div>
              </div>
            ))}
          </div>
          {fieldErrors.category && (
            <p className="mt-1 text-[12.5px] text-[var(--live)]">{fieldErrors.category}</p>
          )}
          {noTechTopic && (
            /* The feed is unconditionally tech-only, and `isTechEvent` follows these chips. Said here
               because the consequence — the event leaving the feed — is otherwise invisible. */
            <p className="mt-[var(--s-2)] text-[12.5px] leading-[1.45] text-[var(--ink-2)]">
              None of these is a tech topic, so the event will not appear in the feed. It stays on
              your My events page.
            </p>
          )}
        </fieldset>

        <label className="block">
          <span className="mb-[var(--s-2)] block text-[13px] font-semibold text-[var(--ink-2)]">
            Description (optional)
          </span>
          <textarea
            value={draft.description}
            onChange={e => set('description', e.target.value)}
            rows={6}
            maxLength={OWNER_DESCRIPTION_MAX}
            className={`w-full r-touch border bg-[var(--surface)] px-3 py-2 text-[14px] leading-relaxed text-[var(--ink)] focus:outline-none ${
              fieldErrors.description ? 'border-[var(--live)]' : 'border-[var(--rule)] focus:border-[var(--accent)]'
            }`}
          />
          {fieldErrors.description && (
            <span className="mt-1 block text-[12.5px] text-[var(--live)]">{fieldErrors.description}</span>
          )}
        </label>
      </div>
    </Sheet>
  );
}

function TextField({
  label,
  value,
  onChange,
  error,
  hint,
  type = 'text',
  list,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  hint?: string;
  type?: string;
  list?: string;
}) {
  return (
    <label className="block">
      <span className="mb-[var(--s-2)] block text-[13px] font-semibold text-[var(--ink-2)]">{label}</span>
      <input
        type={type}
        value={value}
        list={list}
        min={type === 'number' ? 0 : undefined}
        onChange={e => onChange(e.target.value)}
        className={`h-11 w-full r-touch border bg-[var(--surface)] px-3 text-[14px] text-[var(--ink)] focus:outline-none ${
          error ? 'border-[var(--live)]' : 'border-[var(--rule)] focus:border-[var(--accent)]'
        }`}
      />
      {error ? (
        <span className="mt-1 block text-[12.5px] text-[var(--live)]">{error}</span>
      ) : hint ? (
        <span className="mt-1 block text-[12.5px] text-[var(--ink-2)]">{hint}</span>
      ) : null}
    </label>
  );
}
