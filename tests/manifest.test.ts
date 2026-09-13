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
  screenshots: {
    src: string;
    sizes: string;
    type: string;
    form_factor: 'narrow' | 'wide';
    label?: string;
  }[];
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

/** Every `src` the manifest references — icons, screenshots and shortcut icons alike. */
function allReferencedSources(): string[] {
  const fromIcons = manifest.icons.map((i) => i.src);
  const fromScreenshots = manifest.screenshots.map((s) => s.src);
  const fromShortcuts = manifest.shortcuts.flatMap((s) => (s.icons ?? []).map((i) => i.src));
  return [...fromIcons, ...fromScreenshots, ...fromShortcuts];
}

/** `"1080x1920"` -> `{ w, h }`. */
function parseSizes(sizes: string): { w: number; h: number } {
  const [w, h] = sizes.split('x').map(Number);
  return { w, h };
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

  it.each(['icon-192.svg', 'icon-512.svg'])(
    '%s is filled with --accent, not a stale brand colour',
    (file) => {
      // THE THIRD COLOUR DRIFT IN THIS FEATURE, and the one no sweep could ever have found. Both
      // tiles hardcoded #0071E3 and their own comment called it "the one brand colour the design
      // system actually defines". That was true when they were written; globals.css now defines a
      // single accent, #12513C, and --blue survives only as a migration alias labelled "not part
      // of the palette". So the home-screen icon, the launcher icon and the Play feature graphic
      // were all Apple-blue while every surface in the product was deep green.
      //
      // A hex inside an SVG is not a token, so nothing validated it: not the design-token probe
      // (which reads computed CSS), not a `grep '#'` over app/ (this lives in public/), and not
      // a reviewer, because the comment asserted the value was correct. app/components/Logo.tsx
      // was never affected — it uses stroke="currentColor" and inherits the accent.
      //
      // The PNGs are generated FROM these files, so guarding the source guards all 16 outputs.
      const css = readFileSync(path.join(ROOT, 'app', 'globals.css'), 'utf8');
      const accent = css.match(/--accent:\s*(#[0-9A-Fa-f]{6})/);
      expect(accent, 'could not find --accent in app/globals.css').toBeTruthy();

      const svg = readFileSync(path.join(PUBLIC_DIR, file), 'utf8');
      const fill = svg.match(/<rect[^>]*\bfill="(#[0-9A-Fa-f]{6})"/);
      expect(fill, `could not find the ground <rect fill> in ${file}`).toBeTruthy();

      expect(fill![1].toUpperCase()).toBe(accent![1].toUpperCase());
    }
  );
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

describe('screenshot geometry', () => {
  /**
   * EVERY RULE HERE DEGRADES SILENTLY. Chrome does not warn when a screenshot set is invalid; it
   * simply drops the richer install dialog and shows the plain one, so the feature looks like it
   * was never built. The nastiest is the shared-aspect-ratio rule: a single 1080x1921 among
   * 1080x1920s disqualifies the whole set, and no amount of looking at the images reveals it.
   */
  const narrow = manifest.screenshots.filter((s) => s.form_factor === 'narrow');
  const wide = manifest.screenshots.filter((s) => s.form_factor === 'wide');

  it('has at least one narrow screenshot, and Play’s minimum of two overall', () => {
    expect(narrow.length).toBeGreaterThanOrEqual(1);
    expect(manifest.screenshots.length).toBeGreaterThanOrEqual(2);
  });

  it('respects the platform display caps', () => {
    // Android shows at most 5 narrow; desktop at most 8 wide. Extra entries are ignored, so an
    // over-long list is dead weight that still has to be generated and served.
    expect(narrow.length).toBeLessThanOrEqual(5);
    expect(wide.length).toBeLessThanOrEqual(8);
  });

  it.each(manifest.screenshots.map((s) => [s.src, s.sizes] as const))(
    '%s sides are within 320..3840 and the ratio is at most 2.3',
    (_src, sizes) => {
      const { w, h } = parseSizes(sizes);
      for (const side of [w, h]) {
        expect(side).toBeGreaterThanOrEqual(320);
        expect(side).toBeLessThanOrEqual(3840);
      }
      const ratio = Math.max(w, h) / Math.min(w, h);
      // 1080x1920 is 1.78, which also clears Play's stricter 2x listing rule.
      expect(ratio).toBeLessThanOrEqual(2.3);
    }
  );

  it('every narrow screenshot shares one aspect ratio', () => {
    const ratios = new Set(
      narrow.map((s) => {
        const { w, h } = parseSizes(s.sizes);
        return (w / h).toFixed(4);
      })
    );
    expect(
      [...ratios],
      'mixed aspect ratios disqualify the whole set with no warning anywhere'
    ).toHaveLength(1);
  });

  it('declares src, sizes and type on every entry', () => {
    for (const shot of manifest.screenshots) {
      expect(shot.src).toBeTruthy();
      expect(shot.sizes).toMatch(/^\d+x\d+$/);
      // Chrome drops an entry missing `type` rather than sniffing it.
      expect(shot.type).toBe('image/png');
      expect(['narrow', 'wide']).toContain(shot.form_factor);
    }
  });

  it('declared sizes match the real pixels on disk', () => {
    for (const shot of manifest.screenshots) {
      const { width, height } = pngHeader(path.join(PUBLIC_DIR, shot.src.slice(1)));
      const { w, h } = parseSizes(shot.sizes);
      expect(`${shot.src} ${width}x${height}`).toBe(`${shot.src} ${w}x${h}`);
    }
  });

  it('every screenshot is 24-bit with no alpha, so Play can take these files directly', () => {
    // Play requires JPEG or 24-bit PNG with no alpha for listing screenshots. Chromium already
    // emits exactly that here (omitBackground defaults to false and these pages paint an opaque
    // ground), so there is deliberately no separate flattened copy — an earlier version wrote one
    // to store-assets/screenshots/, which cost 1.4 MB of duplicates, satisfied no requirement the
    // originals did not, and on the event page made the file 56% larger.
    //
    // THIS ASSERTION IS WHAT MAKES THAT SAFE. It pins the property on the files themselves, so if
    // a future Chromium starts emitting an alpha channel this fails and the flatten step can come
    // back then — rather than running forever against a requirement that was already met.
    for (const shot of manifest.screenshots) {
      const file = path.join(PUBLIC_DIR, shot.src.slice(1));
      expect(pngHeader(file).colorType, `${shot.src} must be 24-bit with no alpha for Play`).toBe(
        2
      );
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
