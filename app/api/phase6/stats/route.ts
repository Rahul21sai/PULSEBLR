import { NextResponse } from 'next/server';
import { getStats } from '@/lib/helpers/phase6';
import { getCurrentUserId } from '@/lib/auth-helpers';
import { errorLogLine } from '@/lib/http/errors';

export async function GET() {
  const userId = await getCurrentUserId();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const stats = await getStats(userId);
    return NextResponse.json({ stats });
  } catch (error) {
    // No input: always the server's fault; logged as one inert line.
    console.error('Error fetching stats:', errorLogLine(error));
    return NextResponse.json({ error: 'Failed to fetch stats' }, { status: 500 });
  }
}
