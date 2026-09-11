'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import AppShell from '../../components/AppShell';
import Sheet from '../../components/Sheet';
import MergeSheet, { sharedKeyEvidence } from '../MergeSheet';
import { TAP_44, useTagVocabulary } from '../../components/scan/ContactFields';
import {
  Banner,
  Button,
  ButtonLink,
  Card,
  EmptyState,
  PageHeader,
  SectionTitle,
  Skeleton,
  Well,
} from '../../components/ui';
import { dayHeading, fullDateIST, relativeTime, shortDateIST } from '@/lib/format';
import {
  INTERACTION_ICON,
  INTERACTION_LABEL,
  personIdentityLine,
  type InteractionDTO,
  type MergePair,
  type PersonDTO,
} from '@/lib/person-types';
import type { ContactDTO } from '@/lib/contacts/types';

/**
 * ONE HUMAN: who they are, every time you met them, and what you owe them next.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * THREE DEFECTS THIS PAGE EXISTS TO FIX, all of which were structural rather than cosmetic.
 *
 *   1. THERE WAS NO PERSON PAGE. `/people` rows were not clickable and `app/people/[id]/` did not
 *      exist, so the only contact editor lived inside `app/folders/[id]/page.tsx` — correcting a
 *      misread name meant first remembering which event you met them at.
 *
 *   2. A NOTE WAS ONE STRING THAT EVERY EDIT OVERWROTE. What you wrote at the event was gone the
 *      first time you added anything. Notes here APPEND to the timeline: `Interaction` carries no
 *      `updatedAt` and its middleware refuses every modification except a merge repointing
 *      `personId`, because a timeline you can edit is not evidence.
 *
 *   3. "WHEN DID I LAST TALK TO HER" WAS UNANSWERABLE. `completeContactFollowUp()` flipped a boolean
 *      and recorded no timestamp. Every action on this page — a note, a completed follow-up, a
 *      message sent — writes a dated row, so `lastInteractionAt` is a fact rather than capture time.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * NO INVENTED RELATIONSHIP SCORE. A fabricated warmth number is worse than none; "last contacted" and
 * "next action" answer the real question — who have I gone quiet on — with dates.
 */

interface MergeSuggestion {
  personId: string;
  displayName: string;
  contactKey: string;
}

interface Payload {
  person: PersonDTO;
  contacts: ContactDTO[];
  interactions: InteractionDTO[];
  timelineTruncated?: boolean;
  suggestions: MergeSuggestion[];
}

/**
 * The note textarea's id, shared with the draft sheet.
 *
 * A constant rather than a literal in two places: the sheet's "Add a note" button is the ONLY exit
 * from its blocked state, and a button that silently fails to find its target reads as a button that
 * does nothing.
 */
const NOTE_FIELD_ID = 'person-note-draft';

/**
 * Field and section labels inside the sheets. One constant rather than six copies, so the sheets cannot
 * drift from each other one edit at a time.
 *
 * THIS WAS WRITTEN AS EXPLICIT SIZES AND THEN PUT BACK ON `.t-label` MID-TASK, and the reason is worth
 * recording. `.t-label` used to be 11px at +0.055em with `text-transform: uppercase` — the tracked-out
 * ALL-CAPS eyebrow `docs/design-direction.md` names first among the patterns to remove, shouting "NAME"
 * above a name field. So these six labels were rewritten with their own sizes. While that was in flight
 * the owner of `globals.css` de-capsed `.t-label` itself and moved the shout to a new `.t-label-caps`,
 * which is the better fix in the better place — so hardcoding sizes here would now be a SECOND
 * definition of the app's small-label style, drifting from the first by construction. The colour stays
 * explicit because these are ink labels, not the grey the class is usually paired with.
 */
const SHEET_LABEL = 't-label text-[color:var(--ink)]';

/** Follow-up offsets. Deliberately few — the point is one tap, not a date picker. */
const SNOOZE_CHOICES: Array<{ label: string; days: number }> = [
  { label: 'Tomorrow', days: 1 },
  { label: 'In 3 days', days: 3 },
  { label: 'Next week', days: 7 },
  { label: 'In 2 weeks', days: 14 },
];

/**
 * Noon IST, N days out.
 *
 * NOT `<input type="date">`'s `YYYY-MM-DD`, which Mongoose casts to UTC midnight — 5:30 AM IST the
 * same day — so anything that later subtracts hours slides the reminder into the previous day. Same
 * reasoning, and the same shape, as `ContactFields`' own `followUpIso`.
 */
