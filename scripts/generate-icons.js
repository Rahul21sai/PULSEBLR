#!/usr/bin/env node
/**
 * Rasterise the app tile into every PNG the stores and platforms actually require.
 *
 * WHAT THIS REPLACED, and why it mattered: the previous version of this file WROTE
 * `public/icon-192.svg` and `public/icon-512.svg` from scratch, as a purple `#9333ea` square
 * with the letter "P" in Arial. Those two paths now hold hand-authored PulseBLR tiles whose
 * geometry is shared with `app/components/Logo.tsx`. So the old script was a loaded gun in the
 * repo: running the thing named "generate-icons" destroyed the icons. It is now READ-ONLY with
 * respect to the SVG sources, and every output goes to a distinct filename.
 *
 * WHY PLAYWRIGHT DOES THE RASTERISING: it is already a devDependency (`lib/scrapers/core/
 * render.ts` renders JS-only event pages with it, `scripts/diag-design-tokens.ts` drives a real
 * Chromium), its binaries are already installed, and it is the renderer that will actually
 * display these icons — so what we measure is what ships. It also renders the SVG at each target
 * size natively, so nothing is ever resampled from a larger raster.
 *
 * WHY `sharp` IS ALSO HERE, for exactly two outputs. Chromium's PNG encoder DROPS an alpha
 * channel that carries no transparency, and this artwork is a fully opaque tile — so playwright
 * physically cannot emit 32-bit RGBA for it, with or without `omitBackground`. Two consumers
 * require RGBA anyway:
 *
 *   - `app/favicon.ico`. Next's ICO decoder rejects non-RGBA embedded PNGs outright, and this is
 *     a BUILD failure, not a warning: "Format error decoding Ico: The PNG is not in RGBA format".
 *   - `store-assets/icon-512.png`. Play's listing-icon spec asks for 32-bit PNG with alpha.
 *
 * `sharp` was already present as an OPTIONAL TRANSITIVE dependency of `next`, which is not
 * something to build on — `npm ci --omit=optional` drops it and a Next minor could stop shipping
 * it. It is now a declared, exactly-pinned devDependency instead. The generated files are
 * committed, so a checkout without sharp still builds; only regenerating needs it.
 *
 * THE SOURCE IS THE 512 TILE, NOT THE 192. Both draw the same path, but scaling 512 down loses
 * less than scaling 192 up.
 *
 * MASKABLE vs ANY — deliberately the same artwork, and that is a decision rather than an
 * oversight. `public/icon-512.svg` is authored full-bleed with the trace spanning ~60% of the
 * width, comfortably inside the maskable safe zone (the central 80% circle). Used as `any` it
 * simply reads as an app icon with generous padding, which is normal. Emitting a second, tighter
 * variant would mean redesigning someone's mark to save 12% of margin, so the manifest points
 * both purposes at these files. If a tighter `any` is ever wanted, `TRACE_SCALE` below is the
 * one knob: it rescales the trace about the tile centre and nothing else.
 *
 * Run with `npm run icons`. NOT wired to `postinstall` — `copy-wasm.js` owns that hook, and
 * these outputs are committed artefacts rather than per-install state.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const APP_DIR = path.join(ROOT, 'app');
const SOURCE_SVG = path.join(PUBLIC_DIR, 'icon-512.svg');

/**
 * Play listing artwork. Deliberately NOT under `public/` — it is not a web asset, so serving it
 * would publish 26 KB nobody requests and hand `sw.js` one more thing to cache-first for free.
 */
const STORE_DIR = path.join(ROOT, 'store-assets');

/**
 * Sizes the manifest and the platforms ask for.
 *   48        - Android launcher mdpi, and the smallest Play needs
 *   72 96 144 - Android hdpi/xhdpi/xxhdpi launcher densities
 *   128 256   - Chrome Web Store / desktop install surfaces
 *   152       - iPad home screen
 *   192 512   - the two the web manifest spec effectively requires
 *   384       - Chrome splash on high-density Android
 */
const ICON_SIZES = [48, 72, 96, 128, 144, 152, 192, 256, 384, 512];

/** Sizes that also get a `-maskable` copy, matching the manifest's maskable entries. */
const MASKABLE_SIZES = [192, 512];

/** iOS home screen. 180 is the only size worth shipping; iOS downscales the rest itself. */
const APPLE_ICON_SIZE = 180;

/**
 * Embedded in favicon.ico. 16/32 are the browser tab sizes, 48 covers Windows taskbar pinning,
 * and 256 is what Explorer uses for large-icon views. The Next.js starter favicon this replaced
 * carried all four, so dropping 256 would have been a quiet regression.
 */
const FAVICON_SIZES = [16, 32, 48, 256];

/**
 * 1.0 keeps the authored geometry. Raising it enlarges the trace about the tile centre, which
 * is what a tighter `purpose: "any"` icon would want. See the header before changing it.
 */
