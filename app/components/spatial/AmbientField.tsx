'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * The app's ambient 3D layer — one persistent WebGL surface behind EVERY page.
 *
 * WHY IT EXISTS, AND WHY AN EARLIER VERSION OF IT WAS DELETED. A procedural field was built for
 * the feed hero and removed, on the reasoning that components/graph/ already renders a real
 * data-driven connection graph there, so a decorative one beside it would say less. That reasoning
 * was right for the feed and WRONG for the app: the graph is one ~300px band on one route, and
 * every other surface — event detail, tracker, folders, companies, people, settings — was flat.
 * The brief is a dynamic three-dimensional product, not a single 3D component.
 *
 * So this is deliberately the opposite kind of thing from the graph. The graph is FOREGROUND and
 * carries data you can hover and click. This is BACKGROUND: it carries no data, it is never
 * interactive, and it sits behind the whole app giving every page one continuous space to live in.
 * Two different jobs, which is why both can exist without one being a duplicate of the other.
 *
 * WHY RAW WEBGL WHEN three.js IS ALREADY A DEPENDENCY. three is installed, but on the feed only,
 * behind `dynamic(..., { ssr: false })` and a capability gate — most routes never pay for it. This
 * layer is on every route including mobile, so pulling ~150 KB gzipped of renderer into the base
 * bundle to draw one full-screen quad would be the single most expensive line in the app. The whole
 * shader below is about 3 KB of source with no dependency at all.
 *
 * WHAT IT DRAWS. A slow depth field of drifting points on layered planes, parallaxed by scroll:
 * near points move faster than far ones, which is the only thing that actually reads as depth
 * rather than as texture. It is near-monochrome by rule — globals.css rations one accent, so the
 * field is ink at very low alpha and `--blue` touches only a sparse minority of points, where blue
 * already means "there is something here". Cover images stay the only real colour on screen.
 *
 * EVERY GUARD IS LOAD-BEARING. The audit that started this work found 0 of 27 candidate screens
 * honouring prefers-reduced-motion, and this thing is on every page:
 *
 *   · reduced motion  -> ONE static frame. Not slower: a drifting field is exactly what that
 *                        setting exists to switch off. The depth remains, the movement does not.
 *   · offscreen/hidden-> paused. It is fixed, so it is always "in view"; the visibility listener is
 *                        what stops it burning battery in a background tab.
 *   · low-end device  -> refuses to start rather than shipping jank onto a mid-range Android, which
 *                        is what this app is actually used on at a conference.
 *   · no WebGL        -> renders nothing; the CSS fallback shows instead.
 *   · context lost    -> handled both ways. A lost context never restored used to mean a dead layer.
 *   · DPR capped      -> 1.5 desktop / 1.25 mobile. A 3x phone would shade 9x the pixels for a
 *                        background nobody is meant to look at directly.
 *   · pointer-events  -> none, always. It must never intercept a tap meant for the page.
 */

const VERT = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

/**
 * Three depth planes of points. Each plane drifts at its own rate and is parallaxed by scroll at
 * its own rate, which is what produces depth: equal movement would just be a moving texture.
 *
 * Points come from a hash grid — one point per cell, orbiting its own centre on its own phase — so
 * the field never repeats visibly while costing 9 cell lookups per plane per pixel.
 */
const FRAG = `
precision mediump float;

uniform vec2  u_res;
uniform float u_time;
uniform float u_scroll;     // page scroll in CSS px
uniform float u_intensity;
uniform vec3  u_ink;
uniform vec3  u_accent;

vec2 hash2(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453123);
}

// One plane of drifting points. depth is 0 (far) .. 1 (near): nearer planes are bigger,
// brighter, sparser and parallax harder.
float plane(vec2 uv, float cells, float depth, float speed, float parallax, out float accentMix) {
  // Parallax: nearer planes slide further per pixel of scroll. Divided by resolution so the
  // effect is resolution-independent.
  vec2 p = uv;
  p.y += (u_scroll * parallax) / u_res.y;

  vec2 g = p * cells;
  vec2 base = floor(g);
  float acc = 0.0;
  accentMix = 0.0;

  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 cell = base + vec2(float(i), float(j));
      vec2 h = hash2(cell);
      // Sparser on nearer planes, so the depth stack does not turn to soup.
      if (h.x > 0.34 + depth * 0.30) continue;

      float phase = h.y * 6.2831853;
      vec2 at = cell + 0.5 + (0.16 + h.x * 0.18) * vec2(
        cos(phase + u_time * speed),
        sin(phase * 1.31 + u_time * speed * 0.86)
      );

      float d = length(g - at);
      // Nearer points are physically larger and softer at the edge.
      float radius = 0.045 + depth * 0.075;
      float dot_ = smoothstep(radius, 0.0, d);
      acc += dot_;

      // The accent is rare and only on the near plane, where blue can mean something.
      if (depth > 0.6 && hash2(cell + 41.0).x > 0.90) accentMix += dot_;
    }
  }
  return acc;
}

void main() {
  // Aspect-corrected so cells stay square whichever way the viewport is shaped.
  vec2 uv = gl_FragCoord.xy / u_res;
  float aspect = u_res.x / max(u_res.y, 1.0);
  vec2 p = vec2(uv.x * aspect, uv.y);

  float aFar, aMid, aNear;
  float far  = plane(p, 9.0, 0.05, 0.055, 6.0,  aFar);
  float mid  = plane(p, 6.0, 0.45, 0.085, 18.0, aMid);
  float near = plane(p, 3.6, 0.95, 0.115, 42.0, aNear);

  // Far planes are dimmer: atmosphere, not just scale.
  float a = (far * 0.30 + mid * 0.55 + near * 1.0);
  a = clamp(a, 0.0, 1.0) * u_intensity;

  float accent = clamp(aNear, 0.0, 1.0);
  vec3 col = mix(u_ink, u_accent, accent * 0.9);

  gl_FragColor = vec4(col, a);
}
`;

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    // Never thrown: a shader that will not compile must degrade to the CSS fallback, not take a
    // page down. This layer is on every route, so a throw here would be a site-wide outage.
    console.error('[AmbientField] shader compile failed:', gl.getShaderInfoLog(sh));
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

/**
 * Refuse to start on hardware that will stutter. Every signal here is advisory and absent on some
 * browsers, so each check is "known bad" rather than "not known good" and the default is to render.
 */
function capable(): boolean {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } };
  if (nav.connection?.saveData) return false;
  if (typeof nav.deviceMemory === 'number' && nav.deviceMemory > 0 && nav.deviceMemory < 2) return false;
  if (typeof nav.hardwareConcurrency === 'number' && nav.hardwareConcurrency > 0 && nav.hardwareConcurrency <= 2) {
    return false;
  }
  return true;
}

