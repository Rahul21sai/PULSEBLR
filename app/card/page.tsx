'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import QrCode, { downloadQrPng } from '../components/QrCode';
import { Banner, Button, ButtonLink } from '../components/ui';
import type { MyCardDTO } from '@/lib/contacts/types';

/**
 * "Show my code" — the other direction of the exchange.
 *
 * Deliberately full-bleed with no app chrome: this screen is held up in front of somebody
 * else's phone camera, so the only things that matter are the code, your name, and contrast.
 *
 * THE CODE ENCODES A PLAIN HTTPS URL, which is the load-bearing decision. It means the ~95% of
 * people who do not have this app can still scan it with their stock camera and get your
 * details. A private app-to-app payload would be useless to them.
 */
export default function CardPage() {
  const [card, setCard] = useState<MyCardDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /**
   * The outcome of the two footer actions, said out loud.
   *
   * Distinct from `error`, which replaces the whole screen when the card cannot be loaded. This is
   * transient feedback about an action, on the one screen whose entire job is handing your link to
   * somebody standing in front of you — so silence is the worst possible response.
   */
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  function say(tone: 'ok' | 'error', text: string) {
    setNotice({ tone, text });
    // Long enough to read a failure and act on it, and it does not matter if it outlives a
    // navigation: this screen is a dead end with a close button.
    setTimeout(() => setNotice(null), tone === 'error' ? 5000 : 2200);
  }

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/me/card');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setCard(data.card);
    } catch {
      setError('Could not load your card.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(load, 0);
    return () => clearTimeout(timer);
  }, [load]);

  /**
   * COPY THE LINK, AND SURVIVE A REFUSAL.
   *
   * This was `onClick={() => void navigator.clipboard?.writeText(card.url!)}`, and it produced the
   * ONLY uncaught exception in a 200-event click-through crawl of the whole app:
   * `Failed to execute 'writeText' on 'Clipboard': Write permission denied.` `void` discards the
   * RETURN VALUE, not the rejection — the promise still rejects, unhandled.
   *
   * `writeText` rejects routinely, not exceptionally: whenever the document is not focused, the
   * context is not secure, a permissions policy denies it, or — on iOS Safari — when the call is
   * not inside a direct user gesture. So the failure path is the normal path often enough to need
   * words, and this repo already handles it correctly in two other places
   * (`app/folders/[id]/page.tsx` and `app/events/[id]/page.tsx`); this was the third call site and
   * the only one that did not.
   *
   * The absence check is separate from the `.catch()` on purpose: optional chaining SHORT-CIRCUITS
   * the rest of the chain, so with no Clipboard API at all `navigator.clipboard?.writeText(x)
   * .catch(...)` quietly evaluates to `undefined` and the user is told nothing — a silent no-op,
   * which is the bug this fix exists to remove.
   */
  function copyLink() {
    const url = card?.url;
    if (!url) return;
    if (!navigator.clipboard) {
      say('error', 'This browser will not let a page copy for you — press and hold the code above.');
      return;
    }
    void navigator.clipboard
      .writeText(url)
      .then(() => say('ok', 'Link copied.'))
      .catch(() => say('error', 'Could not copy — your browser blocked clipboard access.'));
  }

  async function enable() {
    try {
      const res = await fetch('/api/me/card', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      });
      if (!res.ok) throw new Error();
      await load();
    } catch {
      setError('Could not turn your card on.');
    }
  }

  return (
    <div className="fixed inset-0 flex flex-col bg-white">
      <div
        className="flex items-center justify-between px-3 pb-1"
        style={{ paddingTop: 'max(12px, env(safe-area-inset-top))' }}
      >
        <Link
          href="/folders"
          aria-label="Close"
          className="grid h-10 w-10 place-items-center rounded-full bg-[#F5F5F7] text-[#1D1D1F] [touch-action:manipulation]"
        >
          <span aria-hidden="true" className="material-symbols-outlined text-[20px]">close</span>
        </Link>
        <ButtonLink href="/settings#my-card" size="sm" tone="quiet" icon="edit">
          Edit
        </ButtonLink>
      </div>

      <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center">
        {loading ? (
          <div className="h-[280px] w-[280px] rounded-2xl bg-[#F5F5F7]" />
        ) : error ? (
          <Banner tone="error">{error}</Banner>
        ) : !card?.enabled ? (
          <div className="max-w-[360px]">
            <span aria-hidden="true" className="material-symbols-outlined text-[40px] text-[#8E8E93]">qr_code_2</span>
            <h1 className="t-title mt-3 text-[#1D1D1F]">Your card is off</h1>
            <p className="mt-2 text-[13.5px] leading-relaxed text-[#6E6E73]">
              Turn it on and anyone can scan your code with an ordinary phone camera — no app
              needed — and save your details. You choose what it shows.
            </p>
            <div className="mt-5 flex flex-col items-center gap-2">
              <Button tone="primary" onClick={enable}>
                Turn on my card
              </Button>
              <ButtonLink href="/settings#my-card" tone="quiet">
                Fill in my details first
              </ButtonLink>
            </div>
          </div>
        ) : (
          <>
            {card.url && (
              <QrCode
                value={card.url}
                size={288}
                ariaLabel="Your PulseBLR card, as a QR code"
                className="shadow-[var(--lift-1)]"
              />
            )}

            <h1
              className="mt-6 text-[26px] font-bold leading-tight tracking-[-0.03em] text-[#1D1D1F]"
              style={{ fontFamily: 'var(--font-display)' }}
            >
              {card.displayName || 'You'}
            </h1>
            {(card.role || card.company) && (
              <p className="mt-1 text-[14px] text-[#6E6E73]">
                {[card.role, card.company].filter(Boolean).join(' · ')}
              </p>
            )}
            {card.headline && (
              <p className="mt-1.5 max-w-[38ch] text-[13px] leading-relaxed text-[#8E8E93]">
                {card.headline}
              </p>
            )}

            <p className="mt-6 max-w-[34ch] text-[12.5px] leading-relaxed text-[#8E8E93]">
              Any phone camera can scan this. Turn your screen brightness up if the room is dark.
            </p>
          </>
        )}
      </div>

      {card?.enabled && card.url && (
        <div
          className="p-4"
          style={{ paddingBottom: 'max(16px, env(safe-area-inset-bottom))' }}
        >
          {/* Above the buttons rather than over the code: the code is what somebody else's camera is
              pointed at, and covering it to report on a copy would break the screen's one job. */}
          {notice && (
            <div className="mx-auto mb-3 max-w-[360px]">
              <Banner tone={notice.tone}>{notice.text}</Banner>
            </div>
          )}
          <div className="flex items-center justify-center gap-2">
            <Button
              tone="quiet"
              icon="download"
              /* `.catch()` for the same reason `copyLink` above has one: `downloadQrPng` is async,
                 and a bare `void` leaves a second unhandled rejection one line from the first. */
              onClick={() =>
                void downloadQrPng(card.url!, 'pulseblr-card.png').catch(() =>
                  say('error', 'Could not save the image — try a screenshot.')
                )
              }
            >
              Save as image
            </Button>
            <Button tone="quiet" icon="content_copy" onClick={copyLink}>
              Copy link
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