const TRACE_SCALE = 1.0;

/** Google Play listing feature graphic. Exactly 1024x500, and Play rejects any other size. */
const FEATURE_GRAPHIC = { width: 1024, height: 500 };

// The design system's single accent (globals.css --accent). Was #0071E3, which went stale
// when the palette landed -- see the comment in public/icon-192.svg.
const BRAND_GROUND = '#12513C';

/**
 * Add an alpha channel to an opaque PNG, producing 32-bit RGBA. Not a visual change — every
 * pixel stays fully opaque — only a container change. See the header for the two callers that
 * require it.
 */
async function toRgba(png) {
  let sharp;
  try {
    sharp = require('sharp');
  } catch {
    throw new Error(
      'sharp is required to write the RGBA outputs (app/favicon.ico and the Play listing icon).\n' +
        'It is a declared devDependency: run `npm install`.'
    );
  }
  return sharp(png).ensureAlpha().png().toBuffer();
}

function readSource() {
  if (!fs.existsSync(SOURCE_SVG)) {
    throw new Error(`Source tile missing: ${SOURCE_SVG}`);
  }
  return fs.readFileSync(SOURCE_SVG, 'utf8');
}

/**
 * Return the source SVG resized to `size`, by rewriting only the root width/height and leaving
 * `viewBox` alone so the drawing scales rather than being cropped.
 */
function svgAtSize(source, size) {
  let svg = source
    .replace(/(<svg[^>]*?)\bwidth="\d+"/, `$1width="${size}"`)
    .replace(/(<svg[^>]*?)\bheight="\d+"/, `$1height="${size}"`);

  if (TRACE_SCALE !== 1.0) {
    // Scale about the 512-space centre: translate in, scale, translate back.
    const c = 256;
    const shift = c - c * TRACE_SCALE;
    svg = svg.replace(
      /(<g\s+transform=")/,
      `$1translate(${shift.toFixed(3)} ${shift.toFixed(3)}) scale(${TRACE_SCALE}) `
    );
  }
  return svg;
}

/** A bare page holding one SVG, with no margin and a transparent ground. */
function pageFor(svg, width, height) {
  return `<!doctype html><meta charset="utf-8">
<style>
  html,body{margin:0;padding:0;background:transparent}
  body{width:${width}px;height:${height}px;overflow:hidden;line-height:0}
  svg{display:block}
</style>${svg}`;
}

/** The Play feature graphic: the tile's mark and wordmark on the brand ground. */
function featureGraphicPage(source) {
  // Reuse the authored path rather than redrawing it, so the graphic cannot drift from the icon.
  const pathMatch = source.match(/<path d="([^"]+)"/);
  const tracePath = pathMatch ? pathMatch[1] : '';

  return `<!doctype html><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@500;700&display=swap" rel="stylesheet">
<style>
  html,body{margin:0;padding:0}
  body{
    width:${FEATURE_GRAPHIC.width}px;height:${FEATURE_GRAPHIC.height}px;
    background:${BRAND_GROUND};
    display:flex;align-items:center;justify-content:center;gap:38px;
    padding:0 64px;box-sizing:border-box;
    font-family:Inter,system-ui,-apple-system,'Segoe UI',sans-serif;
    color:#fff;overflow:hidden;
  }
  .mark{flex:0 0 auto}
  .copy{display:flex;flex-direction:column;gap:16px}
  .name{font-size:78px;font-weight:700;letter-spacing:-0.035em;line-height:1}
  /*
    Each tagline line is its own nowrap block. An earlier version set one string with a <br>
    and let the box wrap: the natural wrap fired BEFORE the <br>, orphaning "to —" on a line of
    its own and turning two lines into three. Explicit lines that refuse to wrap cannot do that.
  */
  .tag{font-size:27px;font-weight:500;letter-spacing:-0.008em;line-height:1.32;opacity:.93}
  .tag span{display:block;white-space:nowrap}
</style>
<div class="mark">
  <svg width="172" height="172" viewBox="0 0 24 24" fill="none" stroke="#ffffff"
       stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"
       xmlns="http://www.w3.org/2000/svg">
    <path d="${tracePath}"/>
  </svg>
</div>
<div class="copy">
  <div class="name">PulseBLR</div>
  <div class="tag">
    <span>Bengaluru tech events worth attending,</span>
    <span>and the people you meet there.</span>
  </div>
</div>`;
}

/**
 * Pack PNGs into an .ico. Written by hand because the format is a 6-byte header plus one 16-byte
 * directory entry per image, and every modern browser and Windows Vista+ reads PNG-in-ICO. The
 * alternative was a dependency (`png-to-ico`) for forty lines of Buffer work.
 */
