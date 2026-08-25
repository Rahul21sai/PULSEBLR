'use client';

/**
 * The connection graph in 3D. Lazy-loaded, client-only, and never on the critical path.
 *
 * WHAT IT SPENDS, AND WHY THAT IS THE WHOLE BUDGET. three.js is ~150 KB gzipped, which is more
 * than the rest of the feed put together — so it is behind a `dynamic(..., { ssr: false })` import
 * that only resolves after the event list has rendered and only when the device passes the checks
 * in `EventGraphHero`. Nothing here blocks first paint, and the page is fully usable if this module
 * never loads at all.
 *
 * KEPT CHEAP DELIBERATELY:
 *   · Nodes are drei `<Instances>` — one geometry, one material, one draw call for all 48, with
 *     per-instance hover still working because each `<Instance>` is a real React node. Hand-rolling
 *     InstancedMesh raycasting would be the same cost and much easier to get wrong.
 *   · Edges are a single `lineSegments` with one BufferGeometry, not N line objects.
 *   · No models, no textures, no post-processing, no shadows. The look comes from colour and
 *     motion, both of which are free.
 *   · `dpr` is capped at 1.5. A retina phone would otherwise render 4x the pixels for a background.
 *
 * MOTION IS AMBIENT, NOT DEMANDING. The camera drifts on a slow sine and nodes breathe out of
 * phase. This sits behind a headline someone is reading, so anything faster competes with the text
 * — the same reason the CSS keyframe is 4.5s.
 */

import { useMemo, useRef, useState } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { EventGraph, GraphNode } from '@/lib/graph/build-graph';
import { edgeLabel } from '@/lib/graph/build-graph';

/*
 * The client's design system pins ONE accent, #0071E3, so the graph reads in blue rather than the
 * amber/teal pair this started with. Two shades of the same hue still separate the two things that
 * must never look alike: NODE is the accent itself (an event), EDGE is a lighter tint of it (a
 * connection between events). Monochromatic depth is also what their write-up asks for by name.
 *
 * NODE is lifted slightly off #0071E3 because these are emissive points on a near-black field —
 * the spec's value was chosen for blue-on-white, where it is a link colour, and at 6px on dark it
 * reads muddy without the lift.
 */
/*
 * WORLD-UNIT SCALE FOR NODE RADII, and it is not cosmetic - without it the nodes are invisible.
 *
 * `build-graph.ts` emits `r` in the range 0.075-0.16 as an ABSTRACT ranking value, and the two
 * renderers have to convert it to their own units. GraphFallback.tsx:93 does `n.r * 105` to get
 * SVG pixels. This scene was using `r` RAW as three.js world units - but node x spans +/-13, so a
 * 0.075-0.16 radius is 3-6 PIXELS on a 503px canvas, then dimmed by `settled` on a near-black
 * field. Edges meanwhile use lineBasicMaterial, which draws a crisp 1px line at any distance.
 *
 * So the hierarchy was exactly inverted: the edges (support) were the only thing visible and the
 * nodes (the events, the subject of the legend's "sized by connection score") were sub-pixel
 * noise. The band read as a random wireframe tangle.
 *
 * 3.5 puts the on-screen radius at 4.9-10.4px. That is SMALLER than GraphFallback's 7.9-16.8px,
 * deliberately: the fallback spreads nodes across the FULL box by mapping x and y extents
 * independently, while SCENE_FIT scales uniformly and so packs them toward the middle. At the
 * fallback's radius, 30 nodes at that density were overlapping blobs. Derived, then checked by eye:
 *
 *   visible height = 2 * 9 * tan(25deg) = 8.39 world units over a 252px canvas -> 30.0 px/unit
 *   on-screen r    = r * NODE_SCALE * SCENE_FIT * 30.0
 *                  = 0.075 * 3.5 * 0.62 * 30.0 = 4.9px  ..  0.16 -> 10.4px
 *
 * CHANGE THE CAMERA OR SCENE_FIT AND YOU MUST REDO THIS. Two earlier attempts overshot: 5.6
 * without SCENE_FIT gave 12-27px blobs that swallowed the edges and clipped at the frame, and 5.7
 * with it still overlapped badly. Both were visibly worse than the bug they were fixing.
 *
 * Do NOT fix this by widening `r` in build-graph - that field is shared, and the SVG's * 105 is
 * calibrated against the current range.
 */
const NODE_SCALE = 3.5;

/**
 * Shrinks the whole scene so build-graph's x spread of +/- 13 fits the z=9 frustum's +/- 8.4.
 * Applied to ONE group wrapping the edges and the nodes, so positions and radii scale together.
 */
