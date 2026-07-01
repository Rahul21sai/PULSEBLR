import mongoose, { Schema, Document, Model } from 'mongoose';

export interface IConnection {
  name: string;
  role?: string;
  company?: string;
  linkedin?: string;
  context?: string;
  followUpAt?: Date;
  seenAtEventIds?: mongoose.Types.ObjectId[];  // Track repeat appearances
  followedUp?: boolean;  // Track if follow-up was completed
}

export interface ITrackerEntry extends Document {
  eventId: mongoose.Types.ObjectId;
  userId: string;   // Google sub / email — owner of this entry
  status: 'New' | 'Interested' | 'Applied' | 'Shortlisted' | 'Confirmed' | 'Attended' | 'Skipped' | 'Rejected';
  notes?: string;
  appliedAt?: Date;
  outcome?: string;
  connections: IConnection[];
  updatedAt: Date;
  createdAt: Date;
}

const ConnectionSchema = new Schema<IConnection>(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    role: {
      type: String,
      trim: true,
    },
    company: {
      type: String,
      trim: true,
    },
    linkedin: {
      type: String,
      trim: true,
    },
    context: {
      type: String,
      trim: true,
    },
    followUpAt: {
      type: Date,
    },
    seenAtEventIds: {
      type: [Schema.Types.ObjectId],
      default: [],
    },
    followedUp: {
      type: Boolean,
      default: false,
    },
  },
  { _id: false }
);

const TrackerEntrySchema = new Schema<ITrackerEntry>(
  {
    eventId: {
      type: Schema.Types.ObjectId,
      ref: 'Event',
      required: true,
      index: true,
    },
    userId: {
      type: String,
      required: true,
      index: true,
    },
    status: {
      type: String,
      required: true,
      enum: ['New', 'Interested', 'Applied', 'Shortlisted', 'Confirmed', 'Attended', 'Skipped', 'Rejected'],
      default: 'New',
    },
    notes: {
      type: String,
      trim: true,
    },
    appliedAt: {
      type: Date,
    },
    outcome: {
      type: String,
      trim: true,
    },
    connections: {
      type: [ConnectionSchema],
      default: [],
    },
  },
  {
    timestamps: true,
  }
);

// Compound unique: one tracker entry per user per event
TrackerEntrySchema.index({ userId: 1, eventId: 1 }, { unique: true });
// Index for efficient querying
TrackerEntrySchema.index({ userId: 1, status: 1 });
TrackerEntrySchema.index({ updatedAt: -1 });
TrackerEntrySchema.index({ 'connections.followUpAt': 1 });

const TrackerEntry: Model<ITrackerEntry> =
  mongoose.models.TrackerEntry || mongoose.model<ITrackerEntry>('TrackerEntry', TrackerEntrySchema);

export default TrackerEntry;

// Made with Bob