function followUpIso(days: number): string {
  const target = new Date(Date.now() + days * 24 * 3600 * 1000);
  const y = target.getFullYear();
  const m = String(target.getMonth() + 1).padStart(2, '0');
  const d = String(target.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}T12:00:00+05:30`;
}

export default function PersonDetailClient({ id }: { id: string }) {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [noteDraft, setNoteDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [mergePairs, setMergePairs] = useState<MergePair[]>([]);
  const [mergeOpen, setMergeOpen] = useState(false);

  const tagVocabulary = useTagVocabulary();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/people/${id}`);
      if (res.status === 404) {
        setNotFound(true);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
      setError(null);
    } catch {
      setError('Could not load this person. Nothing has been lost — try again in a moment.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  // Deferred with a zero timeout, matching every other fetching page here: `react-hooks/
  // set-state-in-effect` refuses a setState reached synchronously from an effect body, and deferring
  // is what this repo does instead of disabling the rule.
  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  function flash(message: string) {
    setNotice(message);
    setTimeout(() => setNotice(null), 5000);
  }

  /** Every write on this page is a PATCH, and every PATCH reloads — the counters are derived. */
  const patch = useCallback(
    async (body: Record<string, unknown>, success?: string): Promise<boolean> => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`/api/people/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!res.ok) {
          // The route names the field it refused. Showing that beats a generic apology, and it is
          // deliberately NOT a Mongoose message — those name the model and the schema path.
          setError(
            typeof payload.error === 'string' ? payload.error : `Could not save that (${res.status}).`
          );
          return false;
        }
        if (success) flash(success);
        await load();
        return true;
      } catch {
        setError('Could not reach the server. Nothing was changed.');
        return false;
      } finally {
        setBusy(false);
      }
    },
    [id, load]
  );

  /**
   * The duplicate pair for THIS person, taken from the same endpoint the list banner uses.
   *
   * `GET /api/people/[id]` already returns `suggestions`, but those carry only a name and the shared
   * key — not enough for a side-by-side compare. Rather than a second suggestion shape, the compare
   * sheet is fed from `/api/people/merge`, which is the one place that builds both candidates from the
   * same mapper so the two sides cannot disagree about what they are showing.
   */
  const openMerge = useCallback(async () => {
    try {
      const res = await fetch('/api/people/merge');
      if (!res.ok) return;
      const payload = await res.json();
      const all: MergePair[] = Array.isArray(payload.pairs) ? payload.pairs : [];
      setMergePairs(all.filter(pair => pair.a._id === id || pair.b._id === id));
      setMergeOpen(true);
    } catch {
      setError('Could not load the duplicate details.');
    }
  }, [id]);

  const person = data?.person;
  /**
   * Memoised rather than `data?.contacts ?? []`, because a bare `??` mints a NEW empty array on every
   * render — so the two `useMemo`s below would recompute every time regardless of whether anything
   * changed, and `react-hooks/exhaustive-deps` says so.
   */
  const contacts = useMemo(() => data?.contacts ?? [], [data]);
  const interactions = useMemo(() => data?.interactions ?? [], [data]);

  /**
   * Contact details, newest-first PER FIELD.
   *
   * The same rule `derivePersonFields` uses on the server, and for the same reason: a LinkedIn QR
   * carries a vanity slug and no email, so taking the newest capture WHOLE would blank an address you
   * already had. `Person` deliberately stores none of these — they belong to an encounter — so this is
   * assembled for display only.
   */
  const details = useMemo(() => {
    const pick = (get: (c: ContactDTO) => string | null | undefined): string | null => {
      for (const contact of contacts) {
        const value = (get(contact) ?? '').trim();
        if (value) return value;
      }
      return null;
    };
    return {
      email: pick(c => c.email),
      phone: pick(c => c.phone),
      linkedin: person?.linkedin ?? pick(c => c.linkedin),
      github: pick(c => c.github),
      x: pick(c => c.x),
      website: pick(c => c.website),
    };
  }, [contacts, person?.linkedin]);

  /** The timeline, grouped by the event it happened at. Most recent group first. */
  const groups = useMemo(() => groupByEvent(interactions), [interactions]);

  if (loading && !data) {
    return (
      <AppShell title="Person">
        <div className="mx-auto max-w-[860px] px-4 pt-4 md:px-8">
          <Card>
            <Skeleton className="h-6 w-1/2" />
            <Skeleton className="mt-3 h-4 w-1/3" />
            <Skeleton className="mt-6 h-24 w-full" />
          </Card>
        </div>
      </AppShell>
    );
  }

  if (notFound || !person) {
    return (
      <AppShell title="Person">
        <div className="mx-auto max-w-[860px] px-4 pt-4 md:px-8">
          <EmptyState
            icon="person_off"
            title="We don’t have that person"
            /* Same message for "not yours" as for "never existed" — the API answers 404 for both, so
               that ownership is not observable, and the page must not undo that by guessing. */
            body="The link may be old, or the last time you met them may have been deleted."
            action={
              <ButtonLink href="/people" tone="primary" icon="groups">
                Back to everyone
              </ButtonLink>
            }
          />
        </div>
      </AppShell>
    );
  }

  const overdue = person.nextActionAt && new Date(person.nextActionAt) <= new Date();

  return (
    <AppShell title="Person">
      <div className="mx-auto max-w-[860px] px-4 pt-4 pb-6 md:px-8">
        <Link
          href="/people"
          className="mb-3 inline-flex h-11 items-center gap-1 text-[13px] font-semibold text-[color:var(--blue)] hover:underline"
        >
          <span aria-hidden="true" className="material-symbols-outlined text-[18px]">
            arrow_back
          </span>
          Everyone you&apos;ve met
        </Link>

        {error && (
          <div className="mb-4">
            <Banner tone="error">{error}</Banner>
          </div>
        )}
        {notice && (
          <div className="mb-4">
            <Banner tone="ok">{notice}</Banner>
          </div>
        )}

        {/*
          A TOMBSTONE STILL RESOLVES, AND SAYS SO. `mergedInto` is a soft tombstone precisely so an
          old link keeps working after a merge; landing on a silent copy of a person who now lives
          somewhere else is how a user concludes the merge duplicated them.
        */}
        {person.mergedInto && (
          <div className="mb-4">
            <Banner tone="warn">
              This record was merged into another person. Everything moved across —{' '}
              <Link href={`/people/${person.mergedInto}`} className="font-semibold underline">
                open the surviving record
              </Link>
              . You can undo the merge from the duplicates review on the people list.
            </Banner>
          </div>
        )}

        {/*
          NO EYEBROW. It rendered "MET AT 2 EVENTS" as a tracked-out ALL-CAPS label above the person's
          own name — the pattern `docs/design-direction.md` names first, saying the same thing the pill
          beside the name says, in the loudest available voice. The pills below follow the card's rule:
          a FILL means act on this, an OUTLINE means it is simply true.
        */}
        <PageHeader
          title={
            <span className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
              {person.displayName}
              {/* Bounded with a `--good` marker, matching the card and the rail. The filled version was
                  `--good` on `--good-wash`, measured at 4.00:1 — a WCAG AA failure at 11px. */}
              {person.isTargetCompany && (
                <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold leading-[1.45] text-[color:var(--ink-2)] shadow-[inset_0_0_0_1px_var(--hairline-strong)]">
                  <span aria-hidden="true" className="text-[color:var(--good)]">
                    ●
                  </span>
                  target company
                </span>
              )}
              {person.eventCount > 1 && (
                <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold leading-[1.45] text-[color:var(--ink-2)] shadow-[inset_0_0_0_1px_var(--hairline-strong)]">
                  <span>met <span className="tnum">{person.eventCount}</span>×</span>
                </span>
              )}
            </span>
          }
          subtitle={
            <>
              {personIdentityLine(person) || 'No role or company recorded'}
              {person.lastInteractionAt && (
                /* Its own line rather than appended after a middle dot: "who have I gone quiet on" is
                   the question this half of the product exists to answer, not a trailing detail. */
                <span className="mt-0.5 block text-[color:var(--ink-3)]">
                  Last spoke {relativeTime(person.lastInteractionAt)}
                </span>
              )}
            </>
          }
          action={
            <div className="flex flex-wrap items-center gap-2">
              {details.linkedin && (
                <ButtonLink href={details.linkedin} tone="quiet" icon="open_in_new" external>
                  LinkedIn
                </ButtonLink>
              )}
              {/*
                MESSAGE OPENS THE CHANNEL *AND* RECORDS THAT IT HAPPENED.
                Recording it is the whole point: a `message-sent` row is what moves
                `lastInteractionAt`, which is the field that makes "who have I gone quiet on"
                answerable. The window is opened FIRST and synchronously, because a popup blocker
                treats a window opened after an await as unsolicited and silently drops it.
              */}
              {(details.linkedin || details.email) && (
                <Button
                  tone="primary"
                  icon="send"
                  disabled={busy}
                  onClick={() => {
                    const target = details.linkedin ?? `mailto:${details.email}`;
                    window.open(target, '_blank', 'noopener,noreferrer');
                    void patch({ messageSent: true }, 'Logged that you reached out.');
                  }}
                >
                  Message
                </Button>
              )}
              <Button tone="quiet" icon="edit" onClick={() => setEditing(true)} disabled={busy}>
                Correct
              </Button>
            </div>
          }
        />

        {/* ── Duplicate suggestion ──────────────────────────────────────── */}
        {data?.suggestions && data.suggestions.length > 0 && !person.mergedInto && (
          <div className="mb-4">
            <Card padding="tight">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[13.5px] font-semibold text-[color:var(--ink)]">
                    Is this the same person as{' '}
                    <Link
                      href={`/people/${data.suggestions[0].personId}`}
                      className="text-[color:var(--blue)] hover:underline"
                    >
                      {data.suggestions[0].displayName}
                    </Link>
                    ?
                  </p>
                  {/* The raw key is evidence a reader cannot weigh, and weighing it IS the decision:
                      a shared LinkedIn slug is near-proof, a shared NAME is the exact failure
                      `contactKey` was invented to stop. `sharedKeyEvidence` grades it in words. */}
                  <p className="mt-0.5 text-[12.5px] leading-relaxed text-[color:var(--ink-2)]">
                    Both records carry{' '}
                    {sharedKeyEvidence(data.suggestions[0].contactKey).what}. Nothing was merged — a
                    wrong merge is far harder to undo than a duplicate.
                  </p>
                </div>
                <Button size="sm" tone="primary" icon="merge" onClick={() => void openMerge()}>
                  Compare
                </Button>
              </div>
            </Card>
          </div>
        )}

        {/* ── Follow-up ─────────────────────────────────────────────────── */}
        <div className="mb-4">
          <Card>
            <SectionTitle
              title="Next action"
              subtitle={
                person.nextActionAt
                  ? `${overdue ? 'Was due' : 'Due'} ${dayHeading(person.nextActionAt)} · ${relativeTime(person.nextActionAt)}`
                  : 'Nothing outstanding.'
              }
              /*
                DRAFTING LIVES HERE, NOT IN THE PAGE HEADER, because writing the message IS the
                follow-up — the header already carries LinkedIn / Message / Correct, and a fourth
                control there would put four sub-44px targets in one row, which is the adjacency the
                `TAP_44` note warns about. Alone in this slot it has 12px of clear space below it and
                nothing beside it, so the overlay cannot contest a neighbour's band.
              */
              action={
                <Button
                  tone="quiet"
                  icon="edit_note"
                  disabled={busy}
                  onClick={() => setDrafting(true)}
                  className={TAP_44}
                >
                  Draft a follow-up
                </Button>
              }
            />
            {/*
              FOLLOW-UPS ARE STORED PER ENCOUNTER AND SHOWN PER PERSON, so the controls have to
              collapse them: "Done" closes every outstanding reminder, and setting a date replaces
              the others rather than joining them. Otherwise `nextActionAt` — which is the SOONEST
              outstanding date — stays pinned to an older reminder and the button looks broken while
              having done exactly what it said.
            */}
            <div className="flex flex-wrap items-center gap-2">
              {person.nextActionAt && (
                <Button
                  tone="secondary"
                  icon="task_alt"
                  disabled={busy}
                  onClick={() =>
                    void patch({ followUp: { action: 'done' } }, 'Marked as followed up.')
                  }
                >
                  Done
                </Button>
              )}
              {SNOOZE_CHOICES.map(choice => (
                <Button
                  key={choice.days}
                  tone="quiet"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void patch(
                      { followUp: { action: 'set', at: followUpIso(choice.days) } },
                      `Reminder set for ${choice.label.toLowerCase()}.`
                    )
                  }
                >
                  {person.nextActionAt ? choice.label : `Remind ${choice.label.toLowerCase()}`}
                </Button>
              ))}
            </div>
          </Card>
        </div>

        {/* ── Add a note ────────────────────────────────────────────────── */}
        <div className="mb-4">
          <Card>
            <SectionTitle
              title="Add a note"
              subtitle="Appended to the timeline. Nothing you wrote before is overwritten."
            />
            <textarea
              /* Addressed by the draft sheet's "Add a note" button, which has to land the user in
                 this field rather than merely closing itself and claiming to have helped. */
              id={NOTE_FIELD_ID}
              value={noteDraft}
              onChange={e => setNoteDraft(e.target.value)}
              rows={3}
              maxLength={4000}
              placeholder="What did you talk about? What did you promise them?"
              aria-label="New note"
              className="w-full rounded-xl bg-[#F7F7F9] p-3.5 text-[14.5px] leading-relaxed text-[color:var(--ink)] outline-none focus:shadow-[inset_0_0_0_2px_var(--blue)]"
            />
            <div className="mt-2 flex justify-end">
              <Button
                tone="primary"
                icon="add"
                disabled={busy || !noteDraft.trim()}
                onClick={async () => {
                  const saved = await patch({ note: noteDraft.trim() }, 'Note added.');
                  // Cleared only on success, so a failed save does not silently eat what was typed.
                  if (saved) setNoteDraft('');
                }}
              >
                Add note
              </Button>
            </div>
          </Card>
        </div>

        {/* ── Timeline ──────────────────────────────────────────────────── */}
        <div className="mb-4">
          <Card>
            <SectionTitle
              title="History"
              subtitle={
                interactions.length === 0
                  ? 'Nothing recorded yet.'
                  : `${interactions.length} ${interactions.length === 1 ? 'entry' : 'entries'}, newest first, grouped by where it happened.`
              }
            />
            {interactions.length === 0 ? (
              <p className="text-[13px] text-[color:var(--ink-2)]">
                Captures made before this page existed have no timeline until the backfill runs.
              </p>
            ) : (
              <div className="flex flex-col gap-5">
                {groups.map(group => (
                  <div key={group.key}>
                    <div className="flex flex-wrap items-baseline gap-2 border-b border-[color:var(--hairline)] pb-1.5">
                      <h3 className="text-[13.5px] font-semibold text-[color:var(--ink)]">
                        {group.eventId ? (
                          // A dangling `eventId` is NORMAL: `pruneStale()` deletes events 7 days
                          // past without touching their references. Say so rather than render blank.
                          group.title ? (
                            <Link href={`/events/${group.eventId}`} className="hover:underline">
                              {group.title}
                            </Link>
                          ) : (
                            <span className="text-[color:var(--ink-3)]">An event we no longer have</span>
                          )
                        ) : (
                          'Not at an event'
                        )}
                      </h3>
                      {group.startAt && (
                        <span className="text-[12px] text-[color:var(--ink-3)]">
                          {shortDateIST(group.startAt)}
                        </span>
                      )}
                    </div>
                    <ul className="mt-2 flex flex-col gap-2.5">
                      {group.items.map(item => (
                        <li key={item._id} className="flex items-start gap-2.5">
                          <span
                            aria-hidden="true"
                            className="material-symbols-outlined mt-[2px] text-[16px] text-[color:var(--ink-3)]"
                          >
                            {INTERACTION_ICON[item.kind]}
                          </span>
                          <div className="min-w-0">
                            <p className="text-[13px] text-[color:var(--ink)]">
                              <span className="font-semibold">{INTERACTION_LABEL[item.kind]}</span>
                              <span className="text-[color:var(--ink-3)]">
                                {' · '}
                                {fullDateIST(item.at)}
                              </span>
                            </p>
                            {item.note && (
                              <p className="mt-0.5 whitespace-pre-wrap text-[13px] leading-relaxed text-[color:var(--ink-2)]">
                                {item.note}
                              </p>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
                {data?.timelineTruncated && (
                  <p className="text-[12px] text-[color:var(--ink-3)]">
                    Showing the most recent entries only.
                  </p>
                )}
              </div>
            )}
          </Card>
        </div>

        {/* ── Contact details + captures ────────────────────────────────── */}
        <div className="mb-4 grid gap-4 md:grid-cols-2">
          <Card>
            <SectionTitle title="How to reach them" subtitle="Newest value we have for each." />
            <dl className="flex flex-col">
              <DetailRow label="Email" value={details.email} href={details.email ? `mailto:${details.email}` : null} />
              <DetailRow label="Phone" value={details.phone} href={details.phone ? `tel:${details.phone}` : null} />
              <DetailRow label="LinkedIn" value={details.linkedin} href={details.linkedin} external />
              <DetailRow label="GitHub" value={details.github} href={details.github} external />
              <DetailRow label="X" value={details.x} href={details.x} external />
              <DetailRow label="Website" value={details.website} href={details.website} external />
            </dl>
          </Card>

          <Card>
            <SectionTitle
              title={`${contacts.length} ${contacts.length === 1 ? 'capture' : 'captures'}`}
              subtitle="Each time you scanned or recorded them. These are what the fields above are derived from."
            />
            {contacts.length === 0 ? (
              <p className="text-[13px] text-[color:var(--ink-2)]">No captures left — this record is empty.</p>
            ) : (
              <ul className="flex flex-col gap-2.5">
                {contacts.map(contact => (
                  <li key={contact._id} className="text-[12.5px]">
                    <p className="font-semibold text-[color:var(--ink)]">
                      {contact.folderName ? (
                        <Link href={`/folders/${contact.folderId}`} className="hover:underline">
                          {contact.folderName}
                        </Link>
                      ) : (
                        <span title="The folder this capture was in has been deleted">
                          Folder gone
                        </span>
                      )}
                    </p>
                    <p className="text-[color:var(--ink-3)]">
                      {shortDateIST(contact.scannedAt)}
                      {contact.company ? ` · ${contact.company}` : ''}
                    </p>
                    {/*
                      THE OLD SINGLE `note` FIELD, shown read-only. It is still where a note typed in
                      the capture sheet lands, and it is still overwritten on edit there — which is the
                      defect the timeline above replaces. Hiding it would hide notes people already
                      wrote; editing it from here would rebuild the defect.
                    */}
                    {contact.note && (
                      <p className="mt-0.5 whitespace-pre-wrap text-[color:var(--ink-2)]">{contact.note}</p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>

      {/*
        MOUNTED ONLY WHILE OPEN, so its fields initialise from the person at mount rather than being
        reset by an effect. The effect version was flagged by `react-hooks/set-state-in-effect`, and
        the rule was right: state derived from props at mount belongs in a `useState` initialiser, and
        a fresh mount is also what guarantees a cancelled edit cannot linger and reappear later
        looking like an unsaved change that was quietly kept. `Sheet` restores focus on unmount.
      */}
      {editing && (
        <EditPersonSheet
          person={person}
          busy={busy}
          tagSuggestions={tagVocabulary}
          onClose={() => setEditing(false)}
          onSave={async (overrides, ownTags) => {
            const saved = await patch({ overrides, ownTags }, 'Saved.');
            if (saved) setEditing(false);
          }}
        />
      )}

      {/*
        MOUNTED ONLY WHILE OPEN, for the reason the edit sheet above records — and for one more here:
        the sheet fetches what a draft would be written from when it mounts, so a fresh mount is what
        guarantees the disclosure describes the note as it is NOW rather than as it was when the page
        loaded. A note added in the meantime would otherwise be missing from a screen whose whole job
        is to say what will be sent.
      */}
      {drafting && (
        <DraftFollowupSheet
          personId={id}
          personName={person.displayName}
          linkedin={details.linkedin}
          email={details.email}
          onClose={() => setDrafting(false)}
          onOpenedChannel={() => void patch({ messageSent: true }, 'Logged that you reached out.')}
        />
      )}

      <MergeSheet
        open={mergeOpen}
        pairs={mergePairs}
        onClose={() => setMergeOpen(false)}
        onMerged={message => {
          flash(message);
          void load();
        }}
        onDismissed={message => {
          flash(message);
          void load();
        }}
      />
    </AppShell>
  );
}

function DetailRow({
  label,
  value,
  href,
  external,
}: {
  label: string;
  value: string | null;
  href?: string | null;
  external?: boolean;
}) {
  if (!value) return null;
  return (
    <div className="flex items-start justify-between gap-4 border-b border-[color:var(--hairline)] py-2.5 last:border-0">
      <dt className="shrink-0 text-[13px] text-[color:var(--ink-3)]">{label}</dt>
      <dd className="min-w-0 break-words text-right text-[13px] font-medium text-[color:var(--ink)]">
        {href ? (
          <a
            href={href}
            {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
            className="text-[color:var(--blue)] hover:underline"
          >
            {value}
          </a>
        ) : (
          value
        )}
      </dd>
    </div>
  );
}

/**
 * Draft the day-after follow-up: prose written from the note you took, always editable, never sent.
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * THE DISCLOSURE IS THE FIRST SCREEN, NOT A FOOTNOTE, AND THAT IS THE DESIGN.
 *
 * The material is one person's private notes about a named third party. Somebody who wrote "seemed
 * unhappy at his job" has to know that leaves the machine BEFORE it does — a notice shown next to a
 * finished draft is not a disclosure, it is an apology. So the sheet opens on the note itself,
 * quoted, under a sentence that says where it is going and, more usefully, what is NOT going with it.
 *
 * NAMING THE EXCLUSIONS IS THE PART THAT EARNS TRUST. "Sent to a model" is a phrase people have
 * learned to skim. "Their email, phone and your private tags stay here" is a specific, checkable
 * claim — and it is true by construction: `DRAFT_FIELDS` in `lib/llm/draft-followup.ts` is the whole
 * allowlist and `tests/draft-followup.test.ts` asserts against the bytes handed to `fetch`.
 *
 * THE PREVIEW IS FETCHED, NOT COMPUTED HERE. `GET /api/people/[id]/draft` returns exactly what the
 * POST will send. This page already holds the timeline and the captures and could have merged them
 * locally in about eight lines — and then the screen promising what will be sent and the handler
 * deciding it would be two definitions free to drift, which is how `/events/[id]`'s `WorthGoing`
 * panel ended up explaining a penalty it no longer applied.
 *
 * WHEN IT FAILS THERE IS NO TEMPLATE. There is no keyword floor for prose: "Hi <name>, great meeting
 * you at <event>" is not a degraded draft, it is a worse product wearing the same label, and the user
 * cannot tell which one they got. The failure screen says the drafting service is unavailable and
 * hands back the note verbatim to copy. Their own words are the honest fallback.
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 */
function DraftFollowupSheet({
  personId,
  personName,
  linkedin,
  email,
  onClose,
  onOpenedChannel,
}: {
  personId: string;
  personName: string;
  linkedin: string | null;
  email: string | null;
  onClose: () => void;
  onOpenedChannel: () => void;
}) {
  type Phase = 'loading' | 'preflight' | 'blocked' | 'drafting' | 'drafted' | 'failed';

  const [phase, setPhase] = useState<Phase>('loading');
  const [notes, setNotes] = useState<string[]>([]);
  const [eventTitle, setEventTitle] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  /** What a draft would be written from. No model call, so opening the sheet costs nothing. */
  useEffect(() => {
    let live = true;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/people/${personId}/draft`);
        const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!live) return;
        if (!res.ok) {
          setMessage(
            typeof payload.error === 'string'
              ? payload.error
              : 'Could not read what a draft would use.'
          );
          setPhase('failed');
          return;
        }
        setNotes(Array.isArray(payload.notes) ? (payload.notes as string[]) : []);
        setEventTitle(typeof payload.eventTitle === 'string' ? payload.eventTitle : null);
        // `canDraft: false` is a successful answer to "what would you send" — nothing. It gets its own
        // screen with a real next step rather than an error, because the fix is the user's to make.
        setPhase(payload.canDraft ? 'preflight' : 'blocked');
      } catch {
        if (!live) return;
        setMessage('Could not reach the server. Nothing was sent.');
        setPhase('failed');
      }
    }, 0);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [personId]);

  const requestDraft = useCallback(async () => {
    setPhase('drafting');
    setMessage(null);
    setCopied(false);
    try {
      const res = await fetch(`/api/people/${personId}/draft`, { method: 'POST' });
      const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (Array.isArray(payload.notes)) setNotes(payload.notes as string[]);
      if (!res.ok || typeof payload.draft !== 'string') {
        setMessage(
          typeof payload.error === 'string'
            ? payload.error
            : `Drafting failed (${res.status}). Your note is below.`
        );
        // A missing note is not an outage. The two screens differ because the next steps do.
        setPhase(payload.code === 'no-note' || payload.code === 'no-name' ? 'blocked' : 'failed');
        return;
      }
      setDraft(payload.draft);
      setPhase('drafted');
    } catch {
      setMessage('Could not reach the drafting service. Your note is below; nothing was lost.');
      setPhase('failed');
    }
  }, [personId]);

  /**
   * Copy, without awaiting inside the click handler where a window is also being opened.
   *
   * `writeText` rejects once the document loses focus, and a popup blocker drops a window opened
   * after an `await`. Both constraints are satisfied by STARTING the write synchronously and awaiting
   * the promise afterwards, which is why this takes a promise rather than the text.
   */
  const settleCopy = useCallback(async (pending: Promise<void> | undefined) => {
    if (!pending) {
      setMessage('This browser will not let a page write to the clipboard. Select the text instead.');
      return;
    }
    try {
      await pending;
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setMessage('The clipboard was blocked. Select the text and copy it by hand.');
    }
  }, []);

  const firstName = personName.trim().split(/\s+/)[0] || personName;

  /**
   * ONE ACTION THAT ACTUALLY COMPLETES THE JOB.
   *
   * LinkedIn cannot be pre-filled, so a bare "Open LinkedIn" leaves the draft behind and the user
   * retypes it. Copy-then-open is the whole move, in that order for the focus and popup reasons
   * above. Email CAN be pre-filled, so there the draft travels in the `mailto:` body and no copy is
   * needed — a different action for a different channel rather than one compromise for both.
   *
   * Opening the channel is also what logs `message-sent`, matching the existing Message button in the
   * page header. That row is what moves `lastInteractionAt`, which is what makes "who have I gone
   * quiet on" answerable — the reason the whole timeline exists.
   */
  function openChannel() {
    if (linkedin) {
      const pending = navigator.clipboard?.writeText(draft);
      window.open(linkedin, '_blank', 'noopener,noreferrer');
      onOpenedChannel();
      void settleCopy(pending);
      return;
    }
    if (email) {
      const subject = eventTitle ? `Following up from ${eventTitle}` : 'Following up';
      window.open(
        `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(draft)}`,
        '_blank',
        'noopener,noreferrer'
      );
      onOpenedChannel();
    }
  }

  const channelLabel = linkedin ? 'Copy & open LinkedIn' : 'Open in email';
  const hasChannel = Boolean(linkedin || email);

  return (
    <Sheet
      open
      onClose={onClose}
      labelledBy="draft-followup-title"
      title={`Follow up with ${firstName}`}
      subtitle={eventTitle ? `From ${eventTitle}` : 'From what you wrote down'}
      footer={
        <div className="flex flex-wrap items-center justify-end gap-2">
          {phase === 'drafted' && (
            <>
              <Button tone="quiet" icon="refresh" onClick={() => void requestDraft()}>
                Draft again
              </Button>
              <Button
                tone="quiet"
                icon={copied ? 'check' : 'content_copy'}
                onClick={() => void settleCopy(navigator.clipboard?.writeText(draft))}
              >
                {copied ? 'Copied' : 'Copy'}
              </Button>
              {hasChannel && (
                <Button tone="primary" icon="send" onClick={openChannel}>
                  {channelLabel}
                </Button>
              )}
            </>
          )}

          {phase === 'preflight' && (
            <>
              <Button tone="quiet" onClick={onClose}>
                Cancel
              </Button>
              <Button tone="primary" icon="edit_note" onClick={() => void requestDraft()}>
                Write the draft
              </Button>
            </>
          )}

          {phase === 'drafting' && (
            <Button tone="primary" disabled>
              Writing…
            </Button>
          )}

          {phase === 'failed' && (
            <>
              <Button
                tone="quiet"
                icon={copied ? 'check' : 'content_copy'}
                disabled={notes.length === 0}
                onClick={() => void settleCopy(navigator.clipboard?.writeText(notes.join('\n\n')))}
              >
                {copied ? 'Copied' : 'Copy my note'}
              </Button>
              <Button tone="primary" icon="refresh" onClick={() => void requestDraft()}>
                Try again
              </Button>
            </>
          )}

          {phase === 'blocked' && (
            <Button
              tone="primary"
              icon="add"
              onClick={() => {
                onClose();
                /*
                 * AFTER the close, deliberately. `Sheet` restores focus to whatever was focused
                 * before it opened as part of its unmount cleanup, so focusing the field from inside
                 * this handler would be undone a moment later. Deferred by a tick so the restore
                 * happens first and this wins.
                 */
                setTimeout(() => {
                  const field = document.getElementById(NOTE_FIELD_ID);
                  field?.scrollIntoView({ block: 'center', behavior: 'smooth' });
                  field?.focus();
                }, 0);
              }}
            >
              Add a note
            </Button>
          )}
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {phase === 'loading' && (
          <>
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-20 w-full" />
          </>
        )}

        {(phase === 'preflight' || phase === 'drafting') && (
          <>
            <div>
              <p className="text-[13.5px] leading-relaxed text-[color:var(--ink)]">
                {notes.length === 1 ? 'This is the note' : 'These are the notes'} the draft will be
                written from.
              </p>
              <div className="mt-2 flex flex-col gap-2">
                {notes.map((note, index) => (
                  <Well key={index}>
                    <span className="whitespace-pre-wrap">{note}</span>
                  </Well>
                ))}
              </div>
            </div>

            {/*
              THE DISCLOSURE. Named exclusions rather than a generic reassurance — see the header. The
              provider is spelled out because "a model" is a phrase people skim; if the cascade in
              `lib/llm/draft-followup.ts` ever gains a second tier, this sentence is what changes with
              it.
            */}
            <div className="flex items-start gap-2.5 border-t border-[color:var(--hairline)] pt-4">
              <span
                aria-hidden="true"
                className="material-symbols-outlined mt-[1px] text-[18px] text-[color:var(--ink-3)]"
              >
                lock
              </span>
              <p className="text-[12.5px] leading-relaxed text-[color:var(--ink-2)]">
                Sent to the drafting model (IBM-hosted Claude) along with {firstName}&apos;s name,
                role, company and the event. Their email, phone, LinkedIn and your private tags stay
                here. Nothing is sent anywhere until you press the button, and no message is ever sent
                for you.
              </p>
            </div>
          </>
        )}

        {phase === 'drafted' && (
          <>
            <div>
              <label
                htmlFor="draft-followup-text"
                className="text-[13.5px] font-semibold text-[color:var(--ink)]"
              >
                Your draft
              </label>
              <p className="mt-0.5 text-[12.5px] leading-relaxed text-[color:var(--ink-2)]">
                Edit it. It is a first pass from your note, not a message from you yet — and nothing
                sends until you do it yourself.
              </p>
              <textarea
                id="draft-followup-text"
                value={draft}
                onChange={e => setDraft(e.target.value)}
                rows={8}
                maxLength={4000}
                className="mt-2 w-full rounded-xl bg-[#F7F7F9] p-3.5 text-[14.5px] leading-relaxed text-[color:var(--ink)] outline-none focus:shadow-[inset_0_0_0_2px_var(--blue)]"
              />
            </div>

            {/* Provenance, kept on screen: the claim "written from your note" is checkable rather
                than asserted, and it is also what you fall back to if the draft is wrong. */}
            {notes.length > 0 && (
              <div className="border-t border-[color:var(--hairline)] pt-4">
                <p className={SHEET_LABEL}>Written from</p>
                <div className="mt-2 flex flex-col gap-2">
                  {notes.map((note, index) => (
                    <Well key={index}>
                      <span className="whitespace-pre-wrap">{note}</span>
                    </Well>
                  ))}
                </div>
              </div>
            )}

            {message && <Banner tone="warn">{message}</Banner>}
          </>
        )}

        {phase === 'failed' && (
          <>
            <Banner tone="error">
              {message ?? 'Drafting is unavailable right now. Your note is below; nothing was lost.'}
            </Banner>
            {notes.length > 0 ? (
              <div>
                <p className={SHEET_LABEL}>Your note, to send yourself</p>
                <div className="mt-2 flex flex-col gap-2">
                  {notes.map((note, index) => (
                    <Well key={index}>
                      <span className="whitespace-pre-wrap">{note}</span>
                    </Well>
                  ))}
                </div>
              </div>
            ) : (
              /* NOT "there is no note" — this branch is also reached when the FETCH failed, in which
                 case whether a note exists is exactly what we do not know. Asserting it would be a
                 confident factual claim standing in for a broken request, the failure mode the
                 calendar's "No events this month" already demonstrated on this codebase. */
              <p className="text-[13px] text-[color:var(--ink-2)]">
                Your note could not be loaded either. It is still on this page, further down.
              </p>
            )}
          </>
        )}

        {phase === 'blocked' && (
          <>
            <p className="text-[14.5px] leading-relaxed text-[color:var(--ink)]">
              {message ??
                'Add a note about what you talked about, then draft. A follow-up with nothing in it is worse than none.'}
            </p>
            <p className="text-[12.5px] leading-relaxed text-[color:var(--ink-2)]">
              A message written from an empty record can only say &ldquo;great to meet you&rdquo; —
              which needs no model and tells {firstName} nothing. Two lines about what you actually
              discussed is all it takes. The note field is on this page, just below.
            </p>
          </>
        )}
      </div>
    </Sheet>
  );
}

