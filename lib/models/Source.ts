import mongoose from 'mongoose';

export interface ISource {
  name: string;
  type: 'ical' | 'rss' | 'api' | 'scrape';
  url: string;
  enabled: boolean;
  lastScrapedAt?: Date;
  scrapeFrequency: string;
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
  },
  {
    timestamps: true,
  }
);

// Create indexes
SourceSchema.index({ name: 1 });
SourceSchema.index({ enabled: 1 });

export default mongoose.models.Source || mongoose.model<ISource>('Source', SourceSchema);

// Made with Bob
