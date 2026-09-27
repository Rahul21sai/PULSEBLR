import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import sift from 'sift';
import { onePerSeries, relatedEventsFilter } from '@/lib/events/related';

/**
 * "Similar events" under an event page. Measured on 2026-09-27: under `RSI Research Mixer`
 * ([AI/ML, Open Source, Networking/Meetup]) the list was a comedy show, a Bollywood tribute and a
 * board-games night — all sharing only the GATHERING category `Networking/Meetup`, none tech. Run
 * against representative documents with `sift`, the matcher mongoose already pins.
 */
type Doc = Record<string, unknown>;
const matches = (filter: Doc) => sift(filter as unknown as Parameters<typeof sift>[0]);

const NOW = new Date('2026-09-27T06:00:00Z');
const soon = new Date('2026-09-28T13:30:00Z');
const past = new Date('2026-09-20T13:30:00Z');

const mixer = { _id: 'mixer', category: ['AI/ML', 'Open Source', 'Networking/Meetup'] };

const rows: Doc[] = [
  { _id: 'ai-meetup', title: 'LLM evals meetup', category: ['AI/ML', 'Networking/Meetup'], isTechEvent: true, startDateTime: soon },
  { _id: 'foss', title: 'FOSS night', category: ['Open Source'], isTechEvent: true, startDateTime: soon },
  { _id: 'comedy', title: 'Nearly Nice Guy', category: ['Networking/Meetup', 'Arts/Culture'], isTechEvent: false, startDateTime: soon },
  { _id: 'boardgames', title: 'Social Boardgames Night', category: ['Networking/Meetup'], isTechEvent: false, startDateTime: soon },
  // A tech event that shares only the GATHERING category is not "similar" to an AI mixer.
  { _id: 'devops-only', title: 'Kubernetes meetup', category: ['Cloud/DevOps', 'Networking/Meetup'], isTechEvent: true, startDateTime: soon },
  { _id: 'past-ai', title: 'Last week AI', category: ['AI/ML'], isTechEvent: true, startDateTime: past },
  { _id: 'mixer', title: 'RSI Research Mixer', category: mixer.category, isTechEvent: true, startDateTime: soon },
  { _id: 'private-ai', title: 'Someone else private', category: ['AI/ML'], isTechEvent: true, startDateTime: soon, visibility: 'private', createdByUserId: 'u_other' },
  { _id: 'deleted-ai', title: 'Removed', category: ['AI/ML'], isTechEvent: true, startDateTime: soon, deletedAt: past },
];

const ids = (filter: Doc) => rows.filter(matches(filter)).map(r => r._id);

describe('relatedEventsFilter', () => {
  it('matches tech events sharing a tech TOPIC, and nothing that shares only a gathering category', () => {
    expect(ids(relatedEventsFilter(mixer, null, NOW))).toEqual(['ai-meetup', 'foss']);
  });

  it('never returns a non-tech event, even one with an identical category list', () => {
    const concert = { _id: 'x', category: ['Networking/Meetup', 'Arts/Culture'] };
    const found = ids(relatedEventsFilter(concert, null, NOW));
    expect(found).not.toContain('comedy');
    expect(found).not.toContain('boardgames');
  });

  it('excludes the event itself, past events, other users’ private events and deleted events', () => {
    const found = ids(relatedEventsFilter(mixer, null, NOW));
    for (const id of ['mixer', 'past-ai', 'private-ai', 'deleted-ai']) expect(found).not.toContain(id);
  });

  it('shows the owner their own private event as a suggestion', () => {
    expect(ids(relatedEventsFilter(mixer, 'u_other', NOW))).toContain('private-ai');
  });

  it('falls back to the event’s own categories when it has no tech topic', () => {
    const hack = { _id: 'h', category: ['Hackathon'] };
    const hackRows: Doc[] = [
      { _id: 'other-hack', category: ['Hackathon'], isTechEvent: true, startDateTime: soon },
      { _id: 'ai', category: ['AI/ML'], isTechEvent: true, startDateTime: soon },
    ];
    expect(hackRows.filter(matches(relatedEventsFilter(hack, null, NOW))).map(r => r._id)).toEqual(['other-hack']);
  });

  it('with no categories at all, still returns tech events only', () => {
    const found = ids(relatedEventsFilter({ _id: 'bare', category: [] }, null, NOW));
    expect(found).toContain('ai-meetup');
    expect(found).not.toContain('comedy');
  });

  it('is the only "similar events" query: both call sites use it', () => {
    for (const file of ['app/events/[id]/page.tsx', 'app/api/events/[id]/route.ts']) {
      const source = readFileSync(path.join(process.cwd(), file), 'utf8');
      expect(source, file).toContain('relatedEventsFilter(');
      expect(source, file).not.toContain("'Networking/Meetup']");
      expect(source, file).toContain('.sort(RELATED_SORT)');
    }
  });
});

describe('onePerSeries — a monthly meetup is one suggestion, not four', () => {
  it('keeps the first row of each title, in order, up to the count', () => {
    const rows = [
      { title: 'RSI Research Mixer' },
      { title: 'Python Meetup' },
      { title: 'Python Meetup' },
      { title: 'python meetup!' },
      { title: 'Airflow Night' },
    ];
    expect(onePerSeries(rows, 6).map(r => r.title)).toEqual(['RSI Research Mixer', 'Python Meetup', 'Airflow Night']);
  });

  it('keeps numbered editions distinct (#107 and #108 are different events)', () => {
    const rows = [{ title: 'React Meetup #107' }, { title: 'React Meetup #108' }];
    expect(onePerSeries(rows, 6)).toHaveLength(2);
  });

  it('stops at the count', () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ title: `Event ${i}` }));
    expect(onePerSeries(rows, 6)).toHaveLength(6);
  });

  it('both call sites de-duplicate what they fetch', () => {
    for (const file of ['app/events/[id]/page.tsx', 'app/api/events/[id]/route.ts']) {
      const source = readFileSync(path.join(process.cwd(), file), 'utf8');
      expect(source, file).toContain('onePerSeries(');
      expect(source, file).toContain('.limit(RELATED_FETCH)');
    }
  });
});
