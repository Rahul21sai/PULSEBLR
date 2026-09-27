import { describe, it, expect } from 'vitest';
import { displayOrganizer } from '@/lib/events/organizer-display';

/** The real strings, from the default feed on 2026-09-27. */
describe('displayOrganizer — Meetup slugs read as names', () => {
  it.each([
    ['iasa india software architecture meetup', 'IASA India Software Architecture Meetup'],
    ['ai blr', 'AI BLR'],
    ['lfdt bengaluru', 'LFDT Bengaluru'],
    ['agile chapter bengaluru', 'Agile Chapter Bengaluru'],
    ['bangalore cmmi audits meetup group', 'Bangalore CMMI Audits Meetup Group'],
    ['communication and leadership mastery club', 'Communication and Leadership Mastery Club'],
    ['microsoft azure bangalore', 'Microsoft Azure Bangalore'],
    ['security in devops', 'Security in DevOps'],
    ['bangalore ai machine learning data science', 'Bangalore AI Machine Learning Data Science'],
    ['indiamongodb', 'Indiamongodb'],
  ])('%s → %s', (raw, shown) => {
    expect(displayOrganizer(raw)).toBe(shown);
  });

  it('unwraps a Meetup calendar title to the group name', () => {
    expect(displayOrganizer('Events - BangPypers - Bangalore Python Users Group')).toBe('BangPypers');
    expect(displayOrganizer('Events – bangpypers')).toBe('Bangpypers');
  });

  it.each(['BagOfAI Meetups', 'flutterCon India 2026', 'gRPConf India', 'Bangalore Java User Group (Bangalore JUG)', 'GDG Bangalore', 'The Fifth Elephant'])(
    'leaves a name a person wrote exactly as written: %s',
    name => {
      expect(displayOrganizer(name)).toBe(name);
    }
  );

  it('a small word is capitalised when it starts the name', () => {
    expect(displayOrganizer('the product folks')).toBe('The Product Folks');
  });

  it('never invents a name: empty in, empty out; a lone "Events -" is kept', () => {
    expect(displayOrganizer(undefined)).toBe('');
    expect(displayOrganizer('   ')).toBe('');
    expect(displayOrganizer('Events Team')).toBe('Events Team');
  });

  it('does not touch a name with no letters to case', () => {
    expect(displayOrganizer('42')).toBe('42');
  });
});
