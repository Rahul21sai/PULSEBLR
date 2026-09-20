import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');
const validator = path.join(root, 'scripts', 'validate-android-release-workflow.mjs');
const fixture = path.join(root, 'tests', 'fixtures', 'android-release-workflow', 'legacy-protected-signer.yml');
const temporaryDirectories: string[] = [];

function fixtureRoot(releaseWorkflow: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'pulseblr-android-release-workflow-'));
  temporaryDirectories.push(directory);
  cpSync(path.join(root, '.github'), path.join(directory, '.github'), { recursive: true });
  writeFileSync(path.join(directory, '.github', 'workflows', 'android-release.yml'), releaseWorkflow);
  return directory;
}

function runValidator(releaseWorkflow: string) {
  return spawnSync(process.execPath, [validator, '--root', fixtureRoot(releaseWorkflow)], {
    cwd: root,
    encoding: 'utf8',
  });
}

function expectRejected(releaseWorkflow: string, diagnostic: string): void {
  const result = runValidator(releaseWorkflow);
  const output = `${result.stdout}${result.stderr}`;
  expect(result.status, output).toBe(1);
  expect(output).toContain(diagnostic);
}

function currentReleaseWorkflow(): string {
  return readFileSync(path.join(root, '.github', 'workflows', 'android-release.yml'), 'utf8');
}

function mutate(source: string, before: string, after: string): string {
  expect(source).toContain(before);
  return source.replace(before, after);
}

function mutateSignedManifestValidation(source: string, before: string, after: string): string {
  const marker = '      - name: Validate signed release AAB';
  const markerIndex = source.indexOf(marker);
  expect(markerIndex).toBeGreaterThanOrEqual(0);
  const prefix = source.slice(0, markerIndex);
  return `${prefix}${mutate(source.slice(markerIndex), before, after)}`;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Android protected release workflow boundary', () => {
  it('accepts the canonical protected release workflow', () => {
    const result = runValidator(currentReleaseWorkflow());
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  });

  it('rejects the legacy protected signer that parses an untrusted AAB and trusts ambient Java state', () => {
    expectRejected(
      readFileSync(fixture, 'utf8'),
      'protected signer must not parse untrusted AAB data before secrets: Download and hash Bundletool 1.18.3, Inspect untrusted unsigned AAB before signing secrets',
    );
    expectRejected(
      readFileSync(fixture, 'utf8'),
      'protected signing step must not resolve Java tools from ambient JAVA_HOME, PATH, GITHUB_ENV, or GITHUB_PATH',
    );
  });

  it('rejects a signing secret expression outside the one secret-bearing step env', () => {
    expectRejected(
      mutate(
        currentReleaseWorkflow(),
        '          if-no-files-found: error\n          path: ${{ runner.temp }}/app-release-signed.aab',
        '          if-no-files-found: error\n          retention-days: ${{ secrets.ANDROID_UPLOAD_KEY_PASSWORD }}\n          path: ${{ runner.temp }}/app-release-signed.aab',
      ),
      'signed-aab must keep signing secrets in exactly one step-scoped signing step',
    );
  });

  it('rejects an unallowlisted action in the protected signer', () => {
    expectRejected(
      mutate(
        currentReleaseWorkflow(),
        '      - name: Remove temporary signing material',
        '      - name: Inject unallowlisted signer action\n        uses: actions/cache@d4323d4df104b026a6aa633f5c1c26ad4b2b8b74 # v4.2.3\n\n      - name: Remove temporary signing material',
      ),
      'signed-aab contains an unallowlisted action or step: Inject unallowlisted signer action',
    );
  });

  it('rejects an unallowlisted command step in the protected signer', () => {
    expectRejected(
      mutate(
        currentReleaseWorkflow(),
        '      - name: Remove temporary signing material',
        '      - name: Inject unallowlisted signer command\n        shell: bash\n        run: /usr/bin/true\n\n      - name: Remove temporary signing material',
      ),
      'signed-aab contains an unallowlisted action or step: Inject unallowlisted signer command',
    );
  });

  it('rejects a verified artifact downloaded to the wrong protected-runner path', () => {
    expectRejected(
      mutate(
        currentReleaseWorkflow(),
        '          path: ${{ runner.temp }}/verified-unsigned-aab',
        '          path: ${{ runner.temp }}/unexpected-artifact-directory',
      ),
      'signed-aab must download the verified unsigned AAB artifact to ${{ runner.temp }}/verified-unsigned-aab',
    );
  });

  it('rejects a protected signer that reads a different identity file from the verified AAB', () => {
    expectRejected(
      mutate(
        currentReleaseWorkflow(),
        '          identity_file="$artifact_dir/verified-unsigned-aab.sha256"',
        '          identity_file="$artifact_dir/substituted-identity.sha256"',
      ),
      'signed-aab must validate the exact verified unsigned AAB identity-file semantics before signing',
    );
  });

  it('rejects a version validator with a reduced release-code bound', () => {
    expectRejected(
      mutate(currentReleaseWorkflow(), 'max_version_code=2100000000', 'max_version_code=210000000'),
      'every version-code validation step must enforce integer range 1..2100000000',
    );
  });

  it('rejects final manifest validation without the requested version code', () => {
    expectRejected(
      mutateSignedManifestValidation(
        currentReleaseWorkflow(),
        '"android:versionCode=\\"$VERSION_CODE\\""',
        '"android:versionCode=\\"999\\""',
      ),
      'verify-signed-aab must validate final manifest versionCode against the requested VERSION_CODE',
    );
  });

  it('rejects final manifest validation with the wrong permanent version name', () => {
    expectRejected(
      mutateSignedManifestValidation(
        currentReleaseWorkflow(),
        "'android:versionName=\"1\"'",
        "'android:versionName=\"2\"'",
      ),
      'verify-signed-aab must validate final manifest versionName "1"',
    );
  });
});
