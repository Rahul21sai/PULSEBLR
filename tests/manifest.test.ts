import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

/**
 * The PWA manifest, asserted against the files and tokens it claims to agree with.
 *
 * WHY THIS READS SOURCE FILES FROM A PURE SUITE. `tests/card-metadata.test.ts` set the
 * precedent and its reasoning applies verbatim: it is worth one `readFileSync` to make a
 * documented, already-repeated, silent-by-construction failure impossible to land.
 *
 * The failure in question is colour drift, and it has already happened TWICE in this file:
 *
 *   - `theme_color` was `#F5F5F7`, the cool grey the design system retired. `app/layout.tsx`
 *     was corrected to `#FAF9F5` during the Phase-3 sweep and the manifest copy was missed.
 *     CLAUDE.md records the layout-side fix and does not mention this file.
 *   - `background_color` was `#ffffff` against a `--paper` of `#FAF9F5`, so the install splash
 *     flashed white and then repainted warm.
 *
 * Neither could fail loudly. A manifest colour is not validated by anything, produces no
 * console warning, and is only visible as a flash of the wrong colour on a device nobody is
 * looking at. CLAUDE.md's instruction was "keep it in step with `--paper` by hand", which is
 * exactly the kind of instruction that survives three sweep rounds without being followed.
 * A green pipeline enforces it instead.
 *
 * The other half of the file is existence and geometry: a manifest naming a file that is not
 * there is silent in every browser, and a declared `sizes` that disagrees with the real pixels
 * makes a launcher pick the wrong asset. Both are cheap to assert and invisible otherwise.
 */

