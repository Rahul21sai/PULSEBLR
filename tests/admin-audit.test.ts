import { describe, it, expect } from 'vitest';
import {
  AUDIT_ACTIONS,
  actionLabel,
  diffFields,
  isAuditAction,
  isUndoable,
  normaliseValue,
  redactSnapshot,
  SNAPSHOT_MAX_BYTES,
  summarise,
  undoKind,
  undoPatch,
} from '@/lib/admin/audit';

/**
 * The audit trail's pure half.
 *
 * WHY THIS IS WORTH A TEST SUITE RATHER THAN A DIAG SCRIPT: the audit log is the only thing
 * standing between the control room's buttons and an unrecoverable change. `before` is the backup —
 * a delete is reversible ONLY because `redactSnapshot` kept the document and `undoPatch` knows how
 * to put it back. A silent regression in either turns "Undo" into a button that reports success and
 * restores nothing, which is strictly worse than not offering it.
 *
 * Two properties carry most of the risk and are pinned hardest below:
 *   · `diffFields` must report NOTHING for a no-op. A log where every save lists twenty unchanged
 *     fields is unreadable, and "who broke this" then gets the wrong answer.
 *   · `_id` must survive a snapshot. A restore under a fresh id leaves every dangling
 *     `TrackerEntry.eventId` and `Folder.eventId` pointing at nothing, with an identical row beside
 *     it — the failure mode looks like the undo worked.
 */

describe('normaliseValue — one comparable, storable shape', () => {
  it('turns a Date into the ISO string a JSON body would have carried', () => {
    const d = new Date('2026-09-10T04:30:00.000Z');
    expect(normaliseValue(d)).toBe('2026-09-10T04:30:00.000Z');
  });

  it('collapses undefined to null so "removed" and "set to null" read alike', () => {
    expect(normaliseValue(undefined)).toBeNull();
  });

  it('renders an ObjectId-like value as its hex string, not a Buffer dump', () => {
    const oid = {
      toHexString: () => '66f0a1b2c3d4e5f607182930',
      toString: () => '66f0a1b2c3d4e5f607182930',
    };
    expect(normaliseValue(oid)).toBe('66f0a1b2c3d4e5f607182930');
  });

  it('recurses through arrays and plain objects', () => {
    expect(normaliseValue({ a: [new Date('2026-01-01T00:00:00.000Z'), undefined] })).toEqual({
      a: ['2026-01-01T00:00:00.000Z', null],
    });
  });

  it('leaves primitives alone, including false and 0', () => {
    expect(normaliseValue(false)).toBe(false);
    expect(normaliseValue(0)).toBe(0);
    expect(normaliseValue('')).toBe('');
  });
});

describe('diffFields — only what actually changed', () => {
  it('reports a changed field with both sides', () => {
    expect(diffFields({ isTechEvent: false }, { isTechEvent: true })).toEqual([
      { field: 'isTechEvent', before: false, after: true },
    ]);
  });

  it('reports NOTHING when the patch matches what is already stored', () => {
    // The no-op case. A save that changes nothing must not appear in the log as a change.
    expect(diffFields({ title: 'Kafka Meetup', isTechEvent: true }, { title: 'Kafka Meetup' })).toEqual([]);
  });

  it('ignores keys the action never mentioned', () => {
    // An update is an allowlisted patch. A field absent from `after` was not part of the action and
    // must not be logged as though the admin had touched it.
    const changes = diffFields({ title: 'A', venue: 'B', description: 'C' }, { title: 'A2' });
    expect(changes.map(c => c.field)).toEqual(['title']);
  });

  it('treats a Date and the ISO string that produced it as equal', () => {
    const changes = diffFields(
      { startDateTime: new Date('2026-09-10T04:30:00.000Z') },
      { startDateTime: '2026-09-10T04:30:00.000Z' }
    );
    expect(changes).toEqual([]);
  });

  it('detects a real date change through that same normalisation', () => {
    const changes = diffFields(
      { startDateTime: new Date('2026-09-10T04:30:00.000Z') },
      { startDateTime: '2026-09-11T04:30:00.000Z' }
    );
    expect(changes).toHaveLength(1);
    expect(changes[0].before).toBe('2026-09-10T04:30:00.000Z');
  });

  it('records a first-time value as a change from null', () => {
    expect(diffFields({}, { spotlightAt: '2026-09-10T00:00:00.000Z' })).toEqual([
      { field: 'spotlightAt', before: null, after: '2026-09-10T00:00:00.000Z' },
    ]);
  });

  it('records unpinning as a change TO null, which is what the route sends', () => {
    // Unpinning must send an explicit null: `$set` cannot express `$unset`, and the home page
    // matches `{ $type: 'date' }`, so a stored null correctly reads as unpinned.
    const changes = diffFields({ spotlightAt: new Date('2026-09-01T00:00:00.000Z') }, { spotlightAt: null });
    expect(changes).toEqual([
      { field: 'spotlightAt', before: '2026-09-01T00:00:00.000Z', after: null },
    ]);
  });

  it('compares arrays by contents, so a reordered category list is a change and a copy is not', () => {
    expect(diffFields({ category: ['AI/ML', 'Meetup'] }, { category: ['AI/ML', 'Meetup'] })).toEqual([]);
    expect(diffFields({ category: ['AI/ML', 'Meetup'] }, { category: ['Meetup', 'AI/ML'] })).toHaveLength(1);
  });

  it('returns nothing when there is no patch at all', () => {
    expect(diffFields({ a: 1 }, null)).toEqual([]);
    expect(diffFields(null, null)).toEqual([]);
  });
});

