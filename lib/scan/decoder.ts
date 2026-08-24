/**
 * QR decoding: pick an engine, then decode frames with it.
 *
 * TWO ENGINES, AND THE ORDER MATTERS.
 *
 * 1. NATIVE `BarcodeDetector` — free, fast, zero bytes. Available on Chrome Android 83+ and
 *    Samsung Internet 13+. NOT on Chrome for Windows or Linux (so it is absent on the dev
 *    machine), not on Firefox, and on iOS Safari it exists ONLY behind the "Shape Detection
 *    API" flag, where it is BROKEN (WebKit bug 281848, open since Oct 2024).
 *
 *    That last case is why `if ('BarcodeDetector' in window)` is not good enough: on a
 *    flag-enabled iPhone the global exists, the feature check passes, and the scanner then
 *    silently never decodes anything. So the native path is gated behind a RUNTIME SELF-TEST
 *    that actually decodes a known QR before we trust it.
 *
 * 2. `zxing-wasm@3.1.3` — ZXing-C++ via Emscripten. 1,093,289 bytes raw, measured 349 KB
 *    brotli / 445 KB gzip. Dynamically imported so only somebody who opens the scanner pays
 *    for it, and self-hosted from `/wasm/` (see scripts/copy-wasm.js for why that is
 *    mandatory rather than tidy).
 *
 * READER OPTIONS ARE TUNED FOR A LIVE LOOP, and this is the concrete reason for using
 * `zxing-wasm` directly rather than the `barcode-detector` ponyfill, which hardcodes them.
 * The shipped defaults — `formats: []` (try EVERY 1D and 2D format), `tryHarder: true`,
 * `tryInvert: true`, `maxNumberOfSymbols: 255` — are tuned for accuracy on a still image and
 * will blow a 33 ms frame budget on a mid-range Android. The still-image fallback keeps the
 * accuracy-first defaults, because there a 300 ms decode costs nothing.
 */

/**
 * A real QR encoding the text `PULSEBLR`, as a PNG data URI.
 *
 * Generated with `qrcode` at error-correction level M and verified to decode, because a
 * self-test whose fixture is not a valid QR would fail forever and silently disable the native
 * fast path on the one platform that has it. `scripts/diag-scan-decoder.ts` asserts it decodes.
 */
export const SELF_TEST_QR =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAAAAklEQVR4AewaftIAAALWSURBVO3BQW7jUAwFwX6E7n/lnqyJLH5keWKErIpfWGMVa7RijVas0Yo1WrFGK9ZoxRqtWKMVa7RijXbxA0n4JCpdEjqVLgknVE4k4ZOonCjWaMUarVijFWu0ixepvFsSfksSOpVTKu+WhLuKNVqxRivWaMUa7eINknCXyv+g0iWhU3laEu5SeVKxRivWaMUarVijXfwxKl0SOpVOpUtCp/JXFGu0Yo1WrNGKNdrFH5OEda5YoxVrtGKNVqzRLt5A5beodEk4kYT/QeVTFGu0Yo1WrNGKNdrFi5LwSZLQqXRJ6FS6JLwiCZ+sWKMVa7RijVas0Yo1WvzCQEm4S+WvKNZoxRqtWKMVa7SLH0hCp3IiCZ9OpUtCl4RO5VQSOpUuCXepnCjWaMUarVijFWu0ix9Q6ZLQqZxQ6ZLQqbwiCZ3KXSpdEr6jciIJd6ncVazRijVasUYr1mgXL1LpknAiCZ1Kl4TvqHRJ6FTuUumS8DSVu5LQqZwo1mjFGq1YoxVrtPiFQ0m4S6VLwgmVU0k4odIloVP5H5LQqbxbsUYr1mjFGq1Yo138gMqJJNyl0iXhOyqdSpeEEyp3JeE7KidUuiScULmrWKMVa7RijVas0eIX/pAkdConknBC5bck4YTKiWKNVqzRijVasUa7+IEkfBKVJ6l0SeiS8DSVEypPKtZoxRqtWKMVa7RijXbxIpV3S8LTkvAklVNJeFISOpUTxRqtWKMVa7RijXbxBkm4S+VpSXiSSpeEUypdEjqVLglPKtZoxRqtWKMVa7SLAVS6JDxJ5WlJ6FSeVKzRijVasUYr1mgXf4xKl4QTKncl4TsqXRLuSsIJlRPFGq1YoxVrtGKNdvEGKp9E5UlJ+CQqdxVrtGKNVqzRijXaxYuS8EmScEKlS0Kn0qm8QqVLwm8o1mjFGq1YoxVrtPiFNVaxRivWaMUarVijFWu0Yo1WrNGKNVqxRvsH7FELAwOsKYMAAAAASUVORK5CYII=';

export type EngineName = 'native' | 'wasm';

export interface DecodeEngine {
  name: EngineName;
  /** Decode one frame. Returns the payload text, or null when no code is present. */
  decode(image: ImageData): Promise<string | null>;
  /** Decode a still image or photo, accuracy-first. */
  decodeBlob(blob: Blob): Promise<string | null>;
}