const ROOT = path.join(import.meta.dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

const manifest = JSON.parse(
  readFileSync(path.join(PUBLIC_DIR, 'manifest.json'), 'utf8')
) as {
  id: string;
  start_url: string;
  scope: string;
  display: string;
  display_override: string[];
  theme_color: string;
  background_color: string;
  icons: { src: string; sizes: string; type: string; purpose?: string }[];
  shortcuts: { url: string; icons?: { src: string; sizes: string; type?: string }[] }[];
  share_target?: unknown;
};

/** Width, height, bit depth and colour type straight out of a PNG's IHDR chunk. */
function pngHeader(file: string) {
  const b = readFileSync(file);
  const signature = b.subarray(0, 8).toString('hex');
  if (signature !== '89504e470d0a1a0a') {
    throw new Error(`${file} is not a PNG (signature ${signature})`);
  }
  return {
    width: b.readUInt32BE(16),
    height: b.readUInt32BE(20),
    bitDepth: b.readUInt8(24),
    /** 2 = RGB (24-bit, no alpha), 6 = RGBA (32-bit). */
    colorType: b.readUInt8(25),
  };
}

/** Every `src` the manifest references, from both the icon list and the shortcut icons. */
function allReferencedSources(): string[] {
  const fromIcons = manifest.icons.map((i) => i.src);
  const fromShortcuts = manifest.shortcuts.flatMap((s) => (s.icons ?? []).map((i) => i.src));
  return [...fromIcons, ...fromShortcuts];
}

describe('manifest colours agree with the design system', () => {
  it('theme_color equals the themeColor literal in app/layout.tsx', () => {
    const layout = readFileSync(path.join(ROOT, 'app', 'layout.tsx'), 'utf8');
    const match = layout.match(/themeColor:\s*["'](#[0-9A-Fa-f]{6})["']/);

    // If this throws, themeColor was renamed or moved rather than changed. Fix the regex —
    // do not delete the assertion, which is the only thing tying the two files together.
    expect(match, 'could not find a themeColor literal in app/layout.tsx').toBeTruthy();

    expect(manifest.theme_color.toUpperCase()).toBe(match![1].toUpperCase());
  });

  it('background_color equals --paper in app/globals.css', () => {
    const css = readFileSync(path.join(ROOT, 'app', 'globals.css'), 'utf8');
    const match = css.match(/--paper:\s*(#[0-9A-Fa-f]{6})/);
    expect(match, 'could not find --paper in app/globals.css').toBeTruthy();

    // The install splash paints this before any CSS loads, so a mismatch is a visible flash
    // of the wrong ground colour on every cold start.
    expect(manifest.background_color.toUpperCase()).toBe(match![1].toUpperCase());
  });
});

describe('manifest identity', () => {
  it('id resolves to the same URL as start_url', () => {
    // An absent `id` defaults to the resolved `start_url`, so any OTHER value makes this a
    // DISTINCT application: existing installs are orphaned and a user can install twice.
    const origin = 'https://pulseblr.example';
    expect(new URL(manifest.id, origin).href).toBe(new URL(manifest.start_url, origin).href);
  });

  it('is a standalone, root-scoped app', () => {
    expect(manifest.display).toBe('standalone');
    expect(manifest.scope).toBe('/');
    // display_override is evaluated BEFORE display, so standalone must lead or the whole
    // installed presentation changes without `display` having been touched.
    expect(manifest.display_override[0]).toBe('standalone');
  });

  it('keeps the share target that makes the PWA a share destination', () => {
    expect(manifest.share_target).toBeTruthy();
  });
});

describe('every referenced file exists at the declared size', () => {
  it.each(allReferencedSources())('%s exists in public/', (src) => {
    expect(src.startsWith('/'), `${src} should be a root-relative path`).toBe(true);
    expect(existsSync(path.join(PUBLIC_DIR, src.slice(1))), `${src} is missing`).toBe(true);
  });

  it('declared sizes match the real pixel dimensions of every PNG', () => {
    const pngs = manifest.icons.filter((i) => i.type === 'image/png');
    expect(pngs.length, 'expected PNG icons in the manifest').toBeGreaterThan(0);

    for (const icon of pngs) {
      const { width, height } = pngHeader(path.join(PUBLIC_DIR, icon.src.slice(1)));
      const [w, h] = icon.sizes.split('x').map(Number);
      expect(`${icon.src} ${width}x${height}`).toBe(`${icon.src} ${w}x${h}`);
    }
  });

  it('ships the 192 and 512 raster pair browsers require', () => {
    const raster = manifest.icons.filter((i) => i.type === 'image/png');
    for (const size of ['192x192', '512x512']) {
      expect(
        raster.some((i) => i.sizes === size),
        `no PNG icon at ${size}`
      ).toBe(true);
    }
  });

  it('declares any and maskable as separate purposes', () => {
    // Per spec an unrecognised purpose token invalidates the WHOLE entry, so splitting means a
    // UA that dislikes one keyword still gets the other. It also makes Bubblewrap's
    // maskableIconUrl choice unambiguous instead of a substring match on "any maskable".
    const purposes = manifest.icons.map((i) => i.purpose);
    expect(purposes).toContain('any');
    expect(purposes).toContain('maskable');
  });

  it('uses no SVG for shortcut icons', () => {
    // The Android launcher cannot rasterise an SVG shortcut icon; it renders nothing.
    for (const shortcut of manifest.shortcuts) {
      for (const icon of shortcut.icons ?? []) {
        expect(icon.src.endsWith('.svg'), `${shortcut.url} shortcut uses an SVG icon`).toBe(
          false
        );
        expect(icon.type).toBe('image/png');
      }
    }
  });
});

describe('platform icons outside the manifest', () => {
  it('app/apple-icon.png is 180x180 with NO alpha channel', () => {
    // iOS composites transparency onto BLACK and applies its own mask, so the source must be
    // opaque and full-bleed. Next emits the <link rel="apple-touch-icon"> for this file; the
    // tag that used to be hand-written in layout.tsx pointed at an SVG, which iOS ignores
    // entirely -- it screenshotted the page for the home screen instead.
    const { width, height, colorType } = pngHeader(path.join(ROOT, 'app', 'apple-icon.png'));
    expect({ width, height }).toEqual({ width: 180, height: 180 });
    expect(colorType, 'expected colour type 2 (RGB, no alpha)').toBe(2);
  });

  it('app/favicon.ico is a multi-image ICO whose PNGs are all RGBA', () => {
    // THE RGBA PART IS WHY THIS ASSERTION IS SPECIFIC. An earlier version of this test checked
    // only that each embedded image was a PNG, and passed — while `next build` failed with
    // "Format error decoding Ico: The PNG is not in RGBA format!". Next's ICO decoder rejects
    // 24-bit embedded PNGs outright, so colour type is not cosmetic here, it is the difference
    // between a build and no build. A test that a build can still fail past is worth widening.
    const ico = readFileSync(path.join(ROOT, 'app', 'favicon.ico'));
    expect(ico.readUInt16LE(0)).toBe(0); // reserved
    expect(ico.readUInt16LE(2)).toBe(1); // 1 = icon
    const count = ico.readUInt16LE(4);
    expect(count).toBeGreaterThanOrEqual(3);

    for (let i = 0; i < count; i++) {
      const entry = 6 + 16 * i;
      const offset = ico.readUInt32LE(entry + 12);
      const embedded = ico.subarray(offset, offset + 8);
      expect(embedded.toString('hex'), `ICO image ${i} is not a PNG`).toBe('89504e470d0a1a0a');

      // IHDR colour type sits 25 bytes into the embedded PNG. 6 = RGBA.
      const colorType = ico.readUInt8(offset + 25);
      expect(colorType, `ICO image ${i} must be RGBA (colour type 6) or next build fails`).toBe(6);
    }
  });
});

describe('Play Store listing assets', () => {
  const STORE = path.join(ROOT, 'store-assets');

  it('the feature graphic is exactly 1024x500 with no alpha', () => {
    // Play rejects any other size, and rejects an alpha channel here.
    const { width, height, colorType } = pngHeader(path.join(STORE, 'feature-graphic.png'));
    expect({ width, height }).toEqual({ width: 1024, height: 500 });
    expect(colorType, 'Play requires 24-bit PNG with no alpha').toBe(2);
  });

  it('the listing icon is 512x512 WITH an alpha channel', () => {
    // The opposite requirement from the feature graphic, which is why the generator renders
    // this one differently. See the comment in scripts/generate-icons.js.
    const { width, height, colorType } = pngHeader(path.join(STORE, 'icon-512.png'));
    expect({ width, height }).toEqual({ width: 512, height: 512 });
    expect(colorType, "Play's listing icon spec asks for 32-bit PNG with alpha").toBe(6);
  });

  it('is not served publicly', () => {
    // Store artwork is not a web asset. Under public/ it would be published for anyone to
    // fetch and handed to sw.js to cache-first for free.
    expect(existsSync(path.join(PUBLIC_DIR, 'store'))).toBe(false);
  });
});
