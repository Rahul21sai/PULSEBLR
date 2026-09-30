import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { startTimeKnown } from '@/lib/events/time-known';
import { formatPushPayload } from '@/lib/notifications/reminder-policy';

/** GIDS rendered "27 Apr 05:30" from a developers.events DATE stored as midnight UTC. */
describe('startTimeKnown', () => {
  it('a developers.events midnight-UTC start is not a real time', () => {
    expect(startTimeKnown({ source: 'devevents', startDateTime: '2027-04-27T00:00:00.000Z' })).toBe(false);
  });

  it('the same source with a precise time (upgraded at ingest) is real', () => {
    expect(startTimeKnown({ source: 'devevents', startDateTime: '2027-04-27T04:30:00.000Z' })).toBe(true);
  });

  it('midnight UTC from a source that publishes times is real (a 05:30 IST meetup is possible)', () => {
    expect(startTimeKnown({ source: 'meetup', startDateTime: '2026-10-10T00:00:00.000Z' })).toBe(true);
  });

  it('a missing source is treated as a real time', () => {
    expect(startTimeKnown({ startDateTime: '2026-10-10T00:00:00.000Z' })).toBe(true);
  });

  it('every place that prints a start time asks first', () => {
    for (const file of [
      'app/components/EventRow.tsx',
      'app/components/EventGridCard.tsx',
      'app/calendar/page.tsx',
      'app/events/[id]/page.tsx',
      // Both ICS producers: a date-only start is written as an all-day DATE, never as 05:30.
      'lib/calendar/ics.ts',
      // Everything that sends a start time out of the app: reminder email and push, the digest,
      // the assistant (MCP) rows, and the share image.
      'lib/notifications/reminder-policy.ts',
      'lib/notifications/digest-schedule.ts',
      'lib/mcp/serialize.ts',
      'app/events/[id]/opengraph-image.tsx',
    ]) {
      const source = readFileSync(path.join(process.cwd(), file), 'utf8');
      expect(source, file).toMatch(/startTimeKnown\(/);
    }
  });
});

describe('a date-only event in a reminder', () => {
  const now = new Date('2027-04-26T02:30:00.000Z');
  const base = { id: 'e', title: 'GIDS', startDateTime: '2027-04-27T00:00:00.000Z', city: 'Bengaluru' };

  it('the push says Time TBA, not an invented 05:30', () => {
    const body = formatPushPayload({ ...base, source: 'devevents' }, now).body;
    expect(body).toContain('Time TBA');
    expect(body).not.toContain('05:30');
  });

  it('a real midnight-UTC start from another source still prints its time (control)', () => {
    expect(formatPushPayload({ ...base, source: 'meetup' }, now).body).toContain('05:30');
  });
});
