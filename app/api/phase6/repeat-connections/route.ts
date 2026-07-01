import { NextResponse } from 'next/server';
import { detectRepeatConnections } from '@/lib/helpers/phase6';
import { getCurrentUserId } from '@/lib/auth-helpers';

export async function GET() {
  const userId = await getCurrentUserId();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const repeatConnections = await detectRepeatConnections(userId);
    return NextResponse.json({ repeatConnections });
  } catch (error) {
    console.error('Error detecting repeat connections:', error);
    return NextResponse.json(
      { error: 'Failed to detect repeat connections' },
      { status: 500 }
    );
  }
}
