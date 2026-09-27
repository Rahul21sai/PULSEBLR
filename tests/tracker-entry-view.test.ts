import { describe, it, expect } from 'vitest';
import {
  TRACKER_EVENT_FIELDS,
  TRACKER_EVENT_GUARD_FIELDS,
  TRACKER_EVENT_SELECT,
  lastKnownFromFolder,
  orphanedEventIds,
  shapeTrackerEntries,
  toTrackerEvent,
} from '@/lib/tracker/entry-view';

/**
 * WHAT THE TRACKER API SAYS ABOUT THE EVENT BEHIND AN ENTRY — `lib/tracker/entry-view.ts`.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Three things this pins, each a defect that shipped:
 *
 *   1. `.populate('eventId')` with no projection sent every field of the event, `createdByUserId`
 *      — on a submission, another user's id — included. The view is an ALLOWLIST of the nine fields
 *      the page reads, and the owner field is fetched only so `canViewEvent` can use it.
 *   2. Visibility was decided once, at tracking time. An event soft-deleted or gone private since is
 *      now `null`, exactly like a deleted one. The select must carry the guard fields for that to
 *      work — `canViewEvent` treats an unfetched field as permissive, so a short select fails OPEN.
 *   3. An entry whose event was gone was dropped by the page. The shaping layer keeps it, with its
 *      status, notes and people, and names it from the user's OWN folder where one exists.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */

const ME = 'user-me';
const THEM = 'user-them';
const WHEN = new Date('2026-09-06T13:30:00Z');

/** Stands in for an ObjectId: equal ids, never `===`. */
class FakeObjectId {
  constructor(private readonly hex: string) {}
  toString(): string {
    return this.hex;
  }
}

/**
 * A stored event as the select returns it — plus two fields the select would never fetch, so a test
 * passing here proves the allowlist, not the select, is what keeps a field off the wire.
 */
function stored(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'e1',
    title: 'Rust Bangalore #42',
    startDateTime: new Date('2026-10-04T13:30:00Z'),
    venue: 'Thoughtworks',
    area: 'Koramangala',
    city: 'Bengaluru',
    format: 'offline',
    category: ['Web/Mobile'],
    imageUrl: 'https://img.example/rust.png',
    dedupHash: 'internal-hash',
    clusterKey: 'rust bangalore 42|2026-10-04',
    ...overrides,
  };
}

function entry(id: string, eventId: unknown) {
  return {
    _id: id,
    eventId,
    userId: ME,
    status: 'Attended',
    notes: 'Asked about async traits',
    connections: [{ name: 'Asha', company: 'Razorpay' }],
  };
}

describe('TRACKER_EVENT_SELECT', () => {
  it('fetches every field canViewEvent reads — a short select fails OPEN', () => {
    const selected = TRACKER_EVENT_SELECT.split(' ');
    for (const field of ['visibility', 'createdByUserId', 'deletedAt']) {
      expect(selected).toContain(field);
    }
  });

  it('fetches every field it sends', () => {
    const selected = TRACKER_EVENT_SELECT.split(' ');
    for (const field of TRACKER_EVENT_FIELDS) expect(selected).toContain(field);
  });

  it('never SENDS a guard field', () => {
    const sent = new Set<string>(TRACKER_EVENT_FIELDS);
    expect(TRACKER_EVENT_GUARD_FIELDS.filter(field => sent.has(field))).toEqual([]);
  });
});

describe('toTrackerEvent', () => {
  it('sends exactly the tracker fields of a public event, and nothing internal', () => {
    const view = toTrackerEvent(stored(), ME);
    expect(Object.keys(view ?? {}).sort()).toEqual([...TRACKER_EVENT_FIELDS].sort());
  });

  it("admits the owner to their own private event, then strips the owner field", () => {
    const view = toTrackerEvent(stored({ visibility: 'private', createdByUserId: ME }), ME);
    expect(view).not.toBeNull();
    expect(view).not.toHaveProperty('createdByUserId');
    expect(view).not.toHaveProperty('visibility');
  });

  it("is null for somebody else's private event", () => {
    expect(toTrackerEvent(stored({ visibility: 'private', createdByUserId: THEM }), ME)).toBeNull();
  });

  it('is null for a soft-deleted event, even for its own author', () => {
    const deleted = stored({ visibility: 'private', createdByUserId: ME, deletedAt: WHEN });
    expect(toTrackerEvent(deleted, ME)).toBeNull();
  });

  it('is null for an event that no longer exists', () => {
    expect(toTrackerEvent(null, ME)).toBeNull();
  });
});

