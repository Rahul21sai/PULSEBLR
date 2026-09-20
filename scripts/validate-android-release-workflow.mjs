import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const validationRoot = (() => {
  if (process.argv.length === 2) return repositoryRoot;
  if (process.argv.length === 4 && process.argv[2] === '--root' && process.argv[3].length > 0) {
    return path.resolve(process.argv[3]);
  }
  throw new Error('Usage: validate-android-release-workflow.mjs [--root <repository-root>]');
})();
const workflowDirectory = path.join(validationRoot, '.github', 'workflows');
const bundletoolSha256 = 'a099cfa1543f55593bc2ed16a70a7c67fe54b1747bb7301f37fdfd6d91028e29';
const originalUnsignedArtifact = 'android-release-unsigned-aab-${{ inputs.version_code }}';
const signedIntermediateArtifact = 'android-release-signed-intermediate-aab-${{ inputs.version_code }}';
const finalReleaseArtifact = 'android-release-aab-${{ inputs.version_code }}';
const unsignedArtifactPaths = [
  '${{ runner.temp }}/app-release-unsigned.aab',
  '${{ runner.temp }}/app-release-unsigned.aab.sha256',
];
const unsignedDownloadPath = '${{ runner.temp }}/unsigned-aab';
const signedIntermediatePath = '${{ runner.temp }}/app-release-signed.aab';
const signedIntermediateDownloadPath = '${{ runner.temp }}/signed-aab';
const finalReleasePaths = [
  '${{ runner.temp }}/signed-aab/app-release-signed.aab',
  '${{ runner.temp }}/signed-aab-metadata.txt',
  '${{ runner.temp }}/signed-aab-signature.txt',
];
const signerActionAllowlist = new Map([
  ['Set up trusted JDK 17', 'actions/setup-java'],
  ['Download original unsigned release AAB', 'actions/download-artifact'],
  ['Upload signed release AAB intermediate', 'actions/upload-artifact'],
]);
const signerRunStepAllowlist = new Set([
  'Revalidate version code input',
  'Verify original unsigned AAB identity',
  'Reconstruct and sign protected release AAB',
  'Remove temporary signing material',
]);

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @returns {string[]} */
function stringsIn(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (isRecord(value)) return Object.values(value).flatMap(stringsIn);
  return [];
}

/** @param {unknown} value @returns {Record<string, unknown>} */
function record(value) {
  return isRecord(value) ? value : {};
}

/** @param {Record<string, unknown>} job */
function steps(job) {
  return Array.isArray(job.steps) ? job.steps.map(record) : [];
}

/** @param {Record<string, unknown>} job */
function jobNeeds(job) {
  return typeof job.needs === 'string'
    ? [job.needs]
    : Array.isArray(job.needs) ? job.needs.filter(value => typeof value === 'string') : [];
}

/** @param {Record<string, unknown>} step */
function stepRun(step) {
  return typeof step.run === 'string' ? step.run : '';
}

/** @param {Record<string, unknown>} step */
function stepUses(step) {
  return typeof step.uses === 'string' ? step.uses : '';
}

/** @param {Record<string, unknown>} step */
function stepName(step) {
  return typeof step.name === 'string' ? step.name : stepUses(step);
}

/** @param {Record<string, unknown>} step */
function containsSecret(step) {
  return stringsIn(step).some(value => value.includes('${{ secrets.'));
}

/** @param {Record<string, unknown>} step */
function artifactName(step) {
  const withOptions = record(step.with);
  return typeof withOptions.name === 'string' ? withOptions.name : '';
}

/** @param {Record<string, unknown>} step */
function artifactPaths(step) {
  const pathValue = record(step.with).path;
  return typeof pathValue === 'string'
    ? pathValue.split('\n').map(value => value.trim()).filter(Boolean)
    : [];
}

