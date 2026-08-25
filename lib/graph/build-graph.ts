/**
 * Turn a list of events into the node/edge graph the hero renders.
 *
 * THE POINT OF THE WHOLE FEATURE. PulseBLR's claim is "ranked by who you'll meet" — the corpus
 * is a graph, not a list, and until now that was only ever expressed as a number nobody could
 * see. An edge here means a real, checkable reason two events put you in front of the same
 * people: the same host, an overlapping company, or the same topic. Hovering a node lights its
 * edges, which is the thesis rendered rather than asserted.
 *
 * PURE AND DETERMINISTIC, for three reasons that all matter:
 *   · No `Math.random()`. Positions come from a golden-angle spiral seeded by index, so the same
 *     events always produce the same layout — a re-render on filter change moves nodes to new
 *     places for a REASON rather than reshuffling the sky, and the result is testable at all.
 *   · No React, no three.js imports. This file is the model; the scene is the view. It can be
 *     unit-tested without a WebGL context, which is the only way to test it at all in CI.
 *   · It caps its own size. A scene is not allowed to grow with the corpus (see MAX_NODES).
 */

/** The minimum an event needs for the graph to place it. */
export interface GraphSourceEvent {
  _id: string;
  title: string;
  connectionScore?: number | null;
  organizer?: string | null;
  companies?: string[] | null;
  category?: string[] | null;
  startDateTime: string;
  format?: string | null;
}

export interface GraphNode {
  id: string;
  title: string;
  /** 0-100, drives radius and glow. */
  score: number;
  /** Unit-ish coordinates, roughly within a 10 x 6 x 6 box centred on the origin. */
  x: number;
  y: number;
  z: number;
  /** Render radius, already scaled from `score`. */
  r: number;
  /** How many edges this node has. Used to fade the loners rather than hide them. */
  degree: number;
}

export type EdgeReason = 'organizer' | 'company' | 'category';

export interface GraphEdge {
  /** Indices into `nodes`, always a < b so a pair cannot appear twice. */
  a: number;
  b: number;
  reason: EdgeReason;
}

export interface EventGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** How many events were dropped by the node cap, so the UI can say so honestly. */
  omitted: number;
}

/*
 * A HARD CEILING, not a suggestion.
 *
 * Edge-finding is pairwise, so cost is O(n²) — at 340 events that is ~58,000 comparisons per
 * render, and the scene would draw thousands of line segments over a headline someone is trying
 * to read. 48 nodes keeps the graph legible (you can still trace a cluster by eye) and the work
 * trivial. The events that make the cut are the highest-scoring ones, which is the same ranking
 * the feed uses, so the graph is a view of the top of the feed rather than a different dataset.
 */
export const MAX_NODES = 48;

/** At most this many edges per node, strongest reason first. Prevents a hub becoming a hairball. */
const MAX_DEGREE = 3;

/** Golden angle. Successive indices land far apart, so no seeded randomness is needed. */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

function normalise(value: string | null | undefined): string {
  return (value || '').trim().toLowerCase();
}

/**
 * Build the graph.
 *
 * Events are ranked by `connectionScore` and the top `MAX_NODES` are placed. Edges are then found
 * pairwise and capped per node.
 */
