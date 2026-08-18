import { NextRequest, NextResponse } from 'next/server';
import { requireUser } from '@/lib/api-auth';
import { safeFetch, UnsafeUrlError } from '@/lib/security/safe-fetch';

/**
 * POST /api/scrape-url
 * Body: { url: string }
 * Returns: { event: Partial<EventFields> | null }
 *
 * Fetches the raw HTML of a Luma / Meetup / Hasgeek / Devfolio URL
 * and extracts basic event metadata using simple regex/text heuristics.
 * Does NOT require Playwright — uses fetch() so it works on serverless.
 */
export async function POST(request: NextRequest) {
  // Signed-in only. This endpoint makes the SERVER issue a request to a destination the
  // caller chooses, so leaving it open made it a general-purpose proxy sitting inside
  // the deployment's network.
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  try {
    const { url } = await request.json();
    if (!url || typeof url !== 'string') {
      return NextResponse.json({ error: 'url is required' }, { status: 400 });
    }

    // safeFetch enforces http(s) only, refuses any host that resolves to a private,
    // loopback or link-local address (169.254.169.254 is the cloud metadata service,
    // which hands out temporary credentials), re-validates every redirect hop, and caps
    // the body size. Previously this was a bare fetch(url) with no validation at all.
    let result;
    try {
      result = await safeFetch(url, { timeoutMs: 8000, accept: 'text/html' });
    } catch (err) {
      if (err instanceof UnsafeUrlError) {
        return NextResponse.json({ event: null, error: err.message }, { status: 400 });
      }
      throw err;
    }

    if (result.status < 200 || result.status >= 300) {
      return NextResponse.json({ event: null, error: 'Could not fetch URL' }, { status: 200 });
    }

    const html = result.body;

    // ── Helpers ──────────────────────────────────────────────────────────────
    const metaContent = (name: string): string | undefined => {
      const m = html.match(
        new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"']+)["']`, 'i')
      ) ?? html.match(
        new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${name}["']`, 'i')
      );
      return m?.[1];
    };

    const stripHtml = (s: string) =>
      s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

    // ── Extract fields ────────────────────────────────────────────────────────

    // Title
    const title =
      metaContent('og:title') ??
      metaContent('twitter:title') ??
      html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] ??
      '';

    // Description
    const description =
      metaContent('og:description') ??
      metaContent('twitter:description') ??
      metaContent('description') ??
      '';

    // Image
    // const image = metaContent('og:image');

    // Organizer — try JSON-LD first
    let organizer: string | undefined;
    const jsonLdMatch = html.match(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i);
    if (jsonLdMatch) {
      try {
        const ld = JSON.parse(jsonLdMatch[1]);
        const ldArr = Array.isArray(ld) ? ld : [ld];
        for (const node of ldArr) {
          if (node['@type'] === 'Event' || node['@type'] === 'SocialEvent') {
            organizer = node?.organizer?.name ?? node?.organizer?.[0]?.name;
            break;
          }
        }
      } catch {
        // ignore JSON parse errors
      }
    }

    // Date — try JSON-LD startDate, then og meta, then text heuristic
    let startDateTime: string | undefined;
    let endDateTime: string | undefined;

    if (jsonLdMatch) {
      try {
        const ld = JSON.parse(jsonLdMatch[1]);
        const ldArr = Array.isArray(ld) ? ld : [ld];
        for (const node of ldArr) {
          if (node['@type'] === 'Event' || node['@type'] === 'SocialEvent') {
            if (node.startDate) {
              // Normalise to datetime-local format (YYYY-MM-DDTHH:mm)
              const d = new Date(node.startDate);
              if (!isNaN(d.getTime())) {
                startDateTime = d.toISOString().slice(0, 16);
              }
            }
            if (node.endDate) {
              const d = new Date(node.endDate);
              if (!isNaN(d.getTime())) {
                endDateTime = d.toISOString().slice(0, 16);
              }
            }
            break;
          }
        }
      } catch {
        // ignore
      }
    }

    // Venue
    let venue: string | undefined;
    let format: 'online' | 'offline' | 'hybrid' = 'offline';

    if (jsonLdMatch) {
      try {
        const ld = JSON.parse(jsonLdMatch[1]);
        const ldArr = Array.isArray(ld) ? ld : [ld];
        for (const node of ldArr) {
          if (node['@type'] === 'Event' || node['@type'] === 'SocialEvent') {
            const loc = node.location;
            if (loc) {
              if (loc['@type'] === 'VirtualLocation') {
                format = 'online';
              } else {
                venue = loc.name ?? loc.address?.streetAddress;
                format = 'offline';
              }
            }
            break;
          }
        }
      } catch {
        // ignore
      }
    }

    // Detect online from keywords if not already set
    if (!venue && /online|virtual|zoom|meet\.google|teams\.microsoft|webinar/i.test(html.slice(0, 5000))) {
      format = 'online';
    }

    // sourceUrl — canonicalise
    const canonical =
      html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)?.[1] ?? url;

    const event = {
      title: stripHtml(title).slice(0, 200),
      description: stripHtml(description).slice(0, 1000),
      organizer: organizer?.slice(0, 100),
      sourceUrl: canonical,
      startDateTime,
      endDateTime,
      venue,
      format,
    };

    // If we got at least a title, return it
    if (event.title) {
      return NextResponse.json({ event });
    }

    return NextResponse.json({ event: null });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('scrape-url error:', error);
    return NextResponse.json({ event: null, error: message }, { status: 200 });
  }
}