/**
 * Correct the person's details, and tag the HUMAN.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT IS BEING EDITED HERE IS NOT THE DISPLAYED VALUE — IT IS AN OVERRIDE.
 *
 * `displayName`, `company` and `role` on `Person` are DERIVED: newest encounter wins, per field. A
 * recompute runs on every note, every follow-up and every new scan, so writing over the derived value
 * would be reverted by the next capture with nothing on screen to explain it. An override is the one
 * place a human decision survives, and `derivePersonFields` re-applies it inside the derivation for
 * exactly that reason.
 *
 * CLEARING A FIELD IS "NO OVERRIDE", NOT "FORCE EMPTY". Blank means "go back to what the captures
 * say" — pinning `''` would create a field that no later capture could ever fill, which reads as
 * broken rather than cleared.
 *
 * `ownTags` ARE SEPARATE FROM `tags`, and the separation is load-bearing. `Person.tags` is RECOMPUTED
 * from the contacts' tags unioned with these — never unioned with its own previous value — so removing
 * a tag from a capture actually removes it. Tags added to the human rather than to one encounter have
 * nowhere else to live, and storing them apart is what stops a contact-driven recompute erasing them.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 */
function EditPersonSheet({
  person,
  busy,
  tagSuggestions,
  onClose,
  onSave,
}: {
  person: PersonDTO;
  busy: boolean;
  tagSuggestions: string[];
  onClose: () => void;
  onSave: (
    overrides: { displayName: string; company: string; role: string },
    ownTags: string[]
  ) => void;
}) {
  /**
   * Initialised from the OVERRIDES, not from the effective values — the inputs are editing the
   * override, and pre-filling them with the derived value would silently pin whatever the last scan
   * happened to say the moment the user saved anything at all. The effective value is the
   * `placeholder` instead, which is what "leave blank to use what your captures say" means.
   */
  const [displayName, setDisplayName] = useState(person.overrides.displayName ?? '');
  const [company, setCompany] = useState(person.overrides.company ?? '');
  const [role, setRole] = useState(person.overrides.role ?? '');
  const [ownTags, setOwnTags] = useState<string[]>(person.ownTags);
  const [tagDraft, setTagDraft] = useState('');

  function addTag() {
    const value = tagDraft.trim().toLowerCase();
    if (!value) return;
    // Canonicalised properly on the server by `canonicaliseTags` — this only stops an obvious
    // duplicate chip appearing in the editor before the round trip.
    setOwnTags(current => (current.includes(value) ? current : [...current, value]));
    setTagDraft('');
  }

  const FIELD =
    'mt-1.5 h-11 w-full rounded-xl bg-[#F7F7F9] px-3.5 text-[15px] text-[color:var(--ink)] outline-none focus:shadow-[inset_0_0_0_2px_var(--blue)]';

  return (
    <Sheet
      open
      onClose={onClose}
      labelledBy="edit-person-title"
      title="Correct their details"
      subtitle="Your corrections beat whatever the next scan says."
      footer={
        <div className="flex justify-end gap-2">
          <Button tone="quiet" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            tone="primary"
            disabled={busy}
            onClick={() => onSave({ displayName, company, role }, ownTags)}
          >
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <label className="block">
          <span className={SHEET_LABEL}>Name</span>
          <input
            value={displayName}
            onChange={e => setDisplayName(e.target.value)}
            placeholder={person.displayName}
            maxLength={200}
            autoComplete="off"
            className={FIELD}
          />
          <span className="mt-1.5 block text-[12px] text-[color:var(--ink-3)]">
            Leave blank to use what your captures say ({person.displayName}).
          </span>
        </label>

        <label className="block">
          <span className={SHEET_LABEL}>Company</span>
          <input
            value={company}
            onChange={e => setCompany(e.target.value)}
            placeholder={person.company ?? 'Where they work'}
            maxLength={200}
            autoComplete="off"
            className={FIELD}
          />
        </label>

        <label className="block">
          <span className={SHEET_LABEL}>Role</span>
          <input
            value={role}
            onChange={e => setRole(e.target.value)}
            placeholder={person.role ?? 'What they do'}
            maxLength={200}
            autoComplete="off"
            className={FIELD}
          />
        </label>

        <div>
          <span className={SHEET_LABEL}>Your tags</span>
          <p className="mt-1 text-[12px] leading-relaxed text-[color:var(--ink-3)]">
            For employers the registry doesn&apos;t know, and anything else worth filtering by. These
            stay yours — they are never fed back into the company registry, because a tag counted as
            company evidence once filed a hardware engineer tagged “arm” under the company Arm.
          </p>
          {ownTags.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-x-1.5 gap-y-2">
              {ownTags.map(tag => (
                <span
                  key={tag}
                  className="inline-flex h-9 items-center gap-1 rounded-full bg-[#F5F5F7] pl-3 pr-1.5 text-[12.5px] font-semibold text-[color:var(--ink-2)]"
                >
                  {tag}
                  <button
                    type="button"
                    onClick={() => setOwnTags(current => current.filter(t => t !== tag))}
                    aria-label={`Remove tag ${tag}`}
                    className="grid h-8 w-8 place-items-center rounded-full text-[color:var(--ink-3)] hover:bg-[#E5E5EA] [touch-action:manipulation]"
                  >
                    <span aria-hidden="true" className="material-symbols-outlined text-[16px]">
                      close
                    </span>
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="mt-2 flex gap-2">
            <input
              value={tagDraft}
              onChange={e => setTagDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  // The sheet has no form, but Enter in a tag field means "add this tag" to
                  // everybody, so it is wired explicitly rather than left to do nothing.
                  e.preventDefault();
                  addTag();
                }
              }}
              list="person-tag-vocabulary"
              maxLength={40}
              placeholder="Add a tag…"
              aria-label="Add a tag"
              className="h-11 min-w-0 flex-1 rounded-xl bg-[#F7F7F9] px-3.5 text-[15px] text-[color:var(--ink)] outline-none focus:shadow-[inset_0_0_0_2px_var(--blue)]"
            />
            {/* Native datalist rather than a bespoke popover: it is a one-field type-ahead, and the
                browser's own affordance beats a hand-rolled one here. */}
            <datalist id="person-tag-vocabulary">
              {tagSuggestions.map(tag => (
                <option key={tag} value={tag} />
              ))}
            </datalist>
            <Button tone="quiet" onClick={addTag} disabled={!tagDraft.trim()}>
              Add
            </Button>
          </div>
        </div>
      </div>
    </Sheet>
  );
}

interface TimelineGroup {
  key: string;
  eventId: string | null;
  title: string | null;
  startAt: string | null;
  items: InteractionDTO[];
}

/**
 * Group the timeline by the event each entry happened at.
 *
 * Groups are ordered by their most recent entry, not by the event's date, because the question this
 * page answers is "what happened most recently" — an entry added today about an event in July belongs
 * at the top. Entries with no event (notes, messages) get their own group rather than being scattered.
 *
 * Exported implicitly through the component only; the shape is local because nothing else needs it.
 */
function groupByEvent(interactions: InteractionDTO[]): TimelineGroup[] {
  const groups = new Map<string, TimelineGroup>();

  for (const item of interactions) {
    const key = item.eventId ?? '__none__';
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        eventId: item.eventId ?? null,
        title: item.eventTitle ?? null,
        startAt: item.eventStartAt ?? null,
        items: [],
      };
      groups.set(key, group);
    }
    // A title on any entry in the group is the title for the group: only `met` rows carry an event,
    // and a later note against the same event arrives with the same join.
    if (!group.title && item.eventTitle) group.title = item.eventTitle;
    if (!group.startAt && item.eventStartAt) group.startAt = item.eventStartAt;
    group.items.push(item);
  }

  // The input is already newest-first, so insertion order IS most-recent-first per group.
  return [...groups.values()];
}
