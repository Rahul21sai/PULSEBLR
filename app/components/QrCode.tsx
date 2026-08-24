'use client';

import { useEffect, useState } from 'react';

/**
 * Render a QR code as inline SVG, generated in the browser.
 *
 * THREE REASONS IT IS CLIENT-SIDE SVG rather than an image from a route:
 *
 *   1. `/card` has to work with no signal. Showing your code at a venue whose wifi has
 *      collapsed is precisely the situation it exists for, and an image URL needs a request.
 *   2. The service worker serves non-navigation assets CACHE-FIRST, so a QR served as an
 *      image would keep showing a stale code after the token was rotated — the one change
 *      where being stale is actively harmful.
 *   3. `next.config.ts` only whitelists `**.googleusercontent.com` in `remotePatterns`, so an
 *      external generator is not an option, and sending the token to one would hand a third
 *      party the credential.
 *
 * `qrcode` is imported dynamically so its ~50 KB only loads for someone who actually opens a
 * QR screen.
 *
 * Error correction is level M (~15% recoverable). Level L makes a denser-looking code that
 * fails on a scratched phone screen in bad light; H makes the modules so small that a
 * mid-range camera struggles. M is what the LinkedIn app itself uses.
 */
export default function QrCode({
  value,
  size = 240,
  className = '',
  ariaLabel = 'QR code',
}: {
  value: string;
  size?: number;
  className?: string;
  ariaLabel?: string;
}) {
  /**
   * The result is stored WITH the value it was generated from, rather than reset to null at the
   * start of the effect. Clearing state synchronously inside an effect triggers a cascading
   * render, which this project's lint config rejects — and comparing values is also more
   * correct: a stale code can never be shown for a new value, even for one frame.
   */
  const [result, setResult] = useState<{ value: string; svg: string | null; failed: boolean } | null>(
    null
  );
  const current = result?.value === value ? result : null;
  const svg = current?.svg ?? null;
  const failed = current?.failed ?? false;

  useEffect(() => {
    let cancelled = false;
    if (!value) return;

    import('qrcode')
      .then(mod =>
        mod.toString(value, {
          type: 'svg',
          errorCorrectionLevel: 'M',
          margin: 1,
          // Pure black on pure white. A tinted QR looks designed and scans worse; contrast
          // is the entire job here, and this is the one surface where the design system's
          // "one accent, rationed" rule means no accent at all.
          color: { dark: '#000000', light: '#FFFFFF' },
        })
      )
      .then(generated => {
        if (cancelled) return;
        // The library emits its own width/height; strip them so CSS controls the size and
        // the code stays crisp at any scale.
        setResult({
          value,
          svg: generated.replace(/width="[^"]*"\s*height="[^"]*"/, 'width="100%" height="100%"'),
          failed: false,
        });
      })
      .catch(() => {
        if (!cancelled) setResult({ value, svg: null, failed: true });
      });

    return () => {
      cancelled = true;
    };
  }, [value]);

  if (failed) {
    return (
      <div
        className={`grid place-items-center rounded-2xl bg-[#F5F5F7] p-4 text-center text-[12.5px] text-[#6E6E73] ${className}`}
        style={{ width: size, height: size }}
      >
        Could not draw the code. The link below still works.
      </div>
    );
  }

  return (
    <div
      className={`overflow-hidden rounded-2xl bg-white ${className}`}
      style={{ width: size, height: size }}
      role="img"
      aria-label={ariaLabel}
    >
      {svg ? (
        <div className="h-full w-full [&>svg]:block [&>svg]:h-full [&>svg]:w-full" dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        // A plain placeholder, not a pulse: `prefers-reduced-motion` disables animation
        // globally, so a loading state that is only an animation reads as broken.
        <div className="h-full w-full bg-[#F5F5F7]" />
      )}
    </div>
  );
}

/**
 * Download the rendered code as a PNG.
 *
 * Separate from the component because it needs a canvas at print resolution rather than the
 * on-screen size — a screenshot of a 240px SVG prints as a blurry code that will not scan.
 */
export async function downloadQrPng(value: string, filename: string): Promise<void> {
  const mod = await import('qrcode');
  const dataUrl = await mod.toDataURL(value, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 1024,
    color: { dark: '#000000', light: '#FFFFFF' },
  });
  const link = document.createElement('a');
  link.href = dataUrl;
  link.download = filename;
  link.click();
}
