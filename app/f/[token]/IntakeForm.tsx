'use client';

import { useRef, useState } from 'react';
import {
  createIntakeSubmission,
  sendIntake,
  type IntakeDetails,
  type IntakeFailure,
} from './submission';

/**
 * The self-registration form behind a folder QR.
 *
 * Filled in by a stranger, standing up, on their own phone, in about twenty seconds. So: four
 * fields visible, everything else behind "more", a numeric keypad for the phone, and no
 * autofocus — on a small screen the keyboard would cover the form the instant it loaded.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * A RETRY MUST NOT BE A SECOND PERSON. Venue Wi-Fi routinely delivers a request and loses the
 * response; the person sees an error and taps again. Every such tap used to be a new row in the
 * owner's folder, because nothing tied the second request to the first — the disabled button only
 * covered a tap while a request was still in flight.
 *
 * So each submission carries one idempotency key, minted on its first send and resent on every
 * retry (`createIntakeSubmission()` in `./submission.ts`, which documents why the key also survives
 * an edit). The route namespaces it into the row's `clientId` and answers a replay 200 with
 * `created: false`. A new key is minted only by "Add someone else", after a confirmed success.
 *
 * KNOWN LIMIT: the key lives in memory, so a full page reload mints a new one, and resubmitting from
 * the reloaded page can still duplicate a request that had landed. Restoring the key across a reload
 * blindly would be worse — a second person using the same phone would be silently swallowed as a
 * "replay" of the first — so a safe version would have to match on the details sent, and is not
 * built. The send timeout removes the commonest reason to reload: a spinner that never ended.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 */

const FIELD_CLASS =
  'mt-1.5 h-12 w-full r-touch bg-[var(--paper)] px-3.5 text-[16px] text-[var(--ink)] shadow-[inset_0_0_0_1px_var(--rule)] outline-none focus:shadow-[inset_0_0_0_2px_var(--accent)]';

interface Problem {
  failure: IntakeFailure | 'no-name';
  /** An earlier send of this submission ended without an answer, so it may be on the list already. */
  earlierMayHaveLanded: boolean;
}

interface Done {
  created: boolean;
  editedAfterFirstTry: boolean;
}

function problemCopy({ failure, earlierMayHaveLanded }: Problem): string {
  switch (failure) {
    case 'no-name':
      return 'Your name, at least.';
    case 'network':
      return "Couldn't reach the server. Check your connection and tap Retry — you won't be added twice.";
    case 'unreadable':
      return 'The Wi-Fi answered instead of PulseBLR — it may want you to sign in first. Open any website to do that, then tap Retry.';
    case 'server':
      return "Something went wrong saving that. Tap Retry — you won't be added twice.";
    case 'busy':
      return 'Too many sign-ups from this connection just now. Wait a moment, then tap Retry.';
    case 'rejected':
      return "That didn't go through. Check your details, then tap Retry.";
    case 'gone':
      return earlierMayHaveLanded
        ? "This link has just expired or been switched off. If your earlier try got through, you're already on their list."
        : 'This link has just expired or been switched off.';
  }
}

