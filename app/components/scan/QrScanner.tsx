'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { getEngine, type EngineName } from '@/lib/scan/decoder';

/**
 * The camera viewfinder.
 *
 * Every detail below is a platform constraint rather than a preference:
 *
 * - `playsInline` IS MANDATORY. Without it iOS takes the video fullscreen into the native
 *   player and the canvas reads nothing at all. `muted` matters too — an unmuted autoplaying
 *   video is blocked by the autoplay policy even for a camera stream — and `play()` is also
 *   called explicitly, because the attribute alone is unreliable.
 *
 * - SECURE CONTEXT REQUIRED. `getUserMedia` is undefined on `http://` over a LAN IP;
 *   `localhost` counts as trustworthy. On Android the free route is `chrome://inspect` → Port
 *   forwarding → device 3000 → localhost:3000, which needs no certificates at all. The error
 *   state says this, because otherwise it reads as a broken app.
 *
 * - THE TRACK IS KEPT ALIVE between captures and only the DECODE LOOP is paused. Restarting a
 *   track costs roughly half a second on Android, and you are scanning a queue of people.
 *
 * - TRACKS ARE RELEASED on unmount and when the page is hidden, or the camera indicator stays
 *   lit after you leave — which users reasonably read as the app spying on them.
 *
 * - THE STATUS IS A STATIC LABEL, not an animated reticle. `globals.css` disables every
 *   animation under `prefers-reduced-motion` with `animation-duration: 0.001ms !important` on
 *   `*`, so anything conveyed only by motion is invisible to those users.
 */

/** Decode attempts per second. 10 is responsive; 30 just drains the battery. */
const DECODES_PER_SECOND = 10;
/** Frames are downscaled before decoding — a 1280px frame costs far more and finds no more. */
const DECODE_WIDTH = 640;

export type ScannerStatus = 'starting' | 'scanning' | 'paused' | 'error';

export interface QrScannerHandle {
  resume(): void;
}

