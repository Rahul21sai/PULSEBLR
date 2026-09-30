import { readFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

/**
 * The maskable icons, MEASURED rather than trusted. A launcher may crop a maskable icon to any
 * shape and only a centred circle is guaranteed visible, so the file needs a solid full-bleed ground
 * and every mark inside that circle.
 *
 * WHY BOTH FILES ARE BYTE-IDENTICAL TO THE `any` TILES, AND WHY THAT IS CORRECT. CLAUDE.md §18 listed
 * the identity as an open problem ("adaptive masks may crop it"). Measured 2026-09-30 with this
 * suite, they cannot: public/icon-512.svg was authored for the safe zone, and its mark reaches 33.8%
 * of the size from the centre at 512 and 34.0% at 192, against both bounds below. There was nothing
 * to re-render; what this suite adds is that the fit can no longer be assumed.
 *
 * TWO BOUNDS, AND ANDROID'S IS THE ONE THAT BINDS.
 *   - Web manifest: the safe zone is a circle of radius 40% of the icon's size.
 *   - Android, as Bubblewrap lays the file out. Its adaptive-icon template draws ic_maskable inset
 *     8.5dp inside the 108dp layer, so the image is 91dp across and Android's 66dp safe zone ("never
 *     clipped by a shaped mask defined by an OEM") is 33/91 = 36.3% of it. A mark between 36.3% and
 *     40% passes the web rule and is still not guaranteed on a phone. The inset is read from the
 *     pinned template rather than restated, so a Bubblewrap upgrade that moves it moves this bound.
 */

const ROOT = path.resolve(import.meta.dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const WEB_SAFE_RADIUS = 0.4;
const ADAPTIVE_LAYER_DP = 108;
const ANDROID_SAFE_ZONE_DP = 66;

/** The ground both maskable files are rendered on: the full-bleed rect of their source, icon-512.svg. */
function groundColour(): number[] {
  const svg = readFileSync(path.join(PUBLIC, 'icon-512.svg'), 'utf8');
  const hex = svg.match(/<rect[^>]*\bfill="#([0-9A-Fa-f]{6})"/)?.[1];
  if (!hex) throw new Error('could not find the ground <rect fill> in public/icon-512.svg');
  return [0, 2, 4].map(offset => parseInt(hex.slice(offset, offset + 2), 16));
}

/** The inset Bubblewrap 1.25.0's ic_launcher.xml draws @mipmap/ic_maskable at, in dp. */
function bubblewrapMaskableInsetDp(): number {
  const template = readFileSync(path.join(ROOT, 'node_modules', '@bubblewrap', 'core', 'template_project',
    'app', 'src', 'main', 'res', 'mipmap-anydpi-v26', 'ic_launcher.xml'), 'utf8');
  const item = template.match(/<item\b[^>]*android:drawable="@mipmap\/ic_maskable"[^>]*\/>/)?.[0];
  if (!item) throw new Error('Bubblewrap ic_launcher.xml no longer draws @mipmap/ic_maskable in a layer-list item');
  const insets = ['top', 'right', 'bottom', 'left'].map(side => item.match(new RegExp(`android:${side}="([\\d.]+)dp"`))?.[1]);
  if (insets.some(inset => inset === undefined) || new Set(insets).size !== 1) {
    throw new Error(`Bubblewrap ic_maskable insets are no longer one uniform dp value: ${insets.join(', ')}`);
  }
  return Number(insets[0]);
}

/** Android's guaranteed-visible radius as a fraction of the maskable image's size, under that inset. */
function androidSafeRadius(): number {
  return (ANDROID_SAFE_ZONE_DP / 2) / (ADAPTIVE_LAYER_DP - 2 * bubblewrapMaskableInsetDp());
}

describe('the safe zone the maskable icons are measured against', () => {
  it('reads the 8.5dp inset from the pinned Bubblewrap template, which makes Android the binding bound', () => {
    expect(bubblewrapMaskableInsetDp()).toBe(8.5);
    expect(androidSafeRadius()).toBeCloseTo(33 / 91, 10);
    expect(androidSafeRadius()).toBeLessThan(WEB_SAFE_RADIUS);
  });
});

describe.each([192, 512])('public/icon-maskable-%i.png', size => {
  it('is an opaque full-bleed tile: ground colour in every corner, and every mark inside the safe circle', async () => {
    const { data, info } = await sharp(path.join(PUBLIC, `icon-maskable-${size}.png`)).raw().toBuffer({ resolveWithObject: true });
    expect([info.width, info.height]).toEqual([size, size]);
    const ground = groundColour();
    const pixel = (x: number, y: number) => {
      const offset = (y * size + x) * info.channels;
      return [...data.subarray(offset, offset + info.channels)];
    };
    // Opaque AND the ground colour. A transparent pixel is not ground: Bubblewrap's layer-list paints
    // white behind ic_maskable, so it would show as a white notch in the tile.
    const isGround = (value: number[]) =>
      value[0] === ground[0] && value[1] === ground[1] && value[2] === ground[2] && (info.channels < 4 || value[3] === 255);

    for (const [x, y] of [[0, 0], [size - 1, 0], [0, size - 1], [size - 1, size - 1]]) {
      expect(pixel(x, y), `corner ${x},${y}`).toEqual(info.channels < 4 ? ground : [...ground, 255]);
    }

    const centre = size / 2;
    let marks = 0;
    let farthest = 0;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        if (isGround(pixel(x, y))) continue;
        marks += 1;
        // The pixel square's corner farthest from the centre, so an edge pixel cannot round inward.
        const dx = Math.max(Math.abs(x - centre), Math.abs(x + 1 - centre));
        const dy = Math.max(Math.abs(y - centre), Math.abs(y + 1 - centre));
        farthest = Math.max(farthest, Math.hypot(dx, dy) / size);
      }
    }
    // Without a mark every bound below would pass vacuously (a blank green square is "safe").
    // Measured 6.4% of the pixels at 512 and 6.5% at 192.
    expect(marks / (size * size), 'share of non-ground pixels').toBeGreaterThan(0.02);
    // Measured 0.3381 at 512 and 0.3401 at 192.
    expect(farthest, `farthest non-ground pixel, as a fraction of ${size}px`).toBeLessThanOrEqual(WEB_SAFE_RADIUS);
    expect(farthest, `farthest non-ground pixel against Android's safe zone under Bubblewrap (${androidSafeRadius().toFixed(4)})`)
      .toBeLessThanOrEqual(androidSafeRadius());
  });
});
