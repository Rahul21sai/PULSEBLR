'use client';

import { useEffect, useMemo, useState } from 'react';
import { fullDateIST } from '@/lib/format';

/**
 * The editable fields for a person, shared by the post-scan capture sheet and the folder
 * table's editor. One definition, so a field added for capture is immediately editable later.
 *
 * Ordering is by what you can realistically get in the eight seconds somebody is standing in
 * front of you: name first, then how you met them, then the optional extras. Nothing is
 * autofocused — on a phone the keyboard would cover the card the moment it opened.
 */

export interface ContactDraft {
  name: string;
  /** True while `name` is a guess derived from a LinkedIn slug rather than stated. */
  nameIsGuess?: boolean;
  headline?: string;
  company?: string;
  role?: string;
  linkedin?: string;
  phone?: string;
  email?: string;
  x?: string;
  github?: string;
  website?: string;
  note?: string;
  tags?: string[];
  followUpAt?: string | null;
}

const FIELD_CLASS =
  'mt-1.5 h-11 w-full rounded-xl bg-[#F7F7F9] px-3.5 text-[15px] text-[#1D1D1F] outline-none focus:shadow-[inset_0_0_0_2px_var(--blue)]';

/** Follow-up offsets, in days. Deliberately few — the point is one tap, not a date picker. */
const FOLLOW_UP_CHOICES: Array<{ label: string; days: number | null }> = [
  { label: 'No reminder', days: null },
  { label: 'Tomorrow', days: 1 },
  { label: 'In 3 days', days: 3 },
  { label: 'Next week', days: 7 },
];

/**
 * Noon IST, N days out.
 *
 * NOT `<input type="date">`'s YYYY-MM-DD, which Mongoose casts to UTC midnight — 5:30 AM IST
 * the same day, so anything that later subtracts hours slides it into the previous day.
 */