export default function QrScanner({
  onDetect,
  paused,
  onStatusChange,
}: {
  /** Called with the raw payload. The parent decides what to do and whether to pause. */
  onDetect: (raw: string) => void;
  /** While true the loop stops but the camera stays warm. */
  paused: boolean;
  onStatusChange?: (status: ScannerStatus, detail?: { engine?: EngineName }) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const inFlightRef = useRef(false);
  const lastDecodeRef = useRef(0);
  const pausedRef = useRef(paused);
  const onDetectRef = useRef(onDetect);

  const [status, setStatus] = useState<ScannerStatus>('starting');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [engine, setEngine] = useState<EngineName | null>(null);
  const [torchOn, setTorchOn] = useState(false);
  const [torchAvailable, setTorchAvailable] = useState(false);

  /**
   * Mirror the props into refs so the decode loop never closes over stale values and never has
   * to be torn down and rebuilt when the parent re-renders — restarting the loop would drop
   * frames mid-scan.
   *
   * Done in an effect, not during render: writing to a ref while rendering is a side effect, and
   * React's compiler rules reject it (`Cannot access refs during render`).
   */
  useEffect(() => {
    pausedRef.current = paused;
    onDetectRef.current = onDetect;
  }, [paused, onDetect]);

  const report = useCallback(
    (next: ScannerStatus, detail?: { engine?: EngineName }) => {
      setStatus(next);
      onStatusChange?.(next, detail);
    },
    [onStatusChange]
  );

  /* ── Start the camera, once ─────────────────────────────────────────── */
  useEffect(() => {
    let cancelled = false;

    async function start() {
      if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
        setErrorMessage(
          'This browser will not open a camera here. That usually means the page is not on ' +
            'https — a plain http address on your local network cannot use the camera. Use the ' +
            'photo option below instead.'
        );
        report('error');
        return;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach(track => track.stop());
          return;
        }

        streamRef.current = stream;
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          // Belt and braces alongside the JSX attribute: iOS has historically honoured only
          // one of the two.
          video.setAttribute('playsinline', 'true');
          video.muted = true;
          await video.play().catch(() => {
            /* A rejected play() still usually yields frames; the loop will find out. */
          });
        }

        const track = stream.getVideoTracks()[0];
        const capabilities = (track?.getCapabilities?.() ?? {}) as { torch?: boolean };
        setTorchAvailable(Boolean(capabilities.torch));

        const selected = await getEngine();
        if (cancelled) return;
        setEngine(selected.name);
        report('scanning', { engine: selected.name });
      } catch (error) {
        if (cancelled) return;
        const name = (error as DOMException)?.name;
        setErrorMessage(
          name === 'NotAllowedError'
            ? 'Camera access was refused. Allow it in your browser’s site settings, or use the photo option below.'
            : name === 'NotFoundError'
              ? 'No camera found on this device. Use the photo option below.'
              : 'Could not start the camera. Use the photo option below.'
        );
        report('error');
      }
    }

    void start();

    return () => {
      cancelled = true;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      streamRef.current?.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    };
    // Intentionally runs once. `report` is stable via useCallback, and re-running would
    // restart the camera on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ── Release the camera when the page is hidden ────────────────────── */
  useEffect(() => {
    function onVisibilityChange() {
      if (document.visibilityState !== 'hidden') return;
      streamRef.current?.getTracks().forEach(track => track.stop());
      streamRef.current = null;
      report('paused');
    }
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [report]);

  /* ── The decode loop ───────────────────────────────────────────────── */
  useEffect(() => {
    if (status !== 'scanning') return;

    let stopped = false;

    async function tick() {
      if (stopped) return;
      rafRef.current = requestAnimationFrame(() => void tick());

      if (pausedRef.current || inFlightRef.current) return;

      const now = performance.now();
      if (now - lastDecodeRef.current < 1000 / DECODES_PER_SECOND) return;
      lastDecodeRef.current = now;

      const video = videoRef.current;
      if (!video || video.readyState < 2 || !video.videoWidth) return;

      inFlightRef.current = true;
      try {
        if (!canvasRef.current) canvasRef.current = document.createElement('canvas');
        const canvas = canvasRef.current;

        const scale = Math.min(1, DECODE_WIDTH / video.videoWidth);
        canvas.width = Math.round(video.videoWidth * scale);
        canvas.height = Math.round(video.videoHeight * scale);

        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) return;
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const image = context.getImageData(0, 0, canvas.width, canvas.height);

        const decoder = await getEngine();
        const text = await decoder.decode(image);
        if (text && !pausedRef.current) {
          // A short buzz is the only feedback that works when the phone is at arm's length and
          // you are looking at the other person, not the screen.
          navigator.vibrate?.(30);
          onDetectRef.current(text);
        }
      } catch {
        // One bad frame is normal — a hand across the lens, a partially drawn video. Never
        // surface it; the next frame is 100 ms away.
      } finally {
        inFlightRef.current = false;
      }
    }

    void tick();

    return () => {
      stopped = true;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [status]);

  /* ── Torch ─────────────────────────────────────────────────────────── */
  async function toggleTorch() {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const next = !torchOn;
    try {
      // `torch` is a real, widely-implemented constraint that TypeScript's DOM lib does not
      // declare, so the cast goes through `unknown` rather than pretending it type-checks.
      await track.applyConstraints({
        advanced: [{ torch: next }],
      } as unknown as MediaTrackConstraints);
      setTorchOn(next);
    } catch {
      setTorchAvailable(false);
    }
  }

  /** Decode a photo or screenshot. Accuracy-first options, and it needs no camera at all. */
  async function decodeFile(file: File) {
    try {
      const decoder = await getEngine();
      const text = await decoder.decodeBlob(file);
      if (text) {
        onDetectRef.current(text);
      } else {
        setErrorMessage('No QR code found in that image. Try a closer, brighter shot.');
        setTimeout(() => setErrorMessage(null), 4000);
      }
    } catch {
      setErrorMessage('Could not read that image.');
      setTimeout(() => setErrorMessage(null), 4000);
    }
  }

  return (
    <div className="relative h-full w-full overflow-hidden bg-black">
      <video
        ref={videoRef}
        playsInline
        muted
        autoPlay
        className="h-full w-full object-cover"
        aria-label="Camera viewfinder"
      />

      {/* Framing guide. Static outline, not an animation — see the note on reduced motion. */}
      {status === 'scanning' && !paused && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <div className="h-[62vw] max-h-[300px] w-[62vw] max-w-[300px] rounded-[28px] shadow-[0_0_0_100vmax_rgba(0,0,0,0.45)] outline outline-2 outline-white/85" />
        </div>
      )}

      {/* Status. White-on-dark, because this is the app's only dark surface and the greyscale
          ink tokens are black-alpha and would be invisible here. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 p-4 text-center">
        <p className="inline-block rounded-full bg-black/55 px-3 py-1.5 text-[12.5px] font-semibold text-white">
          {status === 'starting' && 'Starting the camera…'}
          {status === 'scanning' && !paused && 'Point at their LinkedIn QR'}
          {status === 'scanning' && paused && 'Got it'}
          {status === 'paused' && 'Camera paused'}
          {status === 'error' && 'Camera unavailable'}
        </p>
      </div>

      {errorMessage && (
        <div className="absolute inset-x-0 top-16 mx-auto max-w-[420px] px-4">
          <p className="rounded-2xl bg-white/95 px-4 py-3 text-[12.5px] leading-relaxed text-[#1D1D1F]" role="alert">
            {errorMessage}
          </p>
        </div>
      )}

      {/* Controls */}
      <div
        className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-3 p-5"
        style={{ paddingBottom: 'max(20px, env(safe-area-inset-bottom))' }}
      >
        <label className="flex cursor-pointer items-center gap-2 rounded-full bg-white/95 px-4 py-2.5 text-[12.5px] font-semibold text-[#1D1D1F] [touch-action:manipulation]">
          <span aria-hidden="true" className="material-symbols-outlined text-[18px]">photo_camera</span>
          Photo
          {/**
           * Not a nicety. Three open WebKit bugs have the camera freezing or never starting
           * specifically in an INSTALLED iOS PWA, and this app's manifest is
           * `"display": "standalone"`. It also covers a refused permission, a missing camera,
           * and a page served over plain http.
           */}
          <input
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={e => {
              const file = e.target.files?.[0];
              if (file) void decodeFile(file);
              e.target.value = '';
            }}
          />
        </label>

        {torchAvailable && (
          <button
            type="button"
            onClick={toggleTorch}
            aria-pressed={torchOn}
            className="flex items-center gap-2 rounded-full bg-white/95 px-4 py-2.5 text-[12.5px] font-semibold text-[#1D1D1F] [touch-action:manipulation]"
          >
            <span aria-hidden="true" className="material-symbols-outlined text-[18px]">
              {torchOn ? 'flashlight_off' : 'flashlight_on'}
            </span>
            {torchOn ? 'Light off' : 'Light'}
          </button>
        )}
      </div>

      {/* Which engine ran. Invisible in normal use, decisive when debugging on a real phone —
          the native detector is Chrome-Android-only and must pass a self-test to be used. */}
      {engine && (
        <span className="absolute bottom-1 right-2 text-[9px] text-white/35" aria-hidden="true">
          {engine}
        </span>
      )}
    </div>
  );
}
