import { NextRequest, NextResponse } from 'next/server';
import { sendDailyDigestEmail } from '@/lib/notifications/email';

/**
 * POST /api/notifications/send-digest
 * Manually trigger daily digest email
 */
export async function POST(request: NextRequest) {
  try {
    const userEmail = process.env.USER_EMAIL;

    if (!userEmail) {
      return NextResponse.json(
        { error: 'USER_EMAIL not configured' },
        { status: 500 }
      );
    }

    console.log('📧 Sending daily digest via API...');

    const success = await sendDailyDigestEmail({
      to: userEmail,
    });

    if (success) {
      return NextResponse.json({
        success: true,
        message: 'Daily digest sent successfully',
        to: userEmail,
      });
    } else {
      return NextResponse.json(
        { error: 'Failed to send digest' },
        { status: 500 }
      );
    }
  } catch (error: any) {
    console.error('❌ Digest API error:', error);

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
 * GET /api/notifications/send-digest
 * Get digest preview (without sending)
 */
export async function GET(request: NextRequest) {
  try {
    const { generateDailyDigest, formatDigestAsText } = await import('@/lib/notifications/digest');
    
    const digest = await generateDailyDigest();
    const preview = formatDigestAsText(digest);

    return NextResponse.json({
      digest,
      preview,
      stats: {
        newEvents: digest.newEvents.length,
        upcomingDeadlines: digest.upcomingDeadlines.length,
        trackerUpdates: digest.trackerUpdates.length,
        followUpReminders: digest.followUpReminders.length,
      },
    });
  } catch (error: any) {
    console.error('❌ Digest preview error:', error);

    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    );
  }
}

// Made with Bob