const SCENE_FIT = 0.62;

const NODE = '#3D93FF';
const NODE_LIT = '#CFE6FF';
const EDGE = '#4DA3FF';
const EDGE_LIT = '#EAF4FF';

/** What the hero needs back when someone picks a node. */
export interface GraphSelection {
  id: string;
  title: string;
}

function Edges({ graph, hovered }: { graph: EventGraph; hovered: number | null }) {
  /*
   * The geometry is reached through a REF to the mesh, not through the value `useMemo` returned.
   *
   * Recolouring a buffer in place every frame is the only way to light an edge without rebuilding
   * geometry or swapping materials — but React Compiler's immutability rule correctly forbids
   * mutating something a hook handed back, and it cannot know that a THREE.BufferGeometry is an
   * intentionally mutable GPU handle rather than React state. A ref is the sanctioned escape hatch,
   * so the frame loop reads the live object off the mesh instead. That is also more honest: the
   * mesh owns the buffer, and this is the same object three.js is about to upload.
   */
  const meshRef = useRef<THREE.LineSegments>(null);

  const geometry = useMemo(() => {
    const positions = new Float32Array(graph.edges.length * 6);
    const colorArray = new Float32Array(graph.edges.length * 6);
    graph.edges.forEach((edge, i) => {
      const a = graph.nodes[edge.a];
      const b = graph.nodes[edge.b];
      positions.set([a.x, a.y, a.z, b.x, b.y, b.z], i * 6);
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colorArray, 3));
    return geo;
  }, [graph]);

  /*
   * Hover lights a node AND ITS EDGES — this is the product thesis, not a flourish. Seeing which
   * other events light up is the answer to "who will I meet here", so the highlight has to travel
   * along the connections rather than stopping at the node.
   *
   * Written straight into the colour attribute rather than swapping materials, so it stays one
   * draw call.
   */
  useFrame(() => {
    const attr = meshRef.current?.geometry?.attributes?.color;
    if (!attr) return;
    const colors = attr.array as Float32Array;

    const base = new THREE.Color(EDGE);
    const lit = new THREE.Color(EDGE_LIT);
    for (let i = 0; i < graph.edges.length; i++) {
      const edge = graph.edges[i];
      const isLit = hovered !== null && (edge.a === hovered || edge.b === hovered);
      const c = isLit ? lit : base;
      // The weakest reason is pulled well down. "Same topic" is true of a third of the corpus, so
      // at equal weight those edges dominate the picture and flatten the hierarchy into a mesh —
      // the strong claims have to be the ones you see first.
      const dim = isLit ? 1 : edge.reason === 'organizer' ? 0.5 : edge.reason === 'company' ? 0.3 : 0.1;
      for (let v = 0; v < 2; v++) {
        colors[i * 6 + v * 3 + 0] = c.r * dim;
        colors[i * 6 + v * 3 + 1] = c.g * dim;
        colors[i * 6 + v * 3 + 2] = c.b * dim;
      }
    }
    attr.needsUpdate = true;
  });

  return (
    <lineSegments ref={meshRef} geometry={geometry}>
      {/* 0.62, down from 0.95: with the nodes finally at a legible size the edges only have to
          carry the relationships, and at full strength ~90 of them flatten the picture into a
          mesh - the failure this file already warns about for edge WEIGHTING. */}
      <lineBasicMaterial vertexColors transparent opacity={0.62} />
    </lineSegments>
  );
}

/**
 * The event nodes.
 *
 * WHY THIS IS A CORE <instancedMesh> AND NOT drei's <Instances>/<Instance>.
 *
 * It used to be drei, and the nodes DID NOT RENDER AT ALL - at any radius, on a healthy WebGL
 * context, with the edges beside them drawing perfectly. So the band read as a random wireframe
 * tangle: the edges (support) were the only visible thing, and the events themselves - the subject
 * of the legend's "sized by connection score" - were absent. The entire point of the hero was
 * missing, which is why it looked like a static line drawing rather than a graph.
 *
 * Isolated by experiment rather than guessed: a plain core <mesh> with <sphereGeometry> and a
 * magenta <meshBasicMaterial>, dropped into this same scene, rendered immediately while the drei
 * instances beside it stayed invisible. So the fault is drei's instancing against this version set
 * - @react-three/drei 10.7.8 with @react-three/fiber 9.7.0 and three 0.185.1 - and not the
 * geometry, camera, material, colours or sizes, all of which were suspected first.
 *
 * <instancedMesh> is a fiber intrinsic over THREE.InstancedMesh, so it takes exactly the same core
 * path as the edges. Still one draw call, as drei intended; the per-instance matrix and colour are
 * written by hand, which costs a dozen lines and removes a dependency from the most load-bearing
 * element in the app.
 *
 * If you are tempted to restore drei here: run the magenta-sphere experiment first. And note that
 * GraphFallback.tsx renders this same graph as SVG and was the ONLY reason the feature looked
 * finished while this was broken - a working fallback can hide a dead primary indefinitely.
 */
