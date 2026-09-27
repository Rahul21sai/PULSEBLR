import { readFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

/**
 * The notification badge: `public/icon-mono.svg` and the two PNGs rendered from it.
 *
 * Android draws a badge from the ALPHA CHANNEL ONLY. The old badge was `/icon-96.png`, an opaque
 * tile, so every notification carried a solid grey square. Each assertion here is one way that
 * regresses without anyone noticing until a phone shows it.
 */

const PUBLIC = path.resolve(import.meta.dirname, '..', 'public');
const svg = (name: string) => readFileSync(path.join(PUBLIC, name), 'utf8');
const tracePath = (source: string) => source.match(/<path d="([^"]+)"/)?.[1];

describe('public/icon-mono.svg', () => {
  it('draws the SAME trace as the app tile, copied rather than redrawn', () => {
    expect(tracePath(svg('icon-mono.svg'))).toBeTruthy();
    expect(tracePath(svg('icon-mono.svg'))).toBe(tracePath(svg('icon-512.svg')));
  });

  it('has no background to fill the alpha channel, and strokes in white', () => {
    const source = svg('icon-mono.svg');
    expect(source).not.toMatch(/<rect\b/);
    expect(source).toMatch(/stroke="#ffffff"/i);
    expect(source).toMatch(/fill="none"/);
  });
});

describe.each([72, 96])('public/badge-%i.png', size => {
  const file = path.join(PUBLIC, `badge-${size}.png`);

  it('is a 32-bit RGBA PNG at its exact size', () => {
    const png = readFileSync(file);
    // IHDR: width at 16, height at 20, colour type at 25. Type 6 is truecolour WITH alpha.
    expect(png.readUInt32BE(16)).toBe(size);
    expect(png.readUInt32BE(20)).toBe(size);
    expect(png[25]).toBe(6);
  });

  it('is transparent around the trace, opaque on it, and the trace spans ~70% of the width', async () => {
    const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
    expect(info.channels).toBe(4);
    const alpha = (x: number, y: number) => data[(y * info.width + x) * 4 + 3];

    // Every corner is fully transparent: nothing paints a ground.
    for (const [x, y] of [[0, 0], [size - 1, 0], [0, size - 1], [size - 1, size - 1]]) {
      expect(alpha(x, y)).toBe(0);
    }

    let minX = size;
    let maxX = -1;
    let opaque = 0;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const a = alpha(x, y);
        if (a > 0) {
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
        }
        if (a === 255) opaque += 1;
      }
    }
    expect(opaque).toBeGreaterThan(0);
    // Mostly empty: a trace, not a tile.
    expect(opaque / (size * size)).toBeLessThan(0.3);
    const span = (maxX - minX + 1) / size;
    expect(span).toBeGreaterThan(0.64);
    expect(span).toBeLessThan(0.76);
  });
});
