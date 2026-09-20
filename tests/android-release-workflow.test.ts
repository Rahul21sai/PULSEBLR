import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');
const validator = path.join(root, 'scripts', 'validate-android-release-workflow.mjs');

describe('Android protected release workflow boundary', () => {
  it('rejects a protected signer that parses untrusted AAB data or trusts ambient Java state before signing', () => {
    const result = spawnSync(process.execPath, [validator], {
      cwd: root,
      encoding: 'utf8',
    });

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  });
});
