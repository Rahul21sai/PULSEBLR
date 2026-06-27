import { chromium } from 'playwright';
import { RawEvent, ScraperResult } from './types';

/**
 * Scrape events from a Luma calendar page
 * 
 * Luma calendar URL format:
 * https://lu.ma/{calendar-name}
 * 
 * Example calendars:
 * - AI Tinkerers Bangalore: https://lu.ma/aitinkerers-bangalore
 * - Build Club: https://lu.ma/buildclub
 * - GenAI Builders: https://lu.ma/genai-builders
 */
export async function scrapeLumaCalendar(calendarUrl: string): Promise<ScraperResult> {
  const result: ScraperResult = {
    source: 'luma',
    events: [],
    errors: [],
    scrapedAt: new Date(),
  };
  
  let browser;
  
  try {
    console.log(`Scraping Luma calendar: ${calendarUrl}`);
    
    // Launch headless browser
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    });
    const page = await context.newPage();
    
    // Navigate to calendar
    await page.goto(calendarUrl, { waitUntil: 'networkidle', timeout: 30000 });
    
    // Wait for events to load
    await page.waitForSelector('[class*="event"]', { timeout: 10000 }).catch(() => {
      console.log('No events found or page structure changed');
    });
    
    // Extract event cards
    const eventElements = await page.$$('[class*="event-card"], [data-testid*="event"], article');
    
    if (eventElements.length === 0) {
      result.errors.push('No event elements found on page');
      return result;
    }
    
    for (const element of eventElements) {
      try {
        // Extract event data from the card
        const title = await element.$eval('h2, h3, [class*="title"]', el => el.textContent?.trim() || '').catch(() => '');
        const description = await element.$eval('p, [class*="description"]', el => el.textContent?.trim() || '').catch(() => '');
        const eventLink = await element.$eval('a', el => el.getAttribute('href') || '').catch(() => '');
        
        // Extract date/time
        const dateText = await element.$eval('[class*="date"], [class*="time"], time', el => el.textContent?.trim() || '').catch(() => '');
        
        // Extract location
        const locationText = await element.$eval('[class*="location"], [class*="venue"]', el => el.textContent?.trim() || '').catch(() => '');
        
        if (!title) continue; // Skip if no title
        
        // Parse date (Luma typically shows dates like "Dec 25, 2024 • 6:00 PM")
        const startDateTime = parseLumaDate(dateText) || new Date();
        
        // Determine if online or offline
        const isOnline = locationText.toLowerCase().includes('online') || 
                        locationText.toLowerCase().includes('virtual') ||
                        description.toLowerCase().includes('zoom') ||
                        description.toLowerCase().includes('meet');
        
        // Build full URL
        const sourceUrl = eventLink.startsWith('http') ? eventLink : `https://lu.ma${eventLink}`;
        
        const rawEvent: RawEvent = {
          title,
          description: description || title,
          sourceUrl,
          organizer: 'Luma Community',
          venue: isOnline ? undefined : (locationText || 'Bangalore'),
          onlineLink: isOnline ? sourceUrl : undefined,
          startDateTime,
        };
        
        result.events.push(rawEvent);
        
      } catch (error: any) {
        result.errors.push(`Failed to parse event element: ${error.message}`);
      }
    }
    
    console.log(`Scraped ${result.events.length} events from Luma`);
    
  } catch (error: any) {
    result.errors.push(`Failed to scrape Luma calendar: ${error.message}`);
    console.error(`Luma scraper error:`, error);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
  
  return result;
}

/**
 * Parse Luma date format
 * Examples: "Dec 25, 2024 • 6:00 PM", "Tomorrow at 6:00 PM", "Today at 6:00 PM"
 */
function parseLumaDate(dateText: string): Date | null {
  if (!dateText) return null;
  
  try {
    // Handle "Today" and "Tomorrow"
    if (dateText.toLowerCase().includes('today')) {
      const timeMatch = dateText.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
      if (timeMatch) {
        const date = new Date();
        let hours = parseInt(timeMatch[1]);
        const minutes = parseInt(timeMatch[2]);
        const isPM = timeMatch[3].toUpperCase() === 'PM';
        
        if (isPM && hours !== 12) hours += 12;
        if (!isPM && hours === 12) hours = 0;
        
        date.setHours(hours, minutes, 0, 0);
        return date;
      }
    }
    
    if (dateText.toLowerCase().includes('tomorrow')) {
      const timeMatch = dateText.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
      if (timeMatch) {
        const date = new Date();
        date.setDate(date.getDate() + 1);
        
        let hours = parseInt(timeMatch[1]);
        const minutes = parseInt(timeMatch[2]);
        const isPM = timeMatch[3].toUpperCase() === 'PM';
        
        if (isPM && hours !== 12) hours += 12;
        if (!isPM && hours === 12) hours = 0;
        
        date.setHours(hours, minutes, 0, 0);
        return date;
      }
    }
    
    // Try standard date parsing
    const parsed = new Date(dateText);
    if (!isNaN(parsed.getTime())) {
      return parsed;
    }
    
    return null;
  } catch {
    return null;
  }
}

/**
 * Scrape multiple Luma calendars
 */
export async function scrapeLumaCalendars(calendarUrls: string[]): Promise<ScraperResult> {
  const combinedResult: ScraperResult = {
    source: 'luma',
    events: [],
    errors: [],
    scrapedAt: new Date(),
  };
  
  for (const url of calendarUrls) {
    const result = await scrapeLumaCalendar(url);
    combinedResult.events.push(...result.events);
    combinedResult.errors.push(...result.errors);
    
    // Rate limiting - wait 2 seconds between requests
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  
  return combinedResult;
}

// Default Bangalore AI/ML Luma calendars
export const BANGALORE_LUMA_CALENDARS = [
  'https://lu.ma/aitinkerers-bangalore',
  'https://lu.ma/buildclub',
  'https://lu.ma/genai-builders',
];

// Made with Bob