import { NextResponse } from 'next/server';
import dbConnect from '@/lib/mongodb';
import Source from '@/lib/models/Source';
import { requireAdmin } from '@/lib/api-auth';
import { validateNewSource, sourceValidationError } from '@/lib/sources/admin-validate';

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

  // Validated BEFORE dbConnect(), and after the guard: a bad request needs no database to refuse,
  // and an anonymous caller must get 401 rather than 400. See the ordering note in CLAUDE.md §6.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'request body must be valid JSON' }, { status: 400 });
  }

  /*
   * An allowlist, replacing `Source.create(body)`. The header comment above described the risk
   * and the code did not act on it: a Source row is an INSTRUCTION to the scraper, so anything in
   * `url` is fetched on the next run by a job with no user in front of it. `validateNewSource`
   * restricts the scheme to http(s) and drops the scraper's own health bookkeeping
   * (`consecutiveEmptyScrapes`, `lastError`, `lastScrapedAt`, …), which otherwise lets a caller
   * hide a dead feed from the digest's unhealthy-source report or reorder the scrape queue.
   */
  const { doc, issues } = validateNewSource(body);
  if (issues.length > 0) {
    return NextResponse.json(sourceValidationError(issues), { status: 400 });
  }

  try {
    await dbConnect();
    const source = await Source.create(doc);
    return NextResponse.json({ source }, { status: 201 });
  } catch (error) {
    console.error('Error creating source:', error);
    // `{ kind, handle }` is unique, so re-registering a known source is the caller's mistake and
    // must not read as a server fault. Branching on keyPattern rather than assuming which index
    // it was — see the folders E11000 story in CLAUDE.md §9.
    const err = error as { code?: number; keyPattern?: Record<string, unknown> };
    if (err.code === 11000) {
      const onIdentity = err.keyPattern && ('handle' in err.keyPattern || 'kind' in err.keyPattern);
      return NextResponse.json(
        {
          error: onIdentity
            ? 'A source with that kind and handle already exists.'
            : 'That source already exists.',
        },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: 'Failed to create source' }, { status: 500 });
  }
}

// Made with Bob
