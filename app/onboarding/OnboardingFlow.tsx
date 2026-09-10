'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Button, Card, Chip } from '../components/ui';
import {
  AREA_CHOICES,
  DAY_LABELS,
  DEFAULT_PREFERENCES,
  DIGEST_FREQUENCIES,
  TOPIC_CHOICES,
  preferenceSummary,
  type DigestFrequency,
  type FormatPreference,
  type UserPreferences,
} from '@/lib/events/relevance';
import { TECH_CATEGORY_NAMES } from '@/lib/event-types';

/**
 * Three cards: what you're into, where you can get to, and when.
 *
 * ── THE ORDER OF THE QUESTIONS IS THE PRODUCT DECISION, AND IT IS NOT THE OBVIOUS ONE. ───────
 * Topic goes first because it is what a user expects to be asked and refusing to ask it would
 * read as a broken form — but it is the WEAKEST signal in the corpus (`AI/ML` alone is 189 of 297
 * upcoming tech events, 63%, so "I like AI" narrows almost nothing). The two cards after it carry
 * the signal that actually predicts attendance in this city: whether you can get there, and
 * whether the evening is free. `lib/events/relevance.ts` weights them accordingly.
 *
 * ── EVERY CARD IS SKIPPABLE AND NOTHING IS REQUIRED. ─────────────────────────────────────────
 * "Skip for now" is present on all three steps and on the final one, and it is not a courtesy: a
 * user who answers nothing must land on exactly today's feed. That works because empty
 * preferences make `relevanceScore` uniform, so the personalised ranking degrades to the
 * `connections` ranking rather than to noise or to an empty list.
 *
 * ── IT IS ALSO THE EDITOR. ───────────────────────────────────────────────────────────────────
 * `/settings` links here rather than duplicating the controls. `?from=settings` changes the copy
 * and where Done returns to, and nothing else — a second implementation of these chips is exactly
 * how the two rails on `/people` and the feed drifted apart.
 */

type Step = 0 | 1 | 2;

const FORMAT_OPTIONS: Array<{ value: FormatPreference; label: string; hint: string }> = [
  { value: 'offline', label: 'In person', hint: 'Only rooms with people in them' },
  { value: 'any', label: 'No preference', hint: 'Rank both the same' },
  { value: 'online', label: 'Online', hint: 'Streams and remote sessions' },
  { value: 'hybrid', label: 'Hybrid', hint: 'Either, with a remote option' },
];

const DIGEST_LABELS: Record<DigestFrequency, { label: string; hint: string }> = {
  weekly: { label: 'Weekly', hint: 'Five events, Monday morning' },
  daily: { label: 'Daily', hint: 'Every morning — more, and easier to mute' },
  off: { label: 'Off', hint: 'No digest at all' },
};

/** Day order for the chips: the working week first, because that is how people read a week. */
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

const STEPS: Array<{ eyebrow: string; title: string; body: string }> = [
  {
    eyebrow: 'Step 1 of 3',
    title: 'What are you into?',
    body: 'Pick as many as you like. This is the gentlest of the three signals — most tech events in Bengaluru mention AI, so the next two questions do more of the work.',
  },
  {
    eyebrow: 'Step 2 of 3',
    title: 'Where can you actually get to?',
    body: 'The single biggest reason a good event goes unattended here is the commute. Events elsewhere still appear — they just stop outranking the ones near you.',
  },
  {
    eyebrow: 'Step 3 of 3',
    title: 'Which evenings work?',
    body: 'And how often you want to hear from us. Nothing here is a filter: an event on a day you did not pick simply ranks lower.',
  },
];