export default function IntakeForm({
  token,
  folderName,
}: {
  token: string;
  folderName: string;
}) {
  const [name, setName] = useState('');
  const [company, setCompany] = useState('');
  const [role, setRole] = useState('');
  const [linkedin, setLinkedin] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [note, setNote] = useState('');
  const [showMore, setShowMore] = useState(false);
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [done, setDone] = useState<Done | null>(null);

  // One per mounted form; holds the key across retries. Mutated only from event handlers.
  const [submission] = useState(createIntakeSubmission);
  /**
   * The double-submit guard. `disabled` alone is not one: Enter in a field plus a tap, or two taps
   * inside one frame, both arrive before the disabled button has rendered. The second send would
   * reuse the key and so be harmless on the server, but it would still spend a rate-limit token and
   * race the first answer for the screen.
   */
  const inFlight = useRef(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (inFlight.current) return;
    if (!name.trim()) {
      setProblem({ failure: 'no-name', earlierMayHaveLanded: false });
      return;
    }

    const details: IntakeDetails = { name, company, role, linkedin, phone, email, note };
    const key = submission.keyFor(details);

    inFlight.current = true;
    setSending(true);
    setProblem(null);
    try {
      const outcome = submission.settle(await sendIntake(token, details, key));
      if (outcome.kind === 'done') {
        setDone({ created: outcome.created, editedAfterFirstTry: outcome.editedAfterFirstTry });
      } else {
        setProblem({ failure: outcome.failure, earlierMayHaveLanded: outcome.earlierMayHaveLanded });
      }
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  }

  function addAnother() {
    submission.reset();
    setName('');
    setCompany('');
    setRole('');
    setLinkedin('');
    setPhone('');
    setEmail('');
    setNote('');
    setShowMore(false);
    setProblem(null);
    setDone(null);
  }

  // The form is not rendered at all once the person is in, so there is nothing left to submit twice.
  if (done) {
    return (
      <section
        role="status"
        className="bg-[var(--surface)] p-6 text-center shadow-[inset_0_0_0_1px_var(--rule)]"
      >
        <span aria-hidden="true" className="material-symbols-outlined text-[34px] text-[var(--accent)]">check_circle</span>
        <h2 className="ty-section mt-2 text-[var(--ink)]">You&apos;re in</h2>
        <p className="mt-1.5 text-[13.5px] leading-relaxed text-[var(--ink-2)]">
          {done.created
            ? `Added to ${folderName}. Nothing else to do — enjoy the event.`
            : `Added to ${folderName} — your first try had already reached them, so you're on the list once. Nothing else to do — enjoy the event.`}
        </p>
        {done.editedAfterFirstTry && (
          <p className="mt-3 text-[12.5px] leading-relaxed text-[var(--ink-2)]">
            They received the details from an earlier try, so changes you made after it may not have
            been saved. Mention them in person.
          </p>
        )}
        <button
          type="button"
          onClick={addAnother}
          className="pressable mt-4 inline-flex min-h-[44px] items-center justify-center r-touch px-4 text-[13.5px] font-semibold text-[var(--accent)]"
        >
          Add someone else
        </button>
      </section>
    );
  }

  const retryable = problem !== null && problem.failure !== 'no-name' && problem.failure !== 'gone';

  return (
    <form onSubmit={submit} className="bg-[var(--surface)] p-5 shadow-[inset_0_0_0_1px_var(--rule)]">
      <label className="block">
        <span className="t-label text-[var(--ink-2)]">Your name</span>
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          autoComplete="name"
          className={FIELD_CLASS}
        />
      </label>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <label className="block">
          <span className="t-label text-[var(--ink-2)]">Company</span>
          <input
            value={company}
            onChange={e => setCompany(e.target.value)}
            autoComplete="organization"
            className={FIELD_CLASS}
          />
        </label>
        <label className="block">
          <span className="t-label text-[var(--ink-2)]">Role</span>
          <input
            value={role}
            onChange={e => setRole(e.target.value)}
            autoComplete="organization-title"
            className={FIELD_CLASS}
          />
        </label>
      </div>

      <label className="mt-4 block">
        <span className="t-label text-[var(--ink-2)]">LinkedIn</span>
        <input
          value={linkedin}
          onChange={e => setLinkedin(e.target.value)}
          placeholder="linkedin.com/in/… or your handle"
          autoComplete="url"
          className={FIELD_CLASS}
        />
      </label>

      {!showMore && (
        <button
          type="button"
          onClick={() => setShowMore(true)}
          className="mt-4 inline-flex min-h-[44px] items-center r-touch text-[13px] font-semibold text-[var(--accent)] hover:underline"
        >
          Add phone or email
        </button>
      )}

      {showMore && (
        <>
          <label className="mt-4 block">
            <span className="t-label text-[var(--ink-2)]">Phone</span>
            <input
              value={phone}
              onChange={e => setPhone(e.target.value)}
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              className={FIELD_CLASS}
            />
          </label>
          <label className="mt-4 block">
            <span className="t-label text-[var(--ink-2)]">Email</span>
            <input
              value={email}
              onChange={e => setEmail(e.target.value)}
              type="email"
              inputMode="email"
              autoComplete="email"
              className={FIELD_CLASS}
            />
          </label>
          <label className="mt-4 block">
            <span className="t-label text-[var(--ink-2)]">Anything worth noting</span>
            <textarea
              value={note}
              onChange={e => setNote(e.target.value)}
              rows={2}
              className="mt-1.5 w-full resize-none r-touch bg-[var(--paper)] px-3.5 py-2.5 text-[16px] leading-relaxed text-[var(--ink)] shadow-[inset_0_0_0_1px_var(--rule)] outline-none focus:shadow-[inset_0_0_0_2px_var(--accent)]"
            />
          </label>
        </>
      )}

      <div className="mt-5">
        {/* Beside the button rather than above the fields: after a tap at the bottom of a phone
            screen, with the keyboard up, the top of the form is out of sight. */}
        {problem && (
          <p
            className="mb-3 border-l-2 border-l-[var(--live)] bg-[var(--paper)] px-4 py-3 text-[12.5px] text-[var(--live)]"
            role="alert"
          >
            {problemCopy(problem)}
          </p>
        )}
        <button
          type="submit"
          disabled={sending}
          className="flex h-12 w-full items-center justify-center r-touch bg-[var(--ink)] text-[15px] font-semibold text-[var(--accent-ink)] disabled:opacity-45 pressable"
        >
          {sending ? 'Sending…' : retryable ? 'Retry' : 'Add me'}
        </button>
      </div>
    </form>
  );
}