function Nodes({
  graph,
  hovered,
  setHovered,
  onSelect,
  reducedMotion,
}: {
  graph: EventGraph;
  hovered: number | null;
  setHovered: (i: number | null) => void;
  onSelect: (s: GraphSelection) => void;
  reducedMotion: boolean;
}) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  // Scratch objects, allocated once: a fresh Object3D and Color per node per frame would churn
  // ~1800 allocations a second at 30 nodes and 60fps.
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const tint = useMemo(() => new THREE.Color(), []);
  const count = graph.nodes.length;

  useFrame(({ clock }) => {
    const mesh = meshRef.current;
    if (!mesh) return;

    for (let i = 0; i < count; i++) {
      const node = graph.nodes[i];
      const isHovered = hovered === i;

      // 0.62 rather than 0.42 for an unconnected node: still clearly secondary, but at 0.42 on a
      // near-black field it was effectively gone, which made the "in graph" count a lie.
      const settled = node.degree === 0 ? 0.62 : 0.78 + Math.min(node.degree, 3) * 0.07;
      const breath = reducedMotion
        ? 1
        : 1 + Math.sin(clock.elapsedTime * 0.9 + i * 0.7) * 0.12;

      dummy.position.set(node.x, node.y, node.z);
      // NODE_SCALE converts the abstract ranking radius into world units - see its definition.
      dummy.scale.setScalar(node.r * NODE_SCALE * (isHovered ? 1.55 : 1) * breath);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);

      tint.set(isHovered ? NODE_LIT : NODE).multiplyScalar(isHovered ? 1 : settled);
      mesh.setColorAt(i, tint);
    }

    mesh.instanceMatrix.needsUpdate = true;
    // setColorAt allocates instanceColor on first use, so this is null only before the first pass.
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  });

  return (
    <instancedMesh
      ref={meshRef}
      // args are constructor-time, so the count is keyed: a graph with a different node count needs
      // a new InstancedMesh rather than a resized one.
      key={count}
      args={[undefined, undefined, count]}
      onPointerOver={e => {
        e.stopPropagation();
        // Raycasting an InstancedMesh reports which instance was hit, and that index IS the node
        // index - which is what makes hover work without a mesh per node.
        if (e.instanceId != null) setHovered(e.instanceId);
      }}
      onPointerOut={() => setHovered(null)}
      onClick={e => {
        e.stopPropagation();
        const i = e.instanceId;
        if (i == null) return;
        const node = graph.nodes[i];
        if (node) onSelect({ id: node.id, title: node.title });
      }}
    >
      {/* One sphere, low poly. At this size nobody can tell 16 segments from 64, and the difference
          is real vertex count across every instance. */}
      <sphereGeometry args={[1, 16, 16]} />
      {/* Material colour stays WHITE: three multiplies it by the per-instance colour, so tinting it
          here would darken every node twice. toneMapped={false} keeps the accent exactly #3D93FF
          instead of letting tone mapping desaturate it. */}
      <meshBasicMaterial toneMapped={false} />
    </instancedMesh>
  );
}

/** Slow orbital drift, so the depth is readable without the user doing anything. */
function CameraDrift({ enabled }: { enabled: boolean }) {
  useFrame(({ camera, clock }) => {
    if (!enabled) return;
    const t = clock.elapsedTime * 0.08;
    camera.position.x = Math.sin(t) * 1.5;
    camera.position.y = Math.sin(t * 0.7) * 0.5;
    camera.lookAt(0, 0, 0);
  });
  return null;
}

