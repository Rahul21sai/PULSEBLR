import { describe, expect, it } from 'vitest';
import ScanPage from '../app/scan/page';

describe('release route markers', () => {
  it('keeps the scan marker outside its Suspense boundary so prerendered HTML exposes it', () => {
    const page = ScanPage();

    expect(page.props).toEqual(expect.objectContaining({
      'data-pulseblr-route': 'scan',
      className: 'contents',
    }));
  });
});
