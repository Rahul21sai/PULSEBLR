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
// Generic OpenAI-compatible chat-completions tagger.
//
// NVIDIA NIM and IBM Consulting Advantage (ICA) both expose the standard
// OpenAI `/chat/completions` protocol, so they share this one call path — only
// the base URL, model, API key, and timeout differ. Keeping the transport in a
// single place means a fix (timeout, JSON extraction, error surfacing) applies
// to every OpenAI-compatible provider at once.
// ─────────────────────────────────────────────────────────────────────────────
// Some gateway/model combos reject temperature != 1 (e.g. ICA/litellm for
// claude-opus-4-8 returns HTTP 400 "Only temperature=1 is supported"). We prefer
// 0.3 for deterministic classification, but when a model refuses it we retry at
// 1 and remember the model here so every later event in the run skips straight
// to temperature=1 — no repeated failed calls.
const MODELS_REQUIRING_TEMP_1 = new Set<string>();

async function tagWithOpenAICompatible(
  userPrompt: string,
  opts: { apiKey: string; baseUrl: string; model: string; provider: string; timeoutMs?: number }
): Promise<TaggingResult> {
  const { apiKey, baseUrl, model, provider, timeoutMs = 20000 } = opts;
  // Trim any trailing slash so `${baseUrl}/chat/completions` never doubles up.
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;

  const call = (temperature: number) =>
    fetch(url, {
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
        temperature,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

  let response = await call(MODELS_REQUIRING_TEMP_1.has(model) ? 1 : 0.3);

  // Adaptive retry: if the model rejects temperature=0.3, retry once at 1 and
  // cache that so the rest of the batch goes direct. Non-temperature 400s throw.
  if (response.status === 400 && !MODELS_REQUIRING_TEMP_1.has(model)) {
    const errText = await response.text();
    if (/temperature/i.test(errText)) {
      MODELS_REQUIRING_TEMP_1.add(model);
      console.warn(`⚠️  [${provider}] ${model} rejected temperature=0.3 — retrying at 1`);
      response = await call(1);
    } else {
      throw new Error(`${provider} error 400: ${errText}`);
    }
  }

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`${provider} error ${response.status}: ${err}`);
  }

  const data = await response.json();
  const text: string = data.choices?.[0]?.message?.content ?? '';

  // Extract JSON block from the response (model may wrap it in markdown).
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`No JSON in ${provider} response`);
  return JSON.parse(jsonMatch[0]) as TaggingResult;
}

