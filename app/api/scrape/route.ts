import { NextRequest, NextResponse } from 'next/server';
import { runAllScrapers } from '@/lib/scrapers';

/**
 * POST /api/scrape - Manually trigger scraper run
 * This endpoint can be called by:
 * - Manual trigger from UI
 * - GitHub Actions cron job
 * - External scheduler
 */
export async function POST(request: NextRequest) {
  try {
    console.log('🚀 Scraper triggered via API');
    
    const result = await runAllScrapers();
    
    return NextResponse.json({
      success: true,
      result,
    });
    
  } catch (error: any) {
    console.error('❌ Scraper API error:', error);
    
    return NextResponse.json(
      {
        success: false,
        error: error.message,
      },
      { status: 500 }
    );
  }
}

/**
 * GET /api/scrape - Get last scraper run status
 * (For future: store run history in database)
 */
export async function GET(request: NextRequest) {
  return NextResponse.json({
    message: 'Scraper endpoint ready. Use POST to trigger a scraper run.',
    endpoints: {
      trigger: 'POST /api/scrape',
    },
  });
}

// Made with Bob