/**
 * The event DETAIL shape — what `GET /api/events/[id]`, the `/events/[id]` page and
 * `GET /api/me/events` send.
 *
 * The defect this pins: those paths returned the WHOLE document, so every anonymous visitor to an
 * approved user event received the author's Google `sub` (in `createdByUserId`, and again inside the
 * owner-namespaced `clusterKey`), plus the dedup keys and moderation state. Two failure modes, and
 * both are silent:
 *
 *   1. the DTO leaking a field it should not — asserted by serialising a document carrying every
 *      internal field and checking none survives, including the raw id anywhere in the JSON;
 *   2. the QUERY projection forgetting a field `canViewEvent` reads — which does not fail, it admits
 *      every private event. Asserted structurally against `DETAIL_SELECT`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { ACCESS_FIELDS, DETAIL_FIELDS, DETAIL_SELECT, FEED_FIELDS } from '@/lib/events/query';
import { toEventDetail } from '@/lib/events/serialize';
import { canViewEvent } from '@/lib/events/visibility';

const OWNER = '109876543210987654321';
const STRANGER = '101010101010101010101';

/** A lean document shaped like an APPROVED user submission, carrying every internal field. */
function storedDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: { toJSON: () => '6a8c75ac1d13c5f121502f3c', toString: () => '6a8c75ac1d13c5f121502f3c' },
    title: 'Internal Hack Day',
    description: 'Build something.',
    source: 'manual',
    sourceUrl: 'https://pulseblr.local/manual',
    category: ['Hackathon'],
    format: 'offline',
    hasFood: 'unknown',
    isFree: true,
    venue: 'Office',
    address: '1 MG Road',
    startDateTime: new Date('2026-10-01T13:30:00Z'),
    connectionScore: 60,
    isTechEvent: true,
    seenInSources: ['manual'],
    createdByUserId: OWNER,
    clusterKey: `user:${OWNER}|internal hack day|2026-10-01`,
    dedupHash: 'f'.repeat(64),
    tagConfidence: 0.6,
    lastSeenAt: new Date('2026-09-01T00:00:00Z'),
    sourceEventId: 'microsite:abcdef0123456789',
    extraction: { text: 'secret page text' },
    updatedAt: new Date('2026-09-02T00:00:00Z'),
    ...overrides,
  };
}

const NEVER_SENT = [
  'createdByUserId',
  'clusterKey',
  'dedupHash',
  'tagConfidence',
  'lastSeenAt',
  'sourceEventId',
  'extraction',
  'deletedAt',
  'updatedAt',
];

describe('DETAIL_FIELDS / DETAIL_SELECT', () => {
  it('sends no internal, identity or moderation field', () => {
    for (const field of [...NEVER_SENT, 'visibility']) {
      expect(DETAIL_FIELDS as readonly string[], field).not.toContain(field);
    }
  });

  it('the QUERY still fetches every field canViewEvent reads — an omission fails OPEN', () => {
    const selected = DETAIL_SELECT.split(' ');
    for (const field of ['visibility', 'createdByUserId', 'deletedAt']) {
      expect(selected, field).toContain(field);
      expect(ACCESS_FIELDS as readonly string[]).toContain(field);
    }
  });

  it('is a superset of the feed plus the per-event depth the page renders', () => {
    for (const field of FEED_FIELDS) expect(DETAIL_FIELDS as readonly string[]).toContain(field);
    for (const field of ['description', 'address', 'agenda', 'speakers']) {
      expect(DETAIL_FIELDS as readonly string[]).toContain(field);
    }
  });

  /**
   * `app/admin/EditEventModal.tsx` fills its form from `GET /api/events/[id]`. A field it edits that
   * the allowlist drops would load empty and be CLEARED on the admin's next save. Read from the file
   * so a field added there fails here.
   */
  it('covers every field the admin event editor reads', () => {
    const modal = readFileSync(
      path.resolve(import.meta.dirname, '..', 'app', 'admin', 'EditEventModal.tsx'),
      'utf8'
    );
    const read = new Set([...modal.matchAll(/\bevent\??\.(\w+)/g)].map(m => m[1]));
    expect(read.size).toBeGreaterThan(10);
    for (const field of read) {
      expect(DETAIL_FIELDS as readonly string[], `EditEventModal reads event.${field}`).toContain(field);
    }
  });
});

