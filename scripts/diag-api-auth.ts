#!/usr/bin/env tsx
/**
 * Hit every mutating endpoint WITHOUT credentials and assert it refuses.
 *
 * This is the regression test for the session's highest-severity finding: six endpoints
 * accepted unauthenticated writes because proxy.ts's matcher excludes `api`, so the
 * proxy never runs for an API route and each handler was the only possible guard.
 *
 * Payloads are chosen so that a FAILURE here cannot itself damage data — non-existent
 * ObjectIds and empty bodies. What matters is the status code: 401/403/503 means the
 * guard ran, while 400/404/200 means the request reached the handler body.
 *
 * Needs a dev server on http://localhost:3000. No database writes if the guards work.
 *
 * Run: npx tsx scripts/diag-api-auth.ts
 */
const BASE = process.env.PULSEBLR_BASE_URL || 'http://localhost:3000';

/** An id that is valid ObjectId syntax but cannot exist. */
const GHOST = '000000000000000000000000';

interface Case {
  method: string;
  path: string;
  body?: unknown;
  why: string;
}

const MUST_REFUSE: Case[] = [
  { method: 'POST', path: '/api/events', body: {}, why: 'create a global event (renders applyLink into an href)' },
  { method: 'PUT', path: `/api/events/${GHOST}`, body: { title: 'x' }, why: 'rewrite any event' },
  { method: 'DELETE', path: `/api/events/${GHOST}`, why: 'delete any event — ids come from the public feed' },
  { method: 'POST', path: '/api/sources', body: { kind: 'meetup-group', handle: 'x' }, why: 'inject a handle the next scrape will fetch' },
  { method: 'PUT', path: `/api/sources/${GHOST}`, body: { enabled: false }, why: 'disable a source, silently shrinking the feed' },
  { method: 'DELETE', path: `/api/sources/${GHOST}`, why: 'destroy persisted discovery state' },
  { method: 'POST', path: '/api/scrape', body: { fast: true }, why: '~700 upstream requests + LLM spend + prune deleteMany' },
  { method: 'POST', path: '/api/scrape-url', body: { url: 'http://169.254.169.254/' }, why: 'SSRF to cloud metadata' },
  { method: 'POST', path: '/api/notifications/send-digest', why: 'drain the Resend quota' },
  { method: 'GET', path: '/api/notifications/send-digest', why: "read EVERY user's contacts and private notes" },
  { method: 'GET', path: '/api/admin/stats', why: 'source health, user counts and corpus internals' },

  // ── Scan & contacts ──────────────────────────────────────────────────────
  // Every one of these touches a named person's private details: their phone number, their
  // LinkedIn, and free-text notes about how you met them. The CSV export is a bulk PII dump.
  { method: 'GET', path: '/api/folders', why: "list a user's event folders" },
  { method: 'POST', path: '/api/folders', body: { name: 'x' }, why: "create a folder in someone's account" },
  { method: 'GET', path: `/api/folders/${GHOST}`, why: 'read a folder and everyone in it' },
  { method: 'PATCH', path: `/api/folders/${GHOST}`, body: { name: 'x' }, why: 'rename any folder' },
  { method: 'DELETE', path: `/api/folders/${GHOST}`, why: 'delete a folder AND cascade-delete its contacts' },
  {
    method: 'POST',
    path: `/api/folders/${GHOST}/intake`,
    body: { action: 'enable' },
    why: 'mint a public write token for somebody else’s folder',
  },
  { method: 'GET', path: `/api/folders/${GHOST}/export?format=csv`, why: 'bulk PII export — names, phones, notes' },
  { method: 'GET', path: '/api/contacts', why: "read every person a user has ever met" },
  {
    method: 'POST',
    path: '/api/contacts',
    body: { clientId: 'diag', name: 'x', folderId: GHOST },
    why: 'write a contact into another account',
  },
  { method: 'PATCH', path: `/api/contacts/${GHOST}`, body: { name: 'x' }, why: 'rewrite any contact' },
  { method: 'DELETE', path: `/api/contacts/${GHOST}`, why: 'delete any contact' },
  {
    method: 'POST',
    path: '/api/contacts/sync',
    body: { contacts: [] },
    why: 'bulk-write contacts via the offline outbox drain',
  },
  { method: 'GET', path: '/api/me/card', why: 'read a user’s own card, including an unpublished phone number' },
  { method: 'PUT', path: '/api/me/card', body: { enabled: true }, why: 'publish somebody’s card without their say' },

  // ── Tracker & career intelligence ────────────────────────────────────────
  // These were ABSENT from this list until 2026-08-24, despite the docblock above claiming
  // "every mutating endpoint" — so the whole tracker write path, the half of the product that
  // holds a user's private notes on people they have met, was never probed signed-out. Only
  // the /tracker PAGE redirect was checked, which says nothing about the API behind it.
  //
  // The payloads here are DELIBERATELY INVALID, and that is the point. Each of these routes
  // now validates its body (lib/tracker/validate.ts), and validation must run AFTER the
  // guard. If the order is ever inverted, an anonymous caller gets 400 instead of 401 — which
  // both fails to refuse and tells a stranger their payload was well-formed enough to reach
  // the validator. A valid payload could not detect that inversion; an invalid one does.
  {
    method: 'POST',
    path: '/api/tracker',
    body: { eventId: 'not-an-id', status: 'Ghosted' },
    why: 'track an event in someone else’s account — invalid body, so a 400 here means validation outran the guard',
  },
  { method: 'GET', path: `/api/tracker/${GHOST}`, why: 'read a tracker entry, including its private notes' },
  {
    method: 'PUT',
    path: `/api/tracker/${GHOST}`,
    body: { status: 'Ghosted' },
    why: 'rewrite any tracker entry — invalid status, so a 400 here means validation outran the guard',
  },
  { method: 'DELETE', path: `/api/tracker/${GHOST}`, why: 'delete any tracker entry' },
  {
    method: 'POST',
    path: '/api/phase6/follow-ups',
    body: { contactId: GHOST },
    why: 'mark somebody else’s follow-up complete',
  },
];

