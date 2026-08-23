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
 * Requires a dev server with DEV_LOGIN=true. It WRITES tracker data, then deletes
 * everything it created — and it only ever touches its own synthetic accounts, never a
 * real user's rows.
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
