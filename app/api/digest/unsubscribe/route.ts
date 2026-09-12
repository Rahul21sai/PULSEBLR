import { NextRequest, NextResponse } from 'next/server';
import { clientKey, rateLimit } from '@/lib/security/rate-limit';
import { escapeHtml } from '@/lib/notifications/html';
import { verifyDigestUnsubscribeToken } from '@/lib/notifications/digest-schedule';
import { disableDigestFor } from '@/lib/notifications/digest';

/**
 * PUBLIC — get off the digest, with no session.
 *
 * A SECOND ROUTE RATHER THAN A PARAMETER ON `/api/reminders/unsubscribe`, and that is the important
 * decision in this file. The two mailings are two separate consents: reminders are about events the
 * user SAVED, the digest is a recurring summary they chose a cadence for. One route with a `?kind=`
 * would mean one token verifying for both, so a mail client that rewrote or truncated a URL — or a
 * reader who forwarded a digest — could turn off the reminders they still want. Two mailings, two
 * scope strings (`digest:v1:` here, `reminders:v1:` there), two routes.
 *
 * DELIBERATELY UNAUTHENTICATED, and for a stronger reason than convenience: an unsubscribe that
 * needs a sign-in is not an unsubscribe. The reader is in a mail client, possibly on another device,
 * possibly signed out, and quite possibly annoyed. If the escape hatch asks them to authenticate they
 * will use their provider's "report spam" button instead, and that is a domain-reputation problem
 * rather than a preference change. `scripts/diag-api-auth.ts` should list both verbs under
 * `MUST_BE_PUBLIC_404` beside the reminder ones, so staying public is a tested decision rather than
 * an oversight.
 *
 * WHAT KEEPS IT SAFE IS NOT A SESSION:
 *
 *   · `t` is an HMAC of the user id under `NEXTAUTH_SECRET`, so the link cannot be forged or
 *     enumerated
 *   · the only reachable effect is setting one enum to `'off'`. There is no read: the response never
 *     names the account and never says whether the id exists, and the copy is identical either way,
 *     so the link cannot be used as an oracle for "is this a user"
 *   · unauthenticated, therefore rate limited
 *
 * ── GET CONFIRMS, POST ACTS. This is the part that is easy to get wrong. ────────────────────────
 * A GET that unsubscribes is a bug, because it is not the reader who fetches it first: mail clients,
 * corporate link scanners and browser preloaders all follow links in a message before a human has
 * decided anything. So a one-click GET silently unsubscribes people who merely RECEIVED the email —
 * which presents as "my digest just stopped arriving" and is unattributable.
 *
 * So GET renders a small page with a real button, and POST is what writes. Both read their parameters
 * from the QUERY STRING, never from the body, which is also what makes RFC 8058 one-click work:
 * `List-Unsubscribe-Post` makes Gmail and Apple Mail POST the URL themselves with a
 * `List-Unsubscribe=One-Click` form body this handler simply ignores. One handler, two callers, no
 * branching.
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
 * Inline styles, no shared component and no Tailwind: this is served straight out of a route handler
 * with no React tree, and it has to render correctly for somebody who arrived from an email on a
 * phone. The button is 48px tall, past the 44px floor the rest of this app holds to.
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
    /* LITERAL HEXES ON PURPOSE - DO NOT CONVERT THESE TO var(). This is a standalone
       document: app/globals.css is not in scope, so a custom property would resolve to
       nothing and paint transparent.

       Every colour below mirrors one of the nine tokens - ground/--paper, card/--surface,
       body/--ink, secondary/--ink-2, quiet/--ink-3, rule/--rule, link/--accent. Read the
       CURRENT value out of the palette block in app/globals.css and re-sync by hand; this
       comment deliberately does NOT repeat the hexes, because a value copied into a comment
       is a snapshot that goes stale silently and then gets trusted. */
    :root { color-scheme: light; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; background: #FAF9F5; color: #121417; margin: 0; padding: 24px; display: flex; min-height: 100vh; align-items: center; justify-content: center; }
    .card { background: #FFFFFF; border-radius: 18px; box-shadow: 0 0.5px 0 rgba(0,0,0,0.07), 0 8px 30px rgba(0,0,0,0.06); padding: 28px 24px; max-width: 420px; width: 100%; }
    h1 { font-size: 21px; letter-spacing: -0.02em; margin: 0 0 10px 0; }
    p { font-size: 15px; line-height: 1.55; color: #55595F; margin: 0 0 14px 0; }
    button { appearance: none; border: 0; width: 100%; min-height: 48px; border-radius: 999px; background: #121417; color: #FFFFFF; font-size: 15px; font-weight: 600; cursor: pointer; touch-action: manipulation; }
    a.quiet { display: inline-block; margin-top: 14px; font-size: 14px; color: #12513C; text-decoration: none; }
    .ok { color: #12513C; font-weight: 600; }
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
 * Same page for a bad signature, a missing parameter and an unset secret — the reader can do nothing
 * with the difference, and the difference is exactly what a prober wants.
 */
function badLink(): NextResponse {
  return page({
    status: 400,
    title: 'This link has expired',
    body: `<p>We could not read that unsubscribe link. It may have been broken by your mail client, or the app's signing key may have been rotated since the email was sent.</p>
    <p>You can change the digest cadence — including turning it off — on the <a href="/onboarding">preferences screen</a> in the app.</p>`,
  });
}

/** Both verbs answer the same questions in the same order. */
function check(request: NextRequest): { ok: true; userId: string } | { ok: false } {
  const secret = process.env.NEXTAUTH_SECRET || '';
  const userId = request.nextUrl.searchParams.get('u');
  const token = request.nextUrl.searchParams.get('t');
  if (!verifyDigestUnsubscribeToken(userId, token, secret)) return { ok: false };
  return { ok: true, userId: userId as string };
}

export async function GET(request: NextRequest) {
  const limit = rateLimit(clientKey(request, 'digest-unsub'), { limit: 30, windowMs: 60_000 });
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
    title: 'Stop the PulseBLR digest?',
    body: `<p>You will no longer get the regular email rounding up Bengaluru tech events worth your time.</p>
    <form method="post" action="${escapeHtml(action)}">
      <button type="submit">Stop the digest</button>
    </form>
    <p style="margin-top:14px">This does not delete your account and does not touch anything you have saved. It also does not stop reminders about events you saved yourself — those have their own setting and their own unsubscribe link.</p>`,
  });
}

export async function POST(request: NextRequest) {
  const limit = rateLimit(clientKey(request, 'digest-unsub'), { limit: 30, windowMs: 60_000 });
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
    await disableDigestFor(verdict.userId);
  } catch (error) {
    console.error('Failed to unsubscribe from the digest:', error);
    return page({
      status: 500,
      title: 'That did not save',
      body: `<p>Something went wrong on our side, so we cannot promise the change took effect. Please try the link again in a minute.</p>`,
    });
  }

  return page({
    status: 200,
    title: 'Done',
    body: `<p class="ok">You will not get any more digest emails.</p>
    <p>Reminders about events you saved yourself are untouched — those are a separate setting with their own unsubscribe link.</p>
    <p>If you change your mind, you can pick a weekly or daily digest again on the <a href="/onboarding">preferences screen</a>.</p>
    <a class="quiet" href="/digest">See this week on the web instead</a>`,
  });
}