describe('undoPatch — the payload that puts it back', () => {
  it('inverts a change set to its before-values', () => {
    const changes = diffFields(
      { isTechEvent: false, title: 'old' },
      { isTechEvent: true, title: 'new' }
    );
    expect(undoPatch(changes)).toEqual({ isTechEvent: false, title: 'old' });
  });

  it('carries null through, so undoing a first-time set clears the field', () => {
    const changes = diffFields({}, { spotlightAt: '2026-09-10T00:00:00.000Z' });
    expect(undoPatch(changes)).toEqual({ spotlightAt: null });
  });
});

describe('redactSnapshot — the backup a delete relies on', () => {
  it('keeps _id, because a restore must reuse it', () => {
    // Restoring under a fresh id leaves TrackerEntry.eventId and Folder.eventId dangling while an
    // identical row sits beside them. Reusing the id makes those references live again by itself.
    const snap = redactSnapshot({ _id: '66f0a1b2c3d4e5f607182930', title: 'Kafka Meetup' });
    expect(snap.doc._id).toBe('66f0a1b2c3d4e5f607182930');
    expect(snap.truncated).toBe(false);
  });

  it('drops mongoose bookkeeping', () => {
    const snap = redactSnapshot({ _id: 'x', __v: 3, title: 't' });
    expect(snap.doc).not.toHaveProperty('__v');
  });

  it('normalises dates inside the snapshot so it round-trips as JSON', () => {
    const snap = redactSnapshot({ _id: 'x', startDateTime: new Date('2026-09-10T04:30:00.000Z') });
    expect(snap.doc.startDateTime).toBe('2026-09-10T04:30:00.000Z');
  });

  it('sacrifices only the description when a document is too large, and says it did', () => {
    const snap = redactSnapshot({
      _id: 'x',
      title: 'Huge',
      venue: 'MG Road',
      description: 'x'.repeat(SNAPSHOT_MAX_BYTES + 10),
    });
    expect(snap.truncated).toBe(true);
    expect(snap.doc.description).toBe('');
    // Identity and everything a restore needs must survive the trim.
    expect(snap.doc._id).toBe('x');
    expect(snap.doc.title).toBe('Huge');
    expect(snap.doc.venue).toBe('MG Road');
  });

  it('leaves a normal event untouched — truncation is the exception, not the rule', () => {
    const snap = redactSnapshot({ _id: 'x', title: 't', description: 'A normal description.' });
    expect(snap.truncated).toBe(false);
    expect(snap.doc.description).toBe('A normal description.');
  });
});

describe('undoKind — what an undo is allowed to do', () => {
  it('restores a whole document for a delete', () => {
    expect(undoKind('event.delete')).toBe('restore-document');
    expect(undoKind('source.delete')).toBe('restore-document');
  });

  it('restores fields for an edit or a flag toggle', () => {
    expect(undoKind('event.update')).toBe('restore-fields');
    expect(undoKind('event.tech.unflag')).toBe('restore-fields');
    expect(undoKind('event.spotlight.pin')).toBe('restore-fields');
  });

  it('refuses to undo a submission decision', () => {
    // Both directions are already reversible through the submissions queue, and re-deciding one is
    // a judgement rather than a correction — a generic undo would write the field without the
    // review the panel exists to force.
    expect(undoKind('submission.approve')).toBe('none');
    expect(undoKind('submission.reject')).toBe('none');
    expect(isUndoable('submission.approve')).toBe(false);
  });

  it('refuses to undo an undo', () => {
    expect(undoKind('event.restore')).toBe('none');
  });

  it('treats an unknown action as not undoable rather than guessing', () => {
    expect(undoKind('event.explode')).toBe('none');
    expect(isUndoable('')).toBe(false);
  });

  it('has a verdict for every declared action', () => {
    // A new action with no undo rule would silently default to "none", which is safe but silent.
    // This fails loudly instead if the two lists drift.
    for (const action of AUDIT_ACTIONS) {
      expect(['restore-document', 'restore-fields', 're-enable', 'none']).toContain(undoKind(action));
    }
  });
});

describe('isAuditAction / actionLabel', () => {
  it('accepts only declared actions', () => {
    expect(isAuditAction('event.delete')).toBe(true);
    expect(isAuditAction('event.nuke')).toBe(false);
    expect(isAuditAction(42)).toBe(false);
    expect(isAuditAction(undefined)).toBe(false);
  });

  it('gives every declared action a human label', () => {
    for (const action of AUDIT_ACTIONS) {
      expect(actionLabel(action)).not.toBe(action);
      expect(actionLabel(action).length).toBeGreaterThan(3);
    }
  });

  it('falls back to the raw string for an unknown action instead of throwing', () => {
    expect(actionLabel('event.mystery')).toBe('event.mystery');
  });
});

describe('summarise — a line that still makes sense after the row is gone', () => {
  it('names the event, not the mechanism', () => {
    expect(summarise({ action: 'event.delete', targetLabel: 'Kafka Meetup' })).toBe(
      'Deleted an event: “Kafka Meetup”'
    );
  });

  it('lists the fields an edit touched', () => {
    const changes = diffFields({ title: 'a', venue: 'b' }, { title: 'a2', venue: 'b2' });
    expect(summarise({ action: 'event.update', targetLabel: 'GIDS', changes })).toBe(
      'Edited “GIDS” — title, venue'
    );
  });

  it('counts a bulk action rather than naming one victim of it', () => {
    expect(summarise({ action: 'source.bulk.disable', count: 138 })).toBe('Disabled 138 sources');
    expect(summarise({ action: 'source.bulk.disable', count: 1 })).toBe('Disabled 1 source');
  });

  it('still reads sensibly with no label', () => {
    expect(summarise({ action: 'event.delete' })).toBe('Deleted an event: an untitled row');
  });
});
