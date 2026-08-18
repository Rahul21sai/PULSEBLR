import { NextResponse } from 'next/server';
import dbConnect from '@/lib/mongodb';
import Source from '@/lib/models/Source';
import { requireAdmin } from '@/lib/api-auth';

export async function GET() {
  try {
    await dbConnect();
    const sources = await Source.find().sort({ name: 1 });
    
    return NextResponse.json({ sources });
  } catch (error) {
    console.error('Error fetching sources:', error);
    return NextResponse.json(
      { error: 'Failed to fetch sources' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/sources -- register a scrape source. ADMIN ONLY.
 *
 * `Source.create(body)` means an attacker could inject a handle that the NEXT
 * pipeline run will dutifully fetch, turning the scheduled scraper into a request
 * generator aimed at a target of their choosing.
 */
export async function POST(request: Request) {
  const gate = await requireAdmin();
  if ('response' in gate) return gate.response;

  try {
    await dbConnect();
    const body = await request.json();
    
    const source = await Source.create(body);
    
    return NextResponse.json({ source }, { status: 201 });
  } catch (error) {
    console.error('Error creating source:', error);
    return NextResponse.json(
      { error: 'Failed to create source' },
      { status: 500 }
    );
  }
}

// Made with Bob
