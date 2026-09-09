// How many upcoming events each topic page would show — the second floor, measured.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS IS NOT IN `topics.ts`. That module is pure and unit-tested; this one imports mongoose.
// The split is the same one `lib/event-types.ts` and `lib/models/Event.ts` already make, and for
// the same reason: the pure half must stay importable from anywhere, including tests and client
// components, without dragging a database driver behind it.
//
// WHY IT IS SHARED RATHER THAN INLINED. Three surfaces need the same answer — `/topics` (the index,
// which must not list a page that 404s), `app/sitemap.ts` (which must not advertise one), and
// `/topics/[slug]` (which enforces the floor for the page it is about to render). Two of those are
// route files, and a route file must never import another route file: doing it once in this repo put
// EVERY `/api/*` path into a 404, including `/api/auth/csrf`. So the shared definition lives here.
//
// ONE AGGREGATION, NOT N COUNTS. There are ~28 candidate topics; asking `countDocuments` per topic
// is 28 round trips to render one index page. A `$facet` answers both dimensions in a single pass
// over the same matched set — which also guarantees the category counts and the area counts describe
// the same corpus at the same instant.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import Event from '../models/Event';
import connectDB from '../mongodb';
import { buildEventFilter } from './query';
import { MIN_TOPIC_EVENTS, TOPICS, topicForDimension, type Topic } from './topics';

export interface TopicWithCount {
  topic: Topic;
  count: number;
}

interface Bucket {
  _id: string | null;
  n: number;
}

/**
 * The upcoming, public, tech-only corpus every topic page draws from.
 *
 * `buildEventFilter` rather than a hand-rolled `$match`, and `null` for the viewer. Both matter:
 * the visibility clause's `{ visibility: { $exists: false } }` arm is load-bearing — roughly 1500
 * documents predate that field, so omitting it EMPTIES the result instead of narrowing it — and an
 * anonymous viewer is the correct viewer here, because a topic page and the sitemap are public
 * surfaces that must never count somebody's private event.
 */
function corpusFilter() {
  return buildEventFilter({ techOnly: true, includeOngoing: true }, null);
}

/** Upcoming-event count per topic slug. Every published slug is present, zeroes included. */
export async function countTopicEvents(): Promise<Map<string, number>> {
  await connectDB();

  const [result] = await Event.aggregate<{ categories: Bucket[]; areas: Bucket[] }>([
    { $match: corpusFilter() },
    {
      $facet: {
        // An event carries several categories, so it counts once per category it is tagged with —
        // which is what the category page will show.
        categories: [
          { $unwind: '$category' },
          { $group: { _id: '$category', n: { $sum: 1 } } },
        ],
        areas: [{ $group: { _id: '$area', n: { $sum: 1 } } }],
      },
    },
  ]);

  const counts = new Map<string, number>(TOPICS.map(t => [t.slug, 0]));

  for (const bucket of result?.categories ?? []) {
    const topic = topicForDimension('category', bucket._id);
    if (topic) counts.set(topic.slug, bucket.n);
  }
  for (const bucket of result?.areas ?? []) {
    const topic = topicForDimension('area', bucket._id);
    if (topic) counts.set(topic.slug, bucket.n);
  }

  return counts;
}

/**
 * The topics that actually have a page today, most events first.
 *
 * FLOOR 2 IS APPLIED HERE AND NOWHERE ELSE, so the index, the sitemap and the page cannot disagree
 * about which URLs exist. Below `MIN_TOPIC_EVENTS` a page is thin, and a thin templated page with a
 * swapped noun is what Google penalises as a doorway — the floor is the feature, not a nicety.
 */
export async function publishedTopics(): Promise<TopicWithCount[]> {
  const counts = await countTopicEvents();
  return TOPICS.map(topic => ({ topic, count: counts.get(topic.slug) ?? 0 }))
    .filter(entry => entry.count >= MIN_TOPIC_EVENTS)
    .sort((a, b) => b.count - a.count);
}
