import { NextResponse } from 'next/server';
import connectDB from '@/lib/mongodb';
import Event from '@/lib/models/Event';
import { requireAdmin } from '@/lib/api-auth';
import { offCityReason } from '@/lib/scrapers/core/geo';
import {
  courseAdvertSignals,
  groupDuplicateClusters,
  techDisagreement,
} from '@/lib/admin/impact';

/**
 * GET /api/admin/feed-quality — the corpus problems, with the numbers already on screen.
 *
 * Each section replaces a `scripts/diag-*.ts` the operator would otherwise have to remember the name
 * of. The scripts are good; they just print to a terminal that scrolls. What is NOT replaced is
 * their judgement — every predicate here is the script's own, imported where it is exportable and
 * copied with a note where it is not, so the panel and the CLI can never report different numbers.
 *
 * ── ROWS ARE RANKED, NOT JUST COUNTED ───────────────────────────────────────────────────────
 *
 * The most expensive lesson in this repo's history: tech precision measured 98% while the top of the
 * feed was board games and jamming, because the feed sorts by `connectionScore` and 2% of the corpus
 * can be 10% of the first twenty rows. So every list here carries `connectionScore` and is sorted by
 * it descending — a leak at score 100 is a different problem from the same leak at score 15, and a
 * diagnostic that names rows without ranking them under-reports severity.
 *
 * ── WHAT IS REPORT-ONLY, AND WHY ────────────────────────────────────────────────────────────
 *
 * Duplicate clusters are listed and NOT actionable from here. Collapsing one means picking the most
 * complete row, repointing `TrackerEntry` and `Folder.eventId` at the survivor, and gap-filling —
 * `cleanup-duplicate-clusters.ts` does all three, and the repointing is what makes it unsafe to
 * reimplement behind a button that has no dry-run. The panel prints the command instead. Everything
 * else offered here is either reversible (a flag toggle, an unpin) or restorable from the audit log.
 */

/** Longest each list gets. A panel showing 400 rows is a file, not a screen. */
const LIST_CAP = 40;

interface Row {
  _id: unknown;
  title?: string;
  description?: string;
  organizer?: string;
  venue?: string;
  address?: string;
  city?: string;
  lat?: number;
  lng?: number;
  source?: string;
  category?: string[];
  isTechEvent?: boolean;
  connectionScore?: number;
  clusterKey?: string;
  startDateTime?: Date;
  spotlightAt?: Date;
  createdByUserId?: string;
}

/**
 * A row as the panel renders it, plus whatever the section that produced it adds (`signals`,
 * `offCityField`, `spotlightAt`). The index signature is what lets one shaper serve five sections
 * without five near-identical types — the named fields stay checked, which is what matters, because
 * every list is sorted on `connectionScore` and a typo there would silently stop ranking.
 */
type ShapedRow = {
  id: string;
  title: string;
  organizer: string | null;
  source: string | null;
  category: string[];
  isTechEvent: boolean;
  connectionScore: number | null;
  startDateTime: Date | null;
  [extra: string]: unknown;
};

const shape = (r: Row, extra: Record<string, unknown> = {}): ShapedRow => ({
  id: String(r._id),
  title: r.title ?? '(untitled)',
  organizer: r.organizer ?? null,
  source: r.source ?? null,
  category: r.category ?? [],
  isTechEvent: Boolean(r.isTechEvent),
  connectionScore: r.connectionScore ?? null,
  startDateTime: r.startDateTime ?? null,
  ...extra,
});

const byScore = (a: { connectionScore: number | null }, b: { connectionScore: number | null }) =>
  (b.connectionScore ?? -1) - (a.connectionScore ?? -1);

