/**
 * RECURRING EVENTS AS ONE ROW. A monthly meetup is stored as one document per date — same title,
 * same host, same `connectionScore` — so a ranked list puts them side by side. Measured 2026-09-27
 * on the default feed: "Python Meetup" (BangPypers) filled four consecutive rows of "Coming up",
 * 21 Nov / 19 Dec / 16 Jan / 20 Feb, pushing four different events off the first screen.
 *
 * Grouping, not dropping. Every date stays reachable from its group, the headline count ("213
 * upcoming") still counts events, and nothing is removed from `events`; this is presentation over
 * the list already loaded, so it composes with infinite scroll — a later page's instance of a
 * series joins the group the first page started.
 *
 * THE KEY IS TITLE + HOST, not title alone: two communities that both run a "Python Meetup" are
 * two series, and merging them would hide one host behind the other's row. `normalizeTitleForMatch`
 * is the dedup normaliser, so digits survive ("#107" and "#108" are distinct events, not dates of
 * one series) and city words and punctuation do not split a series.
 *
 * THE GROUP SITS WHERE ITS FIRST MEMBER RANKED, and leads with its SOONEST date — the ranking
 * decides the position, and the reader's next question about a series is "when is the next one".
 */
import { normalizeTitleForMatch } from '@/lib/scrapers/core/text';

export interface SeriesItem {
  _id: string;
  title: string;
  organizer?: string | null;
  startDateTime: string;
}

export interface SeriesGroup<T extends SeriesItem> {
  key: string;
  /** The soonest date; the row the list draws. */
  lead: T;
  /** Every other date, soonest first. Empty for a one-off event. */
  later: T[];
}

export function seriesKey(event: SeriesItem): string {
  const host = (event.organizer ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  return `${normalizeTitleForMatch(event.title ?? '')}|${host}`;
}

export function groupSeries<T extends SeriesItem>(events: readonly T[]): SeriesGroup<T>[] {
  const order: string[] = [];
  const members = new Map<string, T[]>();
  for (const event of events) {
    const key = seriesKey(event);
    const list = members.get(key);
    if (list) list.push(event);
    else {
      members.set(key, [event]);
      order.push(key);
    }
  }
  return order.map(key => {
    const dated = [...members.get(key)!].sort(
      (a, b) => new Date(a.startDateTime).getTime() - new Date(b.startDateTime).getTime()
    );
    return { key, lead: dated[0], later: dated.slice(1) };
  });
}
