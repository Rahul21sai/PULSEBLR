import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_FOLLOWUP_NUDGES_PER_RUN,
  followUpCandidates,
  followUpLandingPath,
  followUpNudgesEnabled,
  followUpNudgeTopic,
  formatFollowUpNudgePayload,
  parseNudgePreferenceBody,
  planFollowUpNudges,
  type FollowUpNudge,
  type NudgeContactRow,
  type NudgeEventRow,
  type NudgeFolderRow,
} from '@/lib/notifications/followup-nudge-policy';
import {
  buildFollowUpLanding,
  safeEmail,
  safeLinkedinUrl,
  toFollowUpContactView,
} from '@/lib/notifications/followup-landing';
import {
  DEFAULT_MAX_PUSHES_PER_DAY,
  FOLLOWUP_NUDGE_KIND,
  formatPushPayload,
  PUSH_CHANNEL_KINDS,
  PUSH_PAYLOAD_MAX_BYTES,
  PUSH_REMINDER_KIND,
  REMINDER_KIND,
} from '@/lib/notifications/reminder-policy';

/**
 * The morning-after follow-up nudge — who gets nudged, for which event, with what count.
 *
 * AS IN `tests/push-policy.test.ts`, THE REFUSALS ARE THE HALF THAT MATTERS. A missed nudge is a
 * follow-up the user might have sent anyway; a wrong one is a lock-screen notification about an event
 * that is not over, or not theirs, or has nobody left to message — and a notification the reader
 * learns to swipe away is a permission they will revoke.
 *
 * THE CLOCK. `NOW` is 09:00 IST on 28 Sept 2026, which is 03:30 UTC — the cron's own slot. Several
 * fixtures sit either side of IST midnight precisely because a UTC day boundary would get them wrong.
 */

const NOW = new Date('2026-09-28T03:30:00.000Z'); // 09:00 IST, 28 Sep
const ME = 'google-sub-me';
const THEM = 'google-sub-them';

const EVENT_GIDS = '6a0000000000000000000001';
const EVENT_OTHER = '6a0000000000000000000002';
const F1 = 'f10000000000000000000001';
const F2 = 'f10000000000000000000002';
const F3 = 'f10000000000000000000003';

/** IST wall-clock → instant. */
const ist = (local: string) => new Date(`${local}+05:30`);

function folder(overrides: Partial<NudgeFolderRow> & { id: string }): NudgeFolderRow {
  return {
    userId: ME,
    name: 'GIDS 2026',
    eventId: null,
    eventDate: null,
    archivedAt: null,
    createdAt: ist('2026-09-20T10:00:00'),
    ...overrides,
  };
}

function contacts(folderId: string, pending: number, done = 0, userId = ME): NudgeContactRow[] {
  return [
    ...Array.from({ length: pending }, () => ({ userId, folderId, followedUp: false })),
    ...Array.from({ length: done }, () => ({ userId, folderId, followedUp: true })),
  ];
}

function candidates(input: {
  folders: NudgeFolderRow[];
  events?: NudgeEventRow[];
  contacts?: NudgeContactRow[];
  now?: Date;
}) {
  return followUpCandidates({
    userId: ME,
    now: input.now ?? NOW,
    folders: input.folders,
    events: input.events ?? [],
    contacts: input.contacts ?? [],
  });
}

const GIDS_ENDED_YESTERDAY: NudgeEventRow = {
  id: EVENT_GIDS,
  startDateTime: ist('2026-09-27T09:00:00'),
  endDateTime: ist('2026-09-27T21:00:00'),
};

/* ── Who qualifies ────────────────────────────────────────────────────────────────────────── */

