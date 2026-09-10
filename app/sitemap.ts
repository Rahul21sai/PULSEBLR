import type { MetadataRoute } from 'next';

import Event from '@/lib/models/Event';
import connectDB from '@/lib/mongodb';
import { buildEventFilter } from '@/lib/events/query';
import { publishedTopics } from '@/lib/events/topic-counts';
import { absoluteUrl } from '@/lib/canonical-origin';

/**
 * The sitemap.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT MUST NEVER BE IN HERE, and how each exclusion is enforced rather than remembered:
 *
 *   · A NON-PUBLIC EVENT. Enforced by `buildEventFilter(..., null)` — the anonymous viewer. The
 *     visibility clause it builds admits `visibility: 'public'` and the ~1500 documents that predate
 *     the field, and nothing else. This is the same predicate the public feed uses, so an event in
 *     this file is by construction an event a signed-out visitor can already see. Passing a real
 *     viewer id here, or hand-rolling the `$match`, is how a private event ends up in Google.
 *   · `/c/<token>` AND `/f/<token>`. Never generated here at all: they are somebody's contact card
 *     and somebody's folder intake form, both already `robots: { index: false }` at the page, and
 *     both addressed by a token that must not become permanently public. `app/robots.ts` disallows
 *     them too.
 *   · `/admin` AND EVERY SIGNED-IN PAGE. Same file, same list — see `app/robots.ts`, which derives
 *     its disallow list from `PROTECTED_PATHS` so the two cannot drift.
 *
 * WHY THE EVENT LIST IS TECH-ONLY. The public feed is `techOnly` UNCONDITIONALLY, so a non-tech
 * event page is reachable by direct link but is linked from nowhere in the product. Advertising
 * hundreds of them here would submit orphan pages about concerts and treks from a site that
 * presents itself as a Bengaluru engineering-events product — the thin-content risk the topic-page
 * floor exists to avoid, arriving through a different door. Those pages stay indexable if somebody
 * links to one; they are simply not something we submit.
 *
 * WHY UPCOMING ONLY. A past event page is a dead end for a reader arriving from search. The corpus
 * also prunes events a week after they end, so submitting them would guarantee 404s in Search
 * Console.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */

/**
 * Re-generated hourly rather than on every request.
 *
 * A sitemap changes when the scrape runs — once a day — so per-request generation would spend a
 * database query on every crawler hit to return the same bytes. `revalidate` also keeps this a
 * cached route, which is what stops a crawler burst from becoming a query burst.
 */
export const revalidate = 3600;

/** Google's per-file limit is 50,000 URLs. The upcoming corpus is ~1,300, so this is headroom. */
const MAX_EVENT_URLS = 20000;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();

  const staticEntries: MetadataRoute.Sitemap = [
    { url: absoluteUrl('/'), lastModified: now, changeFrequency: 'hourly', priority: 1 },
    { url: absoluteUrl('/calendar'), lastModified: now, changeFrequency: 'daily', priority: 0.7 },
    { url: absoluteUrl('/topics'), lastModified: now, changeFrequency: 'daily', priority: 0.8 },
    /*
     * `/mcp` is the MCP server's connect page, and it is worth submitting. It is how a developer
     * discovers that this corpus is queryable from inside Claude, and the competitor advertises the
     * same capability on its free tier — so this is a distribution asset, not an internal page.
     * Static config, so it changes only when the tool list does.
     *
     * The ENDPOINT is a different matter and is correctly not here: `app/robots.ts` disallows
     * `/api/`, which covers `/api/mcp`. A crawler has no use for a JSON-RPC POST target.
     */
    { url: absoluteUrl('/mcp'), lastModified: now, changeFrequency: 'monthly', priority: 0.5 },
    /*
     * `/companies` is deliberately absent. The route is public and stays public — event pages link
     * to it — but it was removed from the nav at the owner's direction because 44 of 375 companies
     * have any events, so a visitor meets a mostly-empty directory. Submitting it would advertise
     * that as a destination.
     */
  ];

  /*
   * A database failure degrades to the static entries instead of failing the build or the request.
   *
   * This route is prerendered, so an unreachable Atlas at build time would otherwise take the whole
   * deployment down over a file that search engines poll hourly. A short sitemap costs a day of
   * crawl freshness; a failed build costs the release.
   */
  try {
    await connectDB();

    const [topics, events] = await Promise.all([
      publishedTopics(),
      Event.find(buildEventFilter({ techOnly: true, includeOngoing: true }, null))
        .select('_id updatedAt lastSeenAt startDateTime')
        .sort({ startDateTime: 1 })
        .limit(MAX_EVENT_URLS)
        .lean(),
    ]);

    const topicEntries: MetadataRoute.Sitemap = topics.map(({ topic }) => ({
      url: absoluteUrl(`/topics/${topic.slug}`),
      lastModified: now,
      changeFrequency: 'daily',
      priority: 0.7,
    }));

    const eventEntries: MetadataRoute.Sitemap = events.map(event => ({
      url: absoluteUrl(`/events/${String(event._id)}`),
      // `updatedAt` is when the document last actually changed; `lastSeenAt` only proves a scrape
      // saw it again, which is not a content change. Falling back to it is better than `now`, which
      // would tell a crawler every page changed every hour.
      lastModified: event.updatedAt ?? event.lastSeenAt ?? now,
      changeFrequency: 'weekly',
      priority: 0.6,
    }));

    return [...staticEntries, ...topicEntries, ...eventEntries];
  } catch (error) {
    console.error('sitemap: falling back to static entries only', error);
    return staticEntries;
  }
}
