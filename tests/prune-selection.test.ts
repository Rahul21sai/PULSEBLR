import { describe, it, expect } from 'vitest';
import {
  PRUNE_GRACE_MS,
  PRUNE_REFERRERS,
  chunk,
  partitionByReference,
  splitByReference,
  staleDeleteFilter,
  staleEventFilter,
} from '@/lib/scrapers/prune-selection';

/**
 * WHICH STALE EVENTS THE PRUNER MAY DELETE — `lib/scrapers/prune-selection.ts`.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The nightly pruner hard-deleted past events a user had tracked, filed a folder for, or met someone
 * at, a week after each one happened. Measured 2026-09-27: 12 of 16 tracker entries already pointed
 * at an event it had deleted. The fix is a reference check between "stale" and "deleted", and every
 * way it can fail is SILENT — each one still deletes something and still reports a count:
 *
 *   · comparing ObjectIds by identity spares nothing, and the fix is a no-op;
 *   · a lookup error read as "no references" deletes everything the check exists to protect;
 *   · a batching slip skips some candidates' check entirely;
 *   · a delete that forgets the stale predicate removes a row a concurrent ingest just re-sighted.
 *
 * None of that is visible in a count over today's corpus, so it is pinned here. Nothing in this file
 * reaches the database: every `splitByReference` call passes its own `lookup`, so the default loader
 * — the one function in the module that imports mongoose models — is never invoked.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */

/**
 * What `distinct` hands back: an object whose string form is the hex id, which is never `===` to a
 * string or to another instance holding the same id. The shape that makes an identity check fail.
 */
class FakeObjectId {
  constructor(private readonly hex: string) {}
  toString(): string {
    return this.hex;
  }
}

const A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const C = 'cccccccccccccccccccccccc';
const NOW = new Date('2026-09-27T02:30:00Z');
const CUTOFF = new Date(NOW.getTime() - 7 * 24 * 3600 * 1000);

describe('staleEventFilter — the predicate the pruner always used, unchanged', () => {
  it('is start AND last-seen before the cutoff, scraped rows only', () => {
    expect(staleEventFilter(NOW)).toEqual({
      startDateTime: { $lt: CUTOFF },
      lastSeenAt: { $lt: CUTOFF },
      createdByUserId: { $exists: false },
    });
  });

  it('keeps its seven-day grace', () => {
    expect(PRUNE_GRACE_MS).toBe(7 * 24 * 3600 * 1000);
  });
});

describe('staleDeleteFilter — the delete repeats the stale predicate', () => {
  /**
   * The race guard. Candidates are read, checked, then deleted; a row re-sighted in between no
   * longer matches the predicate and must survive. A delete by `_id` alone would take it.
   */
  it('is every stale arm AND the checked ids, at the same cutoff', () => {
    expect(staleDeleteFilter(NOW, [A, B])).toEqual({
      startDateTime: { $lt: CUTOFF },
      lastSeenAt: { $lt: CUTOFF },
      createdByUserId: { $exists: false },
      _id: { $in: [A, B] },
    });
  });
});

describe('PRUNE_REFERRERS', () => {
  /**
   * Exactly these three. `ReminderLog` and `DigestLog` are logs of a send and are deliberately
   * absent — every digest names the day's new events, so counting one would spare most of the corpus
   * and switch the pruner off.
   */
  it('is the tracker, folders and the interaction spine — and no send log', () => {
    expect([...PRUNE_REFERRERS].sort()).toEqual(['Folder', 'Interaction', 'TrackerEntry']);
  });
});

describe('partitionByReference', () => {
  it('spares a candidate an ObjectId refers to, though the two are never ===', () => {
    expect(partitionByReference([A, B, C], [new FakeObjectId(B)])).toEqual({
      deletable: [A, C],
      spared: [B],
    });
  });

  it('with no references, every candidate is deletable — exactly the old behaviour', () => {
    expect(partitionByReference([A, B], [])).toEqual({ deletable: [A, B], spared: [] });
  });

  it('returns the candidates themselves, in order, keyed through idOf', () => {
    const rows = [
      { _id: new FakeObjectId(A), title: 'kept one' },
      { _id: new FakeObjectId(B), title: 'deleted' },
      { _id: new FakeObjectId(C), title: 'kept two' },
    ];
    const result = partitionByReference(rows, [C, A], row => String(row._id));
    expect(result).toEqual({ deletable: [rows[1]], spared: [rows[0], rows[2]] });
    // The same objects, not copies — cleanup-past.ts prints the titles of exactly what it keeps.
    expect(result.spared[0]).toBe(rows[0]);
  });
});

describe('chunk', () => {
  it('slices into runs of at most size, losing and repeating nothing', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('an empty list is no batches at all', () => {
    expect(chunk([], 3)).toEqual([]);
  });

  it('refuses a size that would never advance', () => {
    expect(() => chunk([1], 0)).toThrow(RangeError);
  });
});

describe('splitByReference', () => {
  it('asks about every candidate exactly once, never more than batchSize at a time', async () => {
    const ids = Array.from({ length: 7 }, (_, i) => String(i).padStart(24, '0'));
    const calls: string[][] = [];
    await splitByReference(ids, {
      batchSize: 3,
      lookup: async batch => {
        calls.push([...batch]);
        return [];
      },
    });
    expect(calls.map(call => call.length)).toEqual([3, 3, 1]);
    expect(calls.flat()).toEqual(ids);
  });

  it('keeps what a later batch reports, not only the first', async () => {
    const result = await splitByReference([A, B, C], {
      batchSize: 1,
      lookup: async batch => (batch.includes(C) ? [new FakeObjectId(C)] : []),
    });
    expect(result).toEqual({ deletable: [A, B], spared: [C] });
  });

  it('looks documents up by their idOf key and returns the documents', async () => {
    const rows = [{ _id: new FakeObjectId(A) }, { _id: new FakeObjectId(B) }];
    const asked: string[] = [];
    const result = await splitByReference(rows, {
      idOf: row => String(row._id),
      lookup: async batch => {
        asked.push(...batch);
        return [B];
      },
    });
    expect(asked).toEqual([A, B]);
    expect(result.spared).toEqual([rows[1]]);
  });

  /**
   * THE ONE THAT MATTERS MOST. A reference check that swallows its own failure and answers "nothing
   * references these" turns an Atlas timeout into the exact deletion it exists to prevent.
   */
  it('FAILS CLOSED: a lookup that throws rejects, and is never read as "no references"', async () => {
    await expect(
      splitByReference([A, B], {
        lookup: async () => {
          throw new Error('Atlas timeout');
        },
      })
    ).rejects.toThrow('Atlas timeout');
  });
});