export async function GET() {
  const gate = await requireAdmin();
  if ('response' in gate) return gate.response;

  try {
    await connectDB();
    const now = new Date();

    /**
     * ONE read of the upcoming corpus, then every check runs over it in memory.
     *
     * Four separate queries would each pay the same scan, and worse, they would each see a slightly
     * different corpus if a scrape landed mid-request — so the panel could report a count in one
     * section that contradicts another. `description` is the expensive field and only the
     * course-advert check needs it, but splitting the read to save it would reintroduce exactly that
     * inconsistency.
     */
    const upcoming = (await Event.find(
      { $or: [{ startDateTime: { $gte: now } }, { endDateTime: { $gte: now } }] },
      {
        title: 1, description: 1, organizer: 1, venue: 1, address: 1, city: 1, lat: 1, lng: 1,
        source: 1, category: 1, isTechEvent: 1, connectionScore: 1, clusterKey: 1,
        startDateTime: 1, spotlightAt: 1, createdByUserId: 1,
      }
    ).lean()) as unknown as Row[];

    /* ── 1. The two definitions of "tech" disagreeing ──────────────────────────────────────── */
    const hidden: ShapedRow[] = [];
    const unbacked: ShapedRow[] = [];
    for (const r of upcoming) {
      const verdict = techDisagreement(r);
      if (verdict === 'hidden') hidden.push(shape(r));
      else if (verdict === 'unbacked') unbacked.push(shape(r));
    }

    /* ── 2. Course adverts inside the tech feed ────────────────────────────────────────────── */
    // Scoped to the tech feed because that is where they do damage — a coaching advert correctly
    // tagged non-tech is invisible to every reader and is not this panel's problem.
    const courseAdverts = upcoming
      .filter(r => r.isTechEvent)
      .map(r => ({ row: r, signals: courseAdvertSignals(`${r.title ?? ''} ${r.description ?? ''}`) }))
      .filter(x => x.signals.length > 0)
      .map(x => shape(x.row, { signals: x.signals }));

    /* ── 3. Off-city rows ──────────────────────────────────────────────────────────────────── */
    /**
     * The ingest gate's OWN predicate, imported rather than mirrored — so it judges
     * `city` / `venue` / `address` / `title` and never the description. Deleting on "lessons from our
     * Chennai rollout" would be the `\bpm\b` over-match with a DELETE attached.
     *
     * Hand-entered events are excluded at SELECTION, exactly as `cleanup-non-bengaluru.ts` does it: a
     * user's own event may legitimately be in another city, and there is no upstream to re-create it
     * from if this is wrong.
     */
    const offCity = upcoming
      .filter(r => !r.createdByUserId)
      .map(r => ({
        row: r,
        verdict: offCityReason({
          title: r.title,
          venue: r.venue,
          address: r.address,
          city: r.city,
          lat: r.lat,
          lng: r.lng,
        }),
      }))
      .filter((x): x is { row: Row; verdict: NonNullable<typeof x.verdict> } => Boolean(x.verdict))
      .map(x =>
        shape(x.row, {
          offCity: x.verdict.city,
          // The field that condemned it, taken from the verdict and never re-derived — a row rejected
          // on its ADDRESS once printed as `city="…"`, which reverses the apparent cause.
          offCityField: x.verdict.field,
          offCityValue: String(
            (x.verdict.field === 'city' ? x.row.city
              : x.verdict.field === 'venue' ? x.row.venue
              : x.verdict.field === 'address' ? x.row.address
              : x.row.title) ?? ''
          ).slice(0, 80),
        })
      );

    /* ── 4. Duplicate clusters (report-only) ───────────────────────────────────────────────── */
    // Hand-entered events excluded: their `clusterKey` is owner-namespaced, and either outcome of
    // collapsing one is data loss — the user's private row deleted, or the public row deleted in
    // favour of one only its owner can see.
    const duplicateGroups = groupDuplicateClusters(upcoming.filter(r => !r.createdByUserId)).map(g => ({
      clusterKey: g.clusterKey,
      rows: g.rows.map(r => shape(r)),
    }));

    // A DIFFERENT fault with a different fix, so counted separately rather than folded in above.
    const withoutClusterKey = upcoming.filter(r => !r.clusterKey).length;

    /* ── 5. Spotlight pins ─────────────────────────────────────────────────────────────────── */
    // `spotlightAt` present AND a real date. A stored null means unpinned — the home page filters on
    // `{ $type: 'date' }` precisely so an explicit null from an unpin reads as unpinned.
    const spotlit = upcoming
      .filter(r => r.spotlightAt instanceof Date)
      .map(r => shape(r, { spotlightAt: r.spotlightAt }))
      .sort((a, b) => new Date(String(b.spotlightAt)).getTime() - new Date(String(a.spotlightAt)).getTime());

    const techCount = upcoming.filter(r => r.isTechEvent).length;

    return NextResponse.json({
      corpus: {
        upcoming: upcoming.length,
        tech: techCount,
        techShare: upcoming.length ? Math.round((techCount / upcoming.length) * 100) : 0,
      },
      techDisagreement: {
        // Reported in BOTH directions, never averaged: one is recall loss (a good event nobody can
        // reach) and the other is precision risk (a row in the feed on a flag no category supports).
        hidden: { count: hidden.length, rows: hidden.sort(byScore).slice(0, LIST_CAP) },
        unbacked: { count: unbacked.length, rows: unbacked.sort(byScore).slice(0, LIST_CAP) },
        fixWith: 'npx tsx scripts/retag-events.ts --inconsistent',
      },
      courseAdverts: {
        count: courseAdverts.length,
        // How many reach the part of the feed a reader actually sees. A count is not a ranking.
        highScoring: courseAdverts.filter(r => (r.connectionScore ?? 0) >= 50).length,
        rows: courseAdverts.sort(byScore).slice(0, LIST_CAP),
      },
      offCity: {
        count: offCity.length,
        inTechFeed: offCity.filter(r => r.isTechEvent).length,
        rows: offCity.sort(byScore).slice(0, LIST_CAP),
        auditWith: 'npx tsx scripts/diag-offcity.ts',
      },
      duplicates: {
        groups: duplicateGroups.length,
        rows: duplicateGroups.reduce((n, g) => n + g.rows.length, 0),
        withoutClusterKey,
        sample: duplicateGroups.slice(0, 12),
        // Report-only: collapsing needs the repointing that only the script does. Stated on screen so
        // the absence of a button reads as deliberate rather than as unfinished work.
        fixWith: 'npx tsx scripts/cleanup-duplicate-clusters.ts --apply',
        reportOnly: true,
      },
      spotlight: {
        pinned: spotlit.length,
        // Only the two most recently pinned render on the home page. Pinning a third is allowed and
        // simply does not show, which is worth knowing before wondering why nothing changed.
        shown: Math.min(2, spotlit.length),
        rows: spotlit.slice(0, LIST_CAP),
      },
    });
  } catch (error) {
    console.error('Feed quality scan failed:', error);
    return NextResponse.json({ error: 'Failed to scan the corpus' }, { status: 500 });
  }
}
