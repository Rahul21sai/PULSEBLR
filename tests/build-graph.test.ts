/**
 * `buildEventGraph()` — the model behind the connection graph hero.
 *
 * The scene is a view; this is the thing that decides what connects to what, and it is where the
 * feature can be wrong in ways a screenshot would not reveal. Three properties carry the weight:
 *
 *   · DETERMINISM. No Math.random, so the same events always land in the same place. Without it a
 *     re-render on filter change reshuffles the whole sky and the motion means nothing.
 *   · THE CAP. Edge-finding is pairwise, so an uncapped graph is O(n²) work and a solid block of
 *     lines. 48 nodes and 3 edges each is what keeps it both cheap and legible.
 *   · REASON PRECEDENCE. "same host" is a much stronger claim about meeting the same people than
 *     "same topic", and since a third of the corpus is AI/ML, category edges left uncapped would
 *     connect everything to everything.
 */
import { describe, it, expect } from 'vitest';
import { buildEventGraph, edgesTouching, edgeLabel, MAX_NODES } from '../lib/graph/build-graph';
import type { GraphSourceEvent } from '../lib/graph/build-graph';

function ev(over: Partial<GraphSourceEvent> & { _id: string }): GraphSourceEvent {
  return {
    title: `Event ${over._id}`,
    connectionScore: 50,
    startDateTime: '2026-09-01T10:00:00Z',
    ...over,
  };
}

describe('determinism', () => {
  it('produces identical output for identical input', () => {
    const events = [ev({ _id: 'a' }), ev({ _id: 'b' }), ev({ _id: 'c' })];
    expect(buildEventGraph(events)).toEqual(buildEventGraph(events));
  });

  it('places a given node at the same coordinates across calls', () => {
    const first = buildEventGraph([ev({ _id: 'a' }), ev({ _id: 'b' })]);
    const second = buildEventGraph([ev({ _id: 'a' }), ev({ _id: 'b' })]);
    expect(first.nodes[0].x).toBe(second.nodes[0].x);
    expect(first.nodes[0].z).toBe(second.nodes[0].z);
  });

  it('handles an empty corpus without throwing', () => {
    const g = buildEventGraph([]);
    expect(g.nodes).toEqual([]);
    expect(g.edges).toEqual([]);
    expect(g.omitted).toBe(0);
  });

  it('handles a single event, where the spiral would divide by zero', () => {
    const g = buildEventGraph([ev({ _id: 'only' })]);
    expect(g.nodes).toHaveLength(1);
    expect(Number.isFinite(g.nodes[0].x)).toBe(true);
    expect(Number.isFinite(g.nodes[0].y)).toBe(true);
  });
});

describe('the node cap, which keeps the scene cheap', () => {
  it(`never exceeds ${MAX_NODES} nodes and reports what it dropped`, () => {
    const many = Array.from({ length: 200 }, (_, i) => ev({ _id: `e${i}` }));
    const g = buildEventGraph(many);
    expect(g.nodes).toHaveLength(MAX_NODES);
    expect(g.omitted).toBe(200 - MAX_NODES);
  });

  it('keeps the HIGHEST-scoring events, matching the feed ranking', () => {
    // The graph must be a view of the top of the feed, not a different dataset.
    const events = [
      ev({ _id: 'low', connectionScore: 5 }),
      ev({ _id: 'high', connectionScore: 99 }),
      ev({ _id: 'mid', connectionScore: 50 }),
    ];
    const g = buildEventGraph(events);
    expect(g.nodes.map(n => n.id)).toEqual(['high', 'mid', 'low']);
  });

  it('breaks score ties by soonest, so the order is still a schedule', () => {
    const g = buildEventGraph([
      ev({ _id: 'later', connectionScore: 50, startDateTime: '2026-09-10T10:00:00Z' }),
      ev({ _id: 'sooner', connectionScore: 50, startDateTime: '2026-09-02T10:00:00Z' }),
    ]);
    expect(g.nodes.map(n => n.id)).toEqual(['sooner', 'later']);
  });
});

