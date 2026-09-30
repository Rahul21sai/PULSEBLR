/**
 * The two public lists — `/topics/[slug]` and `/digest` — render the same HTML for every visitor, and
 * say "saved" on a row only in the browser of the reader who saved it.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT THIS PINS, as source-text assertions like `event-detail-dto.test.ts` makes about the admin
 * modal, because the property is architectural and no pure function owns it:
 *
 *   1. Both pages render their rows through `ViewerEventRows`, which fills in `tracked` after
 *      hydration for a signed-in reader. Before it, both rendered bare `EventRow`s whose loaders never
 *      set `tracked`, so every Save button read "not saved" to everyone.
 *   2. Neither page reads a session while it renders. The tempting fix for (1) — look the reader up
 *      in the loader and call `loadViewerStates` — would cache one visitor's saved events into an ISR
 *      page served to everybody for an hour, and would break the digest's own stated guarantee. This
 *      is the guard against that "fix".
 *   3. The topic page projects its listed rows through `FEED_SELECT`. With no projection it serialised
 *      whole documents into a page cached for everyone — `createdByUserId` and `clusterKey` included,
 *      which on an approved submission is its author's Google `sub`, twice.
 *
 * The reading of the reader's saved set itself is `trackedEventIds`, pinned in
 * `tracker-entry-view.test.ts` against the shape the tracker route actually sends.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { FEED_FIELDS } from '@/lib/events/query';
import { stripComments } from './support/a11y-scan';

const root = path.resolve(import.meta.dirname, '..');
/** Source with comments blanked, so a comment that NAMES a forbidden call cannot trip or satisfy a rule. */
const code = (file: string) => stripComments(readFileSync(path.join(root, file), 'utf8'));

const PAGES = ['app/topics/[slug]/page.tsx', 'app/digest/page.tsx'] as const;

describe('the public lists render their rows through ViewerEventRows', () => {
  for (const page of PAGES) {
    it(`${page} hands its rows to ViewerEventRows, not to a bare EventRow`, () => {
      const src = code(page);
      expect(src).toMatch(/<ViewerEventRows\b/);
      expect(src).not.toMatch(/<EventRow\b/);
    });
  }

  // The gate's BEHAVIOUR is pinned where it is defined (`outbox-auto-drain.test.ts`); this pins that
  // the component is wired through it and asks nothing before it has a reader.
  it('ViewerEventRows asks only for a signed-in reader, and only the tracker route', () => {
    const src = code('app/topics/ViewerEventRows.tsx');
    expect(src).toMatch(/const viewerId = signedInAccount\(status, session\?\.user\?\.id\);/);
    expect(src).toMatch(/if \(!viewerId \|\| !hasRows\) return;/);
    expect(src).toContain("fetch('/api/tracker'");
  });
});

describe('neither public list knows its reader while it renders', () => {
  // Any of these in a page module would make its HTML depend on who asked for it.
  const SESSION_READS = [/\bgetCurrentUserId\b/, /\bauth\s*\(/, /from ['"]@\/auth['"]/, /\bcookies\s*\(/, /\bheaders\s*\(/];

  for (const page of PAGES) {
    it(`${page} reads no session`, () => {
      const src = code(page);
      for (const pattern of SESSION_READS) expect(src, String(pattern)).not.toMatch(pattern);
    });
  }
});

describe('the topic page projects its rows through the feed’s allowlist', () => {
  it('selects FEED_SELECT on the query whose rows reach the client', () => {
    expect(code('app/topics/[slug]/page.tsx')).toMatch(/\.select\(FEED_SELECT\)/);
  });

  it('and that allowlist carries none of the fields the whole document leaked', () => {
    for (const field of ['createdByUserId', 'clusterKey', 'dedupHash', 'visibility', 'description']) {
      expect(FEED_FIELDS as readonly string[]).not.toContain(field);
    }
  });
});
