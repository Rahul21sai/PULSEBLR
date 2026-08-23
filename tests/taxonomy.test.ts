import { describe, it, expect } from 'vitest';
import {
  EVENT_CATEGORIES,
  CATEGORY_GROUPS,
  TECH_CATEGORY_NAMES,
  GATHERING_CATEGORY_NAMES,
  OTHER_CATEGORY_NAMES,
} from '@/lib/event-types';
import { CATEGORY_MIGRATION } from '@/lib/models/Event';

/**
 * The taxonomy is referenced by the schema enum, the LLM system prompt, the filter rail,
 * the Add Event picker and the migration script. Drift between any two of them has already
 * caused real breakage twice: the Add Event form offered six RETIRED categories so every
 * manual submission failed enum validation, and a stale server-side default of
 * 'Networking/Meetup' did the same.
 *
 * These tests make that class of drift impossible to ship.
 */
describe('category taxonomy', () => {
  it('has no duplicates', () => {
    expect(new Set(EVENT_CATEGORIES).size).toBe(EVENT_CATEGORIES.length);
  });

  it('is exactly the union of its three groups, in order', () => {
    const flat = CATEGORY_GROUPS.flatMap(g => [...g.names]);
    expect(flat).toEqual([...EVENT_CATEGORIES]);
  });

  it('assigns every category to exactly one group', () => {
    const counts = new Map<string, number>();
    for (const group of CATEGORY_GROUPS) {
      for (const name of group.names) counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    for (const category of EVENT_CATEGORIES) {
      expect(counts.get(category), `${category} should be in exactly one group`).toBe(1);
    }
  });

  it('keeps the three group constants consistent with CATEGORY_GROUPS', () => {
    const byId = new Map(CATEGORY_GROUPS.map(g => [g.id, [...g.names]]));
    expect(byId.get('tech')).toEqual([...TECH_CATEGORY_NAMES]);
    expect(byId.get('gathering')).toEqual([...GATHERING_CATEGORY_NAMES]);
    expect(byId.get('other')).toEqual([...OTHER_CATEGORY_NAMES]);
  });

  it('does not treat Product/Design as a tech topic', () => {
    // It describes a discipline that attends tech events, not a software/hardware subject.
    // techOnly is defined by TECH_CATEGORY_NAMES, so this changes what the default feed is.
    expect(TECH_CATEGORY_NAMES).not.toContain('Product/Design');
    expect(GATHERING_CATEGORY_NAMES).toContain('Product/Design');
  });
});

describe('CATEGORY_MIGRATION', () => {
  it('maps every retired value onto a CURRENT category', () => {
    const valid = new Set<string>(EVENT_CATEGORIES);
    for (const [retired, replacement] of Object.entries(CATEGORY_MIGRATION)) {
      expect(valid.has(replacement), `${retired} -> ${replacement} must be a current category`).toBe(true);
    }
  });

  it('never maps a current category away', () => {
    // A live category appearing as a KEY would silently rewrite good data on the next
    // migration run.
    const valid = new Set<string>(EVENT_CATEGORIES);
    for (const retired of Object.keys(CATEGORY_MIGRATION)) {
      expect(valid.has(retired), `${retired} is still current and must not be migrated`).toBe(false);
    }
  });

  it('covers the values that actually broke things', () => {
    // Each of these was found in stored documents or hardcoded in the UI after the
    // 32 -> 22 consolidation.
    for (const retired of [
      'Networking/Meetup',
      'Summit/Conference',
      'Career/Job Fair',
      'Fintech',
      'Government',
      'Corporate',
    ]) {
      expect(CATEGORY_MIGRATION[retired], `${retired} needs a migration target`).toBeTruthy();
    }
  });

  it('resolves in a single hop — no chains', () => {
    for (const replacement of Object.values(CATEGORY_MIGRATION)) {
      expect(CATEGORY_MIGRATION[replacement]).toBeUndefined();
    }
  });
});
