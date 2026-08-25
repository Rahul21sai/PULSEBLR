'use client';

/**
 * The signature element: Bengaluru's tech scene as a graph, above the feed.
 *
 * WHY A GRAPH AND NOT A HERO CARD. This app's claim is "ranked by who you'll meet" — the corpus is
 * a network, and `connectionScore` was the only expression of that, rendered as three small bars on
 * a row. The graph makes the claim literal: nodes are the highest-ranked upcoming events, edges are
 * a checkable reason two of them put you in front of the same people (same host, shared company,
 * same topic). Hovering lights a node AND its edges, which answers "who else would I meet" in the
 * one gesture. Clicking scrolls that event's row into view, so the spatial view and the list are
 * the same dataset rather than two features.
 *
 * IT IS A BAND, ~300px, NOT A VIEWPORT HERO. The list is the job. A full-height 3D hero would put
 * the first event row below the fold on a laptop and cost the user a scroll to reach what they came
 * for — the brief's own rule: animate in service of finding an event faster, never slower.
 *
 * ── HOW IT DEGRADES, which is most of the design ──────────────────────────────────────────────
 *
 * The SVG fallback renders FIRST, on the server, always. The 3D module is then loaded and swapped
 * in only if the device passes every check below. So:
 *   · First paint never waits on three.js (~150 KB gzipped, more than the rest of the feed).
 *   · There is no hydration mismatch — the server and the first client render agree on the SVG.
 *   · If the import fails, WebGL is missing, or the checks fail, the fallback simply stays. It is
 *     the same graph from the same model, so nothing is lost but the depth.
 *
 * The checks, and the reason for each:
 *   · `prefers-reduced-motion` — a hard no. Not "slower": the scene never mounts.
 *   · viewport < 768px — a phone gets the SVG. Not a capability guess: a drifting camera behind a
 *     headline on a 390px screen is noise, and it is the battery-sensitive case.
 *   · `hardwareConcurrency <= 4` — a rough proxy for a low-end device, applied only as a floor.
 *   · WebGL context probe — the only one that is a real answer rather than a heuristic.
 *   · `saveData` — if the user has asked the browser to save data, do not fetch 150 KB for decor.
 */

import dynamic from 'next/dynamic';
import { useEffect, useMemo, useState } from 'react';
import type { FeedEvent } from '@/lib/event-types';
import { buildEventGraph } from '@/lib/graph/build-graph';
import GraphFallback from './GraphFallback';
import type { GraphSelection } from './ConnectionGraph';

/**
 * `ssr: false` is load-bearing: three.js has no business running on the server, and rendering the
 * canvas server-side would both fail and delay the HTML the list needs.
 */
const ConnectionGraph = dynamic(() => import('./ConnectionGraph'), {
  ssr: false,
  // No spinner. The SVG is already on screen and is a complete answer; replacing it with a loader
  // would be strictly worse — a downgrade dressed as progress.
  loading: () => null,
});

/** Can this device have the 3D scene? Answered on the client only, after mount. */
function useCanRender3D(): boolean {
  const [ok, setOk] = useState(false);

  useEffect(() => {
    // Bail before touching the DOM if the user has asked for less motion.
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (reduced.matches) return;

    if (window.innerWidth < 768) return;

    const cores = navigator.hardwareConcurrency;
    if (typeof cores === 'number' && cores <= 4) return;

    const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
    if (connection?.saveData) return;

    // The only non-heuristic check. A probe canvas is thrown away immediately; asking for the
    // context is the only way to know, because a browser can expose WebGL and still refuse it
    // (blocklisted driver, too many live contexts).
    try {
      const probe = document.createElement('canvas');
      const gl = probe.getContext('webgl2') || probe.getContext('webgl');
      if (!gl) return;
      // Release it rather than leaving a context alive for the tab's lifetime.
      (gl.getExtension('WEBGL_lose_context') as { loseContext?: () => void } | null)?.loseContext?.();
    } catch {
      return;
    }

    /*
     * Deferred to a task rather than set synchronously, for two reasons that happen to agree.
     *
     * React Compiler flags a synchronous setState in an effect because it can cascade renders. And
     * independently it is what we want: yielding first guarantees the SVG has painted before the
     * 3D chunk is even requested, so the upgrade can never delay the first meaningful frame. The
     * timer is cleared on unmount so a fast navigation away does not set state on a dead component.
     */
    const upgrade = window.setTimeout(() => setOk(true), 0);

    // Someone can turn reduced-motion on while the page is open; honour it immediately.
    const onChange = (e: MediaQueryListEvent) => setOk(!e.matches);
    reduced.addEventListener('change', onChange);
    return () => {
      window.clearTimeout(upgrade);
      reduced.removeEventListener('change', onChange);
    };
  }, []);

  return ok;
}

