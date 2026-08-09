// The event shape the client actually receives from /api/events.
//
// Dates arrive as ISO strings over JSON, which is why every date field is typed
// `string` here rather than `Date` — typing them as Date would compile but every
// `.getTime()` at runtime would throw.

export interface FeedEvent {
  _id: string;
  title: string;
  description?: string;
  source: string;
  sourceUrl: string;
  slug?: string;
  organizer?: string;
  hostAvatarUrl?: string;
  category: string[];
  tags?: string[];
  format: 'online' | 'offline' | 'hybrid';
  hasFood: 'yes' | 'no' | 'unknown';
  isFree: boolean;
  price?: number;
  priceMax?: number;
  currency?: string;
  soldOut?: boolean;
  venue?: string;
  address?: string;
  area?: string;
  city?: string;
  lat?: number;
  lng?: number;
  onlineLink?: string;
  imageUrl?: string;
  startDateTime: string;
  endDateTime?: string;
  timezone?: string;
  applyLink?: string;
  registrationDeadline?: string;
  attendeeCount?: number;
  capacity?: number;
  companies?: string[];
  isTechEvent?: boolean;
  isTargetCompany?: boolean;
  recruiterMentioned?: boolean;
  seenInSources?: string[];
  createdAt?: string;
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  pages: number;
  hasMore: boolean;
}

export interface Facets {
  categories: Record<string, number>;
  areas: Record<string, number>;
  sources: Record<string, number>;
  formats: Record<string, number>;
  companies: Record<string, number>;
  totals: { total: number; free: number; withFood: number; tech: number };
}
