# Phase 2 Complete - Event Scrapers

## ✅ What's Been Built

### Scraper Infrastructure
- **Type definitions** (`lib/scrapers/types.ts`) - Common interfaces for all scrapers
- **Normalizer** (`lib/scrapers/normalizer.ts`) - Converts raw events to our schema with smart detection:
  - Area extraction from venue names
  - Price detection from descriptions
  - Food availability detection
  - Format detection (online/offline/hybrid)
  - Basic category tagging (enhanced by LLM in Phase 3)
- **Ingestion pipeline** (`lib/scrapers/ingestion.ts`) - Saves to MongoDB with deduplication
- **Main orchestrator** (`lib/scrapers/index.ts`) - Runs all scrapers in sequence

### Scrapers Implemented

#### 1. Meetup RSS Scraper (`lib/scrapers/meetup-rss.ts`)
- Fetches events from Meetup group RSS feeds
- No authentication required
- Configured groups:
  - AWS User Group Bangalore
  - GDG Cloud Bangalore
  - Bangalore Python User Group
  - PyData Bangalore
  - Women Who Code Bangalore
  - OWASP Bangalore (Cybersecurity)
  - Bangalore Java User Group

#### 2. Luma Calendar Scraper (`lib/scrapers/luma.ts`)
- Uses Playwright for JavaScript-heavy pages
- Headless browser automation
- Configured calendars:
  - AI Tinkerers Bangalore
  - Build Club
  - GenAI Builders
- Rate-limited (2s between requests)

### Automation

#### Manual Trigger
```bash
npm run scrape
```

#### API Endpoint
```bash
# Trigger scraper via API
curl -X POST http://localhost:3000/api/scrape

# Check scraper status
curl http://localhost:3000/api/scrape
```

#### GitHub Actions (Daily Cron)
- Runs daily at 8 AM IST (2:30 AM UTC)
- Can be manually triggered from GitHub Actions tab
- Requires `MONGODB_URI` secret in repository settings

## 🚀 Setup Instructions

### 1. Install Dependencies
```bash
cd pulseblr
npm install
```

### 2. Install Playwright Browsers
```bash
npx playwright install chromium
```

### 3. Configure MongoDB
Ensure `.env.local` has your MongoDB connection string:
```
MONGODB_URI=mongodb://localhost:27017/pulseblr
# or
MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/pulseblr
```

### 4. Test the Scrapers

#### Option A: Run via CLI
```bash
npm run scrape
```

Expected output:
```
============================================================
PulseBLR Event Scraper
============================================================

🚀 Starting scraper run...
📡 Scraping Meetup groups...
✅ Meetup: 15 events, 0 errors
📡 Scraping Luma calendars...
✅ Luma: 8 events, 0 errors
🔄 Normalizing events...
✅ Normalized 23 events
💾 Ingesting events into database...
✅ Ingestion complete: 23 new, 0 duplicates, 0 errors
🎉 Scraper run complete in 12.45s
```

#### Option B: Run via API
```bash
# Start dev server
npm run dev

# In another terminal, trigger scraper
curl -X POST http://localhost:3000/api/scrape
```

#### Option C: Test Individual Scrapers
Create a test file `test-scraper.ts`:
```typescript
import { runMeetupScraper, runLumaScraper } from './lib/scrapers';

async function test() {
  // Test Meetup
  const meetupResult = await runMeetupScraper();
  console.log('Meetup:', meetupResult);
  
  // Test Luma
  const lumaResult = await runLumaScraper();
  console.log('Luma:', lumaResult);
}

test();
```

### 5. Verify in Database

#### MongoDB Compass
1. Connect to your MongoDB instance
2. Navigate to `pulseblr` database → `events` collection
3. You should see scraped events with all fields populated

#### Via API
```bash
# List all events
curl http://localhost:3000/api/events

# Filter by source
curl http://localhost:3000/api/events?source=meetup
curl http://localhost:3000/api/events?source=luma

# Filter by category
curl http://localhost:3000/api/events?category=AI/ML
```

### 6. View in UI
1. Open http://localhost:3000
2. Events should appear in the feed
3. Each card shows:
   - Title, organizer, description
   - Categories (color-coded)
   - Date/time, location, format
   - Free/paid status, food availability
   - Link to original event

## 📊 Scraper Features

### Deduplication
- Uses hash of: `title + startDateTime + venue + source`
- Prevents duplicate events from multiple sources
- Re-running scraper won't create duplicates

### Smart Detection
- **Area**: Extracts Bangalore locality from venue (Koramangala, Indiranagar, etc.)
- **Price**: Detects ₹ amounts in description
- **Food**: Looks for keywords (food, snacks, pizza, etc.)
- **Format**: Online if has Zoom/Meet link, offline if has venue, hybrid if both
- **Categories**: Basic keyword matching (enhanced by LLM in Phase 3)

### Error Handling
- Continues on individual event failures
- Logs all errors for debugging
- Returns summary with error counts

### Rate Limiting
- Luma scraper waits 2s between calendars
- Respects source ToS
- Uses headless browser with realistic user agent

## 🔧 Configuration

### Add More Meetup Groups
Edit `lib/scrapers/meetup-rss.ts`:
```typescript
export const BANGALORE_MEETUP_GROUPS = [
  'https://www.meetup.com/your-group/events/rss/',
  // Add more...
];
```

### Add More Luma Calendars
Edit `lib/scrapers/luma.ts`:
```typescript
export const BANGALORE_LUMA_CALENDARS = [
  'https://lu.ma/your-calendar',
  // Add more...
];
```

### Adjust Scraper Schedule
Edit `.github/workflows/daily-scrape.yml`:
```yaml
schedule:
  - cron: '30 2 * * *'  # 8 AM IST = 2:30 AM UTC
```

## 🐛 Troubleshooting

### Playwright Issues
```bash
# Reinstall browsers
npx playwright install chromium --with-deps

# On Linux, may need system dependencies
npx playwright install-deps chromium
```

### MongoDB Connection
```bash
# Test connection
mongosh "mongodb://localhost:27017/pulseblr"

# Or for Atlas
mongosh "mongodb+srv://user:pass@cluster.mongodb.net/pulseblr"
```

### No Events Scraped
1. Check if sources are accessible (try URLs in browser)
2. Luma/Meetup may have changed their HTML structure
3. Check scraper logs for specific errors
4. Some groups may have no upcoming events

### Duplicate Events
- Should not happen due to dedupHash
- If it does, check if title/date/venue are exactly the same
- May need to adjust dedup logic in `Event.ts`

## 📈 Next Steps (Phase 3)

1. **LLM Auto-tagging**: Replace basic keyword matching with Claude/GPT for better categorization
2. **Tracker UI**: Build the kanban board for personal event pipeline
3. **Networking Log**: Add connection tracking after attending events

## 🎯 Testing Checklist

- [ ] Scrapers run without errors
- [ ] Events appear in database
- [ ] Events show in UI feed
- [ ] Deduplication works (re-run doesn't create duplicates)
- [ ] Categories are assigned correctly
- [ ] Dates are parsed correctly
- [ ] Venue/area detection works
- [ ] API endpoint responds
- [ ] GitHub Actions workflow is configured

---

**Made with Bob** 🤖