// ─────────────────────────────────────────────────────────────────────────────
// IBM Consulting Advantage (ICA) — OpenAI-compatible gateway (primary when set)
//
// Endpoint and model are NOT guessed: ICA is only activated when ICA_API_KEY,
// ICA_BASE_URL, and ICA_MODEL are ALL present in the environment. Set them in
// .env.local (never in code). Until then this provider is skipped and NVIDIA
// stays primary, so an incomplete config never changes behavior.
// ─────────────────────────────────────────────────────────────────────────────
async function tagWithICA(userPrompt: string): Promise<TaggingResult> {
  return tagWithOpenAICompatible(userPrompt, {
    apiKey: process.env.ICA_API_KEY!,
    baseUrl: process.env.ICA_BASE_URL!,
    model: process.env.ICA_MODEL!,
    provider: 'IBM ICA',
    timeoutMs: 20000,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// NVIDIA NIM — OpenAI-compatible endpoint
// Docs: https://docs.api.nvidia.com/nim/reference/llm-apis
// ─────────────────────────────────────────────────────────────────────────────
async function tagWithNvidia(userPrompt: string): Promise<TaggingResult> {
  return tagWithOpenAICompatible(userPrompt, {
    apiKey: process.env.NVIDIA_API_KEY!,
    baseUrl: process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1',
    model: process.env.NVIDIA_MODEL || 'meta/llama-3.1-8b-instruct',
    provider: 'NVIDIA NIM',
    timeoutMs: 15000,
  });
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

// The 12 canonical Event categories (must stay in sync with the enum in
// lib/models/Event.ts). Any category the LLM invents outside this set is
// dropped; if nothing survives we default to the most generic bucket.
const VALID_CATEGORIES = [
  'AI/ML', 'Fintech', 'Cybersecurity', 'Cloud/DevOps', 'Web/Mobile',
  'Data/Analytics', 'Hackathon', 'Government', 'Corporate',
  'Summit/Conference', 'Networking/Meetup', 'Career/Job Fair',
];

// The only values the Event schema accepts for these fields (lib/models/Event.ts).
// LLMs go off-script — e.g. Llama-3.1-8b returned "format":"unknown" for an event
// whose venue it couldn't classify — and an out-of-enum value makes Mongoose reject
// the whole document at insert. So we coerce to a safe default rather than trust the
// model's string. 'offline' is the schema default intent for format (most Bangalore
// meetups are in-person); 'unknown' is already a valid hasFood value.
const VALID_FORMATS: TaggingResult['format'][] = ['online', 'offline', 'hybrid'];
const VALID_FOOD: TaggingResult['hasFood'][] = ['yes', 'no', 'unknown'];

/**
 * Tag an event through a provider cascade: IBM ICA (primary) → NVIDIA NIM →
 * Anthropic Claude → keyword heuristics. Each provider is attempted only if its
 * env is configured; on error we log ❌ and fall through to the next tier, so a
 * slow/failing provider never drops the event — worst case we still get
 * keyword-based tags. This is what fixed the "0 new" runs where a single
 * NVIDIA timeout aborted every event.
 */
export async function tagEventWithLLM(
  title: string,
  description: string,
  venue?: string,
  onlineLink?: string
): Promise<TaggingResult> {
  const userPrompt = `Event Title: ${title}

Event Description: ${description}
${venue ? `\nVenue: ${venue}` : ''}
${onlineLink ? `\nOnline Link: ${onlineLink}` : ''}

Classify this event.`;

  // Build the provider chain in priority order, skipping any that lack config.
  // ICA requires all three vars (key/base/model) so an incomplete config never
  // silently hijacks tagging.
  const providers: Array<{ name: string; run: () => Promise<TaggingResult> }> = [];
  if (process.env.ICA_API_KEY && process.env.ICA_BASE_URL && process.env.ICA_MODEL) {
    providers.push({ name: 'IBM ICA', run: () => tagWithICA(userPrompt) });
  }
  if (process.env.NVIDIA_API_KEY) {
    providers.push({ name: 'NVIDIA NIM', run: () => tagWithNvidia(userPrompt) });
  }
  if (process.env.ANTHROPIC_API_KEY) {
    providers.push({ name: 'Anthropic', run: () => tagWithAnthropic(userPrompt) });
  }

  if (providers.length === 0) {
    console.warn('⚠️  No LLM API key set (ICA / NVIDIA / Anthropic), using keyword tagging');
    return fallbackTagging(title, description, venue, onlineLink);
  }

  for (const provider of providers) {
    try {
      const result = await provider.run();

      // Validate categories against the canonical enum.
      result.categories = (result.categories || []).filter(c => VALID_CATEGORIES.includes(c));
      if (result.categories.length === 0) result.categories = ['Networking/Meetup'];

      // Coerce format/hasFood to schema-valid values — the model sometimes emits
      // strings outside the enum (e.g. "unknown" for format), which would otherwise
      // fail Mongoose validation and silently drop the event at ingest.
      if (!VALID_FORMATS.includes(result.format)) result.format = 'offline';
      if (!VALID_FOOD.includes(result.hasFood)) result.hasFood = 'unknown';

      console.log(`✅ [${provider.name}] tagged: ${title} → ${result.categories.join(', ')}`);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`❌ [${provider.name}] tagging error: ${message} — falling through`);
      // Try the next provider in the cascade.
    }
  }

  console.warn(`⚠️  All LLM providers failed for "${title}", using keyword tagging`);
  return fallbackTagging(title, description, venue, onlineLink);
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