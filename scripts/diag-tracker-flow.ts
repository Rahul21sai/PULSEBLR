#!/usr/bin/env tsx
/**
 * End-to-end exercise of the TRACKER — the half of the product that had never run.
 *
 * Google's consent screen cannot load in a localhost-only preview pane, so every
 * tracker path below the API layer was unproven: create an entry, move it between
 * statuses, record a person met, set and complete a follow-up, and the per-user
 * isolation that keeps one user's contacts away from another's. This signs in through
 * the DEV-ONLY credentials provider (lib/dev-login.ts) and drives the real endpoints.
 *
 * It also asserts that BAD input is a 400 which names the field and leaks no Mongoose
 * wording. That belongs here rather than in diag-api-auth.ts, whose scope is refusals for
 * UNAUTHENTICATED callers — these are refusals for an authenticated caller sending nonsense,
 * which needs a real session to reach the validation layer at all. The validator itself is
 * pinned by tests/tracker-validation.test.ts; what only a live server can prove is the
 * STATUS CODE, and the status code was the bug.
 *
 * Requires a dev server with DEV_LOGIN=true. It WRITES tracker data, then deletes
 * everything it created — and it only ever touches its own synthetic accounts, never a
 * real user's rows.
 *
 * NOTE ON RUNNING IT FROM A WORKTREE: DEV_LOGIN is gated on NODE_ENV !== 'production'
 * (lib/dev-login.ts), so `next start` cannot sign in and this must run against `npm run dev`.
 * A worktree also needs its own node_modules — Turbopack refuses to follow a junction out of
 * its filesystem root, so either `npm ci` (never `npm install`, which rewrites the version
 * pins) or `next dev --webpack`, which resolves upward and needs no install.
 *
 * Run: npx tsx scripts/diag-tracker-flow.ts
 */
import './load-env';

const BASE = process.env.PULSEBLR_BASE_URL || 'http://localhost:3000';

/** Two synthetic users: one admin (per ADMIN_EMAILS), one plain, to prove isolation. */
const ADMIN_EMAIL = (process.env.ADMIN_EMAILS || '').split(',')[0]?.trim() || 'admin@example.com';
const OTHER_EMAIL = 'diag-other-user@example.invalid';

let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
}

/** Minimal cookie jar: NextAuth needs the csrf cookie echoed back with the POST. */
class Session {
  private jar = new Map<string, string>();

