/**
 * The owner edit/delete rules for hand-added events (`lib/events/owner-edit.ts`).
 *
 * The allowlist half is a NEGATIVE suite on purpose: its job is to prove what an owner can never
 * reach — `visibility: 'public'`, `spotlightAt`, `connectionScore`, the identity keys — because a
 * field that becomes writable fails by quietly working.
 */
import { describe, it, expect } from 'vitest';
import {
  OWNER_DESCRIPTION_MAX,
  ownerDeleteMode,
  ownerVisibility,
  resolveOwnerEdit,
  validateOwnerEdit,
  type OwnerEditCurrent,
} from '@/lib/events/owner-edit';
import { PLACEHOLDER_SOURCE_URL } from '@/lib/events/placeholder';

const STORED: OwnerEditCurrent = {
  title: 'Internal Hack Day',
  description: 'Build something.',
  startDateTime: new Date('2026-10-01T13:30:00Z'),
  endDateTime: new Date('2026-10-01T17:30:00Z'),
  venue: 'Office',
  format: 'offline',
  sourceUrl: PLACEHOLDER_SOURCE_URL,
  category: ['AI/ML', 'Hackathon'],
  isFree: true,
  isTechEvent: true,
  hasFood: 'unknown',
};

function edit(body: unknown, current: OwnerEditCurrent = STORED) {
  const phase1 = validateOwnerEdit(body);
  if (phase1.issues.length) return { issues: phase1.issues, patch: phase1.patch, resolved: null };
  return { issues: [], patch: phase1.patch, resolved: resolveOwnerEdit(phase1.patch, current) };
}

describe('validateOwnerEdit — the allowlist', () => {
  it('never lets a body reach an editorial, derived, identity or moderation field', () => {
    const { patch } = validateOwnerEdit({
      title: 'x',
      visibility: 'public',
      spotlightAt: '2026-10-01T00:00:00Z',
      connectionScore: 100,
      isTechEvent: true,
      createdByUserId: 'someone-else',
      dedupHash: 'a',
      clusterKey: 'b',
      companies: ['Google'],
      source: 'luma',
      lastSeenAt: '2030-01-01',
      deletedAt: null,
      organizer: 'Google',
      soldOut: true,
    });
    expect(Object.keys(patch)).toEqual(['title']);
  });

  it('refuses a non-object body', () => {
    expect(validateOwnerEdit('nope').issues[0].field).toBe('body');
    expect(validateOwnerEdit([1]).issues[0].field).toBe('body');
  });

  it('refuses a javascript: registration link — it lands in an href', () => {
    expect(validateOwnerEdit({ applyLink: 'javascript:alert(1)' }).issues.map(i => i.field)).toEqual(['applyLink']);
  });

  it('refuses an empty category list, and an unknown category', () => {
    expect(validateOwnerEdit({ category: [] }).issues.map(i => i.field)).toEqual(['category']);
    expect(validateOwnerEdit({ category: ['Networking/Meetup'] }).issues.map(i => i.field)).toEqual(['category']);
  });

  it('caps the description at the CREATE path limit (6000), not the admin one (20000)', () => {
    // A literal, not the constant: asserting against `OWNER_DESCRIPTION_MAX` would move with it.
    expect(OWNER_DESCRIPTION_MAX).toBe(6000);
    expect(validateOwnerEdit({ description: 'a'.repeat(6000) }).issues).toEqual([]);
    expect(validateOwnerEdit({ description: 'a'.repeat(6001) }).issues[0].field).toBe('description');
  });

  it('refuses to clear the title or the start time', () => {
    expect(validateOwnerEdit({ title: '' }).issues.map(i => i.field)).toEqual(['title']);
    expect(validateOwnerEdit({ startDateTime: '' }).issues.map(i => i.field)).toEqual(['startDateTime']);
  });

  it('clearing the organiser page writes the placeholder back (sourceUrl is required)', () => {
    expect(validateOwnerEdit({ sourceUrl: '' }).patch.sourceUrl).toBe(PLACEHOLDER_SOURCE_URL);
    expect(validateOwnerEdit({ sourceUrl: PLACEHOLDER_SOURCE_URL }).patch.sourceUrl).toBe(PLACEHOLDER_SOURCE_URL);
    expect(validateOwnerEdit({ sourceUrl: '' }).issues).toEqual([]);
  });

  it('a cleared end time is UNSET, not stored as null', () => {
    const { patch } = validateOwnerEdit({ endDateTime: null });
    expect('endDateTime' in patch).toBe(true);
    expect(patch.endDateTime).toBeUndefined();
  });
});

