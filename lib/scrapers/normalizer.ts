import Event from '../models/Event';
import { RawEvent, NormalizedEvent } from './types';
import { tagEventWithLLM } from '../llm/tagger';
import { isTargetCompanyEvent, hasRecruiterMention } from '../helpers/phase6';

// Bangalore area mapping - extract from venue/address
const BANGALORE_AREAS = [
  'Koramangala',
  'Indiranagar',
  'Whitefield',
  'HSR Layout',
  'Electronic City',
  'MG Road',
  'Marathahalli',
  'Jayanagar',
  'BTM Layout',
  'Bannerghatta Road',
  'Sarjapur Road',
  'Outer Ring Road',
  'Hebbal',
  'Yelahanka',
  'JP Nagar',
];

// Extract area from venue string
function extractArea(venue?: string): string | undefined {
  if (!venue) return undefined;
  
  const venueLower = venue.toLowerCase();
  for (const area of BANGALORE_AREAS) {
    if (venueLower.includes(area.toLowerCase())) {
      return area;
    }
  }
  
  return 'Other';
}

// Detect if event is free from description/title
function detectIsFree(description: string, title: string): boolean {
  const text = `${title} ${description}`.toLowerCase();
  
  if (text.includes('free') || text.includes('no cost') || text.includes('complimentary')) {
    return true;
  }
  
  if (text.includes('₹') || text.includes('rs.') || text.includes('paid') || text.includes('ticket')) {
    return false;
  }
  
  return true; // Default to free for tech events
}

// Extract price from description
function extractPrice(description: string, title: string): number | undefined {
  const text = `${title} ${description}`;
  
  // Match ₹500, Rs. 500, Rs 500, etc.
  const priceMatch = text.match(/(?:₹|Rs\.?\s*)(\d+(?:,\d+)*)/i);
  if (priceMatch) {
    return parseInt(priceMatch[1].replace(/,/g, ''));
  }
  
  return undefined;
}

// Detect food from description
function detectFood(description: string, title: string): 'yes' | 'no' | 'unknown' {
  const text = `${title} ${description}`.toLowerCase();
  
  const foodKeywords = [
    'food', 'snacks', 'refreshments', 'lunch', 'dinner', 'breakfast',
    'pizza', 'beverages', 'drinks', 'meal', 'catering'
  ];
  
  for (const keyword of foodKeywords) {
    if (text.includes(keyword)) {
      return 'yes';
    }
  }
  
  return 'unknown';
}

// Detect format from venue/description
function detectFormat(venue?: string, onlineLink?: string, description?: string): 'online' | 'offline' | 'hybrid' {
  const hasVenue = !!venue && venue.trim().length > 0;
  const hasOnlineLink = !!onlineLink && onlineLink.trim().length > 0;
  
  if (hasVenue && hasOnlineLink) {
    return 'hybrid';
  }
  
  if (hasOnlineLink) {
    return 'online';
  }
  
  if (hasVenue) {
    return 'offline';
  }
  
  // Check description for clues
  const text = description?.toLowerCase() || '';
  if (text.includes('zoom') || text.includes('teams') || text.includes('meet') || text.includes('virtual')) {
    return 'online';
  }
  
  return 'offline'; // Default
}

// Basic category detection (will be enhanced by LLM in Phase 3)
function detectCategories(title: string, description: string): string[] {
  const text = `${title} ${description}`.toLowerCase();
  const categories: string[] = [];
  
  const categoryKeywords: Record<string, string[]> = {
    'AI/ML': ['ai', 'artificial intelligence', 'machine learning', 'ml', 'deep learning', 'neural', 'llm', 'gpt', 'genai'],
    'Fintech': ['fintech', 'finance', 'banking', 'payment', 'blockchain', 'crypto'],
    'Cybersecurity': ['security', 'cyber', 'hacking', 'penetration', 'infosec', 'vulnerability'],
    'Cloud/DevOps': ['cloud', 'devops', 'aws', 'azure', 'gcp', 'kubernetes', 'docker', 'ci/cd'],
    'Web/Mobile': ['web', 'mobile', 'react', 'angular', 'vue', 'flutter', 'ios', 'android'],
    'Data/Analytics': ['data', 'analytics', 'big data', 'data science', 'visualization'],
    'Hackathon': ['hackathon', 'hack', 'coding competition'],
  };
  
  for (const [category, keywords] of Object.entries(categoryKeywords)) {
    for (const keyword of keywords) {
      if (text.includes(keyword)) {
        categories.push(category);
        break;
      }
    }
  }
  
  // Default category if none detected
  if (categories.length === 0) {
    categories.push('Networking/Meetup');
  }
  
  return [...new Set(categories)]; // Remove duplicates
}

