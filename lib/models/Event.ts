import mongoose, { Schema, Document, Model } from 'mongoose';
import crypto from 'crypto';

export interface IEvent extends Document {
  title: string;
  description: string;
  source: string;
  sourceUrl: string;
  organizer?: string;
  category: string[];
  format: 'online' | 'offline' | 'hybrid';
  hasFood: 'yes' | 'no' | 'unknown';
  isFree: boolean;
  price?: number;
  venue?: string;
  area?: string;
  onlineLink?: string;
  startDateTime: Date;
  endDateTime?: Date;
  applyLink?: string;
  registrationDeadline?: Date;
  dedupHash: string;
  // Phase 6 fields
  isTargetCompany?: boolean;
  recruiterMentioned?: boolean;
  guestCount?: number;
  createdAt: Date;
  updatedAt: Date;
}

const EventSchema = new Schema<IEvent>(
  {
    title: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      required: true,
    },
    source: {
      type: String,
      required: true,
      enum: ['luma', 'meetup', 'hasgeek', 'devfolio', 'unstop', 'manual', 'other'],
    },
    sourceUrl: {
      type: String,
      required: true,
    },
    organizer: {
      type: String,
      trim: true,
    },
    category: {
      type: [String],
      required: true,
      enum: [
        'AI/ML',
        'Fintech',
        'Cybersecurity',
        'Cloud/DevOps',
        'Web/Mobile',
        'Data/Analytics',
        'Hackathon',
        'Government',
        'Corporate',
        'Summit/Conference',
        'Networking/Meetup',
        'Career/Job Fair',
      ],
    },
    format: {
      type: String,
      required: true,
      enum: ['online', 'offline', 'hybrid'],
    },
    hasFood: {
      type: String,
      default: 'unknown',
      enum: ['yes', 'no', 'unknown'],
    },
    isFree: {
      type: Boolean,
      default: true,
    },
    price: {
      type: Number,
      min: 0,
    },
    venue: {
      type: String,
      trim: true,
    },
    area: {
      type: String,
      trim: true,
      enum: [
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
        'Other',
      ],
    },
    onlineLink: {
      type: String,
      trim: true,
    },
    startDateTime: {
      type: Date,
      required: true,
    },
    endDateTime: {
      type: Date,
    },
    applyLink: {
      type: String,
      trim: true,
    },
    registrationDeadline: {
      type: Date,
    },
    dedupHash: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    // Phase 6 fields
    isTargetCompany: {
      type: Boolean,
      default: false,
    },
    recruiterMentioned: {
      type: Boolean,
      default: false,
    },
    guestCount: {
      type: Number,
      min: 0,
    },
  },
  {
    timestamps: true,
  }
);

// Index for efficient querying
EventSchema.index({ startDateTime: 1 });
EventSchema.index({ category: 1 });
EventSchema.index({ format: 1 });
EventSchema.index({ area: 1 });
EventSchema.index({ source: 1 });
EventSchema.index({ createdAt: -1 });
EventSchema.index({ isTargetCompany: 1 });

// Static method to generate dedup hash
EventSchema.statics.generateDedupHash = function (
  title: string,
  startDateTime: Date,
  venue?: string,
  source?: string
): string {
  const hashInput = `${title.toLowerCase().trim()}-${startDateTime.toISOString()}-${venue || ''}-${source || ''}`;
  return crypto.createHash('sha256').update(hashInput).digest('hex');
};

// Pre-save hook to generate dedupHash if not provided
EventSchema.pre('save', function () {
  if (!this.dedupHash) {
    this.dedupHash = (this.constructor as any).generateDedupHash(
      this.title,
      this.startDateTime,
      this.venue,
      this.source
    );
  }
});

const Event: Model<IEvent> =
  mongoose.models.Event || mongoose.model<IEvent>('Event', EventSchema);

export default Event;

// Made with Bob