describe('resolveOwnerEdit — rules against the stored row', () => {
  it('a no-op save changes nothing (re-sent values, reordered categories, placeholder round trip)', () => {
    const { resolved } = edit({
      title: 'Internal Hack Day',
      startDateTime: '2026-10-01T13:30:00.000Z',
      // A REAL reorder, and deliberately not already sorted — a reorder that happens to be in sorted
      // order cannot tell "compared as a set" from "compared positionally".
      category: ['Hackathon', 'AI/ML'],
      sourceUrl: '',
      isFree: true,
      price: '',
      address: '',
    });
    expect(resolved?.changed).toEqual([]);
    expect(resolved?.update).toEqual({});
    expect(resolved?.visibility).toBeUndefined();
  });

  it('a differently-SPELLED stored placeholder is still "no link" — not a change', () => {
    // Otherwise an owner who never touched the link would send a public event back to review.
    const { resolved } = edit({ sourceUrl: '' }, { ...STORED, sourceUrl: 'http://pulseblr.local/manual/' });
    expect(resolved?.changed).toEqual([]);
  });

  it('an emptied description falls back to the title', () => {
    expect(edit({ description: '' }).resolved?.update.description).toBe('Internal Hack Day');
    expect(edit({ description: '', title: 'New name' }).resolved?.update.description).toBe('New name');
  });

  it('refuses a start moved past the STORED end, naming the field that was edited', () => {
    const { resolved } = edit({ startDateTime: '2026-10-01T18:00:00.000Z' });
    expect(resolved?.issues.map(i => i.field)).toEqual(['startDateTime']);
    expect(edit({ endDateTime: '2026-10-01T12:00:00.000Z' }).resolved?.issues.map(i => i.field)).toEqual(['endDateTime']);
  });

  it('free and price cannot disagree', () => {
    expect(edit({ isFree: false, price: '' }).resolved?.issues.map(i => i.field)).toEqual(['price']);
    const paid = edit({ isFree: false, price: '499' }).resolved!;
    expect(paid.update.isFree).toBe(false);
    expect(paid.update.price).toBe(499);
    const priceOnly = edit({ price: 250 }).resolved!;
    expect(priceOnly.update.isFree).toBe(false);
    const backToFree = edit({ isFree: true, price: 999 }, { ...STORED, isFree: false, price: 500 }).resolved!;
    expect(backToFree.update.isFree).toBe(true);
    expect('price' in backToFree.update && backToFree.update.price === undefined).toBe(true);
  });

  it('re-derives isTechEvent from a changed category — never from the body', () => {
    const r = edit({ category: ['Meetup'], isTechEvent: true }).resolved!;
    expect(r.update.isTechEvent).toBe(false);
    expect(edit({ category: ['Cloud/DevOps'] }, { ...STORED, category: ['Meetup'], isTechEvent: false }).resolved!.update.isTechEvent).toBe(true);
  });

  it('re-scores when a score input changes, and not otherwise', () => {
    const online = edit({ format: 'online' }).resolved!;
    expect(typeof online.update.connectionScore).toBe('number');
    expect(edit({ format: 'online' }).resolved!.update.connectionScore).toBeLessThan(
      edit({ format: 'hybrid' }).resolved!.update.connectionScore as number
    );
    expect(edit({ venue: 'Somewhere else' }).resolved!.update).not.toHaveProperty('connectionScore');
  });
});

describe('the re-review rule', () => {
  it('a real change to an APPROVED event sends it back to pending — absent visibility is public', () => {
    expect(edit({ title: 'New name' }).resolved?.visibility).toBe('pending');
    expect(edit({ title: 'New name' }, { ...STORED, visibility: 'public' }).resolved?.visibility).toBe('pending');
  });

  it('private and pending events are edited freely, with no visibility change', () => {
    expect(edit({ title: 'New name' }, { ...STORED, visibility: 'private' }).resolved?.visibility).toBeUndefined();
    expect(edit({ title: 'New name' }, { ...STORED, visibility: 'pending' }).resolved?.visibility).toBeUndefined();
  });

  it('ownerVisibility treats absent and unknown values as public', () => {
    expect(ownerVisibility(undefined)).toBe('public');
    expect(ownerVisibility(null)).toBe('public');
    expect(ownerVisibility('private')).toBe('private');
    expect(ownerVisibility('pending')).toBe('pending');
  });
});

describe('ownerDeleteMode', () => {
  it('a public event is always soft-deleted', () => {
    expect(ownerDeleteMode({ visibility: undefined, othersReferencing: 0 })).toBe('soft');
    expect(ownerDeleteMode({ visibility: 'public', othersReferencing: 0 })).toBe('soft');
  });

  it('a private or pending event nobody else references is hard-deleted', () => {
    expect(ownerDeleteMode({ visibility: 'private', othersReferencing: 0 })).toBe('hard');
    expect(ownerDeleteMode({ visibility: 'pending', othersReferencing: 0 })).toBe('hard');
  });

  it('once anyone else depends on it, it is soft — the public → pending → delete chain', () => {
    expect(ownerDeleteMode({ visibility: 'pending', othersReferencing: 2 })).toBe('soft');
    expect(ownerDeleteMode({ visibility: 'private', othersReferencing: 1 })).toBe('soft');
  });
});
