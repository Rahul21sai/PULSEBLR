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
import { Instance, Instances } from '@react-three/drei';
import * as THREE from 'three';
import type { EventGraph, GraphNode } from '@/lib/graph/build-graph';
import { edgeLabel } from '@/lib/graph/build-graph';

const PULSE = '#FF9E3D';
const CONNECT = '#35C4C4';

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

    const base = new THREE.Color(CONNECT);
    const lit = new THREE.Color('#EAFEFE');
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
      <lineBasicMaterial vertexColors transparent opacity={0.95} />
    </lineSegments>
  );
}

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
  return (
    <Instances limit={graph.nodes.length} castShadow={false} receiveShadow={false}>
      {/* One sphere, low poly. At this size on screen nobody can tell 16 segments from 64, and
          the difference is real vertex count across 48 instances. */}
      <sphereGeometry args={[1, 16, 16]} />
      <meshBasicMaterial color={PULSE} transparent />
      {graph.nodes.map((node, i) => (
        <NodeInstance
          key={node.id}
          node={node}
          index={i}
          isHovered={hovered === i}
          onHover={setHovered}
          onSelect={onSelect}
          reducedMotion={reducedMotion}
        />
      ))}
    </Instances>
  );
}

function NodeInstance({
  node,
  index,
  isHovered,
  onHover,
  onSelect,
  reducedMotion,
}: {
  node: GraphNode;
  index: number;
  isHovered: boolean;
  onHover: (i: number | null) => void;
  onSelect: (s: GraphSelection) => void;
  reducedMotion: boolean;
}) {
  const ref = useRef<THREE.Object3D>(null);

  useFrame(({ clock }) => {
    if (!ref.current) return;
    // A node with no edges sits dimmer; hover overrides everything.
    const settled = node.degree === 0 ? 0.42 : 0.7 + Math.min(node.degree, 3) * 0.08;
    const breath = reducedMotion
      ? 1
      : 1 + Math.sin(clock.elapsedTime * 0.9 + index * 0.7) * 0.12;
    const scale = node.r * (isHovered ? 1.9 : 1) * breath;
    ref.current.scale.setScalar(scale);

    // Instances share a material, so per-node brightness has to ride on the instance colour.
    const inst = ref.current as THREE.Object3D & { color?: THREE.Color };
    if (inst.color) {
      inst.color.set(isHovered ? '#FFD8A8' : PULSE).multiplyScalar(isHovered ? 1 : settled);
    }
  });

  return (
    <Instance
      ref={ref}
      position={[node.x, node.y, node.z]}
      onPointerOver={e => {
        e.stopPropagation();
        onHover(index);
      }}
      onPointerOut={() => onHover(null)}
      onClick={e => {
        e.stopPropagation();
        onSelect({ id: node.id, title: node.title });
      }}
    />
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
        <Edges graph={graph} hovered={hovered} />
        <Nodes
          graph={graph}
          hovered={hovered}
          setHovered={setHovered}
          onSelect={onSelect}
          reducedMotion={reducedMotion}
        />
      </Canvas>

      {/*
        The tooltip is HTML, not drei's <Html>, so it inherits the app's type and does not enter
        the 3D transform stack. It says WHY the connections exist — "same host" is the useful part;
        a title alone would just repeat what the list already shows.
      */}
      {active && (
        <div className="pointer-events-none absolute bottom-3 left-3 max-w-[min(420px,80%)] rounded-xl bg-[color:var(--n-surface)]/95 px-3.5 py-2.5 shadow-lg ring-1 ring-[color:var(--n-hairline)]">
          <p className="truncate text-[13px] font-semibold text-[color:var(--n-text)]">
            {active.title}
          </p>
          <p className="mt-0.5 text-[11.5px] text-[color:var(--n-muted)]">
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