/* ────────────────────────────── native ────────────────────────────── */

interface BarcodeDetectorLike {
  detect(source: ImageBitmapSource): Promise<Array<{ rawValue: string }>>;
}
interface BarcodeDetectorCtor {
  new (options?: { formats?: string[] }): BarcodeDetectorLike;
  getSupportedFormats?(): Promise<string[]>;
}

function nativeCtor(): BarcodeDetectorCtor | null {
  const candidate = (globalThis as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  return typeof candidate === 'function' ? candidate : null;
}

/**
 * Does the native detector actually work?
 *
 * Decodes a known QR and checks the answer. A detector that exists but returns nothing — the
 * iOS-with-the-flag-on case — fails here and we fall through to wasm, instead of presenting a
 * camera that never finds anything.
 */
async function nativeSelfTest(): Promise<boolean> {
  const Ctor = nativeCtor();
  if (!Ctor) return false;

  try {
    const formats = (await Ctor.getSupportedFormats?.()) ?? [];
    if (formats.length && !formats.includes('qr_code')) return false;

    const response = await fetch(SELF_TEST_QR);
    const bitmap = await createImageBitmap(await response.blob());
    const detector = new Ctor({ formats: ['qr_code'] });
    const results = await detector.detect(bitmap);
    bitmap.close?.();
    return results.length > 0 && typeof results[0].rawValue === 'string' && results[0].rawValue.length > 0;
  } catch {
    return false;
  }
}

/* ────────────────────────────── wasm ────────────────────────────── */

type ReadBarcodes = typeof import('zxing-wasm/reader')['readBarcodes'];
let readBarcodes: ReadBarcodes | null = null;

async function loadWasm(): Promise<ReadBarcodes> {
  if (readBarcodes) return readBarcodes;

  const mod = await import('zxing-wasm/reader');
  /**
   * Point the Emscripten loader at our self-hosted copy. Without this override it resolves
   * relative to the script URL — `/_next/static/chunks/zxing_reader.wasm` under Turbopack —
   * and 404s on the first scan.
   *
   * `fireImmediately` warms the module now, at the moment the scanner opens, rather than on
   * the first frame, so there is no stall between pointing the camera and the first decode.
   */
  mod.prepareZXingModule({
    overrides: {
      locateFile: (filename: string, prefix: string) =>
        filename.endsWith('.wasm') ? '/wasm/zxing_reader.wasm' : `${prefix}${filename}`,
    },
    fireImmediately: true,
  });

  readBarcodes = mod.readBarcodes;
  return readBarcodes;
}

type ReaderOptions = NonNullable<Parameters<ReadBarcodes>[1]>;

/** Live-loop options: only QR, stop at the first hit, skip the expensive passes. */
const LIVE_OPTIONS: ReaderOptions = {
  formats: ['QRCode'],
  maxNumberOfSymbols: 1,
  tryHarder: false,
  tryInvert: false,
  tryRotate: true,
};

/** Still-image options: accuracy first, because a slow decode is free here. */
const STILL_OPTIONS: ReaderOptions = {
  formats: ['QRCode'],
  maxNumberOfSymbols: 1,
  tryHarder: true,
  tryInvert: true,
  tryRotate: true,
};

/* ────────────────────────────── selection ────────────────────────────── */

let enginePromise: Promise<DecodeEngine> | null = null;

/**
 * Choose an engine once per page load. Native if it passes the self-test, wasm otherwise.
 *
 * The wasm decoder is loaded either way when native is unavailable, and the still-image path
 * ALWAYS uses wasm: it is more accurate on a blurry photo, which is exactly the case the photo
 * fallback exists for.
 */
export function getEngine(): Promise<DecodeEngine> {
  if (enginePromise) return enginePromise;

  enginePromise = (async () => {
    const decodeBlobWithWasm = async (blob: Blob): Promise<string | null> => {
      const read = await loadWasm();
      const results = await read(blob, STILL_OPTIONS);
      return results[0]?.text || null;
    };

    if (await nativeSelfTest()) {
      const Ctor = nativeCtor()!;
      const detector = new Ctor({ formats: ['qr_code'] });
      return {
        name: 'native',
        async decode(image: ImageData) {
          const results = await detector.detect(image as unknown as ImageBitmapSource);
          return results[0]?.rawValue || null;
        },
        decodeBlob: decodeBlobWithWasm,
      };
    }

    const read = await loadWasm();
    return {
      name: 'wasm',
      async decode(image: ImageData) {
        const results = await read(image, LIVE_OPTIONS);
        return results[0]?.text || null;
      },
      decodeBlob: decodeBlobWithWasm,
    };
  })();

  // Never cache a failure: a transient network error while fetching the wasm must not disable
  // the scanner for the rest of the session.
  enginePromise.catch(() => {
    enginePromise = null;
  });

  return enginePromise;
}

/** Test seam: forget the chosen engine so the next call re-selects. */
export function resetEngine(): void {
  enginePromise = null;
  readBarcodes = null;
}
