'use client';

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
}: {
  draft: ContactDraft;
  onChange: (next: ContactDraft) => void;
  /** Reveal the rarely-needed fields. Collapsed by default so capture stays fast. */
  showAll?: boolean;
  onToggleShowAll?: () => void;
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
