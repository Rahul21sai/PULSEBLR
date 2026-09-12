'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import QrCode, { downloadQrPng } from '../components/QrCode';
import type { MyCardDTO } from '@/lib/contacts/types';

/**
 * Edit the card other people scan.
 *
 * Two things here are deliberate and worth stating in the UI rather than only in code:
 *
 *   - THE PHONE NUMBER IS OPT-IN, with its own switch. It is the field people regret
 *     publishing, and a card is a link that can be forwarded.
 *   - REPLACING THE LINK BREAKS EVERY CODE ALREADY SHOWN. That is the point of being able to
 *     do it, but somebody who has printed the code on a badge needs telling before, not after.
 */

const FIELD_CLASS =
  'mt-1.5 h-11 w-full rounded-[var(--r-touch)] bg-[var(--paper)] px-3.5 text-[15px] text-[var(--ink)] outline-none focus:shadow-[inset_0_0_0_2px_var(--blue)]';

export default function MyCardSection() {
  const [card, setCard] = useState<MyCardDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [confirmRotate, setConfirmRotate] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/me/card');
      if (!res.ok) throw new Error();
      const data = await res.json();
      setCard(data.card);
    } catch {
      setStatus('Could not load your card.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(load, 0);
    return () => clearTimeout(timer);
  }, [load]);

  async function patch(body: Record<string, unknown>, message?: string) {
    setSaving(true);
    setStatus(null);
    try {
      const res = await fetch('/api/me/card', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error();
      const data = await res.json();
      setCard(data.card);
      if (message) {
        setStatus(message);
        setTimeout(() => setStatus(null), 3000);
      }
    } catch {
      setStatus('Could not save that.');
    } finally {
      setSaving(false);
      setConfirmRotate(false);
    }
  }

  function field(key: keyof MyCardDTO, label: string, placeholder?: string, type = 'text') {
    return (
      <label className="block">
        <span className="t-label text-[var(--ink-2)]">{label}</span>
        <input
          type={type}
          defaultValue={(card?.[key] as string) ?? ''}
          placeholder={placeholder}
          // Saved on blur rather than on every keystroke: one request per field instead of one
          // per character, and nothing to remember to press.
          onBlur={e => {
            const value = e.target.value.trim();
            if (value !== ((card?.[key] as string) ?? '')) void patch({ [key]: value });
          }}
          className={FIELD_CLASS}
        />
      </label>
    );
  }

  if (loading) {
    return (
      <section id="my-card" className="rounded-[var(--r-flat)] border border-[var(--rule)] p-5">
        <div className="h-4 w-1/3 rounded bg-[var(--paper)]" />
        <div className="mt-3 h-3 w-1/2 rounded bg-[var(--paper)]" />
      </section>
    );
  }

  return (
    <section id="my-card" className="rounded-[var(--r-flat)] border border-[var(--rule)] p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[16px] font-bold text-[var(--ink)]">My card</h2>
          <p className="mt-0.5 text-[13px] text-[var(--ink-2)]">
            The QR you show somebody so they can save your details. Works with any phone camera —
            they don&apos;t need this app.
          </p>
        </div>
        <label className="toggle-wrap shrink-0" title={card?.enabled ? 'Card is on' : 'Card is off'}>
          <input
            type="checkbox"
            checked={Boolean(card?.enabled)}
            onChange={e => void patch({ enabled: e.target.checked })}
          />
          <span className="toggle-track" />
        </label>
      </div>

      {status && (
        <p className="mt-3 rounded-xl border-l-2 border-l-[var(--accent)] bg-[var(--paper)] px-4 py-2.5 text-[12.5px] text-[var(--accent)]" role="status">
          {status}
        </p>
      )}

      {!card?.enabled ? (
        <p className="mt-4 rounded-xl bg-[var(--paper)] p-4 text-[12.5px] leading-relaxed text-[var(--ink-2)]">
          Your card is off, so the link returns nothing. Fill in whatever you want to share below,
          then switch it on.
        </p>
      ) : (
        card.url && (
          <div className="mt-4 flex flex-col items-center gap-3 rounded-xl bg-[var(--paper)] p-4 sm:flex-row sm:items-start">
            <QrCode value={card.url} size={132} ariaLabel="Your card as a QR code" />
            <div className="min-w-0 flex-1 text-center sm:text-left">
              <p className="text-[13px] font-semibold text-[var(--ink)]">
                {card.displayName || 'Your card'}
              </p>
              <code className="mt-1 block break-all text-[11px] text-[var(--ink-2)]">{card.url}</code>
              <div className="mt-3 flex flex-wrap justify-center gap-2 sm:justify-start">
                <Link
                  href="/card"
                  className="inline-flex h-8 items-center rounded-full bg-[var(--ink)] px-3.5 text-[12px] font-semibold text-[var(--accent-ink)]"
                >
                  Show full screen
                </Link>
                <button
                  type="button"
                  onClick={() => void downloadQrPng(card.url!, 'pulseblr-card.png')}
                  className="inline-flex h-8 items-center rounded-full bg-[var(--surface)] px-3.5 text-[12px] font-semibold text-[var(--ink)] shadow-[inset_0_0_0_1px_var(--hairline-strong)]"
                >
                  Save as image
                </button>
              </div>
            </div>
          </div>
        )
      )}

      <div className="mt-5 flex flex-col gap-4">
        {field('displayName', 'Name on the card', 'Naga Sai Rahul Vudumula')}
        {field('headline', 'Headline', 'Application Developer, IBM.com AEM platform')}
        <div className="grid grid-cols-2 gap-3">
          {field('company', 'Company', 'IBM')}
          {field('role', 'Role', 'Application Developer')}
        </div>
        {field('linkedin', 'LinkedIn', 'linkedin.com/in/… or your handle')}
        <div className="grid grid-cols-2 gap-3">
          {field('x', 'X', 'handle')}
          {field('github', 'GitHub', 'handle')}
        </div>
        {field('website', 'Website', 'https://…')}
        {field('email', 'Email to share', 'you@example.com', 'email')}
        {field('phone', 'Phone', '+91 98765 43210', 'tel')}

        <label className="flex items-start justify-between gap-4 rounded-xl bg-[var(--paper)] p-4">
          <span className="min-w-0">
            <span className="block text-[13.5px] font-semibold text-[var(--ink)]">
              Show my phone number
            </span>
            <span className="mt-0.5 block text-[12px] leading-relaxed text-[var(--ink-2)]">
              Off by default. A card is a link, and links get forwarded.
            </span>
          </span>
          <span className="toggle-wrap shrink-0">
            <input
              type="checkbox"
              checked={Boolean(card?.revealPhone)}
              onChange={e => void patch({ revealPhone: e.target.checked })}
            />
            <span className="toggle-track" />
          </span>
        </label>
      </div>

      <div className="mt-5 border-t border-[color:var(--hairline)] pt-4">
        {confirmRotate ? (
          <div className="flex flex-wrap items-center gap-2">
            <p className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-[var(--live)]">
              This gives you a new link. Any code you have already shown, printed or screenshotted
              stops working.
            </p>
            <button
              type="button"
              disabled={saving}
              onClick={() => void patch({ rotate: true }, 'New link created.')}
              className="h-9 shrink-0 rounded-full bg-[var(--paper)] px-4 text-[12.5px] font-semibold text-[var(--live)]"
            >
              Replace it
            </button>
            <button
              type="button"
              onClick={() => setConfirmRotate(false)}
              className="h-9 shrink-0 rounded-full px-3 text-[12.5px] font-semibold text-[var(--ink-2)]"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmRotate(true)}
            className="text-[12.5px] font-semibold text-[var(--accent)] hover:underline"
          >
            Replace my card link
          </button>
        )}
      </div>
    </section>
  );
}
