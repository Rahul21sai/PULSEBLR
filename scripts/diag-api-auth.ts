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
  /**
   * For a public endpoint that refuses on its OWN terms, the code it should refuse with.
   * Defaults to 404. `/api/reminders/unsubscribe` answers 400 instead, and correctly so: the
   * token is a signature over a user id rather than a lookup key, so a broken link is a
   * malformed request, not a missing row. What matters is that it is neither 401/403 (gated by
   * a session it must not require — the link is opened from an email client) nor 500.
   */
  expect?: number;
}

const MUST_REFUSE: Case[] = [
  { method: 'POST', path: '/api/events', body: {}, why: 'create a global event (renders applyLink into an href)' },
  { method: 'PUT', path: `/api/events/${GHOST}`, body: { title: 'x' }, why: 'rewrite any event' },
  { method: 'DELETE', path: `/api/events/${GHOST}`, why: 'delete any event — ids come from the public feed' },
  { method: 'POST', path: '/api/sources', body: { kind: 'meetup-group', handle: 'x' }, why: 'inject a handle the next scrape will fetch' },
  /*
   * THE TWO SOURCE READS WERE IN NEITHER LIST — not MUST_REFUSE, not MUST_ALLOW — so nothing here
   * had an opinion about them, and both were reachable with no cookie. Measured before the fix:
   * `GET /api/sources` returned 423 Source documents anonymously, including every upstream URL and
   * handle and 304 rows carrying internal `lastError` text. `requireAdmin` was imported in the
   * file and used only by POST, which is exactly why the module read as guarded.
   *
   * The general lesson for this script: a list of MUTATING endpoints is not a list of endpoints.
   * A GET that returns the scraping machinery is the same disclosure as `/api/admin/stats`, which
   * has always been asserted below.
   */
  { method: 'GET', path: '/api/sources', why: 'full scraper inventory — every upstream URL, handle and lastError' },
  { method: 'GET', path: `/api/sources/${GHOST}`, why: 'one source row, same disclosure as the collection' },
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

  /*
   * -- EVERYTHING BELOW WAS BUILT AFTER THIS LIST WAS LAST TOUCHED, AND THAT IS THE POINT --------
   *
   * `All checks passed` was true and INCOMPLETE: the list predated the person surface, the control
   * room, MCP v2, the digest, reminders and follow-up drafting. An endpoint this file has no opinion
   * about is not safe by default, it is UNEXAMINED -- which is exactly the lesson the two
   * `GET /api/sources` rows above already record, and the reason these are asserted rather than
   * assumed.
   */

  // -- The person surface. Every one of these reads or writes a named third party's details. --
  { method: 'GET', path: '/api/people', why: 'read every human a user has met, merged across folders' },
  { method: 'GET', path: '/api/people/facets', why: 'per-company and per-tag counts of somebody’s contacts' },
  { method: 'GET', path: `/api/people/${GHOST}`, why: 'one person, their captures, timeline and private notes' },
  {
    method: 'PATCH',
    path: `/api/people/${GHOST}`,
    body: { ownTags: ['x'] },
    why: 'rewrite a person, their tags or their follow-up',
  },
  { method: 'GET', path: '/api/people/export', why: 'bulk PII export - names, companies, reach, notes' },
  {
    method: 'POST',
    path: '/api/people/tags',
    body: { personIds: [GHOST], add: ['x'] },
    why: 'bulk-tag people in another account',
  },
  { method: 'GET', path: '/api/people/merge', why: 'suggested duplicate pairs, i.e. a list of who they know' },
  {
    method: 'POST',
    path: '/api/people/merge',
    body: { action: 'dismiss' },
    why: 'merge or unmerge somebody else’s people',
  },
  /*
   * THE DRAFT ROUTE IS THE MOST SENSITIVE ONE IN THE APP. It sends a private note about a named
   * person to a third-party model, so an unguarded version is both a disclosure AND a way to spend
   * somebody else's LLM budget. Probed WITH a body, so a 400 here would mean validation outran the
   * guard.
   */
  {
    method: 'POST',
    path: `/api/people/${GHOST}/draft`,
    body: { channel: 'email' },
    why: 'send a stranger’s private notes to an LLM on their behalf',
  },
  {
    method: 'POST',
    path: '/api/contacts/bulk',
    body: { ids: [GHOST], tags: ['x'] },
    why: 'bulk-rewrite contacts in another account',
  },

  /*
   * -- CREDENTIAL MINTING. If only one row in this file matters, it is this one. ----------------
   *
   * `POST /api/me/mcp-tokens` issues a bearer token granting read access to the caller's saved
   * events, their people, and who they met where. Unguarded it would let a stranger mint a
   * LONG-LIVED credential against somebody else's account -- strictly worse than any single read
   * in this file, because it survives the request. `DELETE` matters for the mirror reason:
   * revocation must not be something a stranger can do on your behalf either.
   */
  { method: 'GET', path: '/api/me/mcp-tokens', why: 'list somebody’s MCP tokens' },
  {
    method: 'POST',
    path: '/api/me/mcp-tokens',
    body: { label: 'diag' },
    why: 'MINT a bearer credential against another account',
  },
  {
    method: 'DELETE',
    path: `/api/me/mcp-tokens?id=${GHOST}`,
    why: 'revoke another user’s credential',
  },
  { method: 'GET', path: '/api/me/preferences', why: 'read a user’s topics, areas and notification settings' },
  {
    method: 'PUT',
    path: '/api/me/preferences',
    body: { topics: ['AI/ML'] },
    why: 'rewrite feed preferences and opt somebody into mail',
  },

  // -- The control room. Global effects, so these need requireAdmin, not merely a session. --
  { method: 'GET', path: '/api/admin/audit', why: 'the full audit log - who changed what, with before/after' },
  {
    method: 'POST',
    path: '/api/admin/audit/undo',
    body: { id: GHOST },
    why: 'undo an operator action, i.e. resurrect or revert any event',
  },
  { method: 'GET', path: '/api/admin/impact', why: 'which users have tracked or scanned a given event' },
  { method: 'GET', path: '/api/admin/engagement', why: 'per-account activity - signups, actives, what each user saved' },
  { method: 'GET', path: '/api/admin/feed-quality', why: 'corpus internals and delete candidates' },
  {
    method: 'PATCH',
    path: `/api/admin/events/${GHOST}`,
    body: { isTechEvent: false },
    why: 'rewrite any event through the audited path',
  },
  { method: 'DELETE', path: `/api/admin/events/${GHOST}`, why: 'soft-delete any event out of the public feed' },
  {
    method: 'PATCH',
    path: `/api/admin/sources/${GHOST}`,
    body: { enabled: false },
    why: 'disable a source, silently shrinking the feed',
  },
  {
    method: 'POST',
    path: '/api/admin/sources/bulk',
    body: { ids: [GHOST], enabled: false },
    why: 'disable sources in bulk',
  },
  { method: 'GET', path: '/api/admin/submissions', why: 'read pending submissions awaiting review' },
  {
    method: 'PATCH',
    path: '/api/admin/submissions',
    body: { id: GHOST, action: 'approve' },
    why: 'publish an event to the whole city',
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
  // The cross-folder People list. It renders every contact the signed-in user has ever scanned —
  // names, employers, phone numbers, private "how we met" notes — so "carries nothing private in
  // the signed-out HTML" is the assertion that matters most on this page, not merely that it loads.
  '/people',
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
  /*
   * THE MCP ENDPOINT IS PUBLIC ON PURPOSE, so it belongs in a list rather than in neither.
   *
   * That is the lesson the two `GET /api/sources` rows above record: an endpoint nothing here has
   * an opinion about is not "safe by default", it is unexamined. This one is read-only, serves
   * only data already on public pages, and every one of its query plans pins `techOnly` and the
   * anonymous visibility clause — so a 200 here is the intended contract, and the day somebody
   * adds a session read to `lib/mcp/handlers.ts` this line stops being true.
   */
  { method: 'POST', path: '/api/mcp', body: { jsonrpc: '2.0', id: 1, method: 'tools/list' }, why: 'the MCP server is public and read-only by design' },
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
  /*
   * UNSUBSCRIBE MUST NOT REQUIRE A SESSION. It is opened from a mail client, on a phone, possibly
   * months later, by somebody who may well have signed out — a 401 here means the only way to stop
   * the emails is to sign in, which is the behaviour every anti-spam rule exists to forbid.
   *
   * Both verbs are asserted because they do different jobs and only one of them acts: GET renders a
   * confirmation, POST performs the unsubscribe. That split is deliberate — mail scanners and link
   * prefetchers follow URLs before a human does, so a one-click GET would unsubscribe people who
   * merely RECEIVED the email.
   */
  {
    method: 'GET',
    path: '/api/reminders/unsubscribe?u=diag&t=0&s=not-a-signature',
    expect: 400,
    why: 'an unsubscribe link must open without a session, and reject a forged signature',
  },
  {
    method: 'POST',
    path: '/api/reminders/unsubscribe?u=diag&t=0&s=not-a-signature',
    expect: 400,
    why: 'the acting verb must also refuse a forged signature rather than trusting the query',
  },
  /*
   * The DIGEST opt-out is a second, separate unsubscribe and needs its own assertions — turning off
   * event reminders and turning off the weekly digest are different decisions, and a reader who
   * wanted one silenced must not lose the other. Same public-by-necessity argument as above: it is
   * opened from a mail client, possibly months later, by somebody who may have signed out.
   *
   * The POST case matters more than it looks. RFC 8058 one-click unsubscribe means the MAIL PROVIDER
   * posts this itself, with no human and no session, so a signature check is the only thing standing
   * between a forged link and somebody being silently unsubscribed.
   */
  {
    method: 'GET',
    path: '/api/digest/unsubscribe?u=diag&t=0&s=not-a-signature',
    expect: 400,
    why: 'the digest opt-out is opened from a mail client with no session; GET only confirms',
  },
  {
    method: 'POST',
    path: '/api/digest/unsubscribe?u=diag&t=0&s=not-a-signature',
    expect: 400,
    why: 'RFC 8058 one-click POSTs this itself, so a forged signature must refuse on its own terms',
  },
];

/**
 * Endpoints that must stay PUBLIC while disclosing nothing about the deployment.
 *
 * `GET /api/me/whoami` is deliberately unguarded — it has to work precisely when the session is
 * broken, which is when a guard would refuse it — so "does it 200" is the wrong question and
 * "what is IN the 200" is the right one. It used to answer an anonymous `curl` with `nodeEnv`,
 * `nextAuthUrlHost`, `requestHost` and `adminEmailsConfigured`: none of those derive from the
 * caller, which is the property the route's own header cites to justify being open.
 *
 * `adminEmailsConfigured: false` is the sharpest of them — it tells a stranger that every admin
 * route is currently answering 503, i.e. that the operator has locked themselves out right now.
 *
 * Asserted as ABSENT keys rather than falsy ones: `nodeEnv: null` would still confirm which
 * questions the route can answer.
 */
const MUST_NOT_DISCLOSE: Array<{ path: string; forbidden: string[]; required: string[]; why: string }> = [
  {
    path: '/api/me/whoami',
    forbidden: ['nodeEnv', 'nextAuthUrlSet', 'nextAuthUrlHost', 'requestHost', 'adminEmailsConfigured', 'authError'],
    // The session half must survive the trim, or the route stops doing the job it exists for:
    // telling "looks signed in" apart from "is signed in".
    required: ['sentSessionCookie', 'hasSession', 'hasUserId'],
    why: 'unguarded by design; must diagnose a session without describing the deployment',
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

  console.log('\nPUBLIC BUT MUST NOT DESCRIBE THE DEPLOYMENT\n');
  for (const c of MUST_NOT_DISCLOSE) {
    try {
      const res = await fetch(BASE + c.path, {
        redirect: 'manual',
        signal: AbortSignal.timeout(30000),
      });
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      const leaked = body ? c.forbidden.filter(k => k in body) : [];
      const missing = body ? c.required.filter(k => !(k in body)) : c.required;
      const ok = res.status === 200 && leaked.length === 0 && missing.length === 0;
      if (!ok) failures++;
      console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${res.status}  GET    ${c.path.padEnd(42)} ${c.why}`);
      if (leaked.length) console.log(`         DISCLOSES: ${leaked.join(', ')}`);
      if (missing.length) console.log(`         MISSING the session diagnostic: ${missing.join(', ')}`);
    } catch (err) {
      failures++;
      console.log(`  FAIL  ERR  GET ${c.path} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log('\nPUBLIC TOKEN ENDPOINTS (must run un-authed and refuse a bad token on their own terms)\n');
  for (const c of MUST_BE_PUBLIC_404) {
    try {
      const { status, detail } = await hit(c);
      // 404 means the handler ran and refused on its own terms. A 401/403 would mean it had been
      // gated by a session it must not require; a 500 would mean it crashed on a stranger.
      const expected = c.expect ?? 404;
      const ok = status === expected;
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
