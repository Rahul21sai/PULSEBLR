#!/usr/bin/env tsx
/**
 * End-to-end exercise of the SCAN & CONTACTS feature, signed in, against real endpoints.
 *
 * Google's consent screen cannot load in a localhost-only preview pane, so this signs in
 * through the DEV-ONLY credentials provider (lib/dev-login.ts) and drives the actual HTTP
 * routes — the layer that unit tests deliberately do not cover.
 *
 * The assertions that matter most, and why:
 *
 *   IDEMPOTENCY. Posting the same `clientId` twice must yield ONE contact and a 200, not a 409
 *   and not two rows. The scanner writes to IndexedDB first and posts afterwards, possibly
 *   several times over a saturated conference network; if a replay duplicated people, the
 *   offline queue would be worse than no queue.
 *
 *   CROSS-USER ISOLATION. A second synthetic user must not see, edit, delete or export the
 *   first user's contacts, and must not be able to move a contact into their own folder. The
 *   repo's cautionary tale is the digest, whose two unscoped TrackerEntry queries served every
 *   user's contacts and private notes to anonymous callers.
 *
 *   CSV SAFETY. A contact whose name is a spreadsheet formula must come back neutralised.
 *
 * Requires a dev server with DEV_LOGIN=true. It WRITES folders and contacts, then deletes
 * everything it created, and only ever touches its own synthetic accounts.
 *
 * Run: npx tsx scripts/diag-contact-flow.ts
 */
import './load-env';

const BASE = process.env.PULSEBLR_BASE_URL || 'http://localhost:3000';

const OWNER_EMAIL = (process.env.ADMIN_EMAILS || '').split(',')[0]?.trim() || 'admin@example.com';
const OTHER_EMAIL = 'diag-contact-other@example.invalid';

let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
}

/** Minimal cookie jar: NextAuth needs the csrf cookie echoed back with the POST. */
class Session {
  private jar = new Map<string, string>();
  user: { id?: string; email?: string } | null = null;