export default function EventGraphHero({
  events,
  totalUpcoming,
  loading,
  onSelectEvent,
}: {
  /** The ranked feed page. The graph shows the top of it, not a separate query. */
  events: FeedEvent[];
  totalUpcoming: number;
  loading: boolean;
  /** Called when a node is picked, so the page can scroll that row into view. */
  onSelectEvent: (id: string) => void;
}) {
  const canRender3D = useCanRender3D();

  const graph = useMemo(
    () =>
      buildEventGraph(
        events.map(e => ({
          _id: e._id,
          title: e.title,
          connectionScore: e.connectionScore,
          organizer: e.organizer,
          companies: e.companies,
          category: e.category,
          startDateTime: e.startDateTime,
          format: e.format,
        }))
      ),
    [events]
  );

  const handleSelect = (s: GraphSelection) => onSelectEvent(s.id);

  const linked = graph.nodes.filter(n => n.degree > 0).length;

  return (
    <section className="glass-canvas relative overflow-hidden" aria-label="Connection graph">
      <div className="relative mx-auto max-w-[1240px] px-4 py-8 md:px-8 md:py-12">
        {/*
          THE LAYERED GLASS the spec asks for: a frosted panel on the washed canvas, holding a
          DEEP panel for the graph. Two layers is the whole idea — one sheet of glass is a card.

          Text left, visual right, matching the client's hero. That split is also what keeps the
          band short: side by side, the headline and the graph share one band's height instead of
          stacking into two.
        */}
        <div className="glass-panel p-5 sm:p-7 md:p-9">
          <div className="grid items-center gap-7 md:grid-cols-[1.02fr_1fr] md:gap-10">
            <div className="min-w-0">
              {/* The spec's pill badge: light accent fill, uppercase label. */}
              <span className="inline-flex items-center gap-2 rounded-full bg-[#0071E3]/10 px-3.5 py-1.5">
                <span aria-hidden="true" className="node-dot breathe" />
                <span className="t-eyebrow !text-[#0059B5]">Bengaluru live network</span>
              </span>

              {/* Two-tone headline, straight from their hero: ink for the frame of the sentence,
                  the accent gradient on the words that name the subject. The accent is confined
                  to a span, so it stays rationed rather than becoming a coloured headline. */}
              <h1 className="t-graph-title mt-4 max-w-[20ch] text-[#1D1D1F]">
                Ranked by{' '}
                <span className="t-accent-fill">who you&rsquo;ll meet</span>
              </h1>

              <p className="mt-3.5 max-w-[46ch] text-[15px] leading-[1.55] text-[#3a3a3c]">
                Every developer meetup, conference, hackathon and workshop in the city — joined
                wherever two of them put you in front of the same people.
              </p>

              {/* Big accent numerals, per the client's Mission Control screen. `tabular-nums`
                  does the job the mono face was there for: fixed digit widths, so a ticking
                  count cannot shift the layout beside it. */}
              <dl className="mt-6 flex flex-wrap items-end gap-x-8 gap-y-4">
                <div>
                  <dt className="t-eyebrow">upcoming</dt>
                  <dd className="mt-1 text-[30px] font-bold leading-none tracking-[-0.03em] tabular-nums text-[#1D1D1F]">
                    {loading ? '—' : totalUpcoming.toLocaleString('en-IN')}
                  </dd>
                </div>
                <div>
                  <dt className="t-eyebrow">in graph</dt>
                  <dd className="mt-1 text-[30px] font-bold leading-none tracking-[-0.03em] tabular-nums text-[#1D1D1F]">
                    {graph.nodes.length}
                  </dd>
                </div>
                <div>
                  <dt className="t-eyebrow">connected</dt>
                  <dd className="mt-1 text-[30px] font-bold leading-none tracking-[-0.03em] tabular-nums text-[#0071E3]">
                    {linked}
                  </dd>
                </div>
              </dl>
            </div>

            {/*
              The deep panel. The graph needs a dark field — emissive blue points on white have
              almost no contrast, which is why the spec's own "dark-to-light rhythm" earns its
              keep here rather than being atmosphere.

              Fixed heights so the swap from SVG to canvas cannot shift the page.
            */}
            <div className="glass-deep relative overflow-hidden p-3">
              <div className="relative h-[188px] w-full sm:h-[224px] md:h-[252px]">
                {canRender3D ? (
                  <ConnectionGraph graph={graph} onSelect={handleSelect} />
                ) : (
                  <GraphFallback graph={graph} />
                )}
              </div>

              {/* The legend states the mapping in words. Without it, two blues are decoration. */}
              <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1.5 px-1 pb-1 text-[11px] text-[color:var(--deep-muted)]">
                <span className="inline-flex items-center gap-1.5">
                  <span aria-hidden="true" className="node-dot" />
                  event · sized by connection score
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span aria-hidden="true" className="inline-block h-px w-4 bg-[#4DA3FF]" />
                  shares a host, company or topic
                </span>
                {graph.omitted > 0 && (
                  <span className="tabular-nums">+{graph.omitted} more below</span>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
