'use client';

import { useState } from 'react';

/**
 * The self-registration form behind a folder QR.
 *
 * Filled in by a stranger, standing up, on their own phone, in about twenty seconds. So: four
 * fields visible, everything else behind "more", a numeric keypad for the phone, and no
 * autofocus — on a small screen the keyboard would cover the form the instant it loaded.
 */

const FIELD_CLASS =
  'mt-1.5 h-12 w-full rounded-xl bg-[#F7F7F9] px-3.5 text-[16px] text-[#1D1D1F] outline-none focus:shadow-[inset_0_0_0_2px_var(--blue)]';

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
  const [state, setState] = useState<'idle' | 'saving' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) {
      setError('Your name, at least.');
      return;
    }

    setState('saving');
    setError(null);
    try {
      const res = await fetch(`/api/intake/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, company, role, linkedin, phone, email, note }),
      });

      if (res.status === 429) {
        setError('Too many submissions from this connection. Wait a moment and try again.');
        setState('idle');
        return;
      }
      if (res.status === 410 || res.status === 404) {
        setError('This link has just expired or been switched off.');
        setState('idle');
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setState('done');
    } catch {
      setError('Could not send that. Check your connection and try again.');
      setState('idle');
    }
  }

  if (state === 'done') {
    return (
      <section className="rounded-[22px] bg-white p-6 text-center card-shadow">
        <span className="material-symbols-outlined text-[34px] text-[#1D8A44]">check_circle</span>
        <h2 className="t-sub mt-2 text-[#1D1D1F]">You&apos;re in</h2>
        <p className="mt-1.5 text-[13.5px] leading-relaxed text-[#6E6E73]">
          Added to {folderName}. Nothing else to do — enjoy the event.
        </p>
      </section>
    );
  }

  return (
    <form onSubmit={submit} className="rounded-[22px] bg-white p-5 card-shadow">
      {error && (
        <p
          className="mb-4 rounded-xl bg-[#FFF1F0] px-4 py-3 text-[12.5px] text-[#C7362D]"
          role="alert"
        >
          {error}
        </p>
      )}

      <label className="block">
        <span className="t-label text-[#8E8E93]">Your name</span>
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          autoComplete="name"
          className={FIELD_CLASS}
        />
      </label>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <label className="block">
          <span className="t-label text-[#8E8E93]">Company</span>
          <input
            value={company}
            onChange={e => setCompany(e.target.value)}
            autoComplete="organization"
            className={FIELD_CLASS}
          />
        </label>
        <label className="block">
          <span className="t-label text-[#8E8E93]">Role</span>
          <input
            value={role}
            onChange={e => setRole(e.target.value)}
            autoComplete="organization-title"
            className={FIELD_CLASS}
          />
        </label>
      </div>

      <label className="mt-4 block">
        <span className="t-label text-[#8E8E93]">LinkedIn</span>
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
          className="mt-4 text-[13px] font-semibold text-[#0071E3] hover:underline"
        >
          Add phone or email
        </button>
      )}

      {showMore && (
        <>
          <label className="mt-4 block">
            <span className="t-label text-[#8E8E93]">Phone</span>
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
            <span className="t-label text-[#8E8E93]">Email</span>
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
            <span className="t-label text-[#8E8E93]">Anything worth noting</span>
            <textarea
              value={note}
              onChange={e => setNote(e.target.value)}
              rows={2}
              className="mt-1.5 w-full resize-none rounded-xl bg-[#F7F7F9] px-3.5 py-2.5 text-[16px] leading-relaxed text-[#1D1D1F] outline-none focus:shadow-[inset_0_0_0_2px_var(--blue)]"
            />
          </label>
        </>
      )}

      <button
        type="submit"
        disabled={state === 'saving'}
        className="mt-5 flex h-12 w-full items-center justify-center rounded-full bg-[#1D1D1F] text-[15px] font-semibold text-white hover:bg-black disabled:opacity-45 pressable"
      >
        {state === 'saving' ? 'Sending…' : 'Add me'}
      </button>
    </form>
  );
}