describe('toEventDetail', () => {
  it('drops every internal field, and the owner id appears NOWHERE in the output', () => {
    const detail = toEventDetail(storedDoc(), null);
    for (const field of [...NEVER_SENT, 'visibility']) {
      expect(detail, field).not.toHaveProperty(field);
    }
    expect(JSON.stringify(detail)).not.toContain(OWNER);
  });

  it('keeps what the page renders, with dates as ISO strings', () => {
    const detail = toEventDetail(storedDoc(), null);
    expect(detail._id).toBe('6a8c75ac1d13c5f121502f3c');
    expect(detail.title).toBe('Internal Hack Day');
    expect(detail.address).toBe('1 MG Road');
    expect(detail.startDateTime).toBe('2026-10-01T13:30:00.000Z');
  });

  it('a stranger gets no owner block and no id', () => {
    const detail = toEventDetail(storedDoc(), STRANGER, { tracked: true, savedByOthers: 9 });
    expect(detail.isOwner).toBeUndefined();
    expect(detail.visibility).toBeUndefined();
    expect(detail.savedByOthers).toBeUndefined();
    expect(detail.tracked).toBe(true);
    expect(JSON.stringify(detail)).not.toContain(OWNER);
  });

  it('the owner gets isOwner and a normalised visibility — still not the raw id', () => {
    const approved = toEventDetail(storedDoc(), OWNER, { savedByOthers: 3, deleteMode: 'soft' });
    expect(approved.isOwner).toBe(true);
    expect(approved.visibility).toBe('public');
    expect(approved.savedByOthers).toBe(3);
    expect(approved.deleteMode).toBe('soft');
    expect(JSON.stringify(approved)).not.toContain(OWNER);

    expect(toEventDetail(storedDoc({ visibility: 'pending' }), OWNER).visibility).toBe('pending');
  });

  it('owner status cannot be claimed by a caller: it follows the stored owner only', () => {
    // An anonymous viewer, and a scraped row whose owner field is absent, are never owners — even
    // though `undefined === undefined` would say otherwise to a careless comparison.
    expect(toEventDetail(storedDoc(), null).isOwner).toBeUndefined();
    expect(toEventDetail(storedDoc({ createdByUserId: undefined }), STRANGER).isOwner).toBeUndefined();
  });

  it('tracked is only set for a signed-in viewer', () => {
    expect(toEventDetail(storedDoc(), null, { tracked: true }).tracked).toBeUndefined();
  });
});

describe('the projection and the guard together', () => {
  it('a DETAIL_SELECT-shaped private row is still refused to a stranger', () => {
    // What the route actually fetches: only selected paths survive a `.select()`.
    const selected = new Set(DETAIL_SELECT.split(' '));
    const full = storedDoc({ visibility: 'private' }) as Record<string, unknown>;
    const projected = Object.fromEntries(Object.entries(full).filter(([k]) => selected.has(k)));
    expect(canViewEvent(projected, STRANGER)).toBe(false);
    expect(canViewEvent(projected, OWNER)).toBe(true);
  });
});

describe('POST /api/events answers through the DTO', () => {
  it('never returns the raw created document (it carries createdByUserId, clusterKey, dedupHash)', () => {
    const route = readFileSync(path.join(process.cwd(), 'app/api/events/route.ts'), 'utf8');
    expect(route).toMatch(/NextResponse\.json\(toEventDetail\(event\.toObject\(\), gate\.userId\), \{ status: 201 \}\)/);
    expect(route).not.toMatch(/NextResponse\.json\(event,/);
  });
});