export function buildEventGraph(events: GraphSourceEvent[]): EventGraph {
  const ranked = [...events].sort(
    (a, b) =>
      (b.connectionScore ?? 0) - (a.connectionScore ?? 0) ||
      new Date(a.startDateTime).getTime() - new Date(b.startDateTime).getTime()
  );
  const chosen = ranked.slice(0, MAX_NODES);
  const omitted = Math.max(0, events.length - chosen.length);

  /*
   * A phyllotactic spiral flattened into a slab rather than a sphere.
   *
   * A sphere would put half the nodes behind the others from any camera angle; the hero is a wide
   * short band, so the useful shape is wide, short and shallow. `y` is compressed hardest and `z`
   * gives just enough depth to parallax against the camera drift.
   */
  /*
   * PLACEMENT IS CLUSTERED, WHILE THE ARRAY STAYS RANK-ORDERED.
   *
   * Placing nodes in score order put semantically-connected events at opposite ends of the spiral,
   * so their edges crossed the entire field — the first render read as a scribble rather than a
   * network, and no amount of opacity tuning fixes a topology problem.
   *
   * Sorting the PLACEMENT ORDER by cluster key (host, else company, else topic) puts events that
   * will be joined at adjacent spiral slots, so edges become short and local and real clusters
   * become visible. It is still fully deterministic — a stable sort over a derived string, no
   * force simulation, no randomness, no iteration budget.
   *
   * The `nodes` array itself keeps score order, because callers rely on it: the graph must remain
   * a view of the top of the feed, and `tests/build-graph.test.ts` pins that ranking.
   */
  const clusterKey = (e: GraphSourceEvent) =>
    normalise(e.organizer) ||
    normalise((e.companies || [])[0]) ||
    normalise((e.category || [])[0]) ||
    '~'; // sorts last, so unattributed events gather at one end instead of salting the field

  const slotOf = new Array<number>(chosen.length);
  chosen
    .map((event, i) => ({ i, key: clusterKey(event) }))
    .sort((a, b) => a.key.localeCompare(b.key) || a.i - b.i)
    .forEach((entry, slot) => {
      slotOf[entry.i] = slot;
    });

  const nodes: GraphNode[] = chosen.map((event, i) => {
    const slot = slotOf[i];
    const t = chosen.length === 1 ? 0 : slot / (chosen.length - 1);
    const angle = slot * GOLDEN_ANGLE;
    const radius = Math.sqrt(t);
    const score = Math.max(0, Math.min(100, event.connectionScore ?? 20));

    return {
      id: event._id,
      title: event.title,
      score,
      /*
       * SPREAD IS MATCHED TO WHAT THE CAMERA ACTUALLY SEES, which the first version got wrong.
       *
       * At fov 50 and z 9 the frustum is ~8.4 units tall and, at the band's ~4.4:1 aspect, ~37
       * wide. The original ±5.2 by ±2.1 slab therefore filled 28% of the width and half the
       * height, and it rendered exactly as that measurement predicts: a small blob adrift in
       * black, with a dead gap between the counts and the nodes.
       *
       * ±13 by ±3 fills roughly 70% of each axis, which leaves margin without wasting the band.
       * The fallback derives its projection from the real extents rather than these numbers, so
       * changing them cannot silently clip the SVG.
       */
      x: Math.cos(angle) * radius * 13,
      y: Math.sin(angle) * radius * 3,
      // Deterministic depth that does not correlate with x/y, so the slab does not look like a
      // flat disc tilted in space.
      z: Math.sin(slot * 1.7) * 1.9,
      // Radius is driven by score but floored, because a node you cannot see is not a node. The
      // range is deliberately narrow — this encodes a RANKING, not a measurement, the same reason
      // the connection meter draws three bars instead of printing "83".
      r: 0.075 + (score / 100) * 0.085,
      degree: 0,
    };
  });

  // ── edges ──────────────────────────────────────────────────────────────────────
  // Pre-compute the comparable keys once per node rather than inside the pairwise loop.
  const keys = chosen.map(e => ({
    organizer: normalise(e.organizer),
    companies: new Set((e.companies || []).map(normalise).filter(Boolean)),
    categories: new Set((e.category || []).map(normalise).filter(Boolean)),
  }));

  const candidates: GraphEdge[] = [];
  for (let a = 0; a < chosen.length; a++) {
    for (let b = a + 1; b < chosen.length; b++) {
      const ka = keys[a];
      const kb = keys[b];

      /*
       * Strongest reason wins, and the order is a claim about the product, not an arbitrary
       * ranking. Same HOST is the best predictor that you will meet the same people — a community
       * brings its regulars. A shared COMPANY is next: someone from that company is likely at
       * both. Same CATEGORY is weakest, because "AI/ML" covers a third of the corpus and would
       * otherwise connect everything to everything.
       */
      let reason: EdgeReason | null = null;
      if (ka.organizer && ka.organizer === kb.organizer) {
        reason = 'organizer';
      } else if ([...ka.companies].some(c => kb.companies.has(c))) {
        reason = 'company';
      } else if ([...ka.categories].some(c => kb.categories.has(c))) {
        reason = 'category';
      }

      if (reason) candidates.push({ a, b, reason });
    }
  }

  /*
   * Cap per node, strongest first.
   *
   * Without this, `category` alone makes a near-complete graph — 48 AI/ML events would be 1,128
   * lines and the hero becomes a solid block of teal. Sorting by reason before capping means the
   * edges that survive are the meaningful ones, so the hairball is trimmed from the weak end.
   */
  const weight: Record<EdgeReason, number> = { organizer: 0, company: 1, category: 2 };
  candidates.sort((x, y) => weight[x.reason] - weight[y.reason]);

  const degree = new Array(chosen.length).fill(0);
  const edges: GraphEdge[] = [];
  for (const edge of candidates) {
    if (degree[edge.a] >= MAX_DEGREE || degree[edge.b] >= MAX_DEGREE) continue;
    edges.push(edge);
    degree[edge.a]++;
    degree[edge.b]++;
  }

  for (let i = 0; i < nodes.length; i++) nodes[i].degree = degree[i];

  return { nodes, edges, omitted };
}

/** Every edge touching this node index. Used to light a hovered node's connections. */
export function edgesTouching(edges: GraphEdge[], index: number): GraphEdge[] {
  return edges.filter(e => e.a === index || e.b === index);
}

/** Human-readable reason, for the hover tooltip. Says WHY, which is the whole value. */
export function edgeLabel(reason: EdgeReason): string {
  switch (reason) {
    case 'organizer':
      return 'same host';
    case 'company':
      return 'shared company';
    case 'category':
      return 'same topic';
  }
}
