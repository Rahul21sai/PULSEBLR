'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import AppShell from '../../components/AppShell';
import Sheet from '../../components/Sheet';
import MergeSheet from '../MergeSheet';
import { useTagVocabulary } from '../../components/scan/ContactFields';
import {
  Banner,
  Button,
  ButtonLink,
  Card,
  EmptyState,
  PageHeader,
  SectionTitle,
  Skeleton,
} from '../../components/ui';
import { dayHeading, fullDateIST, relativeTime, shortDateIST } from '@/lib/format';
import {
  INTERACTION_ICON,
  INTERACTION_LABEL,
  personSubtitle,
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
          className="mb-3 inline-flex h-11 items-center gap-1 text-[13px] font-semibold text-[#0071E3] hover:underline"
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

        <PageHeader
          eyebrow={person.eventCount > 0 ? `Met at ${person.eventCount} ${person.eventCount === 1 ? 'event' : 'events'}` : undefined}
          title={
            <span className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
              {person.displayName}
              {person.eventCount > 1 && (
                <span className="rounded-full bg-[#EBF7EF] px-2 py-0.5 text-[11px] font-bold text-[#1D8A44]">
                  met {person.eventCount}×
                </span>
              )}
              {person.isTargetCompany && (
                <span className="rounded-full bg-[#EBF7EF] px-2 py-0.5 text-[11px] font-bold text-[#1D8A44]">
                  target company
                </span>
              )}
            </span>
          }
          subtitle={
            <>
              {personSubtitle(person) || 'No role or company recorded'}
              {person.lastInteractionAt && (
                <span className="text-[#8E8E93]">
                  {' · '}last contact {relativeTime(person.lastInteractionAt)}
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
                  <p className="text-[13.5px] font-semibold text-[#1D1D1F]">
                    Might be the same person as{' '}
                    <Link
                      href={`/people/${data.suggestions[0].personId}`}
                      className="text-[#0071E3] hover:underline"
                    >
                      {data.suggestions[0].displayName}
                    </Link>
                  </p>
                  <p className="mt-0.5 text-[12.5px] text-[#6E6E73]">
                    Both point at the identity key{' '}
                    <code className="text-[11.5px]">{data.suggestions[0].contactKey}</code>. Nothing
                    was merged — a wrong merge is far harder to undo than a duplicate.
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
              value={noteDraft}
              onChange={e => setNoteDraft(e.target.value)}
              rows={3}
              maxLength={4000}
              placeholder="What did you talk about? What did you promise them?"
              aria-label="New note"
              className="w-full rounded-xl bg-[#F7F7F9] p-3.5 text-[14.5px] leading-relaxed text-[#1D1D1F] outline-none focus:shadow-[inset_0_0_0_2px_var(--blue)]"
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
              <p className="text-[13px] text-[#6E6E73]">
                Captures made before this page existed have no timeline until the backfill runs.
              </p>
            ) : (
              <div className="flex flex-col gap-5">
                {groups.map(group => (
                  <div key={group.key}>
                    <div className="flex flex-wrap items-baseline gap-2 border-b border-[color:var(--hairline)] pb-1.5">
                      <h3 className="text-[13.5px] font-semibold text-[#1D1D1F]">
                        {group.eventId ? (
                          // A dangling `eventId` is NORMAL: `pruneStale()` deletes events 7 days
                          // past without touching their references. Say so rather than render blank.
                          group.title ? (
                            <Link href={`/events/${group.eventId}`} className="hover:underline">
                              {group.title}
                            </Link>
                          ) : (
                            <span className="text-[#8E8E93]">An event we no longer have</span>
                          )
                        ) : (
                          'Not at an event'
                        )}
                      </h3>
                      {group.startAt && (
                        <span className="text-[12px] text-[#8E8E93]">
                          {shortDateIST(group.startAt)}
                        </span>
                      )}
                    </div>
                    <ul className="mt-2 flex flex-col gap-2.5">
                      {group.items.map(item => (
                        <li key={item._id} className="flex items-start gap-2.5">
                          <span
                            aria-hidden="true"
                            className="material-symbols-outlined mt-[2px] text-[16px] text-[#A1A1A6]"
                          >
                            {INTERACTION_ICON[item.kind]}
                          </span>
                          <div className="min-w-0">
                            <p className="text-[13px] text-[#1D1D1F]">
                              <span className="font-semibold">{INTERACTION_LABEL[item.kind]}</span>
                              <span className="text-[#8E8E93]">
                                {' · '}
                                {fullDateIST(item.at)}
                              </span>
                            </p>
                            {item.note && (
                              <p className="mt-0.5 whitespace-pre-wrap text-[13px] leading-relaxed text-[#3a3a3c]">
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
                  <p className="text-[12px] text-[#A1A1A6]">
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
              <p className="text-[13px] text-[#6E6E73]">No captures left — this record is empty.</p>
            ) : (
              <ul className="flex flex-col gap-2.5">
                {contacts.map(contact => (
                  <li key={contact._id} className="text-[12.5px]">
                    <p className="font-semibold text-[#1D1D1F]">
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
                    <p className="text-[#8E8E93]">
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
                      <p className="mt-0.5 whitespace-pre-wrap text-[#3a3a3c]">{contact.note}</p>
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
      <dt className="shrink-0 text-[13px] text-[#8E8E93]">{label}</dt>
      <dd className="min-w-0 break-words text-right text-[13px] font-medium text-[#1D1D1F]">
        {href ? (
          <a
            href={href}
            {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
            className="text-[#0071E3] hover:underline"
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
    'mt-1.5 h-11 w-full rounded-xl bg-[#F7F7F9] px-3.5 text-[15px] text-[#1D1D1F] outline-none focus:shadow-[inset_0_0_0_2px_var(--blue)]';

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
          <span className="t-label text-[#8E8E93]">Name</span>
          <input
            value={displayName}
            onChange={e => setDisplayName(e.target.value)}
            placeholder={person.displayName}
            maxLength={200}
            autoComplete="off"
            className={FIELD}
          />
          <span className="mt-1.5 block text-[12px] text-[#A1A1A6]">
            Leave blank to use what your captures say ({person.displayName}).
          </span>
        </label>

        <label className="block">
          <span className="t-label text-[#8E8E93]">Company</span>
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
          <span className="t-label text-[#8E8E93]">Role</span>
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
          <span className="t-label text-[#8E8E93]">Your tags</span>
          <p className="mt-1 text-[12px] leading-relaxed text-[#A1A1A6]">
            For employers the registry doesn&apos;t know, and anything else worth filtering by. These
            stay yours — they are never fed back into the company registry, because a tag counted as
            company evidence once filed a hardware engineer tagged “arm” under the company Arm.
          </p>
          {ownTags.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-x-1.5 gap-y-2">
              {ownTags.map(tag => (
                <span
                  key={tag}
                  className="inline-flex h-9 items-center gap-1 rounded-full bg-[#F5F5F7] pl-3 pr-1.5 text-[12.5px] font-semibold text-[#3a3a3c]"
                >
                  {tag}
                  <button
                    type="button"
                    onClick={() => setOwnTags(current => current.filter(t => t !== tag))}
                    aria-label={`Remove tag ${tag}`}
                    className="grid h-8 w-8 place-items-center rounded-full text-[#8E8E93] hover:bg-[#E5E5EA] [touch-action:manipulation]"
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
              className="h-11 min-w-0 flex-1 rounded-xl bg-[#F7F7F9] px-3.5 text-[15px] text-[#1D1D1F] outline-none focus:shadow-[inset_0_0_0_2px_var(--blue)]"
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
