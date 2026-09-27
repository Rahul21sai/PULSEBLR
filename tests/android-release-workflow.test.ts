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

function runValidatorWithWorkflow(filename: string, workflow: string) {
  const directory = fixtureRoot(currentReleaseWorkflow());
  writeFileSync(path.join(directory, '.github', 'workflows', filename), workflow);
  return spawnSync(process.execPath, [validator, '--root', directory], {
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

function expectWorkflowRejected(filename: string, workflow: string, diagnostic: string): void {
  const result = runValidatorWithWorkflow(filename, workflow);
  const output = `${result.stdout}${result.stderr}`;
  expect(result.status, output).toBe(1);
  expect(output).toContain(diagnostic);
}

/**
 * Every mutation snippet in this file is LF, and so is the workflow GitHub actually parses:
 * git stores these files LF (`git ls-files --eol` reports `i/lf`). A Windows checkout under
 * `core.autocrlf=true` writes them to disk as CRLF (`w/crlf`), and a snippet spanning a line
 * break then cannot match. That broke two tests at once, differently: `mutate()` failed its
 * `toContain` on the signing-secret test, while `missingOriginalDigestViolation` (which then
 * returned its input when the snippet was absent) handed the validator an unmutated workflow
 * and failed as a baffling "validation: PASS". Normalise where workflow text enters, so
 * every checkout tests the bytes GitHub sees.
 */
function readWorkflowText(file: string): string {
  return readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

function currentReleaseWorkflow(): string {
  return readWorkflowText(path.join(root, '.github', 'workflows', 'android-release.yml'));
}

function occurrences(source: string, snippet: string): number {
  return source.split(snippet).length - 1;
}

function indexOfOnly(source: string, marker: string): number {
  expect(occurrences(source, marker), `marker must occur exactly once: ${JSON.stringify(marker)}`).toBe(1);
  return source.indexOf(marker);
}

/**
 * Apply one mutation and prove it landed where it was aimed. A snippet that has drifted from
 * the workflow must fail HERE, naming the snippet, instead of passing the validator an
 * unmutated workflow — so no helper may fall back to returning its input. A snippet must also
 * name exactly ONE place, or the mutation silently lands on whichever occurrence comes first.
 * Spliced by index rather than `String#replace`, which would expand `$&`, `$'` and friends in
 * a replacement written as shell text.
 */
function mutate(source: string, before: string, after: string): string {
  expect(source.includes('\r'), 'mutate() needs LF text: read workflows through readWorkflowText()').toBe(false);
  expect(source).toContain(before);
  expect(after, 'a mutation must change the workflow').not.toBe(before);
  const index = indexOfOnly(source, before);
  return `${source.slice(0, index)}${after}${source.slice(index + before.length)}`;
}

function mutateSignedManifestValidation(source: string, before: string, after: string): string {
  const markerIndex = indexOfOnly(source, '      - name: Validate signed release AAB');
  return `${source.slice(0, markerIndex)}${mutate(source.slice(markerIndex), before, after)}`;
}

function mutateJob(source: string, start: string, end: string, before: string, after: string): string {
  const startIndex = indexOfOnly(source, start);
  const endIndex = indexOfOnly(source, end);
  expect(endIndex).toBeGreaterThan(startIndex);
  return `${source.slice(0, startIndex)}${mutate(source.slice(startIndex, endIndex), before, after)}${source.slice(endIndex)}`;
}

function parserRepublishViolation(source: string): string {
  return mutate(source, '\n  signed-aab:', `
      - name: Upload parser-rewritten unsigned AAB
        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2
        with:
          name: android-release-parser-substitute-\${{ inputs.version_code }}
          path: \${{ runner.temp }}/parser-substitute.aab

  signed-aab:`);
}

function missingOriginalDigestViolation(source: string): string {
  return mutateJob(
    source,
    '  unsigned-aab:',
    '  verify-unsigned-aab:',
    `          path: |
            \${{ runner.temp }}/app-release-unsigned.aab
            \${{ runner.temp }}/app-release-unsigned.aab.sha256`,
    '          path: ${{ runner.temp }}/app-release-unsigned.aab',
  );
}

function substitutedSignerArtifactViolation(source: string): string {
  return mutateJob(
    source,
    '  signed-aab:',
    '  verify-signed-aab:',
    'name: android-release-unsigned-aab-${{ inputs.version_code }}',
    'name: android-release-parser-substitute-${{ inputs.version_code }}',
  );
}

function missingSelectedAliasFingerprintViolation(source: string): string {
  return mutate(
    source,
    '[[ "$actual_upload_sha256" == "$expected_upload_sha256" ]] || { echo \'selected upload certificate does not match ANDROID_UPLOAD_SHA256\' >&2; exit 1; }',
    '[[ -n "$actual_upload_sha256" ]]',
  );
}

function missingFinalSignerFingerprintViolation(source: string): string {
  return mutate(
    source,
    '[[ "$signed_aab_sha256" == "$expected_upload_sha256" ]] || { echo \'signed AAB certificate does not match ANDROID_UPLOAD_SHA256\' >&2; exit 1; }',
    '[[ -n "$signed_aab_sha256" ]]',
  );
}

function missingExpectedReleaseViolation(source: string): string {
  return mutate(
    source,
    'PULSEBLR_EXPECTED_RELEASE_COMMIT_SHA: ${{ inputs.expected_release_commit_sha }}',
    "PULSEBLR_EXPECTED_RELEASE_COMMIT_SHA: '0000000000000000000000000000000000000000'",
  );
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

  it('rejects any parser-job artifact publication instead of trusting re-authored signable bytes', () => {
    expectRejected(parserRepublishViolation(currentReleaseWorkflow()), 'verify-unsigned-aab must not upload artifacts or republish signable bytes');
  });

  it('requires the unsigned build job to publish the original AAB and its SHA-256 identity together', () => {
    expectRejected(missingOriginalDigestViolation(currentReleaseWorkflow()), 'unsigned-aab must publish the original AAB and SHA-256 identity together');
  });

  it('requires the protected signer to consume the same original artifact gated by the parser job', () => {
    expectRejected(substitutedSignerArtifactViolation(currentReleaseWorkflow()), 'signed-aab must download the original unsigned AAB artifact');
  });

  it('rejects removal of the selected upload-alias certificate fingerprint comparison', () => {
    expectRejected(missingSelectedAliasFingerprintViolation(currentReleaseWorkflow()), 'signed-aab must bind the selected alias certificate to ANDROID_UPLOAD_SHA256');
  });

  it('rejects removal of the independent final signed-AAB certificate fingerprint comparison', () => {
    expectRejected(missingFinalSignerFingerprintViolation(currentReleaseWorkflow()), 'verify-signed-aab must independently bind the final signer to ANDROID_UPLOAD_SHA256');
  });

  it('requires the release workflow preflight to consume the caller-supplied deployed commit SHA', () => {
    expectRejected(missingExpectedReleaseViolation(currentReleaseWorkflow()), 'android-release preflight must consume inputs.expected_release_commit_sha');
  });

  it('validates action SHA pins in every workflow, including normal CI and scheduled jobs', () => {
    const ci = readWorkflowText(path.join(root, '.github', 'workflows', 'ci.yml'));
    const unpinned = mutate(ci, 'actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683', 'actions/checkout@v4');
    expectWorkflowRejected('ci.yml', unpinned, 'ci.yml:verify:actions/checkout@v4 must use a full 40-character action SHA pin');
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
      mutateJob(
        currentReleaseWorkflow(),
        '  signed-aab:',
        '  verify-signed-aab:',
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

  it('rejects the original artifact downloaded to the wrong protected-runner path', () => {
    expectRejected(
      mutateJob(
        currentReleaseWorkflow(),
        '  signed-aab:',
        '  verify-signed-aab:',
        '          path: ${{ runner.temp }}/unsigned-aab',
        '          path: ${{ runner.temp }}/unexpected-artifact-directory',
      ),
      'signed-aab must download the original unsigned AAB artifact',
    );
  });

  it('rejects a protected signer that reads a different identity file from the verified AAB', () => {
    expectRejected(
      mutateJob(
        currentReleaseWorkflow(),
        '  signed-aab:',
        '  verify-signed-aab:',
        '          identity_file="$artifact_dir/app-release-unsigned.aab.sha256"',
        '          identity_file="$artifact_dir/substituted-identity.sha256"',
      ),
      'signed-aab must validate the exact original unsigned AAB identity-file semantics before signing',
    );
  });

  it('rejects a version validator with a reduced release-code bound', () => {
    expectRejected(
      mutateJob(currentReleaseWorkflow(), '  unsigned-aab:', '  verify-unsigned-aab:', 'max_version_code=2100000000', 'max_version_code=210000000'),
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