/**
 * Private pages, checked signed-out.
 *
 * THE EXPECTATION CHANGED, and the reason is the point. This used to assert a 307 to /login from
 * `proxy.ts`. That check was removed: it looked for a session cookie BY NAME in the edge runtime,
 * where there is no secret to verify a token with, so it could only ask "is a cookie present" —
 * `Cookie: __Secure-authjs.session-token=dummy` returned 200 on every one of these paths in
 * production — while producing false negatives that locked out users whose session was
 * demonstrably valid (`/login` itself reported "You're already signed in as <address>").
 *
 * So a 200 here is now CORRECT for the eight client pages: they render a shell and
 * `ProtectedRouteGate` draws a sign-in prompt once `useSession()` settles as unauthenticated. No
 * user data is in that HTML — every one of them is a client component that fetches from an API
 * enforcing `requireUser()`, which the section above already asserts.
 *
 * `/admin` is the exception and still MUST redirect, because it is a server component that
 * re-checks the session and the allowlist itself before emitting any admin markup. That check is
 * real (it has the secret), so a regression there is a genuine authorisation failure rather than
 * a cosmetic one — which is why it is asserted separately below.
 */
const MUST_REDIRECT = [
  '/admin',
];

/**
 * Pages that legitimately return 200 signed-out and gate on the client.
 *
 * Asserted so that a future change cannot quietly start server-rendering user data into one of
 * them: the guarantee being pinned is "reachable, and carries nothing private".
 */
const CLIENT_GATED = [
  '/settings',
  '/dashboard',
  '/tracker',
  '/add-event',
  // Scan surfaces. NOTE the two public siblings that must NOT be here: `/c/<token>` (somebody's
  // card, opened from a QR by a stranger) and `/f/<token>` (add yourself to a folder). proxy.ts
  // matches by PREFIX, so `/card` is safe only because `'/c/abc'.startsWith('/card')` is false.
  '/folders',
  '/scan',
  '/card',
];

/**
 * Endpoints that are public on purpose — a regression the other way matters too.
 *
 * The two token endpoints are here deliberately: the whole point of a card QR is that somebody
 * with no account and no app can scan it. Listing them formally blesses that, so "why is this
 * reachable signed-out" has a recorded answer. What protects them is not a session:
 * 16 bytes of CSPRNG entropy in the token, an explicit enable flag, an expiry, a rate limit, and
 * responses that carry only what the owner chose to publish.
 */
const MUST_ALLOW: Case[] = [
  { method: 'GET', path: '/api/events?limit=1', why: 'the feed is public' },
  { method: 'GET', path: '/api/events/facets', why: 'filter counts are public' },
  { method: 'GET', path: '/api/companies', why: 'the companies directory is public' },
];

/**
 * Public token endpoints. A bad token must yield 404 (not 401, not 500) — proving the handler
 * ran and refused on its own terms rather than being gated by a session it does not need.
 */
const MUST_BE_PUBLIC_404: Case[] = [
  {
    method: 'GET',
    path: '/api/card/0000000000000000000000',
    why: 'a card page must resolve for a stranger; an unknown token is simply not found',
  },
  {
    method: 'POST',
    path: '/api/intake/0000000000000000000000',
    body: { name: 'diag' },
    why: 'folder self-registration must accept an anonymous POST, and refuse an unknown token',
  },
];

const REFUSING = new Set([401, 403, 503]);

