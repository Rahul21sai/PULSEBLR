import { describe, expect, it } from 'vitest';

import { readSharedEvent, validateManualEvent } from '@/lib/events/manual-input';

/**
 * The Android / PWA share target: `GET /add-event?title=&text=&url=` (public/manifest.json, and the
 * TWA's copy of it, which `tests/twa-manifest.test.ts` keeps in parity).
 *
 * THE CASE THAT WAS BROKEN: Android's share intent has no URL slot. It carries a subject and a text,
 * Chrome maps those to `title` and `text`, and `url` usually arrives EMPTY with the link inside
 * `text`. The page read only `url`, so sharing an event page from the share sheet dropped the bare
 * link into Description and left both "Event URL" and the importer empty.
 */

describe('readSharedEvent — finding the link', () => {
  it('finds a link shared as TEXT, with an empty url parameter', () => {
    const shared = readSharedEvent({ title: 'AI Agents Night · Luma', text: 'https://lu.ma/abc123', url: '' });
    expect(shared.url).toBe('https://lu.ma/abc123');
    expect(shared.title).toBe('AI Agents Night · Luma');
    // A text that is nothing but the link is not a description.
    expect(shared.description).toBe('');
  });

  it('finds a link inside prose, and keeps the prose whole — link included', () => {
    const text = 'Come to the Rust meetup this Friday! https://www.meetup.com/rust-bangalore/events/123/.';
    const shared = readSharedEvent({ text });
    expect(shared.url).toBe('https://www.meetup.com/rust-bangalore/events/123/');
    expect(shared.description).toBe(text);
  });

  it('prefers the url parameter when a sender does fill it', () => {
    const shared = readSharedEvent({ url: 'https://lu.ma/from-url', text: 'also https://lu.ma/from-text' });
    expect(shared.url).toBe('https://lu.ma/from-url');
  });

  it('falls back to a link in the TITLE when that is the only place it is', () => {
    const shared = readSharedEvent({ title: 'https://hasgeek.com/fifthelephant/2026/' });
    expect(shared.url).toBe('https://hasgeek.com/fifthelephant/2026/');
    // A title that is only a link is not a title either.
    expect(shared.title).toBe('');
  });

  it('trims sentence punctuation but keeps a balanced parenthesis that belongs to the link', () => {
    expect(readSharedEvent({ text: '(see https://lu.ma/x)' }).url).toBe('https://lu.ma/x');
    expect(readSharedEvent({ text: 'ref https://en.wikipedia.org/wiki/Foo_(bar), ok' }).url).toBe(
      'https://en.wikipedia.org/wiki/Foo_(bar)'
    );
    expect(readSharedEvent({ text: '“https://lu.ma/quoted”' }).url).toBe('https://lu.ma/quoted');
  });

  it('only ever yields an http(s) link', () => {
    expect(readSharedEvent({ url: 'javascript:alert(1)' }).url).toBe('');
    expect(readSharedEvent({ text: 'data:text/html,<script>x</script>' }).url).toBe('');
    expect(readSharedEvent({ text: 'no link here' }).url).toBe('');
  });

  it('yields a link the validator accepts unchanged', () => {
    const { url } = readSharedEvent({ text: 'Details: https://Lu.Ma/Event?ref=share' });
    expect(url).toBe('https://lu.ma/Event?ref=share');
    expect(validateManualEvent({ title: 'x', startDateTime: '2026-10-01T19:00', sourceUrl: url }).fields?.sourceUrl).toBe(url);
  });
});

describe('readSharedEvent — cleaning what was shared', () => {
  it('flattens a multi-line shared title into one line', () => {
    expect(readSharedEvent({ title: 'Platform Night\r\nBengaluru  ' }).title).toBe('Platform Night Bengaluru');
  });

  it('keeps the shared text multi-line, with every line ending as LF', () => {
    expect(readSharedEvent({ text: 'Line one\r\nLine two\rLine three' }).description).toBe(
      'Line one\nLine two\nLine three'
    );
  });

  it('returns empty strings for an empty share, which the page reads as "nothing to prefill"', () => {
    expect(readSharedEvent({})).toEqual({ title: '', description: '', url: '' });
    expect(readSharedEvent({ title: null, text: '   ', url: null })).toEqual({ title: '', description: '', url: '' });
  });
});