function buildIco(pngs) {
  const HEADER = 6;
  const ENTRY = 16;
  const header = Buffer.alloc(HEADER);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(pngs.length, 4);

  let offset = HEADER + ENTRY * pngs.length;
  const entries = [];
  for (const { size, data } of pngs) {
    const entry = Buffer.alloc(ENTRY);
    // 256 is encoded as 0; every size we emit is smaller, but keep the rule explicit.
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2); // palette size, 0 for PNG
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += data.length;
  }

  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

async function main() {
  const source = readSource();

  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch {
    console.error('playwright is not installed. It is a devDependency: run `npm install`.');
    process.exit(1);
  }

  const browser = await chromium.launch();
  const written = [];

  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });

    /**
     * Render one SVG at one size and return 24-bit RGB PNG bytes.
     *
     * Always opaque. `omitBackground: true` was tried and is pointless here: it forces an alpha
     * channel into the compositor, but the SVG paints its own full-bleed opaque `<rect>`, so no
     * pixel is transparent and Chromium's encoder drops the redundant channel anyway — measured
     * colour type 2 either way. Callers needing RGBA pass the result through `toRgba()`.
     *
     * 24-bit is what iOS wants for `apple-icon` (it composites alpha onto BLACK) and what Play
     * requires for the feature graphic, so it is the right default rather than a limitation.
     */
    async function renderPng(svgSource, size) {
      const svg = svgAtSize(svgSource, size);
      await page.setViewportSize({ width: size, height: size });
      await page.setContent(pageFor(svg, size, size), { waitUntil: 'load' });
      return page.screenshot({
        clip: { x: 0, y: 0, width: size, height: size },
        omitBackground: false,
      });
    }

    // 1. The manifest icon set.
    for (const size of ICON_SIZES) {
      const data = await renderPng(source, size);
      const file = path.join(PUBLIC_DIR, `icon-${size}.png`);
      fs.writeFileSync(file, data);
      written.push([`public/icon-${size}.png`, data.length]);
    }

    // 2. Maskable copies. Same artwork; see the header for why.
    for (const size of MASKABLE_SIZES) {
      const data = await renderPng(source, size);
      const file = path.join(PUBLIC_DIR, `icon-maskable-${size}.png`);
      fs.writeFileSync(file, data);
      written.push([`public/icon-maskable-${size}.png`, data.length]);
    }

    // 3. iOS home screen. Next emits the <link rel="apple-touch-icon"> for `app/apple-icon.png`
    //    automatically, which is what replaces the hand-written tag that pointed at an SVG iOS
    //    cannot read.
    {
      const data = await renderPng(source, APPLE_ICON_SIZE);
      fs.writeFileSync(path.join(APP_DIR, 'apple-icon.png'), data);
      written.push(['app/apple-icon.png', data.length]);
    }

    // 4. favicon.ico. `app/favicon.ico` is picked up by Next's file convention.
    //    Every embedded PNG must be RGBA or `next build` FAILS decoding the ICO — see the header.
    {
      const pngs = [];
      for (const size of FAVICON_SIZES) {
        pngs.push({ size, data: await toRgba(await renderPng(source, size)) });
      }
      const ico = buildIco(pngs);
      fs.writeFileSync(path.join(APP_DIR, 'favicon.ico'), ico);
      written.push([`app/favicon.ico (${FAVICON_SIZES.join('/')})`, ico.length]);
    }

    fs.mkdirSync(STORE_DIR, { recursive: true });

    // 5. Play listing icon. 512x512, 32-bit WITH alpha per Play's spec. See the header for why
    //    this needs sharp rather than another playwright render.
    {
      const data = await toRgba(await renderPng(source, 512));
      fs.writeFileSync(path.join(STORE_DIR, 'icon-512.png'), data);
      written.push(['store-assets/icon-512.png', data.length]);
    }

    // 6. Play listing feature graphic. Exactly 1024x500, 24-bit, NO alpha — Play rejects both a
    //    different size and an alpha channel here.
    {
      await page.setViewportSize(FEATURE_GRAPHIC);
      await page.setContent(featureGraphicPage(source), { waitUntil: 'load' });
      // Let the webfont land; without this the wordmark renders in the fallback face.
      await page.evaluate(() => document.fonts.ready);
      const data = await page.screenshot({
        clip: { x: 0, y: 0, ...FEATURE_GRAPHIC },
        omitBackground: false,
      });
      fs.writeFileSync(path.join(STORE_DIR, 'feature-graphic.png'), data);
      written.push(['store-assets/feature-graphic.png', data.length]);
    }
  } finally {
    await browser.close();
  }

  const pad = Math.max(...written.map(([name]) => name.length));
  for (const [name, bytes] of written) {
    console.log(`  ${name.padEnd(pad)}  ${(bytes / 1024).toFixed(1)} KB`);
  }
  console.log(`\n${written.length} files written. Sources in public/icon-*.svg are untouched.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