describe('followUpCandidates — the positive cases, which pin the design decisions', () => {
  it('nudges a folder linked to an event that ENDED yesterday, counting only people still to do', () => {
    const out = candidates({
      folders: [folder({ id: F1, eventId: EVENT_GIDS, eventDate: GIDS_ENDED_YESTERDAY.startDateTime })],
      events: [GIDS_ENDED_YESTERDAY],
      contacts: contacts(F1, 3, 1),
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      subjectId: EVENT_GIDS,
      eventId: EVENT_GIDS,
      folderId: F1,
      title: 'GIDS 2026',
      metCount: 4,
      pendingCount: 3,
      endedDayKey: '2026-09-27',
    });
  });

  it('DECISION: counts a HAND-MADE folder (no eventId) dated yesterday, keyed on the folder id', () => {
    // CLAUDE.md §9: hand-made folders carry eventId null, and /folders dates a new one at noon IST
    // today. Excluding them would leave the nudge for the minority the tracker created.
    const out = candidates({
      folders: [folder({ id: F2, name: 'api days', eventDate: ist('2026-09-27T12:00:00') })],
      contacts: contacts(F2, 2),
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ subjectId: F2, eventId: null, folderId: F2, title: 'api days' });
  });

  it('dates a multi-day event by its END, not its start', () => {
    const conf: NudgeEventRow = {
      id: EVENT_GIDS,
      startDateTime: ist('2026-09-25T09:00:00'),
      endDateTime: ist('2026-09-27T18:00:00'),
    };
    // The folder is dated the START (ensureFolderForEvent copies startDateTime) — three days ago.
    const out = candidates({
      folders: [folder({ id: F1, eventId: EVENT_GIDS, eventDate: conf.startDateTime })],
      events: [conf],
      contacts: contacts(F1, 1),
    });
    expect(out.map(c => c.subjectId)).toEqual([EVENT_GIDS]);
  });

  it('falls back to the start when an event has no end', () => {
    const out = candidates({
      folders: [folder({ id: F1, eventId: EVENT_GIDS })],
      events: [{ id: EVENT_GIDS, startDateTime: ist('2026-09-27T19:00:00') }],
      contacts: contacts(F1, 1),
    });
    expect(out).toHaveLength(1);
  });

  it('falls back to the folder date when the linked event no longer exists', () => {
    const out = candidates({
      folders: [folder({ id: F1, eventId: EVENT_GIDS, eventDate: ist('2026-09-27T19:00:00') })],
      events: [], // pruned
      contacts: contacts(F1, 1),
    });
    expect(out.map(c => c.subjectId)).toEqual([EVENT_GIDS]);
  });

  it('ONCE PER EVENT: two folders linked to one event are one nudge, counts summed, landing on the fuller one', () => {
    const out = candidates({
      folders: [
        folder({ id: F1, eventId: EVENT_GIDS, createdAt: ist('2026-09-26T10:00:00') }),
        folder({ id: F2, eventId: EVENT_GIDS, name: 'GIDS day 2', createdAt: ist('2026-09-27T10:00:00') }),
      ],
      events: [GIDS_ENDED_YESTERDAY],
      contacts: [...contacts(F1, 1), ...contacts(F2, 3, 1)],
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ metCount: 5, pendingCount: 4, folderId: F2, title: 'GIDS day 2' });
    expect(out[0].folderIds).toEqual([F1, F2]);
  });

  it('orders by people still to follow up, so a cap keeps the fullest evening', () => {
    const out = candidates({
      folders: [
        folder({ id: F1, name: 'small', eventDate: ist('2026-09-27T12:00:00') }),
        folder({ id: F2, name: 'big', eventDate: ist('2026-09-27T12:00:00') }),
      ],
      contacts: [...contacts(F1, 1), ...contacts(F2, 5)],
    });
    expect(out.map(c => c.title)).toEqual(['big', 'small']);
  });
});