export default function ConnectionGraph({
  graph,
  onSelect,
  reducedMotion = false,
}: {
  graph: EventGraph;
  onSelect: (s: GraphSelection) => void;
  reducedMotion?: boolean;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  const active = hovered === null ? null : graph.nodes[hovered];
  const activeEdges = useMemo(
    () => (hovered === null ? [] : graph.edges.filter(e => e.a === hovered || e.b === hovered)),
    [graph.edges, hovered]
  );

  return (
    <div className="relative h-full w-full">
      <Canvas
        // Capped: this is a background, and a 3x-DPR phone would render 9x the pixels of a laptop.
        dpr={[1, 1.5]}
        /*
         * LEAVE THIS AT z=9. The clipping it causes is fixed by SCENE_FIT below, not here.
         *
         * The graph WAS clipped: build-graph spreads nodes across x +/- 13, while z=9 with fov 50 on
         * a 503x252 canvas sees only +/- 8.4 world units across - so 36% of the layout's width sat
         * outside the frustum. The obvious fix is to pull the camera back to z=16, which frames it
         * exactly. Do not: moving it to 16 made the scene render NOTHING - not the nodes, not even
         * the edges that had always drawn - and the cause was never established. Verified from the
         * built bundle (`position:[0,0,16]` was really shipped) with the graph populated
         * (`IN GRAPH 30`), no console errors, and a live context.
         *
         * So the camera stays where it is known to work and the SCENE is scaled to fit instead,
         * which is equivalent for an orthographic-looking band like this one and has no mystery in
         * it.
         */
        camera={{ position: [0, 0, 9], fov: 50 }}
        // No alpha buffer needed — the band has a solid base colour behind it.
        gl={{ antialias: true, alpha: true, powerPreference: 'low-power' }}
        /*
         * R3F OWNS THE CANVAS STYLE — do not pass a `style` prop here.
         *
         * There was a `style={{ pointerEvents: 'auto' }}` on this Canvas. It was removed because it
         * was redundant (nothing above sets `pointer-events: none`) and because the canvas's inline
         * style is how R3F applies its measured width and height, so contributing to it is asking
         * for trouble.
         *
         * `debounce: 0` takes the first measurement immediately rather than on a trailing tick.
         *
         * WHAT IS *NOT* ESTABLISHED, recorded because the investigation looked conclusive and was
         * not: while verifying, the canvas sat at its HTML default of 300x150 inside a 1176x268
         * container, and a synthetic `resize` event snapped it to the correct 1764x402 buffer. That
         * looks exactly like a real first-paint sizing bug. It is not — a direct probe showed that
         * `ResizeObserver` NEVER fires in that headless pane, not even for an element with a stable
         * non-zero size, so R3F could not have sized itself there whatever this code did. With the
         * pane actually displayed, the canvas measured 1176x268 and rendered correctly. So neither
         * line above is a fix for that symptom; treat a 300x150 canvas in a headless browser as an
         * artifact of the harness, and do not "fix" it by dispatching synthetic resize events in
         * app code.
         */
        resize={{ scroll: false, debounce: 0 }}
      >
        <CameraDrift enabled={!reducedMotion} />
        {/*
          SCENE_FIT — one group scaling BOTH the edges and the nodes, which is the whole reason it
          works. build-graph spreads nodes across x +/- 13 and the camera at z=9 sees +/- 8.4, so a
          third of the layout was outside the frustum: events at the edges were absent and the rest
          were crowded, which is a large part of why the band read as a tangle.

          Scaling the group rather than the camera keeps the one arrangement that is known to
          render (see the camera note above), and scaling positions and radii TOGETHER is what makes
          it safe — the picture is identical, just smaller, so NODE_SCALE stays meaningful.

          0.62 puts x at +/- 8.06 inside the +/- 8.4 frustum, so nothing clips and there is a little
          margin. Derived from 8.4/13 with ~4% headroom, not chosen by eye.
        */}
        <group scale={SCENE_FIT}>
          <Edges graph={graph} hovered={hovered} />
          <Nodes
            graph={graph}
            hovered={hovered}
            setHovered={setHovered}
            onSelect={onSelect}
            reducedMotion={reducedMotion}
          />
        </group>
      </Canvas>

      {/*
        The tooltip is HTML, not drei's <Html>, so it inherits the app's type and does not enter
        the 3D transform stack. It says WHY the connections exist — "same host" is the useful part;
        a title alone would just repeat what the list already shows.
      */}
      {active && (
        <div className="pointer-events-none absolute bottom-3 left-3 max-w-[min(420px,80%)] rounded-xl bg-[#0B1220]/92 px-3.5 py-2.5 shadow-lg ring-1 ring-[color:var(--deep-line)] backdrop-blur-md">
          <p className="truncate text-[13px] font-semibold text-[color:var(--deep-text)]">
            {active.title}
          </p>
          <p className="mt-0.5 text-[11.5px] text-[color:var(--deep-muted)]">
            {activeEdges.length === 0
              ? 'no shared host, company or topic yet'
              : `${activeEdges.length} connection${activeEdges.length === 1 ? '' : 's'} · ` +
                [...new Set(activeEdges.map(e => edgeLabel(e.reason)))].join(', ')}
          </p>
        </div>
      )}
    </div>
  );
}
