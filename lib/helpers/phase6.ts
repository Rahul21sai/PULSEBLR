import connectDB from '../mongodb';
import TrackerEntry from '../models/TrackerEntry';
import Event from '../models/Event';
import mongoose from 'mongoose';

/**
 * Get all connections with pending follow-ups
 */
export async function getPendingFollowUps(userId: string) {
  await connectDB();
  
  const now = new Date();
  
  const entries = await TrackerEntry.find({
    userId,
    'connections.followUpAt': { $lte: now },
    'connections.followedUp': { $ne: true },
  }).populate('eventId');
  
  const pendingFollowUps: any[] = [];
  
  for (const entry of entries) {
    for (const connection of entry.connections) {
      if (
        connection.followUpAt &&
        connection.followUpAt <= now &&
        !connection.followedUp
      ) {
        pendingFollowUps.push({
          eventId: entry.eventId,
          eventTitle: (entry.eventId as any).title,
          connection,
          trackerEntryId: entry._id,
        });
      }
    }
  }
  
  return pendingFollowUps;
}

/**
 * Mark a follow-up as completed
 */
export async function markFollowUpComplete(
  trackerEntryId: string,
  connectionName: string,
  userId: string
) {
  await connectDB();
  
  const entry = await TrackerEntry.findOne({ _id: trackerEntryId, userId });
  if (!entry) throw new Error('Tracker entry not found');
  
  const connection = entry.connections.find(c => c.name === connectionName);
  if (!connection) throw new Error('Connection not found');
  
  connection.followedUp = true;
  await entry.save();
  
  return entry;
}

/**
 * Detect repeat connections across events
 * Returns connections that appear in multiple events
 */
export async function detectRepeatConnections(userId: string) {
  await connectDB();
  
  const entries = await TrackerEntry.find({
    userId,
    'connections.0': { $exists: true },
  }).populate('eventId');
  
  // Build a map of connection names to events they appeared at
  const connectionMap = new Map<string, Set<string>>();
  const connectionDetails = new Map<string, any>();
  
  for (const entry of entries) {
    for (const connection of entry.connections) {
      const key = connection.name.toLowerCase().trim();
      
      if (!connectionMap.has(key)) {
        connectionMap.set(key, new Set());
        connectionDetails.set(key, connection);
      }
      
      connectionMap.get(key)!.add(entry.eventId.toString());
    }
  }
  
  // Filter to only repeat connections (appeared at 2+ events)
  const repeatConnections: any[] = [];
  
  for (const [name, eventIds] of connectionMap.entries()) {
    if (eventIds.size >= 2) {
      repeatConnections.push({
        name,
        details: connectionDetails.get(name),
        eventCount: eventIds.size,
        eventIds: Array.from(eventIds),
      });
    }
  }
  
  return repeatConnections.sort((a, b) => b.eventCount - a.eventCount);
}

/**
 * Target company list management
 */
const DEFAULT_TARGET_COMPANIES = [
  'JPMorgan',
  'Goldman Sachs',
  'Visa',
  'Salesforce',
  'Shell',
  'AMD',
  'Google',
  'Microsoft',
  'Amazon',
  'Meta',
  'Apple',
  'Netflix',
  'Uber',
  'Airbnb',
  'Stripe',
];

export function getTargetCompanies(): string[] {
  // In a real app, this would be stored in user settings/database
  // For now, return default list
  return DEFAULT_TARGET_COMPANIES;
}

export function addTargetCompany(company: string): string[] {
  // In a real app, this would update user settings/database
  const companies = getTargetCompanies();
  if (!companies.includes(company)) {
    companies.push(company);
  }
  return companies;
}

export function removeTargetCompany(company: string): string[] {
  // In a real app, this would update user settings/database
  const companies = getTargetCompanies();
  return companies.filter(c => c !== company);
}

/**
 * Check if an event is from a target company
 */
export function isTargetCompanyEvent(
  organizer: string | undefined,
  description: string
): boolean {
  if (!organizer && !description) return false;
  
  const targetCompanies = getTargetCompanies();
  const searchText = `${organizer || ''} ${description}`.toLowerCase();
  
  return targetCompanies.some(company =>
    searchText.includes(company.toLowerCase())
  );
}

/**
 * Check if event description mentions recruiter/talent team
 */
export function hasRecruiterMention(description: string): boolean {
  const recruiterKeywords = [
    'recruiter',
    'recruitment',
    'talent',
    'hiring',
    'careers',
    'job',
    'opportunity',
    'hr team',
    'human resources',
  ];
  
  const lowerDesc = description.toLowerCase();
  return recruiterKeywords.some(keyword => lowerDesc.includes(keyword));
}

/**
 * Get stats for dashboard
 */
export async function getStats(userId: string) {
  await connectDB();
  
  const now = new Date();
  const thisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  
  const [
    totalEvents,
    eventsThisMonth,
    trackedEvents,
    attendedEvents,
    totalConnections,
    pendingFollowUps,
    targetCompanyEvents,
  ] = await Promise.all([
    Event.countDocuments(),
    Event.countDocuments({ createdAt: { $gte: thisMonth } }),
    TrackerEntry.countDocuments({ userId }),
    TrackerEntry.countDocuments({ userId, status: 'Attended' }),
    TrackerEntry.aggregate([
      { $match: { userId } },
      { $unwind: '$connections' },
      { $count: 'total' },
    ]).then(res => res[0]?.total || 0),
    getPendingFollowUps(userId).then(f => f.length),
    Event.countDocuments({ isTargetCompany: true }),
  ]);
  
  return {
    totalEvents,
    eventsThisMonth,
    trackedEvents,
    attendedEvents,
    totalConnections,
    pendingFollowUps,
    targetCompanyEvents,
  };
}

// Made with Bob
