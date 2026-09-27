'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import AppShell from '../../components/AppShell';
import { Banner, Button, ButtonLink, EmptyState, PageHeader, Skeleton, Well } from '../../components/ui';
import { dayHeading } from '@/lib/format';
import type { FollowUpContactView, FollowUpLanding } from '@/lib/notifications/followup-landing';

/**
 * The morning-after follow-up screen.
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * EVERYTHING HERE GOES THROUGH AN ENDPOINT THAT ALREADY EXISTS, except the list itself.
 *
 *   · the list      `GET /api/follow-ups/[folderId]`     — owner-scoped, 404 otherwise, minimal fields
 *   · the preview   `GET /api/people/[id]/draft`         — what a draft WOULD be written from, no cost
 *   · the draft     `POST /api/people/[id]/draft`        — `selectDraftFields` is the whole allowlist
 *   · "I reached out" `PATCH /api/people/[id]`           — `{ messageSent: true }`, as the person page
 *   · "Done"        `POST /api/phase6/follow-ups`        — `{ contactId }` → `completeContactFollowUp`
 *
 * So nothing new is ever sent to the model, and "done" means the same thing here, on the dashboard
 * strip and in the digest.
 *
 * DISCLOSURE BEFORE THE BUTTON, as `/people/[id]` insists: each card quotes the note its draft will be
 * written from BEFORE "Draft" is pressed, and one line at the top names what leaves and what stays.
 *
 * WHEN DRAFTING IS UNAVAILABLE THE SCREEN STILL WORKS, and there is no template. The person page
 * records why ("great to meet you at X" is a worse product wearing the draft's label). The fallback is
 * the user's own note to copy, plus the channel buttons and Done — which is the whole job, minus the
 * prose.
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 */

type Load =
  | { state: 'loading' }
  | { state: 'ready'; data: FollowUpLanding }
  | { state: 'not-found' }
  | { state: 'signed-out' }
  | { state: 'error'; message: string };

/** Every action target on this screen is at least 44px tall. */
const TARGET = 'min-h-11';