function followUpIso(days: number): string {
  const target = new Date(Date.now() + days * 24 * 3600 * 1000);
  const y = target.getFullYear();
  const m = String(target.getMonth() + 1).padStart(2, '0');
  const d = String(target.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}T12:00:00+05:30`;
}

export default function ContactFields({
  draft,
  onChange,
  showAll = false,
  onToggleShowAll,
  tagSuggestions = [],
  autoFocusName = false,
}: {
  draft: ContactDraft;
  onChange: (next: ContactDraft) => void;
  /** Reveal the rarely-needed fields. Collapsed by default so capture stays fast. */
  showAll?: boolean;
  onToggleShowAll?: () => void;
  /**
   * Put the cursor in the name field on mount. OFF by default, and the default is the considered
   * one — the note at the top of this file records why: after a QR scan the card is prefilled and
   * mostly correct, so raising the keyboard would cover the very fields the user is checking.
   *
   * The TYPED capture mode is the one case where it is right, and it inverts the argument rather
   * than ignoring it: the user tapped "Type it" precisely because there is nothing to check, they
   * are standing in front of somebody, and the first thing they need is a cursor in the name box.
   * Making it a prop keeps that a decision the CALLER states, so neither surface inherits the
   * other's behaviour by accident.
   */
  autoFocusName?: boolean;
  /**
   * The user's existing tag vocabulary, for type-ahead.
   *
   * Passed in rather than fetched here: this component is rendered inside a sheet that may be
   * mounted and unmounted per person, and one fetch per capture at an event — on the network this
   * feature exists to cope with — is the wrong place to spend a request.
   */
  tagSuggestions?: string[];
}) {
  const set = <K extends keyof ContactDraft>(key: K, value: ContactDraft[K]) =>
    onChange({ ...draft, [key]: value });

  const activeFollowUp = FOLLOW_UP_CHOICES.find(choice => {
    if (choice.days === null) return !draft.followUpAt;
    if (!draft.followUpAt) return false;
    return draft.followUpAt.startsWith(followUpIso(choice.days).slice(0, 10));
  });

  return (
    <div className="flex flex-col gap-4">
      <label className="block">
        <span className="t-label text-[#8E8E93]">Name</span>
        <input
          value={draft.name}
          onChange={e => onChange({ ...draft, name: e.target.value, nameIsGuess: false })}
          placeholder="Their name"
          autoComplete="off"
          autoFocus={autoFocusName}
          className={FIELD_CLASS}
        />
        {/**
         * A LinkedIn QR carries NO name — only the profile slug. When we managed to derive
         * something from a hyphenated slug it is shown, but it MUST be labelled as a guess:
         * roughly a third of real slugs are custom handles with no name in them at all.
         */}
        {draft.nameIsGuess && (
          <span className="mt-1.5 flex items-center gap-1 text-[12px] text-[#A85B00]">
            <span aria-hidden="true" className="material-symbols-outlined text-[14px]">edit_note</span>
            Guessed from their profile link — check it
          </span>
        )}
      </label>

      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="t-label text-[#8E8E93]">Company</span>
          <input
            value={draft.company ?? ''}
            onChange={e => set('company', e.target.value)}
            placeholder="IBM"
            autoComplete="off"
            className={FIELD_CLASS}
          />
        </label>
        <label className="block">
          <span className="t-label text-[#8E8E93]">Role</span>
          <input
            value={draft.role ?? ''}
            onChange={e => set('role', e.target.value)}
            placeholder="Engineer"
            autoComplete="off"
            className={FIELD_CLASS}
          />
        </label>
      </div>

      <label className="block">
        <span className="t-label text-[#8E8E93]">Phone</span>
        <input
          value={draft.phone ?? ''}
          onChange={e => set('phone', e.target.value)}
          placeholder="+91 98765 43210"
          // `tel` gives a numeric keypad, which is the difference between typing a number in
          // three seconds and in fifteen.
          type="tel"
          inputMode="tel"
          autoComplete="off"
          className={FIELD_CLASS}
        />
      </label>

      <label className="block">
        <span className="t-label text-[#8E8E93]">How you met</span>
        <textarea
          value={draft.note ?? ''}
          onChange={e => set('note', e.target.value)}
          rows={2}
          placeholder="Asked about our AEM migration — wants an intro to the platform team"
          className="mt-1.5 w-full resize-none rounded-xl bg-[#F7F7F9] px-3.5 py-2.5 text-[15px] leading-relaxed text-[#1D1D1F] outline-none focus:shadow-[inset_0_0_0_2px_var(--blue)]"
        />
        <span className="mt-1 block text-[12px] text-[#8E8E93]">
          The bit you will have forgotten in a fortnight.
        </span>
      </label>

      <TagField
        value={draft.tags ?? []}
        onChange={tags => set('tags', tags)}
        suggestions={tagSuggestions}
      />

      <div>
        <span className="t-label text-[#8E8E93]">Follow up</span>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {FOLLOW_UP_CHOICES.map(choice => {
            const active = activeFollowUp?.label === choice.label;
            return (
              <button
                key={choice.label}
                type="button"
                aria-pressed={active}
                onClick={() => set('followUpAt', choice.days === null ? null : followUpIso(choice.days))}
                className={`h-9 rounded-full px-3.5 text-[12.5px] font-semibold transition-colors ${
                  active
                    ? 'bg-[#1D1D1F] text-white'
                    : 'bg-white text-[#1D1D1F] shadow-[inset_0_0_0_1px_var(--hairline)] hover:bg-[#F7F7F9]'
                }`}
              >
                {choice.label}
              </button>
            );
          })}
        </div>
        {draft.followUpAt && (
          <p className="mt-1.5 text-[12px] text-[#6E6E73]">
            Reminder on {fullDateIST(draft.followUpAt)}
          </p>
        )}
      </div>

      {onToggleShowAll && !showAll && (
        <button
          type="button"
          onClick={onToggleShowAll}
          className="self-start text-[13px] font-semibold text-[#0071E3] hover:underline"
        >
          More fields
        </button>
      )}

      {showAll && (
        <div className="flex flex-col gap-4 border-t border-[color:var(--hairline)] pt-4">
          <label className="block">
            <span className="t-label text-[#8E8E93]">LinkedIn</span>
            <input
              value={draft.linkedin ?? ''}
              onChange={e => set('linkedin', e.target.value)}
              placeholder="linkedin.com/in/… or just their handle"
              autoComplete="off"
              className={FIELD_CLASS}
            />
            {/* Canonicalised server-side, which is also what upgrades their identity key. */}
            <span className="mt-1 block text-[12px] text-[#8E8E93]">
              Adding this makes them match automatically next time you scan their code.
            </span>
          </label>

          <label className="block">
            <span className="t-label text-[#8E8E93]">Headline</span>
            <input
              value={draft.headline ?? ''}
              onChange={e => set('headline', e.target.value)}
              placeholder="Staff Engineer, Platform"
              autoComplete="off"
              className={FIELD_CLASS}
            />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="t-label text-[#8E8E93]">X</span>
              <input
                value={draft.x ?? ''}
                onChange={e => set('x', e.target.value)}
                placeholder="handle"
                autoComplete="off"
                className={FIELD_CLASS}
              />
            </label>
            <label className="block">
              <span className="t-label text-[#8E8E93]">GitHub</span>
              <input
                value={draft.github ?? ''}
                onChange={e => set('github', e.target.value)}
                placeholder="handle"
                autoComplete="off"
                className={FIELD_CLASS}
              />
            </label>
          </div>

          <label className="block">
            <span className="t-label text-[#8E8E93]">Email</span>
            <input
              value={draft.email ?? ''}
              onChange={e => set('email', e.target.value)}
              placeholder="them@example.com"
              type="email"
              inputMode="email"
              autoComplete="off"
              className={FIELD_CLASS}
            />
          </label>

          <label className="block">
            <span className="t-label text-[#8E8E93]">Website</span>
            <input
              value={draft.website ?? ''}
              onChange={e => set('website', e.target.value)}
              placeholder="https://…"
              autoComplete="off"
              className={FIELD_CLASS}
            />
          </label>
        </div>
      )}
    </div>
  );
}

/**
 * Tag chips with type-ahead, plus free entry.
 *
 * THE POINT OF THE FREE-ENTRY HALF. The requirement was "find the tech companies in Bangalore, and
 * if the company is not there give me an option to create the tag". The registry covers 375
 * employers and Bengaluru has thousands, so the fallback is not an edge case — it is how the long
 * tail gets labelled at all, and a company filter without it would be permanently incomplete with
 * no way for the user to fix it.
 *
 * Suggestions and free entry are the SAME input on purpose. A separate "create tag" button implies
 * creating is a different act from applying, when for the user it is one thought: this person works
 * at X. Typing a new tag and picking an existing one both end at "this person is tagged X".
 *
 * Canonicalisation is mirrored from `canonicaliseTags()` in `lib/contacts/service.ts` — trim,
 * collapse whitespace, lowercase, 40 characters — so the chip shows exactly what will be stored.
 * The server canonicalises again regardless; this exists so the UI never displays one string and
 * saves another, which would look like a bug the moment a tag came back different.
 */
const MAX_TAG_LEN = 40;
const MAX_TAGS = 20;

function canonicalise(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toLowerCase().slice(0, MAX_TAG_LEN);
}

function TagField({
  value,
  onChange,
  suggestions,
}: {
  value: string[];
  onChange: (tags: string[]) => void;
  suggestions: string[];
}) {
  const [entry, setEntry] = useState('');

  const matches = useMemo(() => {
    const typed = canonicalise(entry);
    const already = new Set(value);
    // With nothing typed, offer the vocabulary as-is — that is the "pick one you already use" case,
    // which is the common one and should not require typing a character first.
    const pool = suggestions.filter(s => !already.has(s));
    if (!typed) return pool.slice(0, 8);
    return pool.filter(s => s.includes(typed)).slice(0, 8);
  }, [entry, suggestions, value]);

  const typed = canonicalise(entry);
  // Offer creation only when it is genuinely new, so "create" never sits next to an identical
  // existing chip and make the user wonder which one they are about to get.
  const canCreate = Boolean(typed) && !suggestions.includes(typed) && !value.includes(typed);

  function add(tag: string) {
    const clean = canonicalise(tag);
    if (!clean || value.includes(clean) || value.length >= MAX_TAGS) return;
    onChange([...value, clean]);
    setEntry('');
  }

  return (
    <div>
      <span className="t-label text-[#8E8E93]">Tags</span>
      <p className="mt-0.5 text-[12px] text-[#8E8E93]">
        Your own labels — an employer we don&apos;t recognise, a team, anything you&apos;ll filter by
        later.
      </p>

      {value.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {value.map(tag => (
            <span
              key={tag}
              className="inline-flex items-center gap-1 rounded-full bg-[#EBF4FE] py-1 pl-3 pr-1.5 text-[12.5px] font-semibold text-[#0058B0]"
            >
              {tag}
              <button
                type="button"
                onClick={() => onChange(value.filter(t => t !== tag))}
                aria-label={`Remove tag ${tag}`}
                className="grid h-5 w-5 place-items-center rounded-full hover:bg-[#D6E7FB]"
              >
                <span aria-hidden="true" className="material-symbols-outlined text-[14px]">
                  close
                </span>
              </button>
            </span>
          ))}
        </div>
      )}

      <input
        value={entry}
        onChange={e => setEntry(e.target.value)}
        onKeyDown={e => {
          // Enter adds; comma too, because typing a list is the natural way to enter several and
          // waiting for a click after each one is not.
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            add(entry);
          } else if (e.key === 'Backspace' && !entry && value.length) {
            // The chip-field convention: backspace on an empty input removes the last chip.
            onChange(value.slice(0, -1));
          }
        }}
        maxLength={MAX_TAG_LEN}
        placeholder={value.length >= MAX_TAGS ? `Limit of ${MAX_TAGS} tags reached` : 'Add a tag'}
        disabled={value.length >= MAX_TAGS}
        className={FIELD_CLASS}
      />

      {(matches.length > 0 || canCreate) && value.length < MAX_TAGS && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {canCreate && (
            <button
              type="button"
              onClick={() => add(entry)}
              className="inline-flex h-8 items-center gap-1 rounded-full bg-[#1D1D1F] px-3 text-[12px] font-semibold text-white"
            >
              <span aria-hidden="true" className="material-symbols-outlined text-[14px]">add</span>
              Create &ldquo;{typed}&rdquo;
            </button>
          )}
          {matches.map(s => (
            <button
              key={s}
              type="button"
              onClick={() => add(s)}
              className="h-8 rounded-full bg-white px-3 text-[12px] font-semibold text-[#1D1D1F] shadow-[inset_0_0_0_1px_var(--hairline)] hover:bg-[#F7F7F9]"
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The user's tag vocabulary, for `tagSuggestions`. Fetched once per page.
 *
 * Lives here beside the field it feeds, so the scan sheet and the folder editor cannot end up with
 * two copies that drift. Per PAGE and not per sheet: `ContactFields` is mounted and unmounted for
 * every person captured, and a request per capture — on exactly the saturated network this feature
 * exists to survive — is the wrong place to spend one.
 *
 * Fails to an empty list on purpose. Type-ahead is a convenience and free entry works without it,
 * so a failed fetch must never be able to block recording somebody standing in front of you.
 */
export function useTagVocabulary(): string[] {
  const [tags, setTags] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/contacts/tags')
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (!cancelled && Array.isArray(d?.tags)) setTags(d.tags as string[]);
      })
      .catch(() => {
        /* Offline or signed out. Free entry still works. */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return tags;
}
