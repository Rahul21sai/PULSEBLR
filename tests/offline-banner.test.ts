/**
 * `OfflineBanner` — the two contracts that make it honest.
 *
 * 1. It claims "offline" only on evidence. `navigator.onLine` is reliable only when it says
 *    `false`; a missing value must read as online, or an embedded webview without the property
 *    would show a permanent false banner.
 * 2. The server claims nothing. The server snapshot is "online", so the server HTML holds an EMPTY
 *    live region: hydration agrees with it, and the region already exists when the client later
 *    fills it, which is what makes screen readers announce the change.
 *
 * Rendered through `react-dom/server` with `createElement`, as `ui-classname.test.ts` does, so this
 * stays a `.ts` file inside vitest's pure-function scope.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import OfflineBanner, { isOnline } from '@/app/components/OfflineBanner';

describe('isOnline: only an explicit false is evidence of being offline', () => {
  it('reads navigator.onLine', () => {
    expect(isOnline({ onLine: true })).toBe(true);
    expect(isOnline({ onLine: false })).toBe(false);
  });

  it('claims nothing it cannot see', () => {
    expect(isOnline(undefined)).toBe(true);
    expect(isOnline(null)).toBe(true);
    expect(isOnline({})).toBe(true);
  });
});

describe('OfflineBanner on the server', () => {
  const html = renderToStaticMarkup(createElement(OfflineBanner));

  it('renders the live region, and nothing inside it', () => {
    expect(html).toMatch(/^<div[^>]*role="status"[^>]*><\/div>$/);
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toMatch(/offline/i);
  });
});
