import { describe, it, expect } from 'vitest';
import { resolveCompanies } from '@/lib/companies/resolve';

/**
 * Company attribution is the feature most prone to silently producing garbage, because a
 * wrong answer looks exactly like a right one until someone reads it. The registry's whole
 * design — `strength: 'distinctive' | 'ambiguous'`, no description matching — exists
 * because naive matching once reported "Intel" 37 times by matching *intel*ligence, "CRED"
 * 31 times through *cred*entials, and "SAP" 157 times.
 *
 * These pin the rules that were arrived at by measurement, so the next well-meaning
 * loosening has to argue with a failing test.
 */
describe('resolveCompanies — organiser', () => {
  it('attributes on the organiser field, the strongest signal', () => {
    expect(resolveCompanies({ organizer: 'Razorpay Rize' })).toContain('Razorpay');
  });

  it('returns nothing rather than guessing', () => {
    // The honest answer for the many community events no company runs.
    expect(resolveCompanies({ organizer: 'Bangalore Weekend Hangout', title: 'Board games' })).toEqual([]);
  });
});

describe('resolveCompanies — the ambiguity guard', () => {
  it('does not match an ambiguous name inside a longer word', () => {
    // The original sin: "Intel" inside "intelligence".
    expect(resolveCompanies({ organizer: 'Artificial Intelligence Meetup' })).not.toContain('Intel');
    expect(resolveCompanies({ title: 'Credentials workshop' })).not.toContain('CRED');
  });

  it('keeps ambiguous names out of the title', () => {
    // Ambiguous names are organiser/tags only — a title mention is not evidence of hosting.
    expect(resolveCompanies({ title: 'Meta-learning for beginners' })).not.toContain('Meta');
  });

  it('never matches the description, however tempting', () => {
    // Measured: description matching attributed a LeetCode meetup and a boardgames night to
    // Google, because their descriptions said "Google Form" and "Google Maps link".
    expect(
      resolveCompanies({
        title: 'Central Bangalore BoardGames',
        organizer: 'HSR Meetups',
        description: 'RSVP via Google Form. Location on Google Maps.',
      })
    ).toEqual([]);
  });
});

describe('resolveCompanies — the venue rule', () => {
  it('attributes an event held at a company office', () => {
    // A company lending its office is involved — the ordinary meaning of hosting, and the
    // relationship the product is asked to surface.
    expect(resolveCompanies({ venue: 'Microsoft Reactor Bengaluru', title: 'FDE talk' })).toContain('Microsoft');
    expect(resolveCompanies({ venue: 'Google RMZ Infinity, Sadanandanagar' })).toContain('Google');
    expect(resolveCompanies({ venue: 'Nokia L5 Manyata Business Park' })).toContain('Nokia');
    expect(resolveCompanies({ venue: 'CESSNA BUSINESS PARK CISCO' })).toContain('Cisco');
  });

  it('matches the company NAME only, never a product alias', () => {
    // THE REGRESSION THIS FILE EXISTS FOR. "District Arena @ Terraform" is a Bengaluru
    // CONCERT VENUE. Matching HashiCorp's "Terraform" alias against it attributed a Gorillaz
    // show and an orchestral Qawwali project to HashiCorp. Buildings are named after
    // companies, not their products: an office is "HashiCorp Bengaluru", never "Terraform".
    const concert = resolveCompanies({
      venue: 'District Arena @ Terraform',
      title: 'Gorillaz The Mountain Tour 2027',
      organizer: 'Momentum',
    });
    expect(concert).not.toContain('HashiCorp');
    expect(concert).toEqual([]);

    // The alias must still work where it IS evidence — an explicit organiser claim.
    expect(resolveCompanies({ organizer: 'HashiCorp User Group' })).toContain('HashiCorp');
  });

  it('keeps ambiguous names out of the venue', () => {
    // A mall or an address sharing a word with a registry entry is a coincidence, not a host.
    expect(resolveCompanies({ venue: 'Phoenix Marketcity, Whitefield' })).not.toContain('Target');
    expect(resolveCompanies({ venue: 'Apple Tree Cafe, Indiranagar' })).not.toContain('Apple');
  });

  it('ranks an organiser above a venue when they disagree', () => {
    // Both are real signals, but the organiser field is an explicit claim while a venue is
    // circumstantial, so the organiser must sort first.
    const names = resolveCompanies({
      organizer: 'Razorpay Rize',
      venue: 'Microsoft Reactor Bengaluru',
    });
    expect(names[0]).toBe('Razorpay');
    expect(names).toContain('Microsoft');
  });
});
