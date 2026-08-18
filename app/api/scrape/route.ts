import { NextRequest, NextResponse } from 'next/server';
import { runPipeline, PipelineOptions } from '@/lib/scrapers/pipeline';
import { requireAdmin } from '@/lib/api-auth';

/**
 * POST /api/scrape — trigger a scraper run. ADMIN ONLY.
 *
 * Body (all optional): { fast?: boolean, skipLlm?: boolean, prune?: boolean }
 *
 * A full run fans out to hundreds of upstream requests and does batched LLM
 * tagging, so it takes minutes. `fast: true` skips the Eventbrite crawl and the
 * company-page sweep and shrinks the enrichment budgets, which is what the UI
 * button should use; the scheduled workflow runs the full pipeline via
 * `npm run scrape` where there is no request timeout at all.
 *
 * ADMIN, not merely signed-in, for three reasons this endpoint uniquely combines:
 * `prune` defaults to TRUE and pruneStale issues Event.deleteMany, each call fans out
 * to ~700 upstream requests plus LLM tagging on the owner's paid keys, and repeated
 * calls get the deployment IP banned by Meetup, Luma and Eventbrite. It was previously
 * reachable by anyone on the internet with no credentials at all.
 *
 * The GitHub Actions cron does NOT use this route — daily-scrape.yml runs
 * `npm run scrape` directly — so gating it breaks no automation.
 */
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  const gate = await requireAdmin();
  if ('response' in gate) return gate.response;

  try {
    let body: Record<string, unknown> = {};
    try {
      body = await request.json();
    } catch {
      // No body is fine — run with defaults.
    }

    const fast = body.fast === true;
    const options: PipelineOptions = {
      skipLlm: body.skipLlm === true,
      prune: body.prune !== false,
      includeEventbrite: !fast,
      includeCompanyPages: !fast,
      ...(fast ? { lumaEnrichBudget: 25, meetupEnrichBudget: 25, maxMeetupGroups: 40 } : {}),
    };

    console.log(`Scraper triggered via API (fast=${fast})`);
    const result = await runPipeline(options);

    return NextResponse.json({
      success: true,
      summary: {
        scraped: result.totalScraped,
        unique: result.uniqueRaw,
        inserted: result.ingestion.inserted,
        updated: result.ingestion.updated,
        merged: result.ingestion.crossSourceMerged,
        duplicates: result.ingestion.duplicates,
        pruned: result.pruned,
        durationMs: result.durationMs,
      },
      sources: result.sources,
      errorCount: result.errors.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Scraper API error:', error);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

/** GET /api/scrape — describe the endpoint. */
export async function GET() {
  return NextResponse.json({
    message: 'Use POST to trigger a scraper run.',
    body: { fast: 'boolean — skip slow sources', skipLlm: 'boolean', prune: 'boolean' },
  });
}
