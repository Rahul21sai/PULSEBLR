'use client';

import { useMemo, useState } from 'react';
import Sheet from '../components/Sheet';
import { Banner, Button } from '../components/ui';
import { relativeTime } from '@/lib/format';
import type { MergeCandidate, MergePair } from '@/lib/person-types';

/**
 * "Are these two the same person?" — side by side, one field at a time.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * THE PRODUCT SURFACE FOR A DETECTED DUPLICATE USED TO BE A `met 3 x` BADGE. `contactKey` found the
 * duplicate; nothing anywhere let you do something about it. So the same human met three times was
 * three rows with three notes and three follow-up dates, and the detection was decoration.
 *
 * A MERGE IS NEVER AUTOMATIC, and this sheet is why that is affordable rather than merely cautious. A
 * wrong merge destroys the distinction between two real people and is very hard to unwind once notes
 * and follow-ups interleave; an un-merged duplicate is merely untidy. So the machine suggests, shows
 * its evidence — the shared `contactKey` is printed, not hidden — and a human decides.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * THREE OUTCOMES, ALL REACHABLE FROM HERE, because a decision you cannot reverse is a decision people
 * avoid making:
 *
 *   · MERGE — nothing is deleted. The loser keeps its keys and gains a `mergedInto` tombstone, so its
 *     old `/people/<id>` URL still resolves and a later capture carrying an old key routes to the
 *     survivor instead of re-creating the person.
 *   · NOT THE SAME PERSON — recorded on BOTH rows, so the suggestion cannot come back from the other
 *     direction. A dismissal that reappears is worse than never having suggested it: the user
 *     re-decides something they already decided and cannot tell whether their answer registered.
 *   · UNDO — offered immediately after a merge, in the same sheet, while the ids are still on screen.
 *     Reversibility that you have to go and find is a claim; reversibility next to the button that
 *     needed it is a feature.
 */

/** The fields the user can be asked to choose between. `headline` is not one — nobody edits it. */
const CHOICE_FIELDS = [
  { key: 'displayName', label: 'Name' },
  { key: 'company', label: 'Company' },
  { key: 'role', label: 'Role' },
] as const;

type ChoiceField = (typeof CHOICE_FIELDS)[number]['key'];

function fieldValue(person: MergeCandidate, field: ChoiceField): string {
  const raw = field === 'displayName' ? person.displayName : person[field];
  return (raw ?? '').trim();
}