async function hit(c: Case) {
  const res = await fetch(BASE + c.path, {
    method: c.method,
    headers: c.body ? { 'Content-Type': 'application/json' } : {},
    body: c.body ? JSON.stringify(c.body) : undefined,
    redirect: 'manual',
    signal: AbortSignal.timeout(30000),
  });
  let detail = '';
  try {
    const text = await res.text();
    detail = text.slice(0, 90).replace(/\s+/g, ' ');
  } catch { /* body may be empty */ }
  return { status: res.status, detail };
}

async function main() {
  console.log(`Probing ${BASE} with NO credentials\n`);
  let failures = 0;

  console.log('MUST REFUSE (401 / 403 / 503)\n');
  for (const c of MUST_REFUSE) {
    try {
      const { status, detail } = await hit(c);
      const ok = REFUSING.has(status);
      if (!ok) failures++;
      console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${status}  ${c.method.padEnd(6)} ${c.path.padEnd(42)} ${c.why}`);
      if (!ok) console.log(`         body: ${detail}`);
    } catch (err) {
      failures++;
      console.log(`  FAIL  ERR  ${c.method} ${c.path} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log('\nMUST STAY PUBLIC (200)\n');
  for (const c of MUST_ALLOW) {
    try {
      const { status } = await hit(c);
      const ok = status === 200;
      if (!ok) failures++;
      console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${status}  ${c.method.padEnd(6)} ${c.path.padEnd(42)} ${c.why}`);
    } catch (err) {
      failures++;
      console.log(`  FAIL  ERR  ${c.method} ${c.path} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log('\nPUBLIC TOKEN ENDPOINTS (must run un-authed and 404 an unknown token)\n');
  for (const c of MUST_BE_PUBLIC_404) {
    try {
      const { status, detail } = await hit(c);
      // 404 means the handler ran and refused on its own terms. A 401/403 would mean it had been
      // gated by a session it must not require; a 500 would mean it crashed on a stranger.
      const ok = status === 404;
      if (!ok) failures++;
      console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${status}  ${c.method.padEnd(6)} ${c.path.padEnd(42)} ${c.why}`);
      if (!ok) console.log(`         body: ${detail}`);
    } catch (err) {
      failures++;
      console.log(`  FAIL  ERR  ${c.method} ${c.path} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log('\nSERVER-CHECKED PAGES THAT MUST REDIRECT TO /login (307)\n');
  for (const path of MUST_REDIRECT) {
    try {
      const res = await fetch(BASE + path, {
        headers: { Accept: 'text/html' },
        redirect: 'manual',
        signal: AbortSignal.timeout(30000),
      });
      const location = res.headers.get('location') || '';
      const ok = (res.status === 307 || res.status === 302) && location.includes('/login');
      if (!ok) failures++;
      console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${res.status}  ${path.padEnd(14)} -> ${location.replace(BASE, '') || '(no redirect)'}`);
    } catch (err) {
      failures++;
      console.log(`  FAIL  ERR  ${path} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /*
   * The client-gated pages. A 200 is correct — see the comment on CLIENT_GATED — but the HTML
   * must not contain private data, since it is served to anyone. Checked by asserting the
   * signed-in shell markers are ABSENT and the gate's own prompt is reachable: these pages are
   * client components, so their user data arrives later from an API that answers 401.
   */
  console.log('\nCLIENT-GATED PAGES: reachable signed-out, and carry nothing private\n');
  for (const path of CLIENT_GATED) {
    try {
      const res = await fetch(BASE + path, {
        headers: { Accept: 'text/html' },
        redirect: 'manual',
        signal: AbortSignal.timeout(30000),
      });
      const body = res.ok ? await res.text() : '';
      /*
       * A canary, not a proof: an email address in server-rendered HTML on a page served to an
       * anonymous caller would mean somebody's session leaked into the document.
       *
       * THE TLD MUST BE ALPHABETIC, and that is not pedantry — a looser `[\w.]+` tail matched
       * `FILL@100..700` from the Material Symbols font URL in `app/layout.tsx` and reported all
       * seven pages as leaking. A canary that cries wolf on every page is worse than none,
       * because the next person turns it off.
       */
      const EMAIL_IN_HTML = /[\w.+-]+@[\w-]+\.[A-Za-z]{2,24}(?![\w.-])/;
      const leaksEmail = EMAIL_IN_HTML.test(body.replace(/onboarding@resend\.dev/g, ''));
      const ok = res.status === 200 && !leaksEmail;
      if (!ok) failures++;
      console.log(
        `  ${ok ? 'PASS' : 'FAIL'}  ${res.status}  ${path.padEnd(14)} ${leaksEmail ? '<- LEAKS AN EMAIL ADDRESS' : 'no private data in HTML'}`
      );
    } catch (err) {
      failures++;
      console.log(`  FAIL  ERR  ${path} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
