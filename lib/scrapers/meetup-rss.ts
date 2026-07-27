import Parser from 'rss-parser';
import { RawEvent, ScraperResult } from './types';

const parser = new Parser({
  customFields: {
    item: [
      ['meetup:event_url', 'eventUrl'],
      ['meetup:venue_name', 'venueName'],
      ['meetup:venue_address', 'venueAddress'],
    ],
  },
});

/**
 * Scrape events from a Meetup group's RSS feed
 * 
 * Meetup RSS feed URL format:
 * https://www.meetup.com/{group-name}/events/rss/
 * 
 * Example groups:
 * - AWS User Group Bangalore: https://www.meetup.com/awsugblr/events/rss/
 * - Bangalore Python User Group: https://www.meetup.com/bangpypers/events/rss/
 * - Data Science Bangalore: https://www.meetup.com/data-science-bangalore/events/rss/
 *
 * NOTE: Meetup still serves public RSS (verified 2026-07-26). A group that has
 * no upcoming events returns HTTP 200 with an empty <channel> — that's normal,
 * not an error. A 404 means the slug is wrong/renamed; such feeds must be fixed
 * or removed, never left in the list (they just log errors every scrape).
 */
export async function scrapeMeetupRSS(feedUrl: string): Promise<ScraperResult> {
  const result: ScraperResult = {
    source: 'meetup',
    events: [],
    errors: [],
    scrapedAt: new Date(),
  };
  
  try {
    console.log(`Fetching Meetup RSS feed: ${feedUrl}`);
    const feed = await parser.parseURL(feedUrl);
    
    if (!feed.items || feed.items.length === 0) {
      result.errors.push('No events found in RSS feed');
      return result;
    }
    
    for (const item of feed.items) {
      try {
        // Parse event data from RSS item
        const title = item.title || 'Untitled Event';
        const description = item.contentSnippet || item.content || '';
        const sourceUrl = item.link || feedUrl;
        
        // Parse date - Meetup RSS uses pubDate
        const startDateTime = item.pubDate ? new Date(item.pubDate) : new Date();
        
        // Extract venue information
        const venueName = (item as any).venueName || '';
        const venueAddress = (item as any).venueAddress || '';
        const venue = venueName || venueAddress || 'Bangalore';
        
        // Determine if online (check description for virtual/online keywords)
        const isOnline = description.toLowerCase().includes('online') || 
                        description.toLowerCase().includes('virtual') ||
                        description.toLowerCase().includes('zoom') ||
                        description.toLowerCase().includes('meet');
        
        const rawEvent: RawEvent = {
          title,
          description,
          sourceUrl,
          organizer: feed.title || 'Meetup Group',
          venue: isOnline ? undefined : venue,
          onlineLink: isOnline ? sourceUrl : undefined,
          startDateTime,
        };
        
        result.events.push(rawEvent);
        
      } catch (error: any) {
        result.errors.push(`Failed to parse event "${item.title}": ${error.message}`);
      }
    }
    
    console.log(`Scraped ${result.events.length} events from Meetup RSS`);
    
  } catch (error: any) {
    result.errors.push(`Failed to fetch RSS feed: ${error.message}`);
    console.error(`Meetup RSS scraper error:`, error);
  }
  
  return result;
}

/**
 * Scrape multiple Meetup groups
 */
export async function scrapeMeetupGroups(groupUrls: string[]): Promise<ScraperResult> {
  const combinedResult: ScraperResult = {
    source: 'meetup',
    events: [],
    errors: [],
    scrapedAt: new Date(),
  };
  
  for (const url of groupUrls) {
    const result = await scrapeMeetupRSS(url);
    combinedResult.events.push(...result.events);
    combinedResult.errors.push(...result.errors);
  }
  
  return combinedResult;
}

// Default Bangalore tech Meetup groups.
// Every slug below was verified HTTP 200 with a valid RSS feed on 2026-07-26.
// Two previously-listed slugs were REMOVED as dead (404): 'gdgcloudbangalore'
// (no working replacement found) and 'OWASP-Bangalore' (renamed — re-added
// below as 'owasp-bangalore-chapter').
export const BANGALORE_MEETUP_GROUPS = [
  // — Original set (kept; verified still alive) —
  'https://www.meetup.com/awsugblr/events/rss/',                  // AWS User Group
  'https://www.meetup.com/bangpypers/events/rss/',               // Python User Group
  'https://www.meetup.com/PyData-Bangalore/events/rss/',         // PyData (AI/ML)
  'https://www.meetup.com/Women-Who-Code-Bangalore/events/rss/', // Women Who Code
  'https://www.meetup.com/Bangalore-Java-User-Group/events/rss/', // Java User Group

  // — Tier-1 additions (verified alive 2026-07-26) —
  'https://www.meetup.com/owasp-bangalore-chapter/events/rss/',  // OWASP (Cybersecurity)
  'https://www.meetup.com/data-science-bangalore/events/rss/',   // Data Science (AI/ML)
  'https://www.meetup.com/the-fifth-elephant/events/rss/',       // Big Data / AI/ML
  'https://www.meetup.com/DataKind-Bangalore/events/rss/',       // Data-for-good (AI/ML)
  'https://www.meetup.com/reactjs-bangalore/events/rss/',        // Web
  'https://www.meetup.com/cloudops-meetup-bangalore/events/rss/', // Cloud & DevOps
  'https://www.meetup.com/golang-bangalore/events/rss/',         // Dev (Go)
  'https://www.meetup.com/flutter-bangalore/events/rss/',        // Mobile
  'https://www.meetup.com/reactplay-bengaluru/events/rss/',      // Web (verified alive 2026-07-26)
  'https://www.meetup.com/techinsider-bangalore/events/rss/',    // Web/Cloud/DevOps (verified alive 2026-07-26)
];

// Made with Bob