describe('lastKnownFromFolder', () => {
  it('takes the title and date the folder denormalised', () => {
    expect(lastKnownFromFolder({ _id: 'f1', name: '  Databricks Hackathon ', eventDate: WHEN })).toEqual({
      title: 'Databricks Hackathon',
      startDateTime: WHEN,
      folderId: 'f1',
    });
  });

  it('a folder with no usable name contributes nothing', () => {
    expect(lastKnownFromFolder({ _id: 'f1', name: '   ' })).toBeNull();
  });
});

describe('shapeTrackerEntries — the listing the board draws', () => {
  it('KEEPS an entry whose event is gone, with its status, notes and people', () => {
    const [shaped] = shapeTrackerEntries([entry('t1', 'gone')], [], [], ME);
    expect(shaped).toMatchObject({
      _id: 't1',
      eventId: null,
      status: 'Attended',
      notes: 'Asked about async traits',
      connections: [{ name: 'Asha', company: 'Razorpay' }],
    });
  });

  it("names a lost event from the viewer's own folder for it", () => {
    const [shaped] = shapeTrackerEntries(
      [entry('t1', 'gone')],
      [],
      [{ _id: 'f1', userId: ME, eventId: 'gone', name: 'Rust Bangalore #41', eventDate: WHEN }],
      ME
    );
    expect(shaped.lastKnown).toEqual({ title: 'Rust Bangalore #41', startDateTime: WHEN, folderId: 'f1' });
  });

  it("never takes a name from another user's folder", () => {
    const [shaped] = shapeTrackerEntries(
      [entry('t1', 'gone')],
      [],
      [{ _id: 'f9', userId: THEM, eventId: 'gone', name: 'Their own label' }],
      ME
    );
    expect(shaped.lastKnown).toBeUndefined();
  });

  it('the first folder wins when a user has several for one event (the route sorts newest first)', () => {
    const [shaped] = shapeTrackerEntries(
      [entry('t1', 'gone')],
      [],
      [
        { _id: 'new', userId: ME, eventId: 'gone', name: 'Newest folder' },
        { _id: 'old', userId: ME, eventId: 'gone', name: 'Older folder' },
      ],
      ME
    );
    expect(shaped.lastKnown?.folderId).toBe('new');
  });

  it('treats an event the viewer may no longer see exactly like a deleted one', () => {
    const hidden = stored({ _id: 'hid', visibility: 'private', createdByUserId: THEM });
    const [shaped] = shapeTrackerEntries(
      [entry('t1', 'hid')],
      [hidden],
      [{ _id: 'f1', userId: ME, eventId: 'hid', name: 'My folder' }],
      ME
    );
    expect(shaped.eventId).toBeNull();
    expect(shaped.lastKnown?.title).toBe('My folder');
    expect(JSON.stringify(shaped)).not.toContain(THEM);
  });

  it('a listed event goes out as its view and never carries lastKnown', () => {
    const [shaped] = shapeTrackerEntries(
      [entry('t1', 'e1')],
      [stored()],
      [{ _id: 'f1', userId: ME, eventId: 'e1', name: 'Rust folder' }],
      ME
    );
    expect(shaped.eventId).toMatchObject({ _id: 'e1', title: 'Rust Bangalore #42' });
    expect(shaped).not.toHaveProperty('lastKnown');
  });

  it('joins by string id, so ObjectIds on both sides still meet', () => {
    const [shaped] = shapeTrackerEntries(
      [entry('t1', new FakeObjectId('e1'))],
      [stored({ _id: new FakeObjectId('e1') })],
      [],
      ME
    );
    expect(shaped.eventId).toMatchObject({ title: 'Rust Bangalore #42' });
  });
});

describe('orphanedEventIds — the events the list route fetches folders for', () => {
  it('is every missing and every hidden event, once each, and never a listed one', () => {
    const entries = [{ eventId: 'e1' }, { eventId: 'gone' }, { eventId: 'gone' }, { eventId: 'hid' }];
    const events = [stored(), stored({ _id: 'hid', visibility: 'private', createdByUserId: THEM })];
    expect(orphanedEventIds(entries, events, ME).sort()).toEqual(['gone', 'hid']);
  });
});
