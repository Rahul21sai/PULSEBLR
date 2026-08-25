/**
 * `looksLikeBusinessGathering()` — the title veto that keeps sales events out of the tech feed.
 *
 * WHY IT EXISTS. `TECH_CATEGORIES` includes `Hackathon` because a hackathon with no stated topic is
 * legitimately tech. But `Hackathon` is a gathering TYPE, not a subject, so the keyword floor
 * flagged "GTM Buildathon | BLR" as an engineering event on the strength of "buildathon" alone.
 * Three more reached the tech feed through the LLM, which sets `isTechEvent` independently of the
 * categories it returns: "Business Referral Circle", "Bengaluru Pitch Circuit 9" and
 * "HackerX — Employer Ticket".
 *
 * THE NEGATIVE HALF IS THE IMPORTANT HALF, and it is why this file is mostly negative cases. A
 * false positive here does not mis-tag an event, it REMOVES a real engineering event from the
 * default feed — and because the feed defaults to `techOnly`, the event becomes invisible rather
 * than merely mis-filed. No aggregate precision number reveals that; only naming the events that
 * must survive does.
 */
import { describe, it, expect } from 'vitest';
import { looksLikeBusinessGathering, keywordTagging } from '../lib/llm/tagger';

describe('vetoes the business gatherings that actually leaked', () => {
  // Each of these was measured in the live corpus carrying isTechEvent: true.
  const leaked = [
    'GTM Buildathon | BLR',
    'Business Referral Circle | Every Founder Deserves The Right Network',
    'Bengaluru Pitch Circuit 9',
    'HackerX - Bengaluru - Employer Ticket - 11/26',
  ];

  for (const title of leaked) {
    it(`vetoes “${title}”`, () => {
      expect(looksLikeBusinessGathering(title)).toBe(true);
    });
  }

  it('vetoes the other named forms', () => {
    for (const title of [
      'Go-To-Market Masterclass for SaaS',
      'Go to Market Strategy Night',
      'Network Marketing Opportunity Meet',
      'MLM Success Summit Bengaluru',
      'Annual Sales Kickoff 2026',
      'Recruiter Ticket — Bengaluru Hiring Day',
      'Startup Pitch Night at Church Street',
      'Founder Pitch Day — Cohort 4',
    ]) {
      expect(looksLikeBusinessGathering(title)).toBe(true);
    }
  });
});

describe('MUST NOT veto — real engineering events that use the same words', () => {
  it('spares a talk that merely contains the word pitch', () => {
    // `pitch` is anchored to circuit/night/day precisely so these survive.
    expect(looksLikeBusinessGathering('Pitch your API to 100 developers')).toBe(false);
    expect(looksLikeBusinessGathering('Pitch Perfect: Demoing Your Side Project')).toBe(false);
    expect(looksLikeBusinessGathering('Audio Pitch Detection with WebAudio')).toBe(false);
  });

  it('spares real hackathons and buildathons', () => {
    for (const title of [
      'The Great Agent Hackathon',
      'IndiaFOSS Buildathon',
      'Databricks Campus Hackathon (BMSCE Edition)',
      'WeAreDevelopers AI Hackathon',
    ]) {
      expect(looksLikeBusinessGathering(title)).toBe(false);
    }
  });

  it('spares proptech, which is why "real estate" is NOT in the veto', () => {
    // A proptech hackathon is genuinely engineering. The LLM prompt already refuses real-estate
    // INVESTING pitches, so vetoing the phrase here would delete the legitimate case.
    expect(looksLikeBusinessGathering('PropTech Hackathon: Real Estate Data at Scale')).toBe(false);
  });

  it('spares hiring and career events that are not employer-only tickets', () => {
    expect(looksLikeBusinessGathering('Engineering Hiring Fair — Candidate Entry')).toBe(false);
    expect(looksLikeBusinessGathering('How to hire your first backend engineer')).toBe(false);
    expect(looksLikeBusinessGathering('Employer Branding for Engineering Teams')).toBe(false);
  });

  it('spares ordinary technical titles', () => {
    for (const title of [
      'Kubernetes Bengaluru Meetup #42',
      'RISC-V and Verilog: Tapeout Stories',
      'Open Source India 2026',
      'Building AI Agents with Amazon Bedrock',
      'Networking Deep Dive: BGP for Backend Engineers', // "networking" alone must not fire
    ]) {
      expect(looksLikeBusinessGathering(title)).toBe(false);
    }
  });

  it('handles absent input', () => {
    expect(looksLikeBusinessGathering(null)).toBe(false);
    expect(looksLikeBusinessGathering(undefined)).toBe(false);
    expect(looksLikeBusinessGathering('')).toBe(false);
  });
});

describe('the veto is wired into keywordTagging, not just exported', () => {
  const base = { description: '', venue: 'Bengaluru' };

  it('turns isTechEvent OFF for a business buildathon', () => {
    // Without the veto this is tech: "buildathon" matches the Hackathon pattern, and
    // TECH_CATEGORIES contains Hackathon.
    const result = keywordTagging({ ...base, title: 'GTM Buildathon | BLR' });
    expect(result.isTechEvent).toBe(false);
  });

  it('leaves a real hackathon ON', () => {
    const result = keywordTagging({ ...base, title: 'The Great Agent Hackathon' });
    expect(result.isTechEvent).toBe(true);
  });

  it('only ever turns the flag off, never on', () => {
    // A vetoed title with no tech category was already false and must stay false — the veto is not
    // a second classifier.
    const result = keywordTagging({ ...base, title: 'Business Referral Circle' });
    expect(result.isTechEvent).toBe(false);
  });
});
