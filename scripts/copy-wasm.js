#!/usr/bin/env node
/**
 * Copy the ZXing reader wasm into `public/wasm/` so the app self-hosts it.
 *
 * WHY THIS IS NECESSARY, verified by reading the shipped `zxing-wasm@3.1.3` dist: there is NO
 * CDN fallback in the build. (The `barcode-detector` README's claim that the wasm "defaults to
 * jsDelivr" is wrong for the published artefact.) The Emscripten glue resolves
 * `zxing_reader.wasm` RELATIVE TO THE SCRIPT URL, which under Turbopack is
 * `/_next/static/chunks/…` — so without this the first scan 404s, and only in a production
 * build, where nobody is watching the network tab.
 *
 * Self-hosting is also required rather than merely tidy:
 *   - this app is a PWA, and a cross-origin fetch cannot be served offline
 *   - `public/wasm/*` is a non-navigation asset, so `sw.js` serves it CACHE-FIRST for free
 *   - a CDN fetch would be the first thing to break under any CSP added later
 *
 * Run automatically by `postinstall`, so the copy tracks the installed package version rather
 * than drifting from it. The file is also committed, so an install with `--ignore-scripts`
 * still works.
 *
 * Plain JS, not tsx: `postinstall` runs before devDependencies are guaranteed usable.
 */
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = path.join(
  __dirname,
  '..',
  'node_modules',
  'zxing-wasm',
  'dist',
  'reader',
  'zxing_reader.wasm'
);
const TARGET_DIR = path.join(__dirname, '..', 'public', 'wasm');
const TARGET = path.join(TARGET_DIR, 'zxing_reader.wasm');

function main() {
  if (!fs.existsSync(SOURCE)) {
    // Not an error: `npm ci --omit=dev` on a machine that never scans, or a partial install.
    // The committed copy stands, and the scanner falls back to a clear error if it is missing.
    console.log('[copy-wasm] zxing-wasm not installed; leaving public/wasm as-is');
    return;
  }

  fs.mkdirSync(TARGET_DIR, { recursive: true });

  const source = fs.statSync(SOURCE);
  if (fs.existsSync(TARGET) && fs.statSync(TARGET).size === source.size) {
    console.log(`[copy-wasm] already current (${source.size} bytes)`);
    return;
  }

  fs.copyFileSync(SOURCE, TARGET);
  console.log(`[copy-wasm] wrote public/wasm/zxing_reader.wasm (${source.size} bytes)`);
}

main();
