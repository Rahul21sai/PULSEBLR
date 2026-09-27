import { describe, expect, it } from 'vitest';
import { describePushTestOutcome } from '../app/settings/PushSection';

/**
 * What the Settings "Send a test notification" button tells somebody. The route answers 200 for
 * every ATTEMPT, so `res.ok` is not success; these pin that a zero-delivery 200 is reported as a
 * failure, and that a dead subscription is flagged so the browser's local copy gets dropped.
 */
describe('describePushTestOutcome', () => {
  it('reports success only when a push service accepted it', () => {
    expect(describePushTestOutcome(200, { sent: 1, failed: 0, pruned: 0 }, null).tone).toBe('ok');
  });

  it('treats a 200 that reached nothing as a failure, not a success', () => {
    const outcome = describePushTestOutcome(200, { sent: 0, failed: 1, pruned: 0 }, null);
    expect(outcome.tone).toBe('error');
    expect(outcome.deviceGone).toBeUndefined();
  });

  it('flags an expired subscription so the dead local copy is dropped', () => {
    const outcome = describePushTestOutcome(200, { sent: 0, failed: 0, pruned: 1 }, null);
    expect(outcome).toMatchObject({ tone: 'warn', deviceGone: true });
  });

  it('does not call a mixed failure "expired" when a live device also failed', () => {
    expect(describePushTestOutcome(200, { sent: 0, failed: 1, pruned: 1 }, null).deviceGone).toBeUndefined();
  });

  it('flags a 404 (the server no longer has this device) the same way', () => {
    expect(describePushTestOutcome(404, { error: 'x' }, null).deviceGone).toBe(true);
  });

  it('quotes Retry-After on a 429, and survives a missing one', () => {
    expect(describePushTestOutcome(429, null, '17').text).toContain('17 seconds');
    expect(describePushTestOutcome(429, null, null).text).toMatch(/wait a moment/i);
  });

  it('says the server is not set up on a 503', () => {
    expect(describePushTestOutcome(503, { error: 'x' }, null).text).toMatch(/not fully set up/i);
  });

  it('never reports success for a 200 without counts', () => {
    expect(describePushTestOutcome(200, null, null).tone).toBe('error');
  });
});
