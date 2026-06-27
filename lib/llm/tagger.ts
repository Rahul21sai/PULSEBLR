import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || '',
});

interface TaggingResult {
  categories: string[];
  format: 'online' | 'offline' | 'hybrid';
  hasFood: 'yes' | 'no' | 'unknown';
  confidence: number;
}

const SYSTEM_PROMPT = `You are an expert at categorizing tech events in Bangalore, India.

Given an event title and description, classify it into the following:

1. Categories (select all that apply):
   - AI/ML: Artificial Intelligence, Machine Learning, Deep Learning, LLMs, GenAI
   - Fintech: Financial technology, banking, payments, blockchain
   - Cybersecurity: Security, hacking, penetration testing, InfoSec
   - Cloud/DevOps: AWS, Azure, GCP, Kubernetes, Docker, CI/CD
   - Web/Mobile: Web development, mobile apps, React, Flutter, iOS, Android
   - Data/Analytics: Data science, big data, analytics, visualization
   - Hackathon: Coding competitions, hackathons
   - Government: Government-sponsored events, Smart India Hackathon
   - Corporate: Company-hosted tech talks, recruitment events
   - Summit/Conference: Large conferences, summits
   - Networking/Meetup: Community meetups, networking events
   - Career/Job Fair: Job fairs, career events, recruitment drives

2. Format:
   - online: Virtual event (Zoom, Teams, Meet)
   - offline: In-person event at a physical venue
   - hybrid: Both online and offline options

3. Food availability:
   - yes: Food/snacks/refreshments explicitly mentioned
   - no: Explicitly states no food
   - unknown: Not mentioned

Respond ONLY with valid JSON in this exact format:
{
  "categories": ["Category1", "Category2"],
  "format": "online|offline|hybrid",
  "hasFood": "yes|no|unknown",
  "confidence": 0.95
}`;

/**
 * Use Claude to intelligently tag an event
 */
export async function tagEventWithLLM(
  title: string,
  description: string,
  venue?: string,
  onlineLink?: string
): Promise<TaggingResult> {
  // Skip if no API key
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('⚠️  ANTHROPIC_API_KEY not set, using basic tagging');
    return fallbackTagging(title, description, venue, onlineLink);
  }

  try {
    const userPrompt = `Event Title: ${title}

Event Description: ${description}

${venue ? `Venue: ${venue}` : ''}
${onlineLink ? `Online Link: ${onlineLink}` : ''}

Classify this event.`;

    const message = await anthropic.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 500,
      temperature: 0.3,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: userPrompt,
        },
      ],
    });

    const content = message.content[0];
    if (content.type !== 'text') {
      throw new Error('Unexpected response type from Claude');
    }

    // Parse JSON response
    const result = JSON.parse(content.text) as TaggingResult;

    // Validate categories
    const validCategories = [
      'AI/ML', 'Fintech', 'Cybersecurity', 'Cloud/DevOps', 'Web/Mobile',
      'Data/Analytics', 'Hackathon', 'Government', 'Corporate',
      'Summit/Conference', 'Networking/Meetup', 'Career/Job Fair'
    ];

    result.categories = result.categories.filter(cat => validCategories.includes(cat));

    // Ensure at least one category
    if (result.categories.length === 0) {
      result.categories = ['Networking/Meetup'];
    }

    console.log(`✅ LLM tagged: ${title} → ${result.categories.join(', ')}`);

    return result;

  } catch (error: any) {
    console.error('❌ LLM tagging error:', error.message);
    return fallbackTagging(title, description, venue, onlineLink);
  }
}

/**
 * Fallback tagging when LLM is unavailable
 * Uses the basic keyword matching from normalizer
 */
function fallbackTagging(
  title: string,
  description: string,
  venue?: string,
  onlineLink?: string
): TaggingResult {
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

  if (categories.length === 0) {
    categories.push('Networking/Meetup');
  }

  // Detect format
  const hasVenue = !!venue && venue.trim().length > 0;
  const hasOnlineLink = !!onlineLink && onlineLink.trim().length > 0;
  let format: 'online' | 'offline' | 'hybrid' = 'offline';

  if (hasVenue && hasOnlineLink) {
    format = 'hybrid';
  } else if (hasOnlineLink || text.includes('zoom') || text.includes('meet') || text.includes('virtual')) {
    format = 'online';
  }

  // Detect food
  const foodKeywords = ['food', 'snacks', 'refreshments', 'lunch', 'dinner', 'pizza', 'beverages'];
  let hasFood: 'yes' | 'no' | 'unknown' = 'unknown';

  for (const keyword of foodKeywords) {
    if (text.includes(keyword)) {
      hasFood = 'yes';
      break;
    }
  }

  return {
    categories: [...new Set(categories)],
    format,
    hasFood,
    confidence: 0.7, // Lower confidence for fallback
  };
}

/**
 * Batch tag multiple events
 */
export async function tagEventsWithLLM(
  events: Array<{ title: string; description: string; venue?: string; onlineLink?: string }>
): Promise<TaggingResult[]> {
  const results: TaggingResult[] = [];

  for (const event of events) {
    const result = await tagEventWithLLM(
      event.title,
      event.description,
      event.venue,
      event.onlineLink
    );
    results.push(result);

    // Rate limiting - wait 1 second between API calls
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  return results;
}

// Made with Bob