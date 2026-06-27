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
 * - GDG Cloud Bangalore: https://www.meetup.com/gdgcloudbangalore/events/rss/
 * - Bangalore Python User Group: https://www.meetup.com/bangpypers/events/rss/
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

// Default Bangalore tech Meetup groups
export const BANGALORE_MEETUP_GROUPS = [
  'https://www.meetup.com/awsugblr/events/rss/',           // AWS User Group
  'https://www.meetup.com/gdgcloudbangalore/events/rss/',  // GDG Cloud
  'https://www.meetup.com/bangpypers/events/rss/',         // Python User Group
  'https://www.meetup.com/PyData-Bangalore/events/rss/',   // PyData
  'https://www.meetup.com/Women-Who-Code-Bangalore/events/rss/', // Women Who Code
  'https://www.meetup.com/OWASP-Bangalore/events/rss/',    // OWASP (Cybersecurity)
  'https://www.meetup.com/Bangalore-Java-User-Group/events/rss/', // Java User Group
];

// Made with Bob