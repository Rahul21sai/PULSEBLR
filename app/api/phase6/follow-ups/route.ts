import { NextResponse } from 'next/server';
import { getPendingFollowUps, markFollowUpComplete } from '@/lib/helpers/phase6';

export async function GET() {
  try {
    const followUps = await getPendingFollowUps();
    return NextResponse.json({ followUps });
  } catch (error) {
    console.error('Error fetching follow-ups:', error);
    return NextResponse.json(
      { error: 'Failed to fetch follow-ups' },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const { trackerEntryId, connectionName } = await request.json();
    
    if (!trackerEntryId || !connectionName) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      );
    }
    
    const entry = await markFollowUpComplete(trackerEntryId, connectionName);
    
    return NextResponse.json({ entry });
  } catch (error) {
    console.error('Error marking follow-up complete:', error);
    return NextResponse.json(
      { error: 'Failed to mark follow-up complete' },
      { status: 500 }
    );
  }
}

// Made with Bob
