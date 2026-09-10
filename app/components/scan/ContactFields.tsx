'use client';

import { useEffect, useMemo, useState } from 'react';
import { fullDateIST } from '@/lib/format';
import {
  dayOffsetIST,
  followUpDayIST,
  followUpInstantForDay,
  followUpInstantInDays,
  todayDayIST,
} from '@/lib/scan/follow-up';

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

/**
 * Follow-up offsets, in days. Deliberately few — at a conference the point is one tap.
 *
 * KEPT, not replaced, now that an exact date is available. The presets are the common case and one
 * tap beats four; the date picker below is the answer to "3 March", which was previously unsayable.
 */
const FOLLOW_UP_CHOICES: Array<{ label: string; days: number | null }> = [
  { label: 'No reminder', days: null },
  { label: 'Tomorrow', days: 1 },
  { label: 'In 3 days', days: 3 },
  { label: 'Next week', days: 7 },
];

/**
 * A 44px hit area on a control painted smaller (WCAG 2.5.5), without changing what is drawn.
 *
 * The chips here are 32–36px painted and must stay that way — a row of 44px pills is a different
 * design — so the target is grown with an `::after` overlay centred on the control, the idiom
 * `app/people/page.tsx` uses.
 *
 * THE ROW GAP IS PART OF THE FIX, and the arithmetic has to be done per control rather than assumed.
 * An overlay on an `h`-px control overhangs `(44 - h) / 2` in each direction, and TWO wrapped rows
 * each overhang toward each other — so a container's vertical gap must be at least `44 - h`, not half
 * of it, or the overlays overlap and the one later in the DOM wins. A tap aimed at one chip then
 * fires a different chip on the row below, which is worse than the small target it replaced. Hence
 * `gap-y-2` (8px) on the 36px follow-up chips, `gap-y-3` (12px) on the 32px suggestion chips, and
 * `gap-y-5` (20px) on the applied-tag row, whose remove button is only 20px.
 */
export const TAP_44 =
  "relative after:absolute after:inset-x-0 after:top-1/2 after:h-11 after:-translate-y-1/2 after:content-[''] [touch-action:manipulation]";

/** The same, for a SQUARE icon button that needs the width grown as well as the height. */
export const TAP_44_SQUARE =
  "relative after:absolute after:left-1/2 after:top-1/2 after:h-11 after:w-11 after:-translate-x-1/2 after:-translate-y-1/2 after:content-[''] [touch-action:manipulation]";

/**
 * The date the module's IST rules say this draft is set to, or `''`.
 *
 * `followUpDayIST` reads the **IST** day. The version this replaces compared ISO string prefixes,
 * which reads the UTC day — so a reminder stored at 21:00 IST matched the day before and no chip lit.
 */
