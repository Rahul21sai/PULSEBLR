/**
 * Pinch zoom must stay available (WCAG 1.4.4).
 *
 * `app/layout.tsx` set a maximum scale of 1. Chrome honours that by disabling pinch zoom outright,
 * and the Play Store build is a TWA running in Chrome, so the primary platform could not zoom at
 * all. The usual reason to add it back is iOS's focus auto-zoom on inputs under 16px; the fix for
 * that is a 16px input, not a zoom lock — so this guards against the "fix" returning.
 *
 * Read as text, like `manifest.test.ts` reads `themeColor`: importing the layout would pull in
 * `next/font`, which only works inside Next's compiler.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const layout = readFileSync(path.join(import.meta.dirname, '..', 'app', 'layout.tsx'), 'utf8');

describe('root viewport', () => {
  it('never caps the zoom level or disables scaling', () => {
    expect(layout).not.toMatch(/\bmaximumScale\s*:/);
    expect(layout).not.toMatch(/\buserScalable\s*:/);
  });

  it('keeps viewportFit cover, which the safe-area insets depend on', () => {
    expect(layout).toMatch(/viewportFit:\s*["']cover["']/);
  });
});
