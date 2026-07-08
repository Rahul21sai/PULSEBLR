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

// ─────────────────────────────────────────────────────────────────────────────
// NVIDIA NIM (primary) — OpenAI-compatible endpoint
// Docs: https://docs.api.nvidia.com/nim/reference/llm-apis
// ─────────────────────────────────────────────────────────────────────────────
async function tagWithNvidia(userPrompt: string): Promise<TaggingResult> {
  const apiKey = process.env.NVIDIA_API_KEY!;
  const model = process.env.NVIDIA_MODEL || 'meta/llama-3.1-8b-instruct';
  const baseUrl = process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1';

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 500,
      temperature: 0.3,
      // Ask for JSON output if the model supports it
      response_format: { type: 'text' },
    }),
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`NVIDIA NIM error ${response.status}: ${err}`);
  }

  const data = await response.json();
  const text: string = data.choices?.[0]?.message?.content ?? '';

  // Extract JSON block from the response (model may wrap it in markdown)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in NVIDIA response');
  return JSON.parse(jsonMatch[0]) as TaggingResult;
}

// ─────────────────────────────────────────────────────────────────────────────
// Anthropic Claude (fallback when NVIDIA key not set)
// ─────────────────────────────────────────────────────────────────────────────
async function tagWithAnthropic(userPrompt: string): Promise<TaggingResult> {
  // Dynamic import so the SDK is only loaded when actually needed
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

  const message = await anthropic.messages.create({
    model: 'claude-3-5-sonnet-20241022',
    max_tokens: 500,
    temperature: 0.3,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const content = message.content[0];
  if (content.type !== 'text') throw new Error('Unexpected Anthropic response type');

  const jsonMatch = content.text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in Anthropic response');
  return JSON.parse(jsonMatch[0]) as TaggingResult;
}

/**
 * Tag an event using NVIDIA NIM (primary) or Anthropic Claude (fallback).
 * If neither key is set, returns keyword-based tagging.
 */
export async function tagEventWithLLM(
  title: string,
  description: string,
  venue?: string,
  onlineLink?: string
): Promise<TaggingResult> {
  const hasNvidia = !!process.env.NVIDIA_API_KEY;
  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;

  if (!hasNvidia && !hasAnthropic) {
    console.warn('⚠️  No LLM API key set (NVIDIA_API_KEY or ANTHROPIC_API_KEY), using keyword tagging');
    return fallbackTagging(title, description, venue, onlineLink);
  }

  const userPrompt = `Event Title: ${title}

Event Description: ${description}
${venue ? `\nVenue: ${venue}` : ''}
${onlineLink ? `\nOnline Link: ${onlineLink}` : ''}

Classify this event.`;

  try {
    const result = hasNvidia
      ? await tagWithNvidia(userPrompt)
      : await tagWithAnthropic(userPrompt);

    // Validate categories
    const validCategories = [
      'AI/ML', 'Fintech', 'Cybersecurity', 'Cloud/DevOps', 'Web/Mobile',
      'Data/Analytics', 'Hackathon', 'Government', 'Corporate',
      'Summit/Conference', 'Networking/Meetup', 'Career/Job Fair',
    ];
    result.categories = result.categories.filter(c => validCategories.includes(c));
    if (result.categories.length === 0) result.categories = ['Networking/Meetup'];

    const provider = hasNvidia ? 'NVIDIA NIM' : 'Anthropic';
    console.log(`✅ [${provider}] tagged: ${title} → ${result.categories.join(', ')}`);
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