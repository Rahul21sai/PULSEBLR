/**
 * `OfflineBanner` — the three contracts that make it honest.
 *
 * 1. It claims "offline" only on evidence. `navigator.onLine` is reliable only when it says
 *    `false`; a missing value must read as online, or an embedded webview without the property
 *    would show a permanent false banner.
 * 2. The server claims nothing. The server snapshot is "online", so the server HTML holds an EMPTY
 *    live region: hydration agrees with it, and the region already exists when the client later
 *    fills it, which is what makes screen readers announce the change.
 * 3. It promises an upload only when one will happen. "Uploads when you're back online" is printed
 *    only while the outbox's automatic drain is armed for a signed-in account; otherwise it says the
 *    weaker thing that is true in every case. `tests/outbox-auto-drain.test.ts` pins when the drain
 *    is armed; this pins that the banner's two sentences say different things.
 *
 * Rendered through `react-dom/server` with `createElement`, as `ui-classname.test.ts` does, so this
 * stays a `.ts` file inside vitest's pure-function scope.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import OfflineBanner, { isOnline, OfflineNotice } from '@/app/components/OfflineBanner';

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

describe('the notice promises an upload only when the drain will make one', () => {
  const render = (uploadsOnReconnect: boolean) =>
    renderToStaticMarkup(createElement(OfflineNotice, { uploadsOnReconnect }));

  it('while the drain is armed for a signed-in account, it says the capture uploads by itself', () => {
    const html = render(true);
    expect(html).toContain('You’re offline.');
    expect(html).toContain('uploads when you’re back online');
    expect(html).not.toContain('until it uploads');
  });

  it('otherwise it claims only that the capture is kept', () => {
    const html = render(false);
    expect(html).toContain('kept on this device until it uploads');
    expect(html).not.toContain('back online');
  });
});