  private header(): string {
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  private absorb(res: Response) {
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

  async json(path: string, init: RequestInit = {}): Promise<{ status: number; body: never }> {
    const res = await this.fetch(path, init);
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* empty or non-JSON body */
    }
    return { status: res.status, body: body as never };
  }

  async post(path: string, payload: unknown, method = 'POST') {
    return this.json(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

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
    const session = (await sessionRes.json()) as { user?: { id?: string; email?: string } };
    this.user = session.user ?? null;
    return Boolean(session.user?.id);
  }
}

const STAMP = String(process.pid);
const FOLDER_NAME = `Diag Scan Folder ${STAMP}`;

async function main() {
  console.log(`Scan & contacts flow against ${BASE}\n`);

  /* ── Sign in ──────────────────────────────────────────────────────────── */
  console.log('Sign-in');
  const owner = new Session();
  if (!(await owner.signIn(OWNER_EMAIL))) {
    console.log('  FAIL  dev-login issued no session');
    console.log('\nCannot continue. Is DEV_LOGIN=true and the server restarted?');
    process.exit(1);
  }
  check('dev-login issues a session', true, `id=${owner.user?.id}`);

  let folderId = '';
  const createdContactIds: string[] = [];

  try {
    /* ── Folder ────────────────────────────────────────────────────────── */
    console.log('\nFolders');
    const created = await owner.post('/api/folders', {
      name: FOLDER_NAME,
      eventDate: new Date().toISOString(),
      venue: 'Diag Venue',
    });
    check('POST /api/folders creates one', created.status === 201, `status=${created.status}`);
    folderId = (created.body as unknown as { folder?: { _id?: string } })?.folder?._id ?? '';
    check('and returns its id', Boolean(folderId), folderId);
    if (!folderId) throw new Error('no folder id');

    const duplicate = await owner.post('/api/folders', { name: FOLDER_NAME });
    check(
      'a duplicate name is refused with 409, not silently duplicated',
      duplicate.status === 409,
      `status=${duplicate.status}`
    );

    /* ── Idempotency: the guarantee the offline queue rests on ─────────── */
    console.log('\nContacts — idempotency');
    const clientId = `diag-${STAMP}-1`;
    const payload = {
      clientId,
      folderId,
      name: 'Diag Priya Sharma',
      company: 'IBM',
      // Canonicalisation should turn this into https://www.linkedin.com/in/diag-priya-sharma
      // and derive the slug, which is what makes contactKey `li:` rather than `nm:`.
      linkedin: 'https://www.linkedin.com/in/diag-priya-sharma?fromQR=1',
      note: 'Met at the diag event',
      capturedVia: 'qr-linkedin',
      rawPayload: 'https://www.linkedin.com/in/diag-priya-sharma?fromQR=1',
    };

    const first = await owner.post('/api/contacts', payload);
    check('POST /api/contacts creates one (201)', first.status === 201, `status=${first.status}`);
    const firstContact = (first.body as unknown as { contact?: Record<string, string> })?.contact;
    if (firstContact?._id) createdContactIds.push(firstContact._id);

    check(
      'the LinkedIn URL is canonicalised, query stripped',
      firstContact?.linkedin === 'https://www.linkedin.com/in/diag-priya-sharma',
      firstContact?.linkedin
    );
    check(
      'contactKey prefers the LinkedIn slug',
      firstContact?.contactKey === 'li:diag-priya-sharma',
      firstContact?.contactKey
    );
    check(
      'the raw payload is kept verbatim',
      firstContact?.rawPayload === payload.rawPayload,
      firstContact?.rawPayload
    );

    // THE decisive assertion: a replayed queued scan.
    const replay = await owner.post('/api/contacts', payload);
    check(
      'a replayed clientId answers 200, not 409',
      replay.status === 200,
      `status=${replay.status}`
    );
    const replayContact = (replay.body as unknown as { contact?: { _id?: string }; created?: boolean });
    check('and reports created:false', replayContact?.created === false, String(replayContact?.created));
    check(
      'and returns the SAME document',
      replayContact?.contact?._id === firstContact?._id,
      `${replayContact?.contact?._id} vs ${firstContact?._id}`
    );

    const afterReplay = await owner.json(`/api/contacts?folderId=${folderId}`);
    const list = (afterReplay.body as unknown as { contacts?: unknown[] })?.contacts ?? [];
    check('exactly one contact exists after the replay', list.length === 1, `count=${list.length}`);

    /* ── The outbox drain endpoint ─────────────────────────────────────── */
    console.log('\nOffline sync');
    const syncPayload = {
      folders: [{ clientId: `diag-folder-${STAMP}`, name: `${FOLDER_NAME} offline` }],
      contacts: [
        { clientId: `diag-${STAMP}-2`, folderClientId: `diag-folder-${STAMP}`, name: 'Diag Offline Person' },
        // Deliberately invalid: one bad record must not fail the batch.
        { clientId: `diag-${STAMP}-3`, folderId, name: '' },
        { clientId: `diag-${STAMP}-4`, folderId, name: 'Diag Second Person' },
      ],
    };
    const sync = await owner.post('/api/contacts/sync', syncPayload);
    check('POST /api/contacts/sync succeeds', sync.status === 200, `status=${sync.status}`);
    const syncBody = sync.body as unknown as {
      synced?: number;
      failed?: number;
      folderMap?: Record<string, string>;
      contacts?: Array<{ clientId: string; ok: boolean; id?: string }>;
    };
    check('it resolves an offline folder clientId to a real id', Boolean(syncBody?.folderMap?.[`diag-folder-${STAMP}`]));
    check('two good contacts synced', syncBody?.synced === 2, `synced=${syncBody?.synced}`);
    check('the one bad record failed without failing the batch', syncBody?.failed === 1, `failed=${syncBody?.failed}`);
    for (const item of syncBody?.contacts ?? []) {
      if (item.ok && item.id) createdContactIds.push(item.id);
    }

    // Replaying the whole batch must add nothing.
    const resync = await owner.post('/api/contacts/sync', syncPayload);
    const resyncBody = resync.body as unknown as { contacts?: Array<{ ok: boolean; duplicate?: boolean }> };
    const duplicates = (resyncBody?.contacts ?? []).filter(c => c.ok && c.duplicate).length;
    check('re-draining the same batch reports duplicates rather than creating rows', duplicates === 2, `duplicates=${duplicates}`);

    /* ── contactKey upgrade ─────────────────────────────────────────────── */
    console.log('\nIdentity upgrade');
    const plain = await owner.post('/api/contacts', {
      clientId: `diag-${STAMP}-5`,
      folderId,
      name: 'Diag Nameonly Person',
    });
    const plainContact = (plain.body as unknown as { contact?: Record<string, string> })?.contact;
    if (plainContact?._id) createdContactIds.push(plainContact._id);
    check(
      'a name-only contact keys on nm:',
      plainContact?.contactKey === 'nm:diag nameonly person',
      plainContact?.contactKey
    );

    const upgraded = await owner.post(
      `/api/contacts/${plainContact?._id}`,
      { linkedin: 'linkedin.com/in/diag-nameonly' },
      'PATCH'
    );
    const upgradedContact = (upgraded.body as unknown as { contact?: Record<string, string> })?.contact;
    check(
      'adding a LinkedIn later upgrades the key to li:',
      upgradedContact?.contactKey === 'li:diag-nameonly',
      upgradedContact?.contactKey
    );

    /* ── CSV export ─────────────────────────────────────────────────────── */
    console.log('\nExport');
    const nasty = await owner.post('/api/contacts', {
      clientId: `diag-${STAMP}-6`,
      folderId,
      name: '=HYPERLINK("http://evil.example","x")',
    });
    const nastyContact = (nasty.body as unknown as { contact?: Record<string, string> })?.contact;
    if (nastyContact?._id) createdContactIds.push(nastyContact._id);

    const csvRes = await owner.fetch(`/api/folders/${folderId}/export?format=csv`);
    const csv = await csvRes.text();
    check('CSV export returns 200', csvRes.status === 200, `status=${csvRes.status}`);
    check(
      'and is not cacheable (it is a bulk PII export)',
      (csvRes.headers.get('cache-control') || '').includes('no-store'),
      csvRes.headers.get('cache-control') || 'missing'
    );
    check('and neutralises a formula in a name', csv.includes(`"'=HYPERLINK`), csv.includes("'=") ? 'escaped' : 'NOT escaped');
    check('and contains the contacts', csv.includes('Diag Priya Sharma'));

    const vcfRes = await owner.fetch(`/api/folders/${folderId}/export?format=vcf`);
    const vcf = await vcfRes.text();
    check('vCard export returns a card per contact', vcf.startsWith('BEGIN:VCARD') && vcf.includes('Diag Priya Sharma'));

    /* ── Cross-user isolation ───────────────────────────────────────────── */
    console.log('\nCross-user isolation');
    const other = new Session();
    if (!(await other.signIn(OTHER_EMAIL))) {
      check('second synthetic user can sign in', false);
    } else {
      const theirFolders = await other.json('/api/folders');
      const names = ((theirFolders.body as unknown as { folders?: Array<{ name: string }> })?.folders ?? []).map(f => f.name);
      check("user B's folder list does not contain user A's folder", !names.includes(FOLDER_NAME));

      const theirContacts = await other.json('/api/contacts');
      const contactNames = ((theirContacts.body as unknown as { contacts?: Array<{ name: string }> })?.contacts ?? []).map(c => c.name);
      check("user B sees none of user A's contacts", !contactNames.includes('Diag Priya Sharma'));

      const readFolder = await other.json(`/api/folders/${folderId}`);
      check("reading user A's folder is 404 for user B", readFolder.status === 404, `status=${readFolder.status}`);

      const exportAttempt = await other.fetch(`/api/folders/${folderId}/export?format=csv`);
      check("exporting user A's folder is 404 for user B", exportAttempt.status === 404, `status=${exportAttempt.status}`);

      const editAttempt = await other.post(`/api/contacts/${firstContact?._id}`, { name: 'hijacked' }, 'PATCH');
      check("editing user A's contact is 404 for user B", editAttempt.status === 404, `status=${editAttempt.status}`);

      const deleteAttempt = await other.json(`/api/contacts/${firstContact?._id}`, { method: 'DELETE' });
      check("deleting user A's contact is 404 for user B", deleteAttempt.status === 404, `status=${deleteAttempt.status}`);

      const writeAttempt = await other.post('/api/contacts', {
        clientId: `diag-hijack-${STAMP}`,
        folderId,
        name: 'Injected',
      });
      check("writing into user A's folder is 404 for user B", writeAttempt.status === 404, `status=${writeAttempt.status}`);

      const intakeAttempt = await other.post(`/api/folders/${folderId}/intake`, { action: 'enable' });
      check("minting a public token for user A's folder is 404 for user B", intakeAttempt.status === 404, `status=${intakeAttempt.status}`);

      // Confirm nothing leaked through despite the refusals.
      const stillOne = await owner.json(`/api/folders/${folderId}`);
      const ownerContacts = (stillOne.body as unknown as { contacts?: Array<{ name: string }> })?.contacts ?? [];
      check('user A still has their own contact, unmodified', ownerContacts.some(c => c.name === 'Diag Priya Sharma'));
      check('and nothing was injected into it', !ownerContacts.some(c => c.name === 'Injected'));
    }

    /* ── Public intake ──────────────────────────────────────────────────── */
    console.log('\nPublic sign-up link');
    const intake = await owner.post(`/api/folders/${folderId}/intake`, { action: 'enable' });
    const intakeBody = intake.body as unknown as { url?: string; folder?: { intakeToken?: string } };
    const token = intakeBody?.folder?.intakeToken ?? '';
    check('the owner can mint an intake token', Boolean(token), token ? 'minted' : 'none');
    check(
      'and the URL is built from NEXTAUTH_URL, not the request Host',
      Boolean(intakeBody?.url?.startsWith(process.env.NEXTAUTH_URL?.replace(/\/+$/, '') || 'http://localhost:3000')),
      intakeBody?.url
    );

    if (token) {
      // Anonymous — no cookie jar at all.
      const anon = await fetch(`${BASE}/api/intake/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Diag Walkup Person', company: 'Acme' }),
        signal: AbortSignal.timeout(30000),
      });
      check('an anonymous stranger can add themselves (201)', anon.status === 201, `status=${anon.status}`);
      const anonBody = (await anon.json().catch(() => ({}))) as Record<string, unknown>;
      check(
        'and the response discloses nothing about the folder',
        !('contacts' in anonBody) && !('folder' in anonBody) && !('userId' in anonBody),
        Object.keys(anonBody).join(',')
      );

      const afterIntake = await owner.json(`/api/contacts?folderId=${folderId}`);
      const withWalkup = ((afterIntake.body as unknown as { contacts?: Array<{ name: string; capturedVia: string }> })?.contacts ?? []);
      const walkup = withWalkup.find(c => c.name === 'Diag Walkup Person');
      check('the row lands in the owner’s folder', Boolean(walkup));
      check('tagged capturedVia=card-page', walkup?.capturedVia === 'card-page', walkup?.capturedVia);
      for (const contact of withWalkup) {
        const id = (contact as unknown as { _id?: string })._id;
        if (id && !createdContactIds.includes(id)) createdContactIds.push(id);
      }

      const disabled = await owner.post(`/api/folders/${folderId}/intake`, { action: 'disable' });
      check('the owner can switch the link off', disabled.status === 200, `status=${disabled.status}`);
      const afterDisable = await fetch(`${BASE}/api/intake/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Should Not Land' }),
        signal: AbortSignal.timeout(30000),
      });
      check('and a disabled token is refused (404)', afterDisable.status === 404, `status=${afterDisable.status}`);
    }
  } finally {
    /* ── Clean up everything this script created ────────────────────────── */
    console.log('\nCleanup');
    if (folderId) {
      // Deleting the folder cascades its contacts, which is also worth asserting.
      const removed = await owner.json(`/api/folders/${folderId}`, { method: 'DELETE' });
      check('deleting the folder succeeds', removed.status === 200, `status=${removed.status}`);
      const cascade = (removed.body as unknown as { contactsDeleted?: number })?.contactsDeleted ?? 0;
      check('and cascades its contacts', cascade > 0, `deleted=${cascade}`);

      const gone = await owner.json(`/api/contacts?folderId=${folderId}`);
      const left = ((gone.body as unknown as { contacts?: unknown[] })?.contacts ?? []).length;
      check('no contacts remain for that folder', left === 0, `left=${left}`);
    }

    // The offline-created folder is separate and needs its own removal.
    const remaining = await owner.json('/api/folders');
    for (const folder of ((remaining.body as unknown as { folders?: Array<{ _id: string; name: string }> })?.folders ?? [])) {
      if (folder.name.startsWith('Diag Scan Folder')) {
        await owner.json(`/api/folders/${folder._id}`, { method: 'DELETE' });
      }
    }
  }

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