describe('followUpCandidates — the negatives', () => {
  it('refuses an event that ended TODAY (still premature)', () => {
    const out = candidates({
      folders: [folder({ id: F1, eventId: EVENT_GIDS })],
      events: [{ id: EVENT_GIDS, startDateTime: ist('2026-09-28T07:00:00'), endDateTime: ist('2026-09-28T08:30:00') }],
      contacts: contacts(F1, 2),
    });
    expect(out).toEqual([]);
  });

  it('refuses an event that ended TWO days ago (stale, and already had its morning)', () => {
    const out = candidates({
      folders: [folder({ id: F1, eventDate: ist('2026-09-26T12:00:00') })],
      contacts: contacts(F1, 2),
    });
    expect(out).toEqual([]);
  });

  it('refuses a multi-day event that started yesterday and has not ended', () => {
    const out = candidates({
      folders: [folder({ id: F1, eventId: EVENT_GIDS, eventDate: ist('2026-09-27T09:00:00') })],
      events: [{ id: EVENT_GIDS, startDateTime: ist('2026-09-27T09:00:00'), endDateTime: ist('2026-09-29T18:00:00') }],
      contacts: contacts(F1, 2),
    });
    expect(out).toEqual([]);
  });

  it('uses the IST day, not the UTC one, on both sides of midnight', () => {
    const at = (instant: string) =>
      candidates({ folders: [folder({ id: F1, eventDate: new Date(instant) })], contacts: contacts(F1, 1) });
    // 00:15 IST on the 28th is 18:45Z on the 27th — UTC calls it yesterday, IST calls it TODAY.
    expect(at('2026-09-27T18:45:00.000Z')).toEqual([]);
    // 23:59 IST on the 26th is 18:29Z on the 26th — two days ago in IST.
    expect(at('2026-09-26T18:29:00.000Z')).toEqual([]);
    // 00:01 IST on the 27th is 18:31Z on the 26th — UTC says two days ago, IST says YESTERDAY.
    expect(at('2026-09-26T18:31:00.000Z')).toHaveLength(1);
  });

  it('refuses when every contact is already followed up', () => {
    const out = candidates({
      folders: [folder({ id: F1, eventId: EVENT_GIDS })],
      events: [GIDS_ENDED_YESTERDAY],
      contacts: contacts(F1, 0, 3),
    });
    expect(out).toEqual([]);
  });

  it('refuses a folder with ZERO contacts — Attended/Confirmed alone has nothing to follow up', () => {
    // Exactly what ensureFolderForEvent() creates when a tracker card moves to Confirmed.
    const out = candidates({
      folders: [folder({ id: F1, eventId: EVENT_GIDS })],
      events: [GIDS_ENDED_YESTERDAY],
      contacts: [],
    });
    expect(out).toEqual([]);
  });

  it("refuses someone else's folder, even when contact rows claim to be mine", () => {
    // The contacts are MINE on purpose: this pins the FOLDER ownership check on its own. With only
    // their contacts in it the contact filter alone would refuse it, and a missing folder check
    // would go unnoticed.
    const out = candidates({
      folders: [folder({ id: F1, userId: THEM, eventDate: ist('2026-09-27T12:00:00') })],
      contacts: [...contacts(F1, 4, 0, THEM), ...contacts(F1, 2, 0, ME)],
    });
    expect(out).toEqual([]);
  });

  it("does not count another user's contacts that point at my folder id", () => {
    const out = candidates({
      folders: [folder({ id: F1, eventDate: ist('2026-09-27T12:00:00') })],
      contacts: contacts(F1, 4, 0, THEM),
    });
    expect(out).toEqual([]);
  });

  it('refuses a folder with no eventId AND no date — an undated folder is never "yesterday"', () => {
    const out = candidates({ folders: [folder({ id: F1 })], contacts: contacts(F1, 2) });
    expect(out).toEqual([]);
  });

  it('refuses a hand-made folder (no eventId) dated any day but yesterday', () => {
    const out = candidates({
      folders: [folder({ id: F1, eventDate: ist('2026-09-21T12:00:00') })],
      contacts: contacts(F1, 2),
    });
    expect(out).toEqual([]);
  });

  it('refuses an archived folder', () => {
    const out = candidates({
      folders: [folder({ id: F1, eventDate: ist('2026-09-27T12:00:00'), archivedAt: ist('2026-09-27T23:00:00') })],
      contacts: contacts(F1, 2),
    });
    expect(out).toEqual([]);
  });

  it('refuses unparseable dates rather than guessing', () => {
    const out = candidates({
      folders: [folder({ id: F1, eventId: EVENT_GIDS, eventDate: 'not a date' })],
      events: [{ id: EVENT_GIDS, startDateTime: 'nope', endDateTime: 'nope' }],
      contacts: contacts(F1, 2),
    });
    expect(out).toEqual([]);
  });
});

/* ── The whole decision ───────────────────────────────────────────────────────────────────── */