function draftDay(draft: ContactDraft): string {
  return followUpDayIST(draft.followUpAt ?? null);
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

  const currentDay = draftDay(draft);
  const activeFollowUp = FOLLOW_UP_CHOICES.find(choice =>
    choice.days === null ? !currentDay : dayOffsetIST(choice.days) === currentDay
  );

  /**
   * Is the date field showing?
   *
   * Open on mount when a date is already set that no preset accounts for — otherwise editing
   * somebody scheduled for "3 March" would show four chips, none of them lit, and no sign of where
   * the date the summary line names came from.
   */
  const [showDatePicker, setShowDatePicker] = useState(
    () => Boolean(currentDay) && !activeFollowUp
  );
  const pickingDate = showDatePicker || (Boolean(currentDay) && !activeFollowUp);

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
        <div className="mt-1.5 flex flex-wrap gap-x-1.5 gap-y-2">
          {FOLLOW_UP_CHOICES.map(choice => {
            const active = !pickingDate && activeFollowUp?.label === choice.label;
            return (
              <button
                key={choice.label}
                type="button"
                aria-pressed={active}
                onClick={() => {
                  setShowDatePicker(false);
                  set(
                    'followUpAt',
                    choice.days === null ? null : followUpInstantInDays(choice.days)
                  );
                }}
                className={`${TAP_44} h-9 rounded-full px-3.5 text-[12.5px] font-semibold transition-colors ${
                  active
                    ? 'bg-[#1D1D1F] text-white'
                    : 'bg-white text-[#1D1D1F] shadow-[inset_0_0_0_1px_var(--hairline)] hover:bg-[#F7F7F9]'
                }`}
              >
                {choice.label}
              </button>
            );
          })}
          {/*
            THE FIFTH ANSWER, not a mode switch dressed as one. The other four are answers
            ("Tomorrow"), so this one is phrased as an answer too — a "Pick a date…" button reads as
            leaving the question rather than answering it.
          */}
          <button
            type="button"
            aria-pressed={pickingDate}
            aria-expanded={pickingDate}
            onClick={() => setShowDatePicker(open => !open)}
            className={`${TAP_44} h-9 rounded-full px-3.5 text-[12.5px] font-semibold transition-colors ${
              pickingDate
                ? 'bg-[#1D1D1F] text-white'
                : 'bg-white text-[#1D1D1F] shadow-[inset_0_0_0_1px_var(--hairline)] hover:bg-[#F7F7F9]'
            }`}
          >
            Another day
          </button>
        </div>

        {pickingDate && (
          <label className="mt-2 block">
            <span className="sr-only">Follow-up date</span>
            <input
              type="date"
              value={currentDay}
              /**
               * `min` is TODAY IN IST, not the browser's today. It is also only a hint — the field
               * can still be typed into, and Safari ignores it for keyboard entry — so
               * `followUpInstantForDay` refuses a past day as well and the message below says so.
               */
              min={todayDayIST()}
              onChange={e => {
                const day = e.target.value;
                if (!day) {
                  set('followUpAt', null);
                  return;
                }
                /**
                 * The IST conversion is the module's, not this component's. A `new Date(day)` here
                 * would be UTC midnight — 05:30 IST — which is the bug this whole picker was blocked
                 * on. `null` back means the day has passed; the draft is left untouched so the field
                 * shows what was typed and the line below explains it, rather than silently
                 * reverting under the user's cursor.
                 */
                const instant = followUpInstantForDay(day);
                if (instant) set('followUpAt', instant);
              }}
              className={FIELD_CLASS}
            />
          </label>
        )}

        {draft.followUpAt ? (
          <p className="mt-1.5 text-[12px] text-[#6E6E73]">
            {/* IST, via lib/format.ts — never the ambient locale. */}
            Reminder on {fullDateIST(draft.followUpAt)}
          </p>
        ) : (
          pickingDate && (
            <p className="mt-1.5 text-[12px] text-[#8E8E93]">
              Pick today or a day after it.
            </p>
          )
        )}
      </div>

      {onToggleShowAll && !showAll && (
        <button
          type="button"
          onClick={onToggleShowAll}
          className={`${TAP_44} self-start text-[13px] font-semibold text-[#0071E3] hover:underline`}
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

/**
 * The client-side half of the mirror, EXPORTED rather than copied.
 *
 * `lib/contacts/service.ts` imports mongoose, so the real `canonicaliseTags()` cannot be reached
 * from the browser — hence the mirror above. What must not happen is a SECOND mirror: the folder
 * table's bulk tag bar has to canonicalise too, because a tag applied to a queued capture is written
 * straight to IndexedDB with no server in the loop, and a tag typed offline has to land in the same
 * facet bucket as one typed online. One mirror, two callers.
 */
export function canonicaliseTagInput(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toLowerCase().slice(0, MAX_TAG_LEN);
}

/** A whole list, deduped and capped — the list-level half of the same mirror. */
export function canonicaliseTagList(input: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    const tag = canonicaliseTagInput(raw);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

const canonicalise = canonicaliseTagInput;

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
        /*
          `gap-y-5` (20px), not `gap-1.5`, and the number is measured rather than chosen. The remove
          buttons are 20px painted, so a 44px overlay overhangs each chip by about 9px top and bottom;
          two wrapped rows each overhang toward the other, so anything under 18px leaves a band where
          the later row wins and a tap aimed at one chip removes a DIFFERENT tag — strictly worse than
          the small target it replaced. Most contacts carry two or three tags and never wrap, so this
          costs nothing in practice. The chips themselves are unchanged.
        */
        <div className="mt-2 flex flex-wrap gap-x-1.5 gap-y-5">
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
                className={`${TAP_44_SQUARE} grid h-5 w-5 place-items-center rounded-full hover:bg-[#D6E7FB]`}
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
        /* 32px chips → 6px of overhang each way, so two wrapped rows need 12px between them. */
        <div className="mt-1.5 flex flex-wrap gap-x-1.5 gap-y-3">
          {canCreate && (
            <button
              type="button"
              onClick={() => add(entry)}
              className={`${TAP_44} inline-flex h-8 items-center gap-1 rounded-full bg-[#1D1D1F] px-3 text-[12px] font-semibold text-white`}
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
              className={`${TAP_44} h-8 rounded-full bg-white px-3 text-[12px] font-semibold text-[#1D1D1F] shadow-[inset_0_0_0_1px_var(--hairline)] hover:bg-[#F7F7F9]`}
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