export default function FollowUpsClient({ folderId }: { folderId: string }) {
  const [load, setLoad] = useState<Load>({ state: 'loading' });

  const fetchList = useCallback(async () => {
    try {
      const res = await fetch(`/api/follow-ups/${encodeURIComponent(folderId)}`);
      if (res.status === 401) return setLoad({ state: 'signed-out' });
      if (res.status === 404) return setLoad({ state: 'not-found' });
      if (!res.ok) return setLoad({ state: 'error', message: 'Could not load the people from this event.' });
      setLoad({ state: 'ready', data: (await res.json()) as FollowUpLanding });
    } catch {
      setLoad({ state: 'error', message: 'Could not reach the server.' });
    }
  }, [folderId]);

  useEffect(() => {
    // Deferred a tick so the effect body does not set state synchronously.
    const timer = setTimeout(() => void fetchList(), 0);
    return () => clearTimeout(timer);
  }, [fetchList]);

  const markDone = useCallback((contactId: string) => {
    setLoad(current => {
      if (current.state !== 'ready') return current;
      const contacts = current.data.contacts.map(c => (c.id === contactId ? { ...c, followedUp: true } : c));
      return {
        state: 'ready',
        data: { ...current.data, contacts, pendingCount: contacts.filter(c => !c.followedUp).length },
      };
    });
  }, []);

  const data = load.state === 'ready' ? load.data : null;
  const total = data?.contacts.length ?? 0;
  const pending = data?.pendingCount ?? 0;

  return (
    <AppShell title="Follow up">
      <div className="mx-auto max-w-[720px] px-4 pt-[var(--s-6)] md:px-8">
        {load.state === 'loading' && (
          <div className="flex flex-col gap-[var(--s-3)]" aria-busy="true">
            <Skeleton className="h-8 w-2/3" />
            <Skeleton className="h-[140px]" />
            <Skeleton className="h-[140px]" />
          </div>
        )}

        {load.state === 'signed-out' && (
          <EmptyState
            icon="lock"
            title="Sign in to follow up"
            body="The people you met are tied to your account."
            action={
              <ButtonLink
                href={`/login?callbackUrl=${encodeURIComponent(`/follow-ups/${folderId}`)}`}
                className={TARGET}
              >
                Sign in
              </ButtonLink>
            }
          />
        )}

        {load.state === 'not-found' && (
          <EmptyState
            icon="search_off"
            title="Nothing to follow up here"
            body="This folder does not exist, or it is not in this account."
            action={
              <ButtonLink href="/folders" tone="quiet" className={TARGET}>
                Your folders
              </ButtonLink>
            }
          />
        )}

        {load.state === 'error' && (
          <Banner tone="error">
            {load.message}{' '}
            <button
              type="button"
              onClick={() => {
                setLoad({ state: 'loading' });
                void fetchList();
              }}
              className="inline-flex min-h-11 items-center font-semibold underline"
            >
              Retry
            </button>
          </Banner>
        )}

        {data && (
          <>
            <PageHeader
              eyebrow="Follow up"
              title={data.folder.name}
              subtitle={[
                data.folder.eventDate ? dayHeading(data.folder.eventDate) : null,
                total === 0
                  ? null
                  : pending === 0
                    ? `All ${total} followed up`
                    : `${pending} of ${total} still to follow up`,
              ]
                .filter(Boolean)
                .join(' · ')}
            />

            {total === 0 ? (
              <EmptyState
                icon="qr_code_scanner"
                title="Nobody captured here"
                body="Scan someone's LinkedIn code at the event and they appear here, ready for a follow-up."
                action={
                  <ButtonLink href="/scan" className={TARGET}>
                    Scan a code
                  </ButtonLink>
                }
              />
            ) : (
              <>
                <Well className="mb-[var(--s-4)] flex items-start gap-2.5">
                  <span
                    aria-hidden="true"
                    className="material-symbols-outlined mt-[1px] text-[18px] text-[var(--ink-3)]"
                  >
                    lock
                  </span>
                  <span>
                    Drafting sends your note about that person, with their name, role, company and the
                    event, to the drafting model (IBM-hosted Claude). Their email, phone, LinkedIn and
                    your tags stay here. Nothing is sent until you tap Draft, and no message is ever
                    sent for you.
                  </span>
                </Well>

                <ul className="flex flex-col">
                  {data.contacts.map(contact => (
                    <FollowUpCard
                      key={contact.id}
                      contact={contact}
                      eventName={data.folder.name}
                      onDone={markDone}
                    />
                  ))}
                </ul>
              </>
            )}

            <div className="mt-[var(--s-6)] flex flex-wrap gap-2 pb-[var(--s-6)]">
              <ButtonLink href={`/folders/${data.folder.id}`} tone="quiet" icon="folder_open" className={TARGET}>
                Open the folder
              </ButtonLink>
              <ButtonLink href="/people" tone="quiet" icon="group" className={TARGET}>
                Everyone you have met
              </ButtonLink>
            </div>
          </>
        )}
      </div>
    </AppShell>
  );
}

type Phase =
  | 'checking'
  /** A Person record exists and has a note: ready to draft. */
  | 'ready'
  /** Nothing to draft from yet. */
  | 'no-note'
  /** The contact is not attached to a Person, so the draft endpoint has nothing to address. */
  | 'no-person'
  | 'drafting'
  | 'drafted'
  | 'failed';