describe('edges express a real reason two events share people', () => {
  it('connects two events with the same host', () => {
    const g = buildEventGraph([
      ev({ _id: 'a', organizer: 'Razorpay Rize' }),
      ev({ _id: 'b', organizer: 'razorpay rize' }), // case-insensitive on purpose
    ]);
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0].reason).toBe('organizer');
  });

  it('connects two events sharing a company', () => {
    const g = buildEventGraph([
      ev({ _id: 'a', companies: ['Google'] }),
      ev({ _id: 'b', companies: ['Google', 'Stripe'] }),
    ]);
    expect(g.edges[0].reason).toBe('company');
  });

  it('connects two events sharing a topic, as the weakest reason', () => {
    const g = buildEventGraph([
      ev({ _id: 'a', category: ['AI/ML'] }),
      ev({ _id: 'b', category: ['AI/ML'] }),
    ]);
    expect(g.edges[0].reason).toBe('category');
  });

  it('prefers the STRONGEST reason when several apply', () => {
    // Same host AND same topic must read as "same host" — the stronger claim.
    const g = buildEventGraph([
      ev({ _id: 'a', organizer: 'GDG Bangalore', category: ['AI/ML'] }),
      ev({ _id: 'b', organizer: 'GDG Bangalore', category: ['AI/ML'] }),
    ]);
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0].reason).toBe('organizer');
  });

  it('does NOT connect events with nothing in common', () => {
    const g = buildEventGraph([
      ev({ _id: 'a', organizer: 'One', category: ['AI/ML'] }),
      ev({ _id: 'b', organizer: 'Two', category: ['Cybersecurity'] }),
    ]);
    expect(g.edges).toEqual([]);
  });

  it('ignores empty and missing values rather than treating them as a match', () => {
    // The trap: two events with no organiser both normalise to '' and would otherwise be
    // "same host" — which would connect every unattributed event to every other one.
    const g = buildEventGraph([
      ev({ _id: 'a', organizer: '', companies: [], category: [] }),
      ev({ _id: 'b', organizer: null, companies: null, category: null }),
      ev({ _id: 'c', organizer: '   ', companies: [''], category: [] }),
    ]);
    expect(g.edges).toEqual([]);
  });
});

describe('the degree cap, which stops a hub becoming a hairball', () => {
  it('gives no node more than 3 edges', () => {
    // 10 events all sharing one topic would be 45 lines uncapped.
    const events = Array.from({ length: 10 }, (_, i) => ev({ _id: `e${i}`, category: ['AI/ML'] }));
    const g = buildEventGraph(events);
    for (const node of g.nodes) {
      expect(node.degree).toBeLessThanOrEqual(3);
    }
  });

  it('records degree on the node, so loners can be faded rather than hidden', () => {
    const g = buildEventGraph([
      ev({ _id: 'a', organizer: 'Same' }),
      ev({ _id: 'b', organizer: 'Same' }),
      ev({ _id: 'lonely', organizer: 'Nobody Else' }),
    ]);
    const lonely = g.nodes.find(n => n.id === 'lonely');
    expect(lonely?.degree).toBe(0);
  });

  it('never emits the same pair twice', () => {
    const events = Array.from({ length: 12 }, (_, i) => ev({ _id: `e${i}`, category: ['AI/ML'] }));
    const g = buildEventGraph(events);
    const seen = new Set(g.edges.map(e => `${e.a}-${e.b}`));
    expect(seen.size).toBe(g.edges.length);
    // And always a < b, which is what makes the key above sufficient.
    for (const e of g.edges) expect(e.a).toBeLessThan(e.b);
  });
});

describe('render inputs', () => {
  it('scales radius with score but never to zero', () => {
    const g = buildEventGraph([
      ev({ _id: 'top', connectionScore: 100 }),
      ev({ _id: 'bottom', connectionScore: 0 }),
    ]);
    const top = g.nodes.find(n => n.id === 'top')!;
    const bottom = g.nodes.find(n => n.id === 'bottom')!;
    expect(top.r).toBeGreaterThan(bottom.r);
    expect(bottom.r).toBeGreaterThan(0);
  });

  it('clamps a score outside 0-100 and defaults a missing one', () => {
    const g = buildEventGraph([
      ev({ _id: 'over', connectionScore: 500 }),
      ev({ _id: 'under', connectionScore: -20 }),
      ev({ _id: 'absent', connectionScore: null }),
    ]);
    expect(g.nodes.find(n => n.id === 'over')!.score).toBe(100);
    expect(g.nodes.find(n => n.id === 'under')!.score).toBe(0);
    expect(g.nodes.find(n => n.id === 'absent')!.score).toBe(20);
  });
});

describe('helpers', () => {
  it('finds every edge touching a node, from either end', () => {
    const edges = [
      { a: 0, b: 1, reason: 'organizer' as const },
      { a: 1, b: 2, reason: 'category' as const },
      { a: 2, b: 3, reason: 'company' as const },
    ];
    expect(edgesTouching(edges, 1)).toHaveLength(2);
    expect(edgesTouching(edges, 3)).toHaveLength(1);
    expect(edgesTouching(edges, 9)).toHaveLength(0);
  });

  it('labels every reason in plain words', () => {
    // The tooltip has to say WHY two events are joined; "organizer" is a field name, not an answer.
    expect(edgeLabel('organizer')).toBe('same host');
    expect(edgeLabel('company')).toBe('shared company');
    expect(edgeLabel('category')).toBe('same topic');
  });
});