/** @param {string[]} actual @param {string[]} expected */
function samePaths(actual, expected) {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

/** @param {Record<string, unknown>} job */
function actionSteps(job, action) {
  return steps(job).filter(step => stepUses(step).startsWith(`${action}@`));
}

/** @param {Record<string, unknown>} job */
function uploadSteps(job) {
  return actionSteps(job, 'actions/upload-artifact');
}

/** @param {Record<string, unknown>} job */
function downloadSteps(job) {
  return actionSteps(job, 'actions/download-artifact');
}

/** @param {Record<string, unknown>} job */
function jobHasSecret(job) {
  return stringsIn(job).some(value => value.includes('${{ secrets.'));
}

/** @param {Record<string, unknown>} job */
function jobRunsForbiddenBuildOrParser(job) {
  return steps(job).filter(step => /\b(bundletool|npm|npx|bubblewrap|gradle|node)\b/i.test(stepRun(step)));
}

/** @param {Record<string, unknown>} job */
function workflowHasBundletool(job) {
  return steps(job).some(step => /bundletool/i.test(stepRun(step)));
}

/** @param {Record<string, unknown>} job */
function findSecretStep(job) {
  return steps(job).findIndex(containsSecret);
}

/** @param {Record<string, unknown>} job */
function expectedJobArtifacts(job, name) {
  return uploadSteps(job).some(step => artifactName(step) === name);
}

/** @param {Record<string, unknown>} job @param {string} name @param {string[]} paths */
function expectedArtifactTransfer(job, action, name, paths) {
  const transfers = action === 'download' ? downloadSteps(job) : uploadSteps(job);
  return transfers.length === 1 && artifactName(transfers[0]) === name && samePaths(artifactPaths(transfers[0]), paths);
}

/** @param {Record<string, unknown>} job */
function hasOnlyAllowedSignerSteps(job) {
  return steps(job).filter(step => {
    const uses = stepUses(step);
    const name = stepName(step);
    if (uses) return signerActionAllowlist.get(name) !== uses.split('@', 1)[0];
    return !signerRunStepAllowlist.has(name) || stepRun(step).length === 0;
  });
}

/** @param {Record<string, unknown>} job */
function hasOriginalUnsignedIdentityCheck(job) {
  const step = steps(job).find(candidate => stepName(candidate) === 'Verify original unsigned AAB identity');
  const run = step ? stepRun(step) : '';
  return run.includes('artifact_dir="$RUNNER_TEMP/unsigned-aab"') &&
    run.includes('aab="$artifact_dir/app-release-unsigned.aab"') &&
    run.includes('identity_file="$artifact_dir/app-release-unsigned.aab.sha256"') &&
    run.includes("identity=$(/usr/bin/tr -d '\\r\\n' < \"$identity_file\")") &&
    run.includes('[[ "$identity" =~ ^[0-9a-f]{64}\\ \\ app-release-unsigned\\.aab$ ]]') &&
    run.includes('expected_sha256="${identity%% *}"') &&
    run.includes("printf '%s  %s\\n' \"$expected_sha256\" \"$aab\" | /usr/bin/sha256sum --check --status");
}

/** @param {Record<string, unknown>} workflow @param {Record<string, unknown>} job */
function hasExpectedReleasePreflight(workflow, job) {
  const on = record(workflow.on);
  const dispatch = record(on.workflow_dispatch);
  const input = record(record(dispatch.inputs).expected_release_commit_sha);
  const preflight = steps(job).find(step => stepName(step) === 'Preflight deployed origin');
  return input.required === true && input.type === 'string' && preflight !== undefined &&
    record(preflight.env).PULSEBLR_EXPECTED_RELEASE_COMMIT_SHA === '${{ inputs.expected_release_commit_sha }}' &&
    stepRun(preflight) === 'npm run android:preflight';
}

/** @param {Record<string, unknown>} jobs */
function hasBoundedVersionCodeValidation(jobs) {
  const expectedNames = new Set(['Validate version code input', 'Revalidate version code input']);
  const validators = Object.values(jobs).flatMap(job => steps(record(job))).filter(step => expectedNames.has(stepName(step)));
  return validators.length === 4 && validators.every(step => {
    const environment = record(step.env);
    const run = stepRun(step);
    return environment.VERSION_CODE === '${{ inputs.version_code }}' &&
      run.includes('max_version_code=2100000000') &&
      run.includes('[[ "$VERSION_CODE" =~ ^[1-9][0-9]*$ ]]') &&
      run.includes('[ "${#VERSION_CODE}" -gt "${#max_version_code}" ]') &&
      run.includes('[[ "$VERSION_CODE" > "$max_version_code" ]]');
  });
}

/** @param {unknown} value */
function isFullActionPin(value) {
  return typeof value === 'string' && (value.startsWith('./') || /^[^\s@]+@[0-9a-f]{40}(?:\s+#.*)?$/i.test(value));
}

/** @param {Record<string, unknown>} workflow @param {string} filename @param {string[]} errors */
function validateActionPins(workflow, filename, errors) {
  const jobs = record(workflow.jobs);
  for (const [jobName, job] of Object.entries(jobs)) {
    for (const step of steps(record(job))) {
      if (step.uses && !isFullActionPin(step.uses)) {
        errors.push(`${filename}:${jobName}:${stepName(step)} must use a full 40-character action SHA pin`);
      }
      if (/play/i.test(stepUses(step))) {
        errors.push(`${filename}:${jobName}:${stepName(step)} must not use a Play upload action`);
      }
    }
  }
}

/** @param {Record<string, unknown>} workflow @param {string[]} errors */
function validateReleaseWorkflow(workflow, errors) {
  const jobs = record(workflow.jobs);
  const unsigned = record(jobs['unsigned-aab']);
  const verified = record(jobs['verify-unsigned-aab']);
  const signer = record(jobs['signed-aab']);
  const postSign = record(jobs['verify-signed-aab']);

  if (!jobs['unsigned-aab']) errors.push('unsigned-aab job is required');
  if (!jobs['verify-unsigned-aab']) errors.push('verify-unsigned-aab job is required');
  if (!jobs['signed-aab']) errors.push('signed-aab job is required');
  if (!jobs['verify-signed-aab']) errors.push('verify-signed-aab job is required');

  if (!hasBoundedVersionCodeValidation(jobs)) {
    errors.push('every version-code validation step must enforce integer range 1..2100000000');
  }

  if (jobHasSecret(unsigned) || unsigned.environment) {
    errors.push('unsigned-aab must remain secret-free and unprotected');
  }
  if (!hasExpectedReleasePreflight(workflow, unsigned)) {
    errors.push('android-release preflight must consume inputs.expected_release_commit_sha');
  }
  if (!expectedArtifactTransfer(unsigned, 'upload', originalUnsignedArtifact, unsignedArtifactPaths)) {
    errors.push('unsigned-aab must publish the original AAB and SHA-256 identity together');
  }
  if (jobHasSecret(verified) || verified.environment) {
    errors.push('verify-unsigned-aab must remain secret-free and unprotected');
  }
  if (!jobNeeds(verified).includes('unsigned-aab')) {
    errors.push('verify-unsigned-aab must depend on unsigned-aab');
  }
  if (!expectedArtifactTransfer(verified, 'download', originalUnsignedArtifact, [unsignedDownloadPath])) {
    errors.push('verify-unsigned-aab must download the unsigned AAB artifact to ${{ runner.temp }}/unsigned-aab');
  }
  if (!workflowHasBundletool(verified) || !steps(verified).some(step => stepRun(step).includes(bundletoolSha256))) {
    errors.push('verify-unsigned-aab must hash Bundletool 1.18.3 before validating the unsigned AAB');
  }
  if (!steps(verified).some(step => stepName(step) === 'Verify original unsigned AAB identity and metadata' &&
    stepRun(step).includes('identity_file="$artifact_dir/app-release-unsigned.aab.sha256"') &&
    stepRun(step).includes('/usr/bin/sha256sum --check --status'))) {
    errors.push('verify-unsigned-aab must gate the build-job SHA-256 identity before parsing');
  }
  if (uploadSteps(verified).length > 0) {
    errors.push('verify-unsigned-aab must not upload artifacts or republish signable bytes');
  }
  if (workflowHasBundletool(unsigned)) {
    errors.push('unsigned-aab must leave unsigned AAB parsing to verify-unsigned-aab');
  }

  if (signer.environment !== 'android-release') {
    errors.push('signed-aab must be protected by the android-release environment');
  }
  if (!jobNeeds(signer).includes('verify-unsigned-aab')) {
    errors.push('signed-aab must depend on successful verify-unsigned-aab');
  }
  if (!expectedArtifactTransfer(signer, 'download', originalUnsignedArtifact, [unsignedDownloadPath])) {
    errors.push('signed-aab must download the original unsigned AAB artifact');
  }
  const signerSteps = steps(signer);
  const unallowlistedSignerSteps = hasOnlyAllowedSignerSteps(signer);
  if (unallowlistedSignerSteps.length > 0) {
    errors.push(`signed-aab contains an unallowlisted action or step: ${unallowlistedSignerSteps.map(stepName).join(', ')}`);
  }
  const signerSecretSteps = signerSteps.filter(containsSecret);
  const signerSecretIndex = findSecretStep(signer);
  if (stringsIn(signer.env).some(value => value.includes('${{ secrets.')) || signerSecretSteps.length !== 1 || signerSecretIndex === -1) {
    errors.push('signed-aab must keep signing secrets in exactly one step-scoped signing step');
  } else {
    const secretStep = signerSteps[signerSecretIndex];
    const unsafeEarlierSteps = signerSteps.slice(0, signerSecretIndex).filter(step => /\b(bundletool|npm|npx|bubblewrap|gradle|node)\b/i.test(stepRun(step)));
    if (unsafeEarlierSteps.length > 0) {
      errors.push(`protected signer must not parse untrusted AAB data before secrets: ${unsafeEarlierSteps.map(stepName).join(', ')}`);
    }
    if (/\b(JAVA_HOME|PATH|GITHUB_ENV|GITHUB_PATH)\b/.test(stepRun(secretStep))) {
      errors.push('protected signing step must not resolve Java tools from ambient JAVA_HOME, PATH, GITHUB_ENV, or GITHUB_PATH');
    }
    const signingEnvironment = record(secretStep.env);
    if (signingEnvironment.TRUSTED_JDK_PATH !== '${{ steps.trusted-jdk.outputs.path }}') {
      errors.push('protected signing step must consume only the trusted setup-java path output');
    }
    if (signingEnvironment.ANDROID_UPLOAD_SHA256 !== '${{ vars.ANDROID_UPLOAD_SHA256 }}') {
      errors.push('signed-aab must bind the selected alias certificate to ANDROID_UPLOAD_SHA256');
    }
    const signingRun = stepRun(secretStep);
    if (!signingRun.includes('/opt/hostedtoolcache/Java_Temurin-Hotspot_jdk/17') ||
      !signingRun.includes('$TRUSTED_JDK_PATH/bin/keytool') ||
      !signingRun.includes('$TRUSTED_JDK_PATH/bin/jarsigner')) {
      errors.push('protected signing step must validate the hosted-toolcache JDK path and invoke absolute keytool/jarsigner paths');
    }
    if (!signingRun.includes('trap cleanup EXIT') || !signingRun.includes('rm -f')) {
      errors.push('protected signing step must trap keystore cleanup');
    }
    if (!['ANDROID_UPLOAD_KEYSTORE_BASE64', 'ANDROID_UPLOAD_KEYSTORE_PASSWORD', 'ANDROID_UPLOAD_KEY_PASSWORD', 'ANDROID_UPLOAD_KEY_ALIAS']
      .every(name => signingRun.includes(`::add-mask::%s\\n' "$${name}"`))) {
      errors.push('protected signing step must mask every signing secret before use');
    }
    if (!signingRun.includes('/usr/bin/chmod 600') ||
      !signingRun.includes('-storepass:env ANDROID_UPLOAD_KEYSTORE_PASSWORD') ||
      !signingRun.includes('-keypass:env ANDROID_UPLOAD_KEY_PASSWORD')) {
      errors.push('protected signing step must use restrictive keystore permissions and environment-only passwords');
    }
    if (!signingRun.includes('expected_upload_sha256=$(normalize_sha256 "$ANDROID_UPLOAD_SHA256")') ||
      !signingRun.includes('actual_upload_sha256=$(normalize_sha256 "$actual_upload_sha256_raw")') ||
      !signingRun.includes('[[ "$actual_upload_sha256" == "$expected_upload_sha256" ]]') ||
      !signingRun.includes('"$keytool_bin" -list -v')) {
      errors.push('signed-aab must bind the selected alias certificate to ANDROID_UPLOAD_SHA256');
    }
  }
  if (jobRunsForbiddenBuildOrParser(signer).length > 0) {
    errors.push('protected signer must not execute Bundletool, repository code, npm, Bubblewrap, or Gradle before/after signing');
  }
  if (!hasOriginalUnsignedIdentityCheck(signer)) {
    errors.push('signed-aab must validate the exact original unsigned AAB identity-file semantics before signing');
  }
  if (!steps(signer).some(step => step.if === 'always()' && /pulseblr-upload\.keystore/.test(stepRun(step)))) {
    errors.push('signed-aab must retain an always() keystore cleanup backstop');
  }
  if (!expectedArtifactTransfer(signer, 'upload', signedIntermediateArtifact, [signedIntermediatePath])) {
    errors.push('signed-aab may upload only the signed intermediate AAB at its exact artifact path');
  }
  if (uploadSteps(signer).some(step => artifactName(step) === finalReleaseArtifact)) {
    errors.push('signed-aab must not publish the final owner-facing release artifact');
  }

  if (jobHasSecret(postSign) || postSign.environment !== 'android-release') {
    errors.push('verify-signed-aab must be fresh, secret-free, and protected by android-release');
  }
  if (!jobNeeds(postSign).includes('signed-aab')) {
    errors.push('verify-signed-aab must depend on signed-aab');
  }
  if (!expectedArtifactTransfer(postSign, 'download', signedIntermediateArtifact, [signedIntermediateDownloadPath])) {
    errors.push('verify-signed-aab must download the signed intermediate artifact to ${{ runner.temp }}/signed-aab');
  }
  const postSignRuns = steps(postSign).map(stepRun).join('\n');
  if (!postSignRuns.includes(bundletoolSha256) || !/bundletool/i.test(postSignRuns) || !/-verify\s+-verbose\s+-certs\s+-strict/.test(postSignRuns)) {
    errors.push('verify-signed-aab must hash Bundletool and strictly verify the final signed AAB');
  }
  if (!postSignRuns.includes('package="app.pulseblr.twa"') || !postSignRuns.includes('android:minSdkVersion="21"') || !postSignRuns.includes('android:targetSdkVersion="36"')) {
    errors.push('verify-signed-aab must validate final package and SDK metadata');
  }
  if (!postSignRuns.includes('android:versionCode=\\"$VERSION_CODE\\"')) {
    errors.push('verify-signed-aab must validate final manifest versionCode against the requested VERSION_CODE');
  }
  if (!postSignRuns.includes('android:versionName="1"')) {
    errors.push('verify-signed-aab must validate final manifest versionName "1"');
  }
  const postSignValidation = steps(postSign).find(step => stepName(step) === 'Validate signed release AAB');
  const postSignEnvironment = record(postSignValidation?.env);
  const postSignRun = postSignValidation ? stepRun(postSignValidation) : '';
  if (postSignEnvironment.ANDROID_UPLOAD_SHA256 !== '${{ vars.ANDROID_UPLOAD_SHA256 }}' ||
    postSignEnvironment.TRUSTED_JDK_PATH !== '${{ steps.trusted-jdk.outputs.path }}' ||
    !postSignRun.includes('"$keytool_bin" -printcert -jarfile "$aab"') ||
    !postSignRun.includes('signed_aab_sha256=$(normalize_sha256 "$signed_aab_sha256_raw")') ||
    !postSignRun.includes('[[ "$signed_aab_sha256" == "$expected_upload_sha256" ]]')) {
    errors.push('verify-signed-aab must independently bind the final signer to ANDROID_UPLOAD_SHA256');
  }
  if (!expectedArtifactTransfer(postSign, 'upload', finalReleaseArtifact, finalReleasePaths)) {
    errors.push('only verify-signed-aab may publish the final owner-facing AAB and diagnostics at exact artifact paths');
  }
  const finalPublishers = Object.entries(jobs).filter(([, job]) => expectedJobArtifacts(record(job), finalReleaseArtifact));
  if (finalPublishers.length !== 1 || finalPublishers[0][0] !== 'verify-signed-aab') {
    errors.push('the final release artifact must be published only by verify-signed-aab');
  }
}

const errors = [];
const parsedWorkflows = new Map();
for (const filename of readdirSync(workflowDirectory).filter(file => /\.ya?ml$/i.test(file)).sort()) {
  const source = readFileSync(path.join(workflowDirectory, filename), 'utf8');
  const workflow = load(source);
  if (!isRecord(workflow)) {
    errors.push(`${filename} must parse as a YAML mapping`);
    continue;
  }
  parsedWorkflows.set(filename, workflow);
  validateActionPins(workflow, filename, errors);
}

const dependabot = load(readFileSync(path.join(validationRoot, '.github', 'dependabot.yml'), 'utf8'));
if (!isRecord(dependabot)) errors.push('dependabot.yml must parse as a YAML mapping');

const releaseWorkflow = parsedWorkflows.get('android-release.yml');
if (!releaseWorkflow) {
  errors.push('android-release.yml must be present and parse as YAML');
} else {
  validateReleaseWorkflow(releaseWorkflow, errors);
}

const debugWorkflow = parsedWorkflows.get('android-twa.yml');
if (!debugWorkflow) {
  errors.push('android-twa.yml must be present and parse as YAML');
} else {
  const debugJob = record(record(debugWorkflow.jobs)['debug-aab']);
  if (!hasExpectedReleasePreflight(debugWorkflow, debugJob)) {
    errors.push('android-twa preflight must consume inputs.expected_release_commit_sha');
  }
}

if (errors.length > 0) {
  console.error(`Android release workflow boundary validation failed:\n- ${errors.join('\n- ')}`);
  process.exitCode = 1;
} else {
  console.log('Android release workflow boundary validation: PASS');
}