  private header(): string {
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  private absorb(res: Response) {
    // getSetCookie keeps multiple Set-Cookie headers separate, which a plain get() merges.
    const raw = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
    for (const line of raw) {
      const [pair] = line.split(';');
      const idx = pair.indexOf('=');
      if (idx > 0) this.jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
  }

  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(BASE + path, {
      ...init,
      headers: {
        ...(init.headers || {}),
        ...(this.jar.size ? { Cookie: this.header() } : {}),
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(45000),
    });
    this.absorb(res);
    return res;
  }

  /** Sign in via the dev-only credentials provider. */
  async signIn(email: string): Promise<boolean> {
    const csrfRes = await this.fetch('/api/auth/csrf');
    const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };

    const body = new URLSearchParams({ email, csrfToken, callbackUrl: BASE, json: 'true' });
    await this.fetch('/api/auth/callback/dev-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    const sessionRes = await this.fetch('/api/auth/session');
    const session = (await sessionRes.json()) as { user?: { id?: string; email?: string; isAdmin?: boolean } };
    this.user = session.user ?? null;
    return !!session.user?.id;
  }

  user: { id?: string; email?: string; isAdmin?: boolean } | null = null;
}

async function main() {
  console.log(`Tracker flow against ${BASE}\n`);

  // ── Sign in ────────────────────────────────────────────────────────────────
  console.log('Sign-in');
  const admin = new Session();
  const ok = await admin.signIn(ADMIN_EMAIL);
  check('dev-login issues a session', ok, admin.user ? `id=${admin.user.id}` : 'no session');
  if (!ok) {
    console.log('\nCannot continue without a session. Is DEV_LOGIN=true and the server restarted?');
    process.exit(1);
  }
  check('session carries the email', admin.user?.email === ADMIN_EMAIL.toLowerCase(), String(admin.user?.email));
  check('admin is recognised as admin', admin.user?.isAdmin === true, `isAdmin=${admin.user?.isAdmin}`);

  // ── Admin-gated route now works for an admin ───────────────────────────────
  console.log('\nAdmin access with a real session');
  const statsRes = await admin.fetch('/api/admin/stats');
  check('GET /api/admin/stats returns 200 for an admin', statsRes.status === 200, `HTTP ${statsRes.status}`);

  // ── Pick a real event to track ─────────────────────────────────────────────
  const feed = await (await admin.fetch('/api/events?techOnly=true&limit=1')).json();
  const event = feed.events?.[0];
  check('found an event to track', !!event, event ? event.title.slice(0, 40) : 'feed empty');
  if (!event) process.exit(1);

  // ── Create ─────────────────────────────────────────────────────────────────
  console.log('\nTracker: create');
  const createRes = await admin.fetch('/api/tracker', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ eventId: event._id, status: 'Interested' }),
  });
  const created = await createRes.json().catch(() => ({}));
  // The route returns the document at the TOP LEVEL, not wrapped in { entry }.
  let entryId: string | undefined = created?._id ?? created?.entry?._id;

  if (createRes.status === 409) {
    // A previous run of this script left the entry behind (it exits early on failure).
    // Reuse it rather than reporting a false failure — the 409 itself proves the
    // compound-unique index is doing its job.
    const existing = await (await admin.fetch('/api/tracker')).json();
    entryId = (existing.entries || []).find(
      (e: { eventId?: { _id?: string } | string }) =>
        (typeof e.eventId === 'string' ? e.eventId : e.eventId?._id) === event._id
    )?._id;
    check('reusing the entry left by an earlier run', !!entryId, `HTTP 409, id=${entryId}`);
  } else {
    check('POST /api/tracker creates an entry', createRes.status === 201 && !!entryId, `HTTP ${createRes.status}`);
    if (!entryId) console.log('   body:', JSON.stringify(created).slice(0, 200));
  }

  // The compound-unique {userId, eventId} index should reject a second entry.
  const dupeRes = await admin.fetch('/api/tracker', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ eventId: event._id, status: 'Interested' }),
  });
  check(
    'tracking the same event twice is refused',
    dupeRes.status >= 400,
    `HTTP ${dupeRes.status} (compound-unique {userId, eventId})`
  );

  if (entryId) {
    // ── Move between statuses — what the kanban drag does ────────────────────
    console.log('\nTracker: status changes (what a kanban drag calls)');
    for (const status of ['Confirmed', 'Attended']) {
      const res = await admin.fetch(`/api/tracker/${entryId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      check(`PUT status -> ${status}`, res.status < 300, `HTTP ${res.status}`);
    }

    // ── Bad input is the CALLER's fault, and must not leak the schema ─────────
    // Both write paths used to hand the raw body to Mongoose — POST via
    // `TrackerEntry.create()`, PUT via `{ $set: body }` with `runValidators: true` — so a
    // bad `status` became a ValidationError, fell through to the catch-all and was
    // reported as 500 with `details: err.message`:
    //
    //   TrackerEntry validation failed: status: `Foo` is not a valid enum value for path `status`.
    //
    // Two defects: a client error reported as a server fault, and the model name plus the
    // schema path echoed to the caller. The unit suite pins the validator
    // (tests/tracker-validation.test.ts); these checks pin the STATUS CODES, which is the
    // half a pure function cannot prove. Every request below writes nothing.
    console.log('\nTracker: bad input is rejected with 400, not 500');

    /** Assert a rejection is a 400 and that its body names the field without leaking. */
    async function checkRejection(label: string, res: Response, mustName: string[]) {
      const raw = await res.text();
      check(`${label} → 400`, res.status === 400, `HTTP ${res.status}`);
      const named = mustName.filter(s => raw.includes(s));
      check(
        `${label} names ${mustName.join(', ')}`,
        named.length === mustName.length,
        `body: ${raw.slice(0, 120)}`
      );
      // The exact phrases a Mongoose ValidationError / CastError message is built from.
      const leaks = ['validation failed', 'is not a valid enum value', 'for path', 'Cast to']
        .filter(p => raw.toLowerCase().includes(p.toLowerCase()));
      check(`${label} leaks no Mongoose wording`, leaks.length === 0, leaks.join(', ') || 'clean');
    }

    await checkRejection(
      'POST with an invalid status',
      await admin.fetch('/api/tracker', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId: event._id, status: 'Ghosted' }),
      }),
      ['status', 'Interested', 'Rejected']
    );

    await checkRejection(
      'PUT with an invalid status (a stale kanban column id)',
      await admin.fetch(`/api/tracker/${entryId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'Ghosted' }),
      }),
      ['status', 'Interested', 'Rejected']
    );

    // Capitalisation matters, so a lowercase client is the likeliest real typo.
    await checkRejection(
      'PUT with a lowercase status',
      await admin.fetch(`/api/tracker/${entryId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'interested' }),
      }),
      ['status']
    );

    // A malformed id used to reach Event.findById() and throw a CastError — also a 500.
    await checkRejection(
      'POST with a malformed eventId',
      await admin.fetch('/api/tracker', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId: 'not-an-id', status: 'New' }),
      }),
      ['eventId']
    );

    // `ConnectionSchema.name` is required, so this was a 500 as well. The index must be
    // named: the edit modal sends the whole array, so "a name is required" alone does not
    // say which person is missing one.
    await checkRejection(
      'PUT with a nameless connection',
      await admin.fetch(`/api/tracker/${entryId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connections: [{ name: 'Fine' }, { role: 'SRE' }] }),
      }),
      ['connections[1].name']
    );

    // request.json() throws on a malformed body: the same 500-for-a-client-error, one layer up.
    await checkRejection(
      'POST with a body that is not JSON',
      await admin.fetch('/api/tracker', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"eventId": ',
      }),
      ['JSON']
    );

    // A rejected write must leave the entry untouched — the 400s above ran against the
    // real entry, so this proves none of them was a partial update.
    const afterRejects = await (await admin.fetch('/api/tracker')).json();
    const stillThere = (afterRejects.entries || []).find((e: { _id: string }) => e._id === entryId);
    check(
      'the rejected writes changed nothing',
      stillThere?.status === 'Attended',
      `status=${stillThere?.status} (expected the last VALID PUT to have won)`
    );

    // ── Record a person met, with a follow-up ───────────────────────────────
    console.log('\nTracker: record a person met');
    // getPendingFollowUps filters `followUpAt <= now`: it lists follow-ups that are
    // DUE, not upcoming, so a future date is correctly invisible to it and the fixture
    // is backdated. Worth knowing: the email digest uses the OPPOSITE window
    // (now .. +3 days), so the two surfaces disagree on what a follow-up is.
    const followUpAt = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const connRes = await admin.fetch(`/api/tracker/${entryId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        notes: 'Talked about Iceberg compaction.',
        connections: [
          {
            name: 'Diag Test Person',
            role: 'Staff Engineer',
            company: 'ClickHouse',
            context: 'Met at the table by the door',
            followUpAt,
          },
        ],
      }),
    });
    check('PUT saves a connection with a follow-up', connRes.status < 300, `HTTP ${connRes.status}`);

    const readBack = await (await admin.fetch('/api/tracker')).json();
    const mine = (readBack.entries || []).find((e: { _id: string }) => e._id === entryId);
    const conn = mine?.connections?.[0];
    check('the connection reads back', !!conn, conn ? `${conn.name} @ ${conn.company}` : 'missing');
    check('context is persisted', conn?.context === 'Met at the table by the door', String(conn?.context));
    check('notes are persisted', mine?.notes === 'Talked about Iceberg compaction.', String(mine?.notes));
    check('followUpAt is persisted', !!conn?.followUpAt, String(conn?.followUpAt));

    // ── The follow-up must actually surface, then be completable ────────────
    console.log('\nCareer intelligence: follow-ups');
    const pending = await (await admin.fetch('/api/phase6/follow-ups')).json();
    const list = pending.followUps || [];
    check(
      'the follow-up appears as pending',
      Array.isArray(list) && list.length > 0,
      `${Array.isArray(list) ? list.length : 0} pending`
    );

    const complete = await admin.fetch('/api/phase6/follow-ups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trackerEntryId: entryId, connectionName: 'Diag Test Person' }),
    });
    check('POST marks the follow-up done', complete.status < 300, `HTTP ${complete.status}`);

    const after = await (await admin.fetch('/api/phase6/follow-ups')).json();
    const afterList = after.followUps || [];
    check(
      'it no longer appears as pending',
      !(afterList as Array<{ connectionName?: string }>).some(
        f => JSON.stringify(f).includes('Diag Test Person')
      ),
      `${Array.isArray(afterList) ? afterList.length : 0} pending after`
    );

    // ── followedUp via the tracker PUT ──────────────────────────────────────
    // Two different surfaces complete a follow-up and they use DIFFERENT endpoints: the
    // strip on /tracker posts to /api/phase6/follow-ups (asserted above), while the edit
    // modal's per-person "Mark done" toggle saves `followedUp` with the rest of the
    // connection through PUT /api/tracker/[id]. That second path was untested, and before
    // the modal was rebuilt it did not exist at all — `followedUp` had exactly one writer
    // in the whole repo.
    console.log('\nTracker: followedUp via PUT (the edit modal path)');
    const putRes = await admin.fetch(`/api/tracker/${entryId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        connections: [
          {
            name: 'Diag Test Person',
            role: 'Staff Engineer',
            company: 'ClickHouse',
            context: 'Met at the table by the door',
            followUpAt,
            followedUp: true,
          },
        ],
      }),
    });
    check('PUT accepts followedUp on a connection', putRes.status < 300, `HTTP ${putRes.status}`);

    const afterPut = await (await admin.fetch('/api/tracker')).json();
    const putEntry = (afterPut.entries || []).find((e: { _id: string }) => e._id === entryId);
    check(
      'followedUp persists through the tracker PUT',
      putEntry?.connections?.[0]?.followedUp === true,
      `followedUp=${putEntry?.connections?.[0]?.followedUp}`
    );

    const stillPending = await (await admin.fetch('/api/phase6/follow-ups')).json();
    check(
      'a PUT-completed follow-up drops out of the pending list too',
      !JSON.stringify(stillPending.followUps || []).includes('Diag Test Person'),
      'both surfaces agree on what is done'
    );

    // ── Per-user isolation: the whole point of userId scoping ───────────────
    console.log('\nPer-user isolation');
    const other = new Session();
    const otherOk = await other.signIn(OTHER_EMAIL);
    check('a second user can sign in', otherOk, String(other.user?.email));
    check('the second user is NOT admin', other.user?.isAdmin !== true, `isAdmin=${other.user?.isAdmin}`);

    if (otherOk) {
      const theirTracker = await (await other.fetch('/api/tracker')).json();
      const leaked = (theirTracker.entries || []).some((e: { _id: string }) => e._id === entryId);
      check("user B cannot see user A's tracker entry", !leaked, leaked ? 'LEAKED' : 'isolated');

      const steal = await other.fetch(`/api/tracker/${entryId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'Rejected' }),
      });
      check(
        "user B cannot modify user A's entry",
        steal.status === 403 || steal.status === 404,
        `HTTP ${steal.status}`
      );

      const adminProbe = await other.fetch('/api/admin/stats');
      check('a non-admin gets 403 from /api/admin/stats', adminProbe.status === 403, `HTTP ${adminProbe.status}`);

      const digest = await (await other.fetch('/api/notifications/send-digest')).json().catch(() => ({}));
      const digestBlob = JSON.stringify(digest);
      check(
        "user B's digest contains none of user A's data",
        !digestBlob.includes('Diag Test Person'),
        digestBlob.includes('Diag Test Person') ? 'LEAKED into digest' : 'scoped'
      );
    }

    // ── Clean up ───────────────────────────────────────────────────────────
    console.log('\nCleanup');
    const del = await admin.fetch(`/api/tracker/${entryId}`, { method: 'DELETE' });
    check('DELETE removes the entry', del.status < 300, `HTTP ${del.status}`);
  }

  console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