// Main normalizer function
export function normalizeEvent(raw: RawEvent, source: string): NormalizedEvent {
  const isFree = detectIsFree(raw.description, raw.title);
  const price = isFree ? undefined : extractPrice(raw.description, raw.title);
  
  // Use basic detection as fallback (LLM tagging happens in async version)
  const format = detectFormat(raw.venue, raw.onlineLink, raw.description);
  const area = format === 'offline' ? extractArea(raw.venue) : undefined;
  const hasFood = detectFood(raw.description, raw.title);
  const category = detectCategories(raw.title, raw.description);
  
  // Generate dedup hash
  const dedupHash = (Event as any).generateDedupHash(
    raw.title,
    raw.startDateTime,
    raw.venue,
    source
  );
  
  return {
    title: raw.title.trim(),
    description: raw.description.trim(),
    source,
    sourceUrl: raw.sourceUrl,
    organizer: raw.organizer?.trim(),
    category,
    format,
    hasFood,
    isFree,
    price,
    venue: raw.venue?.trim(),
    area,
    onlineLink: raw.onlineLink?.trim(),
    startDateTime: raw.startDateTime,
    endDateTime: raw.endDateTime,
    applyLink: raw.applyLink?.trim(),
    registrationDeadline: raw.registrationDeadline,
    dedupHash,
  };
}

// Batch normalize
export function normalizeEvents(rawEvents: RawEvent[], source: string): NormalizedEvent[] {
  return rawEvents.map(raw => normalizeEvent(raw, source));
}

// Async normalizer with LLM tagging
export async function normalizeEventWithLLM(raw: RawEvent, source: string): Promise<NormalizedEvent> {
  const isFree = detectIsFree(raw.description, raw.title);
  const price = isFree ? undefined : extractPrice(raw.description, raw.title);
  const area = raw.venue ? extractArea(raw.venue) : undefined;
  
  // Use LLM for intelligent tagging
  const llmResult = await tagEventWithLLM(
    raw.title,
    raw.description,
    raw.venue,
    raw.onlineLink
  );
  
  // Generate dedup hash
  const dedupHash = (Event as any).generateDedupHash(
    raw.title,
    raw.startDateTime,
    raw.venue,
    source
  );
  
  // Phase 6: Detect target company and recruiter mentions
  const isTargetCompany = isTargetCompanyEvent(raw.organizer, raw.description);
  const recruiterMentioned = hasRecruiterMention(raw.description);
  
  return {
    title: raw.title.trim(),
    description: raw.description.trim(),
    source,
    sourceUrl: raw.sourceUrl,
    organizer: raw.organizer?.trim(),
    category: llmResult.categories,
    format: llmResult.format,
    hasFood: llmResult.hasFood,
    isFree,
    price,
    venue: raw.venue?.trim(),
    area,
    onlineLink: raw.onlineLink?.trim(),
    startDateTime: raw.startDateTime,
    endDateTime: raw.endDateTime,
    applyLink: raw.applyLink?.trim(),
    registrationDeadline: raw.registrationDeadline,
    dedupHash,
    // Phase 6 fields
    isTargetCompany,
    recruiterMentioned,
  };
}

// Batch normalize with LLM
export async function normalizeEventsWithLLM(rawEvents: RawEvent[], source: string): Promise<NormalizedEvent[]> {
  const normalized: NormalizedEvent[] = [];
  
  for (const raw of rawEvents) {
    const event = await normalizeEventWithLLM(raw, source);
    normalized.push(event);
  }
  
  return normalized;
}

// Made with Bob