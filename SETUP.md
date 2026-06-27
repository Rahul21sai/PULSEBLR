# PulseBLR - Local Setup Guide

Complete step-by-step instructions to run PulseBLR on your local machine.

## Prerequisites

Before you begin, ensure you have:
- **Node.js** 18+ installed ([Download](https://nodejs.org/))
- **MongoDB** account (free tier at [MongoDB Atlas](https://www.mongodb.com/cloud/atlas))
- **Git** installed
- A code editor (VS Code recommended)

## Step 1: Install Dependencies

Open your terminal in the `pulseblr` directory and run:

```bash
npm install
```

This will install all required packages including:
- Next.js, React, TypeScript
- MongoDB/Mongoose
- Playwright (for scraping)
- Anthropic SDK (for Claude AI)
- Resend (for emails)
- date-fns, RSS parser, etc.

## Step 2: Set Up MongoDB

### Option A: MongoDB Atlas (Recommended - Free)

1. Go to [MongoDB Atlas](https://www.mongodb.com/cloud/atlas)
2. Sign up for a free account
3. Create a new cluster (M0 Free tier is perfect)
4. Click "Connect" → "Connect your application"
5. Copy the connection string (looks like: `mongodb+srv://username:password@cluster.mongodb.net/`)
6. Replace `<password>` with your actual password
7. Add `/pulseblr` at the end: `mongodb+srv://username:password@cluster.mongodb.net/pulseblr`

### Option B: Local MongoDB

If you prefer running MongoDB locally:

```bash
# Install MongoDB Community Edition
# macOS
brew install mongodb-community

# Start MongoDB
brew services start mongodb-community

# Your connection string will be:
# mongodb://localhost:27017/pulseblr
```

## Step 3: Get API Keys

### Claude API (for LLM tagging)

1. Go to [Anthropic Console](https://console.anthropic.com/)
2. Sign up and get your API key
3. Free tier includes credits to get started

### Resend (for email notifications)

1. Go to [Resend](https://resend.com/)
2. Sign up for free account
3. Get your API key from dashboard
4. Verify your sending domain (or use their test domain for development)

## Step 4: Create Environment File

Create a `.env.local` file in the `pulseblr` directory:

```bash
# Copy the example file
cp .env.example .env.local
```

Edit `.env.local` with your actual values:

```env
# MongoDB Connection
MONGODB_URI=mongodb+srv://your-username:your-password@cluster.mongodb.net/pulseblr

# Claude AI API Key (for auto-tagging events)
ANTHROPIC_API_KEY=sk-ant-api03-your-key-here

# Resend API Key (for email notifications)
RESEND_API_KEY=re_your-key-here

# Email Configuration
NOTIFICATION_EMAIL=your-email@example.com

# Optional: Set to 'development' for local testing
NODE_ENV=development
```

**Important Notes:**
- Never commit `.env.local` to Git (it's already in `.gitignore`)
- The app will work without `ANTHROPIC_API_KEY` (falls back to keyword matching)
- Email notifications require `RESEND_API_KEY`

## Step 5: Generate PWA Icons

Run the icon generator script:

```bash
node scripts/generate-icons.js
```

This creates placeholder SVG icons. For production, replace with proper PNG icons.

## Step 6: Start Development Server

```bash
npm run dev
```

The app will start at **http://localhost:3000**

You should see:
```
✓ Ready in 2.5s
○ Local:        http://localhost:3000
```

## Step 7: Test the App

### 7.1 Open the App
Navigate to http://localhost:3000 in your browser

### 7.2 Add a Test Event
1. Click "+ Add Event" button
2. Fill in event details
3. Click "Add Event"
4. You should see it appear in the feed

### 7.3 Test the Tracker
1. Click "Track" on an event
2. Go to "Tracker" tab
3. Drag events between status columns
4. Add networking connections

### 7.4 Test the Calendar
1. Click "Calendar" tab
2. Select a date
3. View events for that day

### 7.5 Test the Dashboard
1. Click "📊" icon
2. View your stats
3. Check pending follow-ups

## Step 8: Run the Scrapers (Optional)

To test event scraping:

```bash
# Run scrapers manually
npm run scrape
```

This will:
- Scrape Meetup RSS feeds (7 Bangalore groups)
- Scrape Luma calendars (3 AI/ML communities)
- Normalize and tag events with LLM
- Store in MongoDB (deduplicating automatically)

**Note:** Scraping requires Playwright browsers. First run will download them automatically.

## Step 9: Test Email Digest (Optional)

To test the daily digest email:

```bash
# Send digest manually
npm run send-digest
```

This will:
- Generate a digest of new events
- Send email to `NOTIFICATION_EMAIL`
- Requires `RESEND_API_KEY` to be set

## Common Issues & Solutions

### Issue: MongoDB Connection Error
```
Error: connect ECONNREFUSED
```
**Solution:** 
- Check your `MONGODB_URI` is correct
- Ensure MongoDB Atlas IP whitelist includes your IP (or use 0.0.0.0/0 for development)
- Verify your password doesn't contain special characters (URL encode if needed)

### Issue: Playwright Browser Not Found
```
Error: Executable doesn't exist at /path/to/chromium
```
**Solution:**
```bash
npx playwright install chromium
```

### Issue: LLM Tagging Not Working
```
Warning: ANTHROPIC_API_KEY not set, using fallback
```
**Solution:**
- This is just a warning - app works with keyword-based tagging
- To enable LLM tagging, add your Claude API key to `.env.local`

### Issue: Port 3000 Already in Use
```
Error: Port 3000 is already in use
```
**Solution:**
```bash
# Use a different port
PORT=3001 npm run dev
```

### Issue: TypeScript Errors
```
Type error: Cannot find module...
```
**Solution:**
```bash
# Reinstall dependencies
rm -rf node_modules package-lock.json
npm install
```

## Development Workflow

### Daily Development
```bash
# Start dev server
npm run dev

# In another terminal, run scrapers
npm run scrape

# Test email digest
npm run send-digest
```

### Code Quality
```bash
# Type checking
npm run build

# Lint code
npm run lint
```

### Database Management

View your data in MongoDB Atlas:
1. Go to your cluster
2. Click "Browse Collections"
3. See `events`, `trackerentries`, `sources` collections

Or use MongoDB Compass (GUI):
1. Download [MongoDB Compass](https://www.mongodb.com/products/compass)
2. Connect using your `MONGODB_URI`
3. Browse and edit data visually

## Project Structure

```
pulseblr/
├── app/                    # Next.js app directory
│   ├── page.tsx           # Main feed
│   ├── calendar/          # Calendar view
│   ├── tracker/           # Tracker kanban
│   ├── dashboard/         # Stats dashboard
│   ├── settings/          # Settings page
│   ├── add-event/         # Manual event entry
│   └── api/               # API routes
├── lib/
│   ├── models/            # MongoDB schemas
│   ├── scrapers/          # Event scrapers
│   ├── llm/               # Claude AI integration
│   ├── notifications/     # Email digest
│   └── helpers/           # Phase 6 helpers
├── public/                # Static files
│   ├── manifest.json      # PWA manifest
│   └── sw.js             # Service worker
├── scripts/               # Utility scripts
└── .github/workflows/     # GitHub Actions (for production)
```

## Next Steps

Once everything is running:

1. **Add Real Events**: Use the scraper or manual entry
2. **Track Events**: Move events through your pipeline
3. **Add Connections**: Log people you meet
4. **Set Follow-ups**: Schedule networking follow-ups
5. **View Dashboard**: Check your stats

## Production Deployment

When ready to deploy:

1. **Deploy to Vercel**:
   ```bash
   npm install -g vercel
   vercel
   ```

2. **Set Environment Variables** in Vercel dashboard

3. **Set up GitHub Actions** for automated scraping (already configured in `.github/workflows/`)

4. **Install as PWA** on your phone/desktop

## Getting Help

- Check the main README.md for feature documentation
- Review the master prompt for architecture details
- MongoDB Atlas has excellent documentation
- Anthropic Claude API docs: https://docs.anthropic.com/

## Success Checklist

- [ ] Dependencies installed (`npm install`)
- [ ] MongoDB connected (Atlas or local)
- [ ] `.env.local` configured with all keys
- [ ] Dev server running (`npm run dev`)
- [ ] Can add and view events
- [ ] Tracker works (drag & drop)
- [ ] Calendar displays events
- [ ] Dashboard shows stats
- [ ] (Optional) Scrapers run successfully
- [ ] (Optional) Email digest sends

You're all set! Start tracking Bangalore tech events! 🎉