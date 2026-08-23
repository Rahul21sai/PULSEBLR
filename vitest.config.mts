import { defineConfig } from 'vitest/config';
import path from 'node:path';

/**
 * Test config.
 *
 * Scope is deliberate: PURE functions only — scoring, dedup keys, the taxonomy, the search
 * filter, the SSRF guard. Those are where a silent regression does real damage and where a
 * test is worth more than it costs. Nothing here touches MongoDB or the network; the
 * `scripts/diag-*.ts` suite already covers live behaviour against a real database and a
 * real server, and duplicating that in unit tests would only produce slow, flaky copies.
 *
 * `@` resolves the same way tsconfig does so tests import exactly what the app imports.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // A pure-function suite that takes longer than this has hit a real problem.
    testTimeout: 5000,
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, '.') },
  },
});
