import { NextRequest, NextResponse } from 'next/server';
import { clientKey, rateLimit } from '@/lib/security/rate-limit';
import { escapeHtml } from '@/lib/notifications/html';
import { verifyUnsubscribeToken } from '@/lib/notifications/reminder-policy';
import { disableRemindersFor } from '@/lib/notifications/reminders';

/**
 * PUBLIC — get off the reminder list, with no session.
 *
 * DELIBERATELY UNAUTHENTICATED, and for a stronger reason than convenience: an unsubscribe that
 * needs a sign-in is not an unsubscribe. The reader is in a mail client, possibly on a different
 * device, possibly signed out, and quite possibly annoyed. If the escape hatch asks them to
 * authenticate they will use their mail provider's "report spam" button instead, and that is a
 * domain-reputation problem rather than a preference change. `scripts/diag-api-auth.ts` should
 * list this alongside `/api/card/[token]` under MUST_ALLOW so it staying public is a tested
 * decision rather than an oversight.
 *
 * WHAT KEEPS IT SAFE IS NOT A SESSION:
 *
 *   · the `t` parameter is an HMAC of the user id under `NEXTAUTH_SECRET`, so the link cannot be
 *     forged or enumerated (`lib/notifications/reminder-policy.ts` documents what is in the URL
 *     and why the user id being there grants nothing — every other route in this app derives
 *     `userId` from the session and never from input)
 *   · the only reachable effect is setting one boolean to false. There is no read: the response
 *     never names the account, never says whether the id exists, and the copy is identical either
 *     way, so the link cannot be used as an oracle for "is this a user"
 *   · unauthenticated, therefore rate limited
 *
 * ── GET CONFIRMS, POST ACTS. This is the part that is easy to get wrong. ─────────────────────────
 * A GET that unsubscribes is a bug, because it is not the reader who fetches it first: mail
 * clients, corporate link scanners and Safari's preloader all follow links in a message before a
 * human has decided anything. Gmail's own proxy fetches images and some clients prefetch
 * destinations. So a one-click GET silently unsubscribes people who merely RECEIVED the email —
 * which presents as "your reminders just stopped working" and is unattributable.
 *
 * So GET renders a small page with a real button, and POST is what writes. Both read their
 * parameters from the QUERY STRING, never from the body, which is also what makes RFC 8058
 * one-click work: `List-Unsubscribe-Post` makes Gmail and Apple Mail POST the URL themselves with
 * a `List-Unsubscribe=One-Click` form body this handler simply ignores. One handler, two callers,
 * no branching.
 *
 * It returns HTML rather than JSON because a person opens it in a browser. `noindex` because a
 * crawler has no business here.
 */

const NOINDEX_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  // Never cached: the page reflects a preference that this very request changes.
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow',
};

/**
 * One page shell for all four outcomes.
 *
 * Inline styles, no shared component and no Tailwind: this is served straight out of a route
 * handler with no React tree, and it has to render correctly for somebody who arrived from an
 * email on a phone. `viewport` and a 17px base keep it legible; the button is 48px tall, past the
 * 44px floor the rest of this work holds to.
 */
function page(input: { title: string; body: string; status: number }): NextResponse {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>${escapeHtml(input.title)} · PulseBLR</title>
  <style>
    :root { color-scheme: light; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; background: #F7F7F9; color: #1D1D1F; margin: 0; padding: 24px; display: flex; min-height: 100vh; align-items: center; justify-content: center; }
    .card { background: #FFFFFF; border-radius: 18px; box-shadow: 0 0.5px 0 rgba(0,0,0,0.07), 0 8px 30px rgba(0,0,0,0.06); padding: 28px 24px; max-width: 420px; width: 100%; }
    h1 { font-size: 21px; letter-spacing: -0.02em; margin: 0 0 10px 0; }
    p { font-size: 15px; line-height: 1.55; color: #6E6E73; margin: 0 0 14px 0; }
    button { appearance: none; border: 0; width: 100%; min-height: 48px; border-radius: 999px; background: #1D1D1F; color: #FFFFFF; font-size: 15px; font-weight: 600; cursor: pointer; touch-action: manipulation; }
    a.quiet { display: inline-block; margin-top: 14px; font-size: 14px; color: #0071E3; text-decoration: none; }
    .ok { color: #248A3D; font-weight: 600; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(input.title)}</h1>
    ${input.body}
  </div>
</body>
</html>`;
  return new NextResponse(html, { status: input.status, headers: NOINDEX_HEADERS });
}

/**
 * A refusal that says nothing about whether the id exists.
 *
 * Same page for a bad signature, a missing parameter and an unset secret — because the reader can
 * do nothing with the difference, and the difference is exactly what a prober wants.
 */
function badLink(): NextResponse {
  return page({
    status: 400,
    title: 'This link has expired',
    body: `<p>We could not read that unsubscribe link. It may have been broken by your mail client, or the app's signing key may have been rotated since the email was sent.</p>
    <p>You can turn reminders off in the app under Settings, or simply reply to the email and we will do it.</p>`,
  });
}

/** Both verbs answer the same questions in the same order. */
function check(request: NextRequest): { ok: true; userId: string } | { ok: false } {
  const secret = process.env.NEXTAUTH_SECRET || '';
  const userId = request.nextUrl.searchParams.get('u');
  const token = request.nextUrl.searchParams.get('t');
  if (!verifyUnsubscribeToken(userId, token, secret)) return { ok: false };
  return { ok: true, userId: userId as string };
}

export async function GET(request: NextRequest) {
  const limit = rateLimit(clientKey(request, 'unsub'), { limit: 30, windowMs: 60_000 });
  if (!limit.ok) {
    return page({
      status: 429,
      title: 'Too many attempts',
      body: '<p>Please wait a minute and open the link again.</p>',
    });
  }

  const verdict = check(request);
  if (!verdict.ok) return badLink();

  // The form posts back to this exact URL, so the query string carries the parameters through and
  // POST never has to trust a body.
  const action = `${request.nextUrl.pathname}${request.nextUrl.search}`;
  return page({
    status: 200,
    title: 'Stop event reminders?',
    body: `<p>You will no longer get an email when an event you saved is about to happen.</p>
    <form method="post" action="${escapeHtml(action)}">
      <button type="submit">Stop these reminders</button>
    </form>
    <p style="margin-top:14px">This does not delete your account, does not touch anything you have saved, and does not stop the weekly digest — that has its own setting in the app.</p>`,
  });
}

export async function POST(request: NextRequest) {
  const limit = rateLimit(clientKey(request, 'unsub'), { limit: 30, windowMs: 60_000 });
  if (!limit.ok) {
    return page({
      status: 429,
      title: 'Too many attempts',
      body: '<p>Please wait a minute and try again.</p>',
    });
  }

  const verdict = check(request);
  if (!verdict.ok) return badLink();

  try {
    // `matched` is deliberately NOT reflected in the copy. Saying "we could not find that account"
    // would turn this into a lookup oracle, and there is nothing the reader could do about it
    // anyway — either way, they are not going to be emailed.
    await disableRemindersFor(verdict.userId);
  } catch (error) {
    console.error('Failed to unsubscribe from reminders:', error);
    return page({
      status: 500,
      title: 'That did not save',
      body: `<p>Something went wrong on our side, so we cannot promise the change took effect. Please try the link again in a minute.</p>`,
    });
  }

  return page({
    status: 200,
    title: 'Done',
    body: `<p class="ok">You will not get any more reminder emails.</p>
    <p>If you change your mind, you can turn them back on in the app under Settings.</p>
    <a class="quiet" href="/">Open PulseBLR</a>`,
  });
}
