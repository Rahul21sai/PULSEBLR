/**
 * The placeholder `sourceUrl` — what a hand-added event stores when its author gave no link — and
 * every reader that must not treat it as a real page.
 *
 * It is a syntactically perfect https URL, which is the whole problem: every "is this linkable" check
 * passed it, so the event page drew a Register button and an "Organiser's page" link to a host that
 * cannot exist. THE NEGATIVE HALF MATTERS as much as the positive: a predicate that over-matches hides
 * real links on real events, and nobody notices a link that is not there.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  PLACEHOLDER_SOURCE_URL,
  isPlaceholderSourceUrl,
  registrationUrl,
  usableLink,
} from '@/lib/events/placeholder';
import { toMcpEventRow, toMcpEventDetail } from '@/lib/mcp/serialize';

describe('isPlaceholderSourceUrl', () => {
  it('recognises the constant and its harmless spellings', () => {
    expect(isPlaceholderSourceUrl(PLACEHOLDER_SOURCE_URL)).toBe(true);
    expect(isPlaceholderSourceUrl('http://pulseblr.local/manual')).toBe(true);
    expect(isPlaceholderSourceUrl('https://PULSEBLR.LOCAL/manual/')).toBe(true);
    expect(isPlaceholderSourceUrl('  https://pulseblr.local/manual  ')).toBe(true);
    // The pipeline's other stand-in, and any path under the reserved host.
    expect(isPlaceholderSourceUrl('https://pulseblr.local/microsites')).toBe(true);
    expect(isPlaceholderSourceUrl('https://x.pulseblr.local/')).toBe(true);
  });

  it('does NOT match look-alike hosts or real pages', () => {
    for (const url of [
      'https://notpulseblr.local/manual',
      'https://pulseblr.local.evil.com/manual',
      'https://pulseblr.localhost/manual',
      'https://pulseblr.vercel.app/events/1',
      'https://www.meetup.com/x/events/1',
      'https://example.com/?next=https://pulseblr.local/manual',
    ]) {
      expect(isPlaceholderSourceUrl(url), url).toBe(false);
    }
  });

  it('is false for absent, blank, malformed and non-http values', () => {
    for (const value of [undefined, null, '', '   ', 'not a url', 'javascript:alert(1)', 42]) {
      expect(isPlaceholderSourceUrl(value)).toBe(false);
    }
  });
});

describe('usableLink and registrationUrl', () => {
  it('usableLink keeps real http(s) links and refuses the placeholder and other schemes', () => {
    expect(usableLink(' https://lu.ma/x ')).toBe('https://lu.ma/x');
    expect(usableLink(PLACEHOLDER_SOURCE_URL)).toBeUndefined();
    expect(usableLink('javascript:alert(1)')).toBeUndefined();
    expect(usableLink('data:text/html,hi')).toBeUndefined();
    expect(usableLink('')).toBeUndefined();
  });

  it('prefers the registration link', () => {
    expect(registrationUrl({ applyLink: 'https://lu.ma/r', sourceUrl: 'https://lu.ma/s' })).toBe('https://lu.ma/r');
  });

  it('falls back to a REAL source page', () => {
    expect(registrationUrl({ applyLink: '', sourceUrl: 'https://meetup.com/e/1' })).toBe('https://meetup.com/e/1');
  });

  it('is null — the no-link state — when the only URL is the placeholder', () => {
    expect(registrationUrl({ sourceUrl: PLACEHOLDER_SOURCE_URL })).toBeNull();
    expect(registrationUrl({ applyLink: null, sourceUrl: PLACEHOLDER_SOURCE_URL })).toBeNull();
  });

  it('never hands a javascript: applyLink to an href, even with a real fallback', () => {
    expect(registrationUrl({ applyLink: 'javascript:alert(1)', sourceUrl: 'https://lu.ma/s' })).toBe('https://lu.ma/s');
  });
});

/**
 * DRIFT GUARD. The create path writes the placeholder; this module recognises it. If the two ever
 * disagree, every hand-added event grows a dead Register button again and nothing errors. Reading a
 * source file from a pure suite is the documented exception (`tests/card-metadata.test.ts`); the
 * assertion passes trivially once the route imports `PLACEHOLDER_SOURCE_URL` instead of a literal.
 */
describe('the create path writes something the predicate recognises', () => {
  it('every pulseblr.local literal in the writers is a placeholder', () => {
    const root = path.resolve(import.meta.dirname, '..');
    for (const file of ['app/api/events/route.ts', 'lib/events/manual-input.ts']) {
      const source = readFileSync(path.join(root, file), 'utf8');
      const literals = source.match(/https?:\/\/[^'"`\s]*pulseblr\.local[^'"`\s]*/g) ?? [];
      for (const literal of literals) {
        expect(isPlaceholderSourceUrl(literal), `${file}: ${literal}`).toBe(true);
      }
    }
  });
});

describe('MCP never hands the placeholder to an assistant as "the source"', () => {
  const base = {
    _id: '6a8c75ac1d13c5f121502f3c',
    title: 'Internal hack day',
    format: 'offline' as const,
    startDateTime: '2026-10-01T13:30:00.000Z',
    source: 'manual',
  };

  it('omits sourceUrl when it is the placeholder, on the row and the detail', () => {
    expect(toMcpEventRow({ ...base, sourceUrl: PLACEHOLDER_SOURCE_URL })).not.toHaveProperty('sourceUrl');
    expect(toMcpEventDetail({ ...base, sourceUrl: PLACEHOLDER_SOURCE_URL })).not.toHaveProperty('sourceUrl');
  });

  it('keeps a real sourceUrl', () => {
    expect(toMcpEventRow({ ...base, sourceUrl: 'https://lu.ma/x' }).sourceUrl).toBe('https://lu.ma/x');
  });
});
