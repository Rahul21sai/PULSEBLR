# PulseBLR - Bangalore Tech Events Tracker

> Your personal hub for discovering and tracking tech events in Bangalore. Never miss an AI/ML, fintech, cybersecurity, or hackathon event again.

![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js)
![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?logo=typescript)
![MongoDB](https://img.shields.io/badge/MongoDB-Atlas-green?logo=mongodb)
![PWA](https://img.shields.io/badge/PWA-Enabled-purple)

## 🎯 What is PulseBLR?

PulseBLR is a full-stack PWA that aggregates tech events from multiple sources (Luma, Meetup, Hasgeek, Devfolio, Unstop) into one clean feed, with a personal tracker for managing your event pipeline and networking follow-ups.

Built for developers actively job-hunting toward SDE/AI engineer roles who treat tech events as a pipeline for networking, hackathon wins, and staying current on AI/fintech/cybersecurity.

## ✨ Features

### Core Features (Phase 1-5)
- 📅 **Event Aggregation** - Pulls from Meetup RSS, Luma calendars, and manual entry
- 🤖 **Smart Tagging** - LLM-powered categorization (AI/ML, Fintech, Cybersecurity, etc.)
- 📊 **Personal Tracker** - Kanban board with status pipeline (New → Interested → Applied → Confirmed → Attended)
- 🤝 **Networking Log** - Track connections made at events with follow-up reminders
- 📧 **Daily Digest** - Email notifications for new events and upcoming deadlines
- 📱 **PWA** - Installable on mobile/desktop with offline support
- 🗓️ **Calendar View** - See events by date
- 🔍 **Advanced Filters** - Category, format, food, area, price
- ⚙️ **Settings** - Manage scraper sources and preferences
- ➕ **Manual Entry** - Add events the scrapers miss

### Advanced Features (Phase 6)
- 🔗 **PWA Share Target** - Share event links from any app → instant add
- ⏰ **Follow-up Reminders** - Never let a connection go cold
- 🔄 **Repeat Connection Detection** - See your network forming
- 🎯 **Target Company Tagging** - Auto-flags events from companies you're targeting
- 📈 **Stats Dashboard** - Attendance rate, connections made, pending follow-ups

## 🚀 Quick Start

### Prerequisites
- Node.js 18+
- MongoDB (Atlas free tier or local)
- Optional: Claude API key, Resend API key

### Installation

```bash
# Clone the repository
git clone https://github.com/Rahul21sai/PULSEBLR.git
cd PULSEBLR/pulseblr

# Install dependencies
npm install

# Set up environment variables
cp .env.example .env.local
# Edit .env.local with your MongoDB URI and API keys

# Generate PWA icons
node scripts/generate-icons.js

# Start development server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to see the app.

### Environment Variables

Create `.env.local`:

```env
# Required
MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/pulseblr

# Optional (for full features)
ANTHROPIC_API_KEY=sk-ant-api03-your-key-here
RESEND_API_KEY=re_your-key-here
NOTIFICATION_EMAIL=your-email@example.com
```

## 📖 Documentation

- **[SETUP.md](SETUP.md)** - Detailed setup instructions
- **[.env.example](.env.example)** - Environment variable template

## 🏗️ Tech Stack

- **Frontend**: Next.js 16, React 19, TypeScript, Tailwind CSS
- **Backend**: Next.js API Routes
- **Database**: MongoDB with Mongoose
- **Scraping**: Playwright (Luma), RSS Parser (Meetup)
- **AI**: Claude API (Anthropic) for event tagging
- **Email**: Resend for transactional emails
- **Automation**: GitHub Actions for daily scraping
- **PWA**: Service Worker, Web App Manifest

## 📁 Project Structure

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
│       ├── events/        # Event CRUD
│       ├── tracker/       # Tracker CRUD
│       ├── sources/       # Source management
│       ├── scrape/        # Scraper trigger
│       ├── notifications/ # Email digest
│       └── phase6/        # Advanced features
├── lib/
│   ├── models/            # MongoDB schemas
│   │   ├── Event.ts
│   │   ├── TrackerEntry.ts
│   │   └── Source.ts
│   ├── scrapers/          # Event scrapers
│   │   ├── meetup-rss.ts
│   │   ├── luma.ts
│   │   ├── normalizer.ts
│   │   └── ingestion.ts
│   ├── llm/               # Claude AI integration
│   ├── notifications/     # Email digest system
│   └── helpers/           # Phase 6 helpers
├── public/
│   ├── manifest.json      # PWA manifest
│   ├── sw.js             # Service worker
│   └── icon-*.svg        # App icons
├── scripts/
│   ├── generate-icons.js  # Icon generator
│   └── send-digest.ts    # Manual digest trigger
└── .github/workflows/     # GitHub Actions
    ├── daily-scrape.yml
    └── daily-digest.yml
```

## 🔧 Available Scripts

```bash
# Development
npm run dev              # Start dev server
npm run build           # Build for production
npm run start           # Start production server

# Utilities
npm run scrape          # Run event scrapers manually
npm run send-digest     # Send email digest manually
node scripts/generate-icons.js  # Generate PWA icons

# Code Quality
npm run lint            # Lint code
```

## 🎨 Features in Detail

### Event Aggregation
- **Meetup RSS**: 7 Bangalore tech groups (AWS, GDG, Python, PyData, Women Who Code, OWASP, Java)
- **Luma Calendars**: 3 AI/ML communities (AI Tinkerers, Build Club, GenAI)
- **Manual Entry**: Add events from WhatsApp, Instagram, or word of mouth

### Smart Tagging
- LLM-powered categorization using Claude API
- Fallback to keyword matching if API key not set
- Auto-detects: category, format (online/offline/hybrid), food availability

### Personal Tracker
- Status pipeline: New → Interested → Applied → Shortlisted → Confirmed → Attended → Skipped/Rejected
- Notes field per event
- Networking connections with LinkedIn URLs
- Follow-up reminders

### Networking Log
- Track who you met at each event
- Name, role, company, LinkedIn, context
- Follow-up date reminders
- Repeat connection detection

### Daily Digest
- New events listed today
- Registration deadlines in next 3 days
- Tracker updates changelog
- Sent via email at 8 AM IST

### Dashboard Analytics
- Total events tracked
- Events attended this month
- Attendance rate
- Total connections made
- Average connections per event
- Pending follow-ups
- Target company events

## 🌐 Event Sources

Currently scraping:
- **Meetup Groups**: AWS UG Bangalore, GDG Cloud Bangalore, Bangalore Python UG, PyData Bangalore, Women Who Code Bangalore, OWASP Bangalore, Bangalore Java UG
- **Luma Calendars**: AI Tinkerers Bangalore, Build Club Bangalore, GenAI Community

Easily extensible to add more sources!

## 🚢 Deployment

### Vercel (Recommended)

```bash
# Install Vercel CLI
npm install -g vercel

# Deploy
vercel

# Set environment variables in Vercel dashboard
```

### Environment Variables for Production
Set these in your deployment platform:
- `MONGODB_URI`
- `ANTHROPIC_API_KEY` (optional)
- `RESEND_API_KEY` (optional)
- `NOTIFICATION_EMAIL` (optional)

### GitHub Actions
The project includes workflows for:
- Daily scraping at 8 AM IST
- Daily digest email at 8 AM IST

Set these secrets in GitHub:
- `MONGODB_URI`
- `ANTHROPIC_API_KEY`
- `RESEND_API_KEY`
- `NOTIFICATION_EMAIL`

## 🤝 Contributing

This is a personal project, but suggestions and improvements are welcome!

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## 📝 License

This project is open source and available under the [MIT License](LICENSE).

## 🙏 Acknowledgments

- Built with guidance from the master prompt
- Event sources: Meetup, Luma, Hasgeek, Devfolio, Unstop
- LLM tagging powered by Anthropic Claude
- Email delivery by Resend

## 📧 Contact

Rahul - [@Rahul21sai](https://github.com/Rahul21sai)

Project Link: [https://github.com/Rahul21sai/PULSEBLR](https://github.com/Rahul21sai/PULSEBLR)

---

**Made with ❤️ for the Bangalore tech community**