const hex2rgb = (hex: string): [number, number, number] => {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

export default function AmbientField({
  /*
   * Peak alpha. Started at 0.2, which measured as "still a static website" to the person who
   * asked for a dynamic three-dimensional product - at that strength the field was only visible
   * in the gutters between cards and read as paper texture, not depth.
   *
   * 0.5 is a DELIBERATE trade against globals.css rule 4 ("one accent, rationed... everything
   * else is greyscale, which is what leaves the cover images as the only colourful thing"),
   * made on explicit and repeated direction. It is still ink-on-paper rather than a second hue,
   * and the accent still touches only the sparse near-plane minority, so the rule is bent on
   * INTENSITY rather than broken on colour. If the covers start losing the fight, this number is
   * the one dial to turn back down.
   */
  intensity = 0.5,
  ink = '#1D1D1F',
  accent = '#0071E3',
}: {
  intensity?: number;
  ink?: string;
  accent?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Starts true so server-rendered HTML and any client without WebGL shows the CSS fallback. The
  // effect is additive; there is never a blank box waiting on JS.
  const [inactive, setInactive] = useState(true);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !capable()) return;

    const reduced =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let gl: WebGLRenderingContext | null = null;
    let program: WebGLProgram | null = null;
    let buffer: WebGLBuffer | null = null;
    let raf = 0;
    let disposed = false;
    let start = 0;
    let scroll = 0;
    let u: Record<string, WebGLUniformLocation | null> = {};

    const init = (): boolean => {
      const opts: WebGLContextAttributes = {
        alpha: true,
        antialias: false,
        depth: false,
        stencil: false,
        premultipliedAlpha: false,
        powerPreference: 'low-power',
      };
      gl = (canvas.getContext('webgl', opts) as WebGLRenderingContext | null) ?? null;
      if (!gl) return false;

      const vs = compile(gl, gl.VERTEX_SHADER, VERT);
      const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
      if (!vs || !fs) return false;

      program = gl.createProgram();
      if (!program) return false;
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        console.error('[AmbientField] link failed:', gl.getProgramInfoLog(program));
        return false;
      }
      gl.useProgram(program);

      buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
        gl.STATIC_DRAW,
      );
      const loc = gl.getAttribLocation(program, 'a_pos');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

      u = {
        res: gl.getUniformLocation(program, 'u_res'),
        time: gl.getUniformLocation(program, 'u_time'),
        scroll: gl.getUniformLocation(program, 'u_scroll'),
        intensity: gl.getUniformLocation(program, 'u_intensity'),
        ink: gl.getUniformLocation(program, 'u_ink'),
        accent: gl.getUniformLocation(program, 'u_accent'),
      };

      gl.disable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

      const [ir, ig, ib] = hex2rgb(ink);
      const [ar, ag, ab] = hex2rgb(accent);
      gl.uniform3f(u.ink, ir, ig, ib);
      gl.uniform3f(u.accent, ar, ag, ab);
      gl.uniform1f(u.intensity, intensity);
      return true;
    };

    const resize = () => {
      if (!gl) return;
      const mobile = window.innerWidth < 640;
      const dpr = Math.min(window.devicePixelRatio || 1, mobile ? 1.25 : 1.5);
      const w = Math.max(1, Math.round(window.innerWidth * dpr));
      const h = Math.max(1, Math.round(window.innerHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      gl.viewport(0, 0, w, h);
      gl.uniform2f(u.res, w, h);
    };

    const draw = (ms: number) => {
      if (!gl || disposed) return;
      gl.uniform1f(u.time, ms / 1000);
      gl.uniform1f(u.scroll, scroll);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    };

    const loop = (now: number) => {
      if (disposed) return;
      if (!start) start = now;
      draw(now - start);
      raf = requestAnimationFrame(loop);
    };

    const stop = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };
    const play = () => {
      if (disposed || reduced || raf) return;
      raf = requestAnimationFrame(loop);
    };

    const onScroll = () => {
      scroll = window.scrollY || 0;
      // Under reduced motion the parallax still applies — it is a position, not an animation, and
      // it only changes when the user themselves scrolls. What is switched off is the drift.
      if (reduced) draw(0);
    };

    const onLost = (e: Event) => {
      e.preventDefault();
      stop();
      setInactive(true);
    };
    const onRestored = () => {
      if (disposed) return;
      if (init()) {
        resize();
        setInactive(false);
        if (reduced) draw(0);
        else play();
      }
    };

    canvas.addEventListener('webglcontextlost', onLost);
    canvas.addEventListener('webglcontextrestored', onRestored);

    if (!init()) {
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      return; // inactive stays true -> CSS fallback
    }

    scroll = window.scrollY || 0;
    resize();
    setInactive(false);
    if (reduced) draw(0);
    else play();

    const onResize = () => {
      resize();
      if (reduced) draw(0);
    };
    const onVisibility = () => {
      if (document.hidden) stop();
      else play();
    };

    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onScroll, { passive: true });
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      disposed = true;
      stop();
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onScroll);
      document.removeEventListener('visibilitychange', onVisibility);
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      if (gl) {
        if (buffer) gl.deleteBuffer(buffer);
        if (program) gl.deleteProgram(program);
        // Free the GPU context eagerly. Browsers cap live WebGL contexts (~16) and React can
        // mount/unmount this repeatedly in dev; leaking them makes later mounts silently fail.
        gl.getExtension('WEBGL_lose_context')?.loseContext();
      }
      gl = null;
      program = null;
      buffer = null;
    };
  }, [intensity, ink, accent]);

  return (
    <div className="ambient-field" aria-hidden="true" data-inactive={inactive}>
      <canvas ref={canvasRef} />
    </div>
  );
}