export default function MergeSheet({
  open,
  pairs,
  onClose,
  onMerged,
  onDismissed,
}: {
  open: boolean;
  pairs: MergePair[];
  onClose: () => void;
  /** The list has to reload: one of these rows is now a tombstone and must stop being listed. */
  onMerged: (message: string) => void;
  onDismissed: (message: string) => void;
}) {
  const [index, setIndex] = useState(0);
  const [winnerId, setWinnerId] = useState<string | null>(null);
  const [choices, setChoices] = useState<Partial<Record<ChoiceField, string>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Set after a successful merge, so Undo has the ids it needs without another fetch. */
  const [justMerged, setJustMerged] = useState<{ loserId: string; name: string } | null>(null);
  /**
   * Pairs dismissed in THIS sheet, remembered locally.
   *
   * The server has recorded them on both rows, so they will not come back — but the parent's `pairs`
   * prop is only refreshed by its own refetch, and until that lands, merely advancing an index is not
   * enough: with one pair left, `Math.min(index, length - 1)` clamps straight back to the pair just
   * dismissed and re-offers a decision the user has already made. Filtering is what actually removes it.
   */
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const pairId = (p: MergePair) => [p.a._id, p.b._id].sort().join(':');
  const visible = useMemo(
    () => pairs.filter(p => !dismissed.has(pairId(p))),
    [pairs, dismissed]
  );
  const pair = visible[Math.min(index, Math.max(0, visible.length - 1))];

  /**
   * WHO SURVIVES, defaulted rather than demanded.
   *
   * The row with more history wins by default, because merging into the thinner row means the merge
   * has more to move and more chances to leave something behind. The user can still flip it — but
   * being asked to pick a winner before being shown the two records is the wrong order.
   */
  const defaultWinner = useMemo(() => {
    if (!pair) return null;
    const score = (p: MergeCandidate) => p.interactionCount * 10 + p.eventCount;
    return score(pair.b) > score(pair.a) ? pair.b._id : pair.a._id;
  }, [pair]);

  const effectiveWinner = winnerId ?? defaultWinner;
  const winner = pair && effectiveWinner === pair.b._id ? pair.b : pair?.a;
  const loser = pair && effectiveWinner === pair.b._id ? pair.a : pair?.b;

  /**
   * Only fields where the two sides genuinely DISAGREE need a choice.
   *
   * Where they agree, or where only one side has a value, derivation already produces the right
   * answer — `derivePersonFields` falls back per field to the newest encounter that HAD a value, so a
   * capture with a name and no company cannot blank a company you already knew. Asking about those
   * fields would be asking the user to confirm something that cannot go wrong, and every answer would
   * be stored as an override that no future capture could improve.
   */
  const contested = useMemo(() => {
    if (!winner || !loser) return [];
    return CHOICE_FIELDS.filter(field => {
      const a = fieldValue(winner, field.key);
      const b = fieldValue(loser, field.key);
      return a && b && a !== b;
    });
  }, [winner, loser]);

  function reset() {
    setWinnerId(null);
    setChoices({});
    setError(null);
    setJustMerged(null);
  }

  function nextPair() {
    reset();
    setIndex(i => i + 1);
  }

  async function post(body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/people/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        // The route names the field it refused, so show that rather than a generic apology.
        setError(typeof data.error === 'string' ? data.error : `Could not do that (${res.status}).`);
        return null;
      }
      return data;
    } catch {
      setError('Could not reach the server. Nothing was changed.');
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function doMerge() {
    if (!winner || !loser) return;
    /**
     * The picked values are sent as `overrides`, which is the ONLY place a human decision survives.
     * Written onto the derived fields instead they would be undone by the next `recomputePerson()` —
     * and that runs on every note, every follow-up and every new scan.
     */
    const overrides: Record<string, string> = {};
    for (const field of contested) {
      overrides[field.key] = choices[field.key] ?? fieldValue(winner, field.key);
    }

    const data = await post({
      action: 'merge',
      winnerId: winner._id,
      loserId: loser._id,
      ...(Object.keys(overrides).length ? { overrides } : {}),
    });
    if (!data) return;

    setJustMerged({ loserId: loser._id, name: loser.displayName });
    onMerged(`Merged “${loser.displayName}” into “${winner.displayName}”.`);
  }

  async function doUndo() {
    if (!justMerged) return;
    const data = await post({ action: 'unmerge', loserId: justMerged.loserId });
    if (!data) return;
    setJustMerged(null);
    onMerged(`Merge undone — “${justMerged.name}” is a separate person again.`);
  }

  async function doDismiss() {
    if (!pair) return;
    const data = await post({
      action: 'dismiss',
      personId: pair.a._id,
      otherId: pair.b._id,
    });
    if (!data) return;
    setDismissed(current => new Set(current).add(pairId(pair)));
    onDismissed('Noted — we won’t suggest those two again.');
    // Index is RESET rather than advanced: the dismissed pair has just been filtered out, so the
    // next one has taken its place at the current index. Advancing would skip it.
    reset();
    setIndex(0);
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      labelledBy="merge-sheet-title"
      title="Possible duplicate"
      subtitle={
        visible.length > 1
          ? `${Math.min(index + 1, visible.length)} of ${visible.length}`
          : undefined
      }
      footer={
        justMerged ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[12.5px] text-[#6E6E73]">
              Nothing was deleted — this can be undone.
            </span>
            <div className="flex gap-2">
              <Button size="sm" tone="quiet" onClick={() => void doUndo()} disabled={busy}>
                Undo merge
              </Button>
              {index + 1 < visible.length ? (
                <Button size="sm" tone="primary" onClick={nextPair} disabled={busy}>
                  Next duplicate
                </Button>
              ) : (
                <Button size="sm" tone="primary" onClick={onClose} disabled={busy}>
                  Done
                </Button>
              )}
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button
              tone="primary"
              onClick={() => void doMerge()}
              disabled={busy || !pair}
              icon="merge"
            >
              {busy ? 'Working…' : 'Merge into one person'}
            </Button>
            <Button tone="quiet" onClick={() => void doDismiss()} disabled={busy || !pair}>
              Not the same person
            </Button>
          </div>
        )
      }
    >
      {!pair ? (
        <p className="text-[13.5px] text-[#6E6E73]">No duplicates left to review.</p>
      ) : (
        <div className="flex flex-col gap-4">
          {error && <Banner tone="error">{error}</Banner>}

          {justMerged ? (
            <Banner tone="ok">
              Merged. “{justMerged.name}” is now part of one record — their notes, timeline and
              follow-ups came with them, and their old link still works.
            </Banner>
          ) : (
            <>
              {/* THE EVIDENCE, shown rather than asserted. A suggestion you cannot argue with is
                  one you either obey or ignore. */}
              <div className="rounded-xl bg-[#F7F7F9] p-3.5 text-[12.5px] leading-relaxed text-[#3a3a3c]">
                Both records point at the same identity key{' '}
                <code className="rounded bg-white px-1.5 py-0.5 text-[11.5px] text-[#1D1D1F]">
                  {pair.contactKey || 'unknown'}
                </code>
                . That usually means one person scanned twice — but a key can be shared by mistake, so
                nothing was merged automatically.
              </div>

              <fieldset>
                <legend className="t-label mb-2 text-[#8E8E93]">Which record survives?</legend>
                <div className="grid gap-2 sm:grid-cols-2">
                  {[pair.a, pair.b].map(candidate => (
                    <CandidateCard
                      key={candidate._id}
                      candidate={candidate}
                      selected={effectiveWinner === candidate._id}
                      onSelect={() => {
                        setWinnerId(candidate._id);
                        // The contested set is computed from winner-vs-loser, so a flip invalidates
                        // every per-field pick made against the old orientation.
                        setChoices({});
                      }}
                    />
                  ))}
                </div>
              </fieldset>

              {contested.length > 0 && winner && loser && (
                <div>
                  <p className="t-label mb-2 text-[#8E8E93]">These disagree — pick one of each</p>
                  <div className="flex flex-col gap-3">
                    {contested.map(field => {
                      const options = [fieldValue(winner, field.key), fieldValue(loser, field.key)];
                      const chosen = choices[field.key] ?? options[0];
                      return (
                        <div key={field.key}>
                          <p className="text-[12px] text-[#8E8E93]">{field.label}</p>
                          <div className="mt-1 flex flex-wrap gap-x-1.5 gap-y-2">
                            {options.map(option => (
                              <button
                                key={option}
                                type="button"
                                aria-pressed={chosen === option}
                                onClick={() =>
                                  setChoices(current => ({ ...current, [field.key]: option }))
                                }
                                className={`relative inline-flex h-9 items-center rounded-full px-3.5 text-[12.5px] font-semibold transition-colors [touch-action:manipulation] after:absolute after:inset-x-0 after:top-1/2 after:h-11 after:-translate-y-1/2 after:content-[''] ${
                                  chosen === option
                                    ? 'bg-[#0071E3] text-white'
                                    : 'bg-white text-[#1D1D1F] shadow-[inset_0_0_0_1px_var(--hairline)] hover:bg-[#F7F7F9]'
                                }`}
                              >
                                {option}
                              </button>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <p className="mt-2 text-[12px] leading-relaxed text-[#A1A1A6]">
                    Your pick is stored as a correction, so the next scan can’t quietly revert it.
                  </p>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </Sheet>
  );
}

function CandidateCard({
  candidate,
  selected,
  onSelect,
}: {
  candidate: MergeCandidate;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`rounded-xl p-3.5 text-left transition-colors [touch-action:manipulation] ${
        selected
          ? 'bg-[#EBF4FE] shadow-[inset_0_0_0_2px_var(--blue)]'
          : 'bg-white shadow-[inset_0_0_0_1px_var(--hairline)] hover:bg-[#F7F7F9]'
      }`}
    >
      <p className="t-sub truncate text-[#1D1D1F]">{candidate.displayName}</p>
      <p className="mt-0.5 truncate text-[12.5px] text-[#6E6E73]">
        {[candidate.role || candidate.headline, candidate.company].filter(Boolean).join(' · ') ||
          'No role or company recorded'}
      </p>
      <p className="mt-1.5 text-[12px] text-[#8E8E93]">
        <span className="tnum">{candidate.eventCount}</span>{' '}
        {candidate.eventCount === 1 ? 'event' : 'events'} ·{' '}
        <span className="tnum">{candidate.interactionCount}</span> in the timeline
        {candidate.lastInteractionAt ? ` · last ${relativeTime(candidate.lastInteractionAt)}` : ''}
      </p>
      {selected && (
        <p className="mt-1.5 text-[11.5px] font-bold uppercase tracking-[0.055em] text-[#0058B0]">
          Survives
        </p>
      )}
    </button>
  );
}