export default function OnboardingFlow() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const fromSettings = searchParams.get('from') === 'settings';

  const [step, setStep] = useState<Step>(0);
  const [draft, setDraft] = useState<UserPreferences>(DEFAULT_PREFERENCES);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  /*
   * Load what is already stored, so opening this from settings shows the current answers rather
   * than an empty form — and so a user who half-finished it once does not start over.
   */
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await fetch('/api/me/preferences');
        if (!res.ok) throw new Error('Could not load your preferences');
        const data = await res.json();
        if (live && data.preferences) {
          const p = data.preferences as UserPreferences;
          setDraft({
            topics: p.topics ?? [],
            areas: p.areas ?? [],
            format: p.format ?? 'any',
            evenings: p.evenings ?? [],
            remindersEnabled: p.remindersEnabled ?? true,
            digestFrequency: p.digestFrequency ?? 'weekly',
          });
        }
      } catch (err) {
        // Not fatal: an unreadable preference set still lets the user state a new one. Saying so
        // matters though — silently showing an empty form would look like their answers were lost.
        if (live) setLoadError(err instanceof Error ? err.message : 'Could not load your preferences');
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const toggle = useCallback(<T,>(list: T[], value: T): T[] =>
    list.includes(value) ? list.filter(v => v !== value) : [...list, value], []);

  /**
   * Does the draft say anything the ranking can act on? Mirrors `hasRankingPreferences` — the
   * server is the authority and returns it as `personalised` on every read, but this has to be
   * computed from the UNSAVED draft to decide where "See my feed" goes.
   */
  const personalised = useMemo(
    () =>
      draft.topics.length > 0 ||
      draft.areas.length > 0 ||
      draft.format !== 'any' ||
      (draft.evenings.length > 0 && draft.evenings.length < 7),
    [draft]
  );

  /**
   * Save, then leave.
   *
   * `skip` sends an EMPTY body rather than the draft. `PUT /api/me/preferences` merges onto what is
   * stored, so `{}` changes nothing while still stamping `onboardedAt` — which is what stops the
   * prompt in the feed from reappearing. Sending the draft on a skip would write the defaults over
   * a returning user's real answers, i.e. the exact opposite of skipping.
   */
  const finish = useCallback(
    async (mode: 'save' | 'skip') => {
      setSaving(true);
      setError(null);
      try {
        const res = await fetch('/api/me/preferences', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(mode === 'skip' ? {} : draft),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || 'Could not save your preferences');
        }
        /*
         * `?feed=for-you` on the way to the feed, but only when something was actually saved. Land
         * a skipping user on `/` and they get the feed they already had, which is the promise; land
         * them on the personalised tab and it would rank identically while claiming to be tailored.
         */
        const destination =
          fromSettings ? '/settings' : mode === 'save' && personalised ? '/?feed=for-you' : '/';
        router.push(destination);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not save your preferences');
        setSaving(false);
      }
    },
    [draft, fromSettings, personalised, router]
  );

  const summary = preferenceSummary(draft);
  const meta = STEPS[step];

  return (
    <div className="mx-auto max-w-[640px] px-4 pb-28 pt-6 md:pt-10">
      {/* Progress: three segments, not a percentage. A three-step flow with a 33% bar reads as a
          longer form than it is. */}
      <div className="flex items-center gap-1.5" aria-hidden="true">
        {[0, 1, 2].map(i => (
          <span
            key={i}
            className={`h-[3px] flex-1 rounded-full transition-colors ${
              i <= step ? 'bg-[#1D1D1F]' : 'bg-[color:var(--hairline-strong)]'
            }`}
          />
        ))}
      </div>

      <p className="t-label mt-5 text-[#8E8E93]">
        {fromSettings ? 'Your preferences' : meta.eyebrow}
      </p>
      <h1 className="t-display mt-2 text-[#1D1D1F]">{meta.title}</h1>
      <p className="mt-3 max-w-[52ch] text-[14px] leading-[1.55] text-[#3a3a3c]">{meta.body}</p>

      {loadError && (
        <p className="mt-4 rounded-xl bg-[#FFF8E6] px-4 py-3 text-[13px] text-[#8a6100]">
          {loadError}. You can still set them now.
        </p>
      )}

      <div className="mt-6 flex flex-col gap-4">
        {loading ? (
          <Card>
            <div className="flex flex-wrap gap-2">
              {Array.from({ length: 10 }, (_, i) => (
                <span key={i} className="skeleton h-9 w-24 rounded-full" />
              ))}
            </div>
          </Card>
        ) : step === 0 ? (
          <Card>
            <fieldset>
              <legend className="t-label mb-3 text-[#8E8E93]">Tech topics</legend>
              <div className="flex flex-wrap gap-2">
                {TOPIC_CHOICES.filter(t => (TECH_CATEGORY_NAMES as readonly string[]).includes(t)).map(
                  topic => (
                    <Chip
                      key={topic}
                      pressed={draft.topics.includes(topic)}
                      onClick={() => setDraft(d => ({ ...d, topics: toggle(d.topics, topic) }))}
                    >
                      {topic}
                    </Chip>
                  )
                )}
              </div>
            </fieldset>
            {/* The gathering kinds are a SEPARATE fieldset because they answer a different question
                — "what will I learn" versus "will I meet anyone" — which is the same split the
                filter rail makes. One flat list of sixteen chips hides that. */}
            <fieldset className="mt-6">
              <legend className="t-label mb-3 text-[#8E8E93]">Kinds of gathering</legend>
              <div className="flex flex-wrap gap-2">
                {TOPIC_CHOICES.filter(t => !(TECH_CATEGORY_NAMES as readonly string[]).includes(t)).map(
                  topic => (
                    <Chip
                      key={topic}
                      pressed={draft.topics.includes(topic)}
                      onClick={() => setDraft(d => ({ ...d, topics: toggle(d.topics, topic) }))}
                    >
                      {topic}
                    </Chip>
                  )
                )}
              </div>
            </fieldset>
          </Card>
        ) : step === 1 ? (
          <>
            <Card>
              <fieldset>
                <legend className="t-label mb-3 text-[#8E8E93]">
                  Areas you can reach on a weekday evening
                </legend>
                <div className="flex flex-wrap gap-2">
                  {AREA_CHOICES.map(area => (
                    <Chip
                      key={area}
                      pressed={draft.areas.includes(area)}
                      onClick={() => setDraft(d => ({ ...d, areas: toggle(d.areas, area) }))}
                    >
                      {area}
                    </Chip>
                  ))}
                </div>
                {/* Stated plainly, because it is the thing a reader will worry about and the thing
                    that makes the feature trustworthy. Half the corpus has no resolved area, so
                    this is also literally true of the data. */}
                <p className="mt-3 text-[12.5px] leading-relaxed text-[#6E6E73]">
                  Events with no known neighbourhood are never pushed down for it — about half the
                  listings do not say where they are, and that is our gap, not yours.
                </p>
              </fieldset>
            </Card>
            <Card>
              <fieldset>
                <legend className="t-label mb-3 text-[#8E8E93]">In person, or on a screen</legend>
                <div className="flex flex-col gap-1">
                  {FORMAT_OPTIONS.map(option => (
                    <RadioRow
                      key={option.value}
                      name="format"
                      label={option.label}
                      hint={option.hint}
                      checked={draft.format === option.value}
                      onChange={() => setDraft(d => ({ ...d, format: option.value }))}
                    />
                  ))}
                </div>
              </fieldset>
            </Card>
          </>
        ) : (
          <>
            <Card>
              <fieldset>
                <legend className="t-label mb-3 text-[#8E8E93]">Evenings that usually work</legend>
                <div className="flex flex-wrap gap-2">
                  {DAY_ORDER.map(day => (
                    <Chip
                      key={day}
                      pressed={draft.evenings.includes(day)}
                      onClick={() => setDraft(d => ({ ...d, evenings: toggle(d.evenings, day) }))}
                    >
                      {DAY_LABELS[day]}
                    </Chip>
                  ))}
                </div>
                {/* Says so out loud, because a user who selects all seven and expects a stronger
                    result would otherwise be quietly wrong: seven days and none are the same
                    statement, and the score treats them identically. */}
                <p className="mt-3 text-[12.5px] leading-relaxed text-[#6E6E73]">
                  Pick none — or all seven — and the day stops counting either way.
                </p>
              </fieldset>
            </Card>
            <Card>
              {/* These two are read by the digest and the reminder sender, not by the ranking. They
                  are asked here because it is the one moment the user is already answering
                  questions, and burying them in settings is how nobody ever finds them. */}
              <fieldset>
                <legend className="t-label mb-3 text-[#8E8E93]">Email</legend>
                <label className="flex items-start gap-3 rounded-xl px-1 py-2">
                  <input
                    type="checkbox"
                    checked={draft.remindersEnabled}
                    onChange={e => setDraft(d => ({ ...d, remindersEnabled: e.target.checked }))}
                    className="mt-0.5 h-[18px] w-[18px] shrink-0 accent-[#0071E3]"
                  />
                  <span>
                    <span className="block text-[14px] font-semibold text-[#1D1D1F]">
                      Remind me about events I save
                    </span>
                    <span className="block text-[12.5px] text-[#6E6E73]">
                      One email before an event you put in your tracker.
                    </span>
                  </span>
                </label>
                <div className="mt-4 flex flex-col gap-1">
                  <span className="t-label mb-1 block text-[#8E8E93]">Digest</span>
                  {DIGEST_FREQUENCIES.map(value => (
                    <RadioRow
                      key={value}
                      name="digest"
                      label={DIGEST_LABELS[value].label}
                      hint={DIGEST_LABELS[value].hint}
                      checked={draft.digestFrequency === value}
                      onChange={() => setDraft(d => ({ ...d, digestFrequency: value }))}
                    />
                  ))}
                </div>
              </fieldset>
            </Card>
          </>
        )}
      </div>

      {summary && (
        <p className="mt-5 text-[12.5px] text-[#6E6E73]">
          Ranking so far: <span className="font-semibold text-[#1D1D1F]">{summary}</span>
        </p>
      )}

      {error && (
        <p role="alert" className="mt-4 rounded-xl bg-[#FFF1F0] px-4 py-3 text-[13px] text-[#C7362D]">
          {error}
        </p>
      )}

      {/* Sticky footer, with the safe-area inset honoured — `viewportFit: 'cover'` is global, so
          without the `max()` this sits under the iOS home indicator. */}
      <div
        className="fixed inset-x-0 bottom-0 border-t border-black/5 bg-[#F5F5F7]/97 glass-nav px-4 pt-3"
        style={{ paddingBottom: 'max(12px, env(safe-area-inset-bottom))' }}
      >
        <div className="mx-auto flex max-w-[640px] items-center gap-3">
          {step > 0 && (
            <Button tone="quiet" onClick={() => setStep(s => (s - 1) as Step)} disabled={saving}>
              Back
            </Button>
          )}
          {step < 2 ? (
            <Button full onClick={() => setStep(s => (s + 1) as Step)} disabled={loading}>
              Continue
            </Button>
          ) : (
            <Button full onClick={() => finish('save')} disabled={saving || loading}>
              {saving ? 'Saving…' : fromSettings ? 'Save' : 'See my feed'}
            </Button>
          )}
          {/*
            SKIP IS ON EVERY STEP, and it is a real button rather than a link, because it has to
            stamp `onboardedAt` — otherwise the prompt in the feed comes back on the next visit and
            the user has to decline the same thing repeatedly. From settings it is "Cancel", which
            is the same action with an honest label: nothing saved, go back.
          */}
          <button
            type="button"
            onClick={() => finish('skip')}
            disabled={saving}
            className="shrink-0 rounded-full px-3 py-2 text-[13px] font-semibold text-[#8E8E93] hover:text-[#1D1D1F] disabled:opacity-45"
          >
            {fromSettings ? 'Cancel' : 'Skip for now'}
          </button>
        </div>
        {!fromSettings && (
          <p className="mx-auto mt-2 max-w-[640px] text-center text-[11.5px] text-[#a1a1a6]">
            You can change all of this later in{' '}
            <Link href="/settings" className="font-semibold text-[#0071E3] hover:underline">
              Settings
            </Link>
            .
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * A radio as a full-width row.
 *
 * A native `<input type="radio">` inside the label, not a styled `<div>` with `role="radio"`:
 * keyboard arrow-key group navigation, form semantics and screen-reader grouping all come free and
 * none of them survive a hand-rolled version.
 */
function RadioRow({
  name,
  label,
  hint,
  checked,
  onChange,
}: {
  name: string;
  label: string;
  hint: string;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-xl px-1 py-2 hover:bg-[#F7F7F9]">
      <input
        type="radio"
        name={name}
        checked={checked}
        onChange={onChange}
        className="mt-0.5 h-[18px] w-[18px] shrink-0 accent-[#0071E3]"
      />
      <span>
        <span className="block text-[14px] font-semibold text-[#1D1D1F]">{label}</span>
        <span className="block text-[12.5px] text-[#6E6E73]">{hint}</span>
      </span>
    </label>
  );
}
