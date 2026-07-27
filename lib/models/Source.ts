import mongoose from 'mongoose';

export interface ISource {
  name: string;
  type: 'ical' | 'rss' | 'api' | 'scrape';
  url: string;
  enabled: boolean;
  lastScrapedAt?: Date;
  scrapeFrequency: string;
  // Health tracking — populated on every scrape so silent breakage is visible.
  // A source that starts 404-ing or goes permanently empty won't throw; it just
  // quietly stops contributing events. These fields make that observable and
  // are surfaced in the daily digest (see lib/notifications/digest.ts).
  lastEventCount?: number;        // events returned by the most recent scrape
  consecutiveEmptyScrapes: number; // resets to 0 the moment a scrape returns >0 events
  lastError?: string;             // last fetch/parse error message, if any
  lastErrorAt?: Date;             // when lastError was recorded
  createdAt: Date;
  updatedAt: Date;
}

const SourceSchema = new mongoose.Schema<ISource>(
  {
    name: {
      type: String,
      required: true,
    },
    type: {
      type: String,
      enum: ['ical', 'rss', 'api', 'scrape'],
      required: true,
    },
    url: {
      type: String,
      required: true,
    },
    enabled: {
      type: Boolean,
      default: true,
    },
    lastScrapedAt: {
      type: Date,
    },
    scrapeFrequency: {
      type: String,
      default: 'daily',
    },
    lastEventCount: {
      type: Number,
    },
    consecutiveEmptyScrapes: {
      type: Number,
      default: 0,
    },
    lastError: {
      type: String,
    },
    lastErrorAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
  }
);

// Create indexes
SourceSchema.index({ name: 1 });
SourceSchema.index({ enabled: 1 });
// Surface unhealthy sources cheaply in the digest query.
SourceSchema.index({ consecutiveEmptyScrapes: -1 });

export default mongoose.models.Source || mongoose.model<ISource>('Source', SourceSchema);

// Made with Bob