function FollowUpCard({
  contact,
  eventName,
  onDone,
}: {
  contact: FollowUpContactView;
  eventName: string;
  onDone: (contactId: string) => void;
}) {
  const [phase, setPhase] = useState<Phase>(contact.personId ? 'checking' : 'no-person');
  const [notes, setNotes] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);

  const { personId } = contact;
  const firstName = contact.name.trim().split(/\s+/)[0] || contact.name;

  /** The preview: what a draft would be written from. No model call. Skipped once followed up. */
  useEffect(() => {
    if (!personId || contact.followedUp) return;
    let live = true;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/people/${personId}/draft`);
        const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!live) return;
        if (!res.ok) {
          // A merged or missing Person: drafting has nothing to address. Not an outage.
          setPhase(res.status === 404 || res.status === 409 ? 'no-person' : 'failed');
          if (res.status >= 500) setMessage('Could not check what a draft would use.');
          return;
        }
        setNotes(Array.isArray(payload.notes) ? (payload.notes as string[]) : []);
        setPhase(payload.canDraft ? 'ready' : 'no-note');
      } catch {
        if (!live) return;
        setMessage('Could not reach the server.');
        setPhase('failed');
      }
    }, 0);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [personId, contact.followedUp]);

  async function requestDraft() {
    if (!personId) return;
    setPhase('drafting');
    setMessage(null);
    setCopied(false);
    try {
      const res = await fetch(`/api/people/${personId}/draft`, { method: 'POST' });
      const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (Array.isArray(payload.notes)) setNotes(payload.notes as string[]);
      if (!res.ok || typeof payload.draft !== 'string') {
        if (payload.code === 'no-note' || payload.code === 'no-name') {
          setPhase('no-note');
          return;
        }
        setMessage(
          typeof payload.error === 'string'
            ? payload.error
            : 'Drafting is unavailable right now. Your note is below; nothing was lost.'
        );
        setPhase('failed');
        return;
      }
      setDraft(payload.draft);
      setPhase('drafted');
    } catch {
      setMessage('Could not reach the drafting service. Your note is below; nothing was lost.');
      setPhase('failed');
    }
  }

  /**
   * Copy without awaiting inside a handler that also opens a window — `writeText` rejects once the
   * document loses focus, and a popup blocker drops a window opened after an `await`. Same reasoning
   * as `settleCopy` on the person page.
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

  /** Logs `message-sent` on the Person, which is what moves "last contacted". Fire and forget. */
  function logReachedOut() {
    if (!personId) return;
    void fetch(`/api/people/${personId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageSent: true }),
    }).catch(() => undefined);
  }

  const textToSend = phase === 'drafted' ? draft : '';

  function openLinkedin() {
    if (!contact.linkedin) return;
    const pending = textToSend ? navigator.clipboard?.writeText(textToSend) : undefined;
    window.open(contact.linkedin, '_blank', 'noopener,noreferrer');
    logReachedOut();
    if (textToSend) void settleCopy(pending);
  }

  function openEmail() {
    if (!contact.email) return;
    const subject = `Following up from ${eventName}`;
    const body = textToSend ? `&body=${encodeURIComponent(textToSend)}` : '';
    window.open(
      `mailto:${contact.email}?subject=${encodeURIComponent(subject)}${body}`,
      '_blank',
      'noopener,noreferrer'
    );
    logReachedOut();
  }

  async function markDone() {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch('/api/phase6/follow-ups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactId: contact.id }),
      });
      if (!res.ok) throw new Error(String(res.status));
      onDone(contact.id);
    } catch {
      setMessage('Could not mark that as done. Try again.');
    } finally {
      setSaving(false);
    }
  }

  const who = [contact.role, contact.company].filter(Boolean).join(' · ');

  if (contact.followedUp) {
    return (
      <li className="rule-b flex min-h-11 items-center gap-3 py-[var(--s-3)]">
        <span aria-hidden="true" className="material-symbols-outlined text-[20px] text-[var(--accent)]">
          check_circle
        </span>
        <span className="min-w-0 flex-1 truncate text-[14.5px] text-[var(--ink-2)]">{contact.name}</span>
        <span className="ty-meta shrink-0">Followed up</span>
      </li>
    );
  }

  return (
    <li className="rule-b flex flex-col gap-[var(--s-3)] py-[var(--s-4)]">
      <div className="min-w-0">
        <p className="ty-row-title break-words text-[var(--ink)]">{contact.name}</p>
        {who && <p className="ty-meta mt-0.5 break-words">{who}</p>}
      </div>

      {phase === 'checking' && <Skeleton className="h-10 w-full" />}

      {(phase === 'ready' || phase === 'drafting') && notes.length > 0 && (
        <div className="border-l-2 border-[var(--rule)] bg-[var(--paper)] px-3 py-2 text-[12.5px] leading-relaxed text-[var(--ink-2)]">
          <span className="font-semibold text-[var(--ink)]">Drafted from your note: </span>
          <span className="whitespace-pre-wrap break-words">{notes.join(' / ')}</span>
        </div>
      )}

      {phase === 'no-note' && (
        <p className="text-[13px] leading-relaxed text-[var(--ink-2)]">
          No note about what you talked about yet, so there is nothing to draft from.{' '}
          {personId && (
            <Link
              href={`/people/${personId}`}
              className="inline-flex min-h-11 items-center font-semibold text-[var(--accent)] underline"
            >
              Add a note on {firstName}&apos;s page
            </Link>
          )}
        </p>
      )}

      {phase === 'no-person' && (
        <p className="text-[13px] leading-relaxed text-[var(--ink-2)]">
          Drafting is not available for this contact yet. You can still reach out and mark it done.
        </p>
      )}

      {phase === 'drafted' && (
        <div>
          <label htmlFor={`draft-${contact.id}`} className="text-[13px] font-semibold text-[var(--ink)]">
            Your draft — edit it, nothing sends until you do
          </label>
          <textarea
            id={`draft-${contact.id}`}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            rows={6}
            maxLength={4000}
            className="mt-2 w-full r-touch bg-[var(--paper)] p-3 text-[15px] leading-relaxed text-[var(--ink)] shadow-[inset_0_0_0_1px_var(--rule)] outline-none focus:shadow-[inset_0_0_0_2px_var(--accent)]"
          />
        </div>
      )}

      {phase === 'failed' && (
        <>
          <Banner tone="warn">{message ?? 'Drafting is unavailable right now.'}</Banner>
          {notes.length > 0 && (
            <div className="border-l-2 border-[var(--rule)] bg-[var(--paper)] px-3 py-2 text-[12.5px] leading-relaxed text-[var(--ink-2)]">
              <span className="font-semibold text-[var(--ink)]">Your note: </span>
              <span className="whitespace-pre-wrap break-words">{notes.join('\n\n')}</span>
            </div>
          )}
        </>
      )}

      {message && phase !== 'failed' && <Banner tone="warn">{message}</Banner>}

      <div className="flex flex-wrap gap-2">
        {phase === 'ready' && (
          <Button tone="primary" icon="edit_note" className={TARGET} onClick={() => void requestDraft()}>
            Draft follow-up
          </Button>
        )}
        {phase === 'drafting' && (
          <Button tone="primary" className={TARGET} disabled aria-busy="true">
            Writing…
          </Button>
        )}
        {phase === 'drafted' && (
          <>
            <Button
              tone="quiet"
              icon={copied ? 'check' : 'content_copy'}
              className={TARGET}
              onClick={() => void settleCopy(navigator.clipboard?.writeText(draft))}
            >
              {copied ? 'Copied' : 'Copy'}
            </Button>
            <Button tone="quiet" icon="refresh" className={TARGET} onClick={() => void requestDraft()}>
              Draft again
            </Button>
          </>
        )}
        {phase === 'failed' && notes.length > 0 && (
          <Button
            tone="quiet"
            icon={copied ? 'check' : 'content_copy'}
            className={TARGET}
            onClick={() => void settleCopy(navigator.clipboard?.writeText(notes.join('\n\n')))}
          >
            {copied ? 'Copied' : 'Copy my note'}
          </Button>
        )}
        {phase === 'failed' && personId && (
          <Button tone="quiet" icon="refresh" className={TARGET} onClick={() => void requestDraft()}>
            Try again
          </Button>
        )}

        {contact.linkedin && (
          <Button
            tone={phase === 'drafted' ? 'secondary' : 'quiet'}
            icon="open_in_new"
            className={TARGET}
            onClick={openLinkedin}
          >
            {phase === 'drafted' ? 'Copy & open LinkedIn' : 'Open LinkedIn'}
          </Button>
        )}
        {contact.email && (
          <Button tone="quiet" icon="mail" className={TARGET} onClick={openEmail}>
            Email
          </Button>
        )}
        <Button
          tone="quiet"
          icon="check"
          className={TARGET}
          onClick={() => void markDone()}
          disabled={saving}
          aria-busy={saving}
        >
          {saving ? 'Saving…' : 'Done'}
        </Button>
      </div>
    </li>
  );
}
