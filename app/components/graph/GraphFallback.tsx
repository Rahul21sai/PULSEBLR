'use client';

import type { EventGraph } from '@/lib/graph/build-graph';

/**
 * The graph without WebGL — SVG, ~2 KB, no three.js.
 *
 * THIS IS NOT A PLACEHOLDER, it is the version most people will see. It renders on phones, on
 * low-core devices, under `prefers-reduced-motion`, before the 3D chunk arrives, and if WebGL is
 * unavailable or the canvas fails. So it draws the SAME graph from the SAME model — real nodes at
 * real positions with real edges — rather than a decorative squiggle. Somebody on a mid-range
 * Android gets the actual information, not an apology.
 *
 * It reads the same two-colour mapping as the 3D scene (sodium = event, teal = edge), so the
 * static path teaches the same thing the animated one does.
 *
 * The projection is a plain orthographic flatten of the model's x/y, with `z` used only to scale
 * radius slightly — enough to suggest depth without needing a camera.
 */
export default function GraphFallback({
  graph,
  animate = true,
}: {
  graph: EventGraph;
  /** False under reduced-motion: the CSS class that breathes is simply not applied. */
  animate?: boolean;
}) {
  const { nodes, edges } = graph;

  if (nodes.length === 0) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <p className="t-eyebrow">no events in range</p>
      </div>
    );
  }

  /*
   * The projection is FITTED to the graph's real extents, not to hard-coded bounds.
   *
   * The first version divided by the literals the model happened to use (5.4 / 2.3). When the
   * spread was later widened to fill the camera frustum, those literals silently clipped every
   * outer node — the kind of coupling that breaks quietly and only in the fallback, which is the
   * path least likely to be looked at. Measuring the extents here means the two can never
   * disagree again.
   */
  const VB_W = 1200;
  const VB_H = 420;
  const PAD = 34;

  const maxX = Math.max(...nodes.map(n => Math.abs(n.x)), 0.001);
  const maxY = Math.max(...nodes.map(n => Math.abs(n.y)), 0.001);
  const project = (x: number, y: number) => ({
    cx: VB_W / 2 + (x / maxX) * (VB_W / 2 - PAD),
    cy: VB_H / 2 - (y / maxY) * (VB_H / 2 - PAD),
  });

  return (
    <svg
      viewBox={`0 0 ${VB_W} ${VB_H}`}
      className="h-full w-full"
      // Decorative here: the headline and the live counts beside it carry the meaning, and a
      // screen reader cannot use a node cloud. The event list below is the accessible path.
      aria-hidden="true"
      preserveAspectRatio="xMidYMid slice"
    >
      {/* Edges first, so nodes sit on top of them. */}
      <g stroke="var(--n-connect)" fill="none">
        {edges.map((e, i) => {
          const a = project(nodes[e.a].x, nodes[e.a].y);
          const b = project(nodes[e.b].x, nodes[e.b].y);
          return (
            <line
              key={`${e.a}-${e.b}-${i}`}
              x1={a.cx}
              y1={a.cy}
              x2={b.cx}
              y2={b.cy}
              strokeWidth={e.reason === 'organizer' ? 1.4 : 0.9}
              // Strongest reason reads brightest — the same hierarchy the 3D scene uses.
              // Same hierarchy as the 3D scene, and for the same reason: "same topic" is true of a
              // third of the corpus, so at equal weight it becomes a mesh and hides the strong claims.
              strokeOpacity={e.reason === 'organizer' ? 0.5 : e.reason === 'company' ? 0.3 : 0.11}
            />
          );
        })}
      </g>

      <g fill="var(--n-pulse)">
        {nodes.map((n, i) => {
          const { cx, cy } = project(n.x, n.y);
          // r is authored in world units; scale to the viewBox and lift slightly with z.
          const r = n.r * 105 * (1 + n.z * 0.04);
          return (
            <circle
              key={n.id}
              cx={cx}
              cy={cy}
              r={Math.max(2.2, r)}
              // A node with no edges is dimmed rather than dropped: "nothing connects to this yet"
              // is information, and hiding it would misrepresent the graph.
              fillOpacity={n.degree === 0 ? 0.3 : 0.62 + Math.min(n.degree, 3) * 0.1}
              className={animate ? 'breathe' : undefined}
              // Staggered so the field shimmers rather than pulsing in unison, which reads
              // mechanical. Deterministic offset, no randomness.
              style={animate ? { animationDelay: `${(i % 9) * 0.34}s` } : undefined}
            />
          );
        })}
      </g>
    </svg>
  );
}
