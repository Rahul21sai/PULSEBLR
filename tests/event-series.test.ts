import { describe, it, expect } from 'vitest';
import { groupSeries, seriesKey } from '@/lib/events/series';

const ev = (id: string, title: string, date: string, organizer = 'BangPypers') => ({
  _id: id,
  title,
  organizer,
  startDateTime: `${date}T05:00:00.000Z`,
});

describe('groupSeries — a monthly meetup is one row', () => {
  it('collapses the measured case: four Python Meetups become one group of four dates', () => {
    const feed = [
      ev('airflow', 'Bangalore Apache Airflow Meetup', '2026-10-07', 'Uber'),
      ev('py-nov', 'Python Meetup', '2026-11-21'),
      ev('py-dec', 'Python Meetup', '2026-12-19'),
      ev('techx', 'TechX-AI Conference 2026', '2026-10-24', 'Microsoft'),
      ev('py-jan', 'Python Meetup', '2027-01-16'),
      ev('py-feb', 'Python Meetup', '2027-02-20'),
    ];
    const groups = groupSeries(feed);
    expect(groups.map(g => g.lead._id)).toEqual(['airflow', 'py-nov', 'techx']);
    expect(groups[1].later.map(e => e._id)).toEqual(['py-dec', 'py-jan', 'py-feb']);
  });

  it('keeps the group where its FIRST member ranked, but leads with the SOONEST date', () => {
    const groups = groupSeries([
      ev('a', 'Other', '2026-10-01', 'X'),
      ev('late', 'Python Meetup', '2027-01-16'),
      ev('b', 'Another', '2026-10-02', 'Y'),
      ev('soon', 'Python Meetup', '2026-11-21'),
    ]);
    expect(groups.map(g => g.lead._id)).toEqual(['a', 'soon', 'b']);
    expect(groups[1].later.map(e => e._id)).toEqual(['late']);
  });

  it('does NOT merge two hosts that run a same-named event', () => {
    const groups = groupSeries([
      ev('pypers', 'Python Meetup', '2026-11-21', 'BangPypers'),
      ev('other', 'Python Meetup', '2026-11-22', 'PyData Bengaluru'),
    ]);
    expect(groups).toHaveLength(2);
  });

  it('keeps numbered editions distinct', () => {
    expect(groupSeries([ev('a', 'React Meetup #107', '2026-10-01'), ev('b', 'React Meetup #108', '2026-11-01')])).toHaveLength(2);
  });

  it('treats city words, punctuation and case as the same series', () => {
    expect(seriesKey(ev('a', 'Python Meetup – Bangalore!', '2026-10-01'))).toBe(seriesKey(ev('b', 'python meetup', '2026-11-01')));
  });

  it('loses nothing: every input event is a lead or a later date exactly once', () => {
    const feed = [
      ev('1', 'A', '2026-10-01'), ev('2', 'A', '2026-11-01'), ev('3', 'B', '2026-10-05'),
      ev('4', 'A', '2026-12-01'), ev('5', 'C', '2026-10-09'),
    ];
    const out = groupSeries(feed).flatMap(g => [g.lead, ...g.later]).map(e => e._id).sort();
    expect(out).toEqual(['1', '2', '3', '4', '5']);
  });

  it('a one-off event is a group with no later dates', () => {
    expect(groupSeries([ev('x', 'Solo', '2026-10-01')])[0].later).toEqual([]);
  });
});
