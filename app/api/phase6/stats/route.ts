import { NextResponse } from 'next/server';
import { getStats } from '@/lib/helpers/phase6';
import { getCurrentUserId } from '@/lib/auth-helpers';

export async function GET() {
  const userId = await getCurrentUserId();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const stats = await getStats(userId);
    return NextResponse.json({ stats });
  } catch (error) {
    console.error('Error fetching stats:', error);
    return NextResponse.json({ error: 'Failed to fetch stats' }, { status: 500 });
  }
}