function plan(overrides: Partial<Parameters<typeof planFollowUpNudges>[0]> = {}) {
  return planFollowUpNudges({
    userId: ME,
    now: NOW,
    hasSubscription: true,
    preference: {},
    folders: [folder({ id: F1, eventId: EVENT_GIDS })],
    events: [GIDS_ENDED_YESTERDAY],
    contacts: contacts(F1, 4),
    claimedSubjectIds: [],
    pushesSentToday: 0,
    ...overrides,
  });
}

describe('planFollowUpNudges', () => {
  it('sends one nudge for the event, with the count', () => {
    const out = plan();
    expect(out.outcome).toBe('send');
    expect(out.send).toHaveLength(1);
    expect(out.send[0]).toMatchObject({ subjectId: EVENT_GIDS, pendingCount: 4 });
  });

  it('push disabled: no subscription means nobody is considered at all', () => {
    const out = plan({ hasSubscription: false });
    expect(out.outcome).toBe('no-subscription');
    expect(out.send).toEqual([]);
    expect(out.candidates).toEqual([]);
  });

  it('opted out: an explicit false on the account switch stops it', () => {
    const out = plan({ preference: { pushFollowUpNudges: false } });
    expect(out.outcome).toBe('opted-out');
    expect(out.send).toEqual([]);
  });

  it('DECISION: default ON for somebody who enabled push and never touched the switch', () => {
    expect(plan({ preference: {} }).outcome).toBe('send');
    expect(plan({ preference: null }).outcome).toBe('send');
    expect(plan({ preference: { pushFollowUpNudges: null } }).outcome).toBe('send');
    expect(followUpNudgesEnabled({ pushFollowUpNudges: true })).toBe(true);
    expect(followUpNudgesEnabled({ pushFollowUpNudges: false })).toBe(false);
  });

  it('an already-claimed log row sends nothing — a re-run or a retry is a no-op', () => {
    const out = plan({ claimedSubjectIds: [EVENT_GIDS] });
    expect(out.outcome).toBe('already-sent');
    expect(out.send).toEqual([]);
    expect(out.alreadyClaimed).toBe(1);
  });

  it('a claim for a DIFFERENT subject does not suppress this one', () => {
    expect(plan({ claimedSubjectIds: [EVENT_OTHER] }).outcome).toBe('send');
  });

  it('the hand-made folder is claimed under its folder id', () => {
    const out = plan({
      folders: [folder({ id: F3, eventDate: ist('2026-09-27T12:00:00') })],
      events: [],
      contacts: contacts(F3, 1),
      claimedSubjectIds: [F3],
    });
    expect(out.outcome).toBe('already-sent');
  });

  it('nothing ended yesterday → nothing-due', () => {
    expect(plan({ events: [{ ...GIDS_ENDED_YESTERDAY, endDateTime: ist('2026-09-28T08:00:00') }] }).outcome).toBe(
      'nothing-due'
    );
  });

  it('shares the PHONE budget: a day already at the cap sends nothing', () => {
    const out = plan({ pushesSentToday: DEFAULT_MAX_PUSHES_PER_DAY });
    expect(out.outcome).toBe('daily-cap');
    expect(out.deferred).toHaveLength(1);
  });

  it('clamps to what is left of the day, and to its own per-run cap', () => {
    const three = {
      folders: [
        folder({ id: F1, name: 'a', eventDate: ist('2026-09-27T12:00:00') }),
        folder({ id: F2, name: 'b', eventDate: ist('2026-09-27T12:00:00') }),
        folder({ id: F3, name: 'c', eventDate: ist('2026-09-27T12:00:00') }),
      ],
      events: [],
      contacts: [...contacts(F1, 3), ...contacts(F2, 2), ...contacts(F3, 1)],
    };
    const fresh = plan(three);
    expect(fresh.send.map(n => n.title)).toEqual(['a', 'b']);
    expect(fresh.send).toHaveLength(DEFAULT_MAX_FOLLOWUP_NUDGES_PER_RUN);
    expect(fresh.deferred.map(n => n.title)).toEqual(['c']);

    // Two reminders already went out this morning: one slot of three is left.
    const busy = plan({ ...three, pushesSentToday: 2 });
    expect(busy.send.map(n => n.title)).toEqual(['a']);
  });
});

