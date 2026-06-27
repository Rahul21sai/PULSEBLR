import { NextResponse } from 'next/server';
import { detectRepeatConnections } from '@/lib/helpers/phase6';

export async function GET() {
  try {
    const repeatConnections = await detectRepeatConnections();
    return NextResponse.json({ repeatConnections });
  } catch (error) {
    console.error('Error detecting repeat connections:', error);
    return NextResponse.json(
      { error: 'Failed to detect repeat connections' },
      { status: 500 }
    );
  }
}

// Made with Bob