/* ── The kinds ────────────────────────────────────────────────────────────────────────────── */

describe('FOLLOWUP_NUDGE_KIND and the shared phone budget', () => {
  it('is its own at-most-once guarantee, distinct from both reminder kinds', () => {
    expect(FOLLOWUP_NUDGE_KIND).not.toBe(REMINDER_KIND);
    expect(FOLLOWUP_NUDGE_KIND).not.toBe(PUSH_REMINDER_KIND);
  });

  it('counts every push kind together and the EMAIL kind never', () => {
    expect([...PUSH_CHANNEL_KINDS].sort()).toEqual([FOLLOWUP_NUDGE_KIND, PUSH_REMINDER_KIND].sort());
    expect(PUSH_CHANNEL_KINDS).not.toContain(REMINDER_KIND);
  });
});

/* ── The notification ─────────────────────────────────────────────────────────────────────── */

const NUDGE: FollowUpNudge = {
  subjectId: EVENT_GIDS,
  eventId: EVENT_GIDS,
  folderId: F1,
  folderIds: [F1],
  title: 'GIDS 2026',
  metCount: 4,
  pendingCount: 4,
  endedDayKey: '2026-09-27',
  endedAt: ist('2026-09-27T21:00:00'),
};

describe('formatFollowUpNudgePayload', () => {
  it('says who and how many, and nothing else', () => {
    const payload = formatFollowUpNudgePayload(NUDGE);
    expect(Object.keys(payload).sort()).toEqual(['body', 'tag', 'title', 'url']);
    expect(payload.title).toBe('You met 4 people at GIDS 2026');
    expect(payload.body).toContain('Draft follow-ups');
  });

  it('says how many are left when some are already done, and is singular for one', () => {
    expect(formatFollowUpNudgePayload({ ...NUDGE, metCount: 5, pendingCount: 2 }).body).toMatch(/^2 still to follow up/);
    expect(formatFollowUpNudgePayload({ ...NUDGE, metCount: 1, pendingCount: 1 }).title).toBe(
      'You met 1 person at GIDS 2026'
    );
  });

  it('opens a PATH carrying only the folder id — the server re-authorises it', () => {
    const payload = formatFollowUpNudgePayload(NUDGE);
    expect(payload.url).toBe(`/follow-ups/${F1}`);
    expect(payload.url).toBe(followUpLandingPath(F1));
    expect(payload.url).not.toMatch(/^https?:/);
  });

  it('never replaces a reminder: its tag and its push-service topic differ from the reminder’s', () => {
    const payload = formatFollowUpNudgePayload(NUDGE);
    const reminder = formatPushPayload(
      { id: EVENT_GIDS, title: 'GIDS 2026', startDateTime: ist('2026-09-27T09:00:00') },
      NOW
    );
    expect(payload.tag).not.toBe(reminder.tag);
    expect(payload.tag).toBe(`pblr-followup-${EVENT_GIDS}`);
    // The reminder's topic is the bare event id (lib/notifications/push.ts).
    const topic = followUpNudgeTopic(EVENT_GIDS);
    expect(topic).not.toBe(EVENT_GIDS);
    expect(topic.length).toBeLessThanOrEqual(32);
    expect(topic).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('clamps a pathological folder name and stays inside the payload ceiling', () => {
    const payload = formatFollowUpNudgePayload({ ...NUDGE, title: 'x'.repeat(5000) });
    expect(payload.title.length).toBeLessThanOrEqual(120);
    expect(Buffer.byteLength(JSON.stringify(payload), 'utf8')).toBeLessThanOrEqual(PUSH_PAYLOAD_MAX_BYTES);
  });
});

/* ── The Settings switch ──────────────────────────────────────────────────────────────────── */

describe('parseNudgePreferenceBody', () => {
  it('accepts a real boolean either way', () => {
    expect(parseNudgePreferenceBody({ enabled: true })).toEqual({ ok: true, enabled: true });
    expect(parseNudgePreferenceBody({ enabled: false })).toEqual({ ok: true, enabled: false });
  });

  it('refuses a stringly boolean, a missing field and a non-object', () => {
    expect(parseNudgePreferenceBody({ enabled: 'false' }).ok).toBe(false);
    expect(parseNudgePreferenceBody({}).ok).toBe(false);
    expect(parseNudgePreferenceBody(null).ok).toBe(false);
    expect(parseNudgePreferenceBody([true]).ok).toBe(false);
  });
});

/* ── The landing screen's data ───────────────────────────────────────────────────────────── */

describe('the landing projection', () => {
  it('sends an allowlist: no phone, no note, no tags, no raw payload', () => {
    const view = toFollowUpContactView({
      _id: 'c1',
      personId: '6b0000000000000000000009',
      name: 'Priya',
      role: 'SRE',
      company: 'Razorpay',
      linkedin: 'https://www.linkedin.com/in/priya',
      email: 'priya@example.com',
      followedUp: false,
      // Present on the row and deliberately NOT projected.
      ...({ phone: '9876543210', note: 'talked about k8s', tags: ['sre'], rawPayload: 'x' } as object),
    });
    expect(Object.keys(view).sort()).toEqual(
      ['company', 'email', 'followedUp', 'id', 'linkedin', 'name', 'personId', 'role'].sort()
    );
  });

  it('drops a personId that is not an ObjectId', () => {
    expect(toFollowUpContactView({ _id: 'c1', personId: 'nope', name: 'x' }).personId).toBeNull();
  });

  it('lists people still to do first, in the order met', () => {
    const landing = buildFollowUpLanding({ _id: F1, name: 'GIDS' }, [
      { _id: 'a', name: 'done', followedUp: true, scannedAt: '2026-09-27T05:00:00Z' },
      { _id: 'b', name: 'second', followedUp: false, scannedAt: '2026-09-27T07:00:00Z' },
      { _id: 'c', name: 'first', followedUp: false, scannedAt: '2026-09-27T06:00:00Z' },
    ]);
    expect(landing.contacts.map(c => c.name)).toEqual(['first', 'second', 'done']);
    expect(landing.pendingCount).toBe(2);
  });
});

describe('safeLinkedinUrl — every contact field came from somebody else’s QR code', () => {
  it('keeps a real LinkedIn URL, upgraded to https', () => {
    expect(safeLinkedinUrl('http://www.linkedin.com/in/priya?fromQR=1')).toBe(
      'https://www.linkedin.com/in/priya?fromQR=1'
    );
    expect(safeLinkedinUrl('https://in.linkedin.com/in/priya')).toBe('https://in.linkedin.com/in/priya');
  });

  it('refuses script URLs and look-alike hosts', () => {
    expect(safeLinkedinUrl('javascript:alert(1)')).toBeNull();
    expect(safeLinkedinUrl('data:text/html,<script>')).toBeNull();
    expect(safeLinkedinUrl('https://linkedin.com.evil.example/in/priya')).toBeNull();
    expect(safeLinkedinUrl('https://evillinkedin.com/in/priya')).toBeNull();
    expect(safeLinkedinUrl('https://user:pw@www.linkedin.com/in/priya')).toBeNull();
    // A username alone, so the username check is pinned independently of the password one.
    expect(safeLinkedinUrl('https://user@www.linkedin.com/in/priya')).toBeNull();
    expect(safeLinkedinUrl('https://:pw@www.linkedin.com/in/priya')).toBeNull();
  });

  it('rebuilds from the parsed slug when the URL is unusable, and refuses a hostile slug', () => {
    expect(safeLinkedinUrl('javascript:x', 'naga-sai')).toBe('https://www.linkedin.com/in/naga-sai');
    expect(safeLinkedinUrl(null, '../../evil')).toBeNull();
    expect(safeLinkedinUrl(null, null)).toBeNull();
  });
});

describe('safeEmail — what may follow mailto:', () => {
  it('keeps a plain address', () => {
    expect(safeEmail('Priya@Example.com')).toBe('priya@example.com');
  });

  it('refuses anything that would inject mailto headers or is not one address', () => {
    expect(safeEmail('a@b.com?cc=victim@x.com')).toBeNull();
    expect(safeEmail('a@b.com&body=x')).toBeNull();
    expect(safeEmail('a b@c.com')).toBeNull();
    expect(safeEmail('a@b@c.com')).toBeNull();
    expect(safeEmail('no-at-sign')).toBeNull();
    expect(safeEmail(null)).toBeNull();
  });
});

/* ── Structural: the files this suite cannot execute ──────────────────────────────────────── */

const REPO = path.resolve(import.meta.dirname, '..');
const read = (file: string) => fs.readFileSync(path.join(REPO, file), 'utf8').replace(/\r\n/g, '\n');
const code = (file: string) =>
  read(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(line => !line.trim().startsWith('//'))
    .join('\n');

describe('structure', () => {
  it('never borrows EMAIL consent, and derives recipients from the subscription collection', () => {
    for (const file of ['lib/notifications/followup-nudge.ts', 'lib/notifications/followup-nudge-policy.ts']) {
      expect(code(file)).not.toContain('remindersEnabled');
      expect(code(file)).not.toContain('onboardedAt');
    }
    expect(code('lib/notifications/followup-nudge.ts')).toContain("PushSubscription.distinct('userId')");
  });

  it('counts the daily cap over every PUSH kind', () => {
    const source = code('lib/notifications/followup-nudge.ts');
    const call = source.slice(source.indexOf("ReminderLog.distinct('batchId'"));
    const filter = call.slice(0, call.indexOf('});') + 3);
    expect(filter).toContain('kind: { $in: [...PUSH_CHANNEL_KINDS] }');
    expect(filter).toContain('sentAt');
  });

  it('claims under its own kind before it sends', () => {
    const source = code('lib/notifications/followup-nudge.ts');
    const claim = source.indexOf('ReminderLog.create(');
    const send = source.indexOf('sendToDevice(', claim);
    expect(claim).toBeGreaterThan(-1);
    expect(send).toBeGreaterThan(claim);
    expect(source.slice(claim, send)).toContain('kind: FOLLOWUP_NUDGE_KIND');
  });

  it('reads no contact name, note or channel into the sender — counting fields only', () => {
    const source = code('lib/notifications/followup-nudge.ts');
    expect(source).toContain(".select('userId folderId followedUp')");
  });

  it('runs the follow-up pass after the reminder pass has reported', () => {
    const source = code('scripts/send-push-reminders.ts');
    // The FIRST call, not the first one after the summary: the crash path in `catch` calls it too,
    // so searching from the summary onwards would find that one and pass on a reordered main path.
    const reminders = source.indexOf('summarise(report);');
    const followUps = source.indexOf('await followUpPass()');
    expect(reminders).toBeGreaterThan(-1);
    expect(followUps).toBeGreaterThan(reminders);
    // A user-typed folder name is sanitised before it reaches a terminal or the Actions log.
    expect(source).toMatch(/toLogLine\(nudge\.title, \d+\)/);
  });

  it('keeps the route files to HTTP methods only — `next build` rejects anything else', () => {
    for (const file of ['app/api/follow-ups/[folderId]/route.ts', 'app/api/me/follow-up-nudges/route.ts']) {
      const exports = code(file).match(/^export .*/gm) ?? [];
      expect(exports.length).toBeGreaterThan(0);
      for (const line of exports) expect(line).toMatch(/^export async function (GET|PUT|POST|PATCH|DELETE)\(/);
    }
  });

  it('puts the guard before anything reads the request', () => {
    for (const file of ['app/api/follow-ups/[folderId]/route.ts', 'app/api/me/follow-up-nudges/route.ts']) {
      const source = code(file);
      for (const handler of source.split(/export async function /).slice(1)) {
        const guard = handler.indexOf('requireUser()');
        expect(guard).toBeGreaterThan(-1);
        for (const read of ['request.json(', 'await params', 'connectDB(']) {
          const at = handler.indexOf(read);
          if (at > -1) expect(at).toBeGreaterThan(guard);
        }
      }
    }
  });

  it('scopes the landing folder lookup by the SESSION user, not the id alone', () => {
    const source = code('app/api/follow-ups/[folderId]/route.ts');
    expect(source).toContain('Folder.findOne({ _id: folderId, userId: gate.userId })');
    expect(source).toContain("return json({ error: 'Not found' }, 404)");
    expect(source).not.toContain('403');
  });
});
