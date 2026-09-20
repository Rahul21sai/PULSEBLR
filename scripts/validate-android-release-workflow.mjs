import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowDirectory = path.join(root, '.github', 'workflows');
const bundletoolSha256 = 'a099cfa1543f55593bc2ed16a70a7c67fe54b1747bb7301f37fdfd6d91028e29';
const verifiedUnsignedArtifact = 'android-release-verified-unsigned-aab-${{ inputs.version_code }}';
const signedIntermediateArtifact = 'android-release-signed-intermediate-aab-${{ inputs.version_code }}';
const finalReleaseArtifact = 'android-release-aab-${{ inputs.version_code }}';

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
  return stringsIn(step.env).some(value => value.includes('${{ secrets.'));
}

/** @param {Record<string, unknown>} step */
function artifactName(step) {
  const withOptions = record(step.with);
  return typeof withOptions.name === 'string' ? withOptions.name : '';
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

/** @param {Record<string, unknown>} job */
function expectedDownloadedArtifact(job, name) {
  const downloads = downloadSteps(job);
  return downloads.length === 1 && artifactName(downloads[0]) === name;
}

/** @param {unknown} value */
function isFullActionPin(value) {
  return typeof value === 'string' && /^[^\s@]+@[0-9a-f]{40}(?:\s+#.*)?$/i.test(value);
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

  if (jobHasSecret(unsigned) || unsigned.environment) {
    errors.push('unsigned-aab must remain secret-free and unprotected');
  }
  if (jobHasSecret(verified) || verified.environment) {
    errors.push('verify-unsigned-aab must remain secret-free and unprotected');
  }
  if (!jobNeeds(verified).includes('unsigned-aab')) {
    errors.push('verify-unsigned-aab must depend on unsigned-aab');
  }
  if (!expectedDownloadedArtifact(verified, 'android-release-unsigned-aab-${{ inputs.version_code }}')) {
    errors.push('verify-unsigned-aab must download exactly the unsigned AAB artifact');
  }
  if (!workflowHasBundletool(verified) || !steps(verified).some(step => stepRun(step).includes(bundletoolSha256))) {
    errors.push('verify-unsigned-aab must hash Bundletool 1.18.3 before validating the unsigned AAB');
  }
  if (!expectedJobArtifacts(verified, verifiedUnsignedArtifact)) {
    errors.push('verify-unsigned-aab must publish the verified unsigned AAB intermediate artifact');
  }
  if (!steps(verified).some(step => /app-release-verified\.aab/.test(stepRun(step)) && /sha256sum/.test(stepRun(step)))) {
    errors.push('verify-unsigned-aab must publish a SHA-256 identity for the exact verified AAB');
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
  if (!expectedDownloadedArtifact(signer, verifiedUnsignedArtifact)) {
    errors.push('signed-aab must download only the verified unsigned AAB intermediate artifact');
  }
  const signerSteps = steps(signer);
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
  }
  if (jobRunsForbiddenBuildOrParser(signer).length > 0) {
    errors.push('protected signer must not execute Bundletool, repository code, npm, Bubblewrap, or Gradle before/after signing');
  }
  if (!steps(signer).some(step => stepName(step) === 'Verify verified unsigned AAB identity' &&
      stepRun(step).includes('/usr/bin/sha256sum --check --status') &&
      stepRun(step).includes('app-release-verified.aab'))) {
    errors.push('signed-aab must re-check the verified AAB SHA-256 identity with fixed /usr/bin/sha256sum');
  }
  if (!steps(signer).some(step => step.if === 'always()' && /pulseblr-upload\.keystore/.test(stepRun(step)))) {
    errors.push('signed-aab must retain an always() keystore cleanup backstop');
  }
  if (!expectedJobArtifacts(signer, signedIntermediateArtifact)) {
    errors.push('signed-aab may upload only the signed intermediate AAB artifact');
  }
  if (uploadSteps(signer).some(step => artifactName(step) === finalReleaseArtifact)) {
    errors.push('signed-aab must not publish the final owner-facing release artifact');
  }

  if (jobHasSecret(postSign) || postSign.environment) {
    errors.push('verify-signed-aab must be fresh, secret-free, and unprotected');
  }
  if (!jobNeeds(postSign).includes('signed-aab')) {
    errors.push('verify-signed-aab must depend on signed-aab');
  }
  if (!expectedDownloadedArtifact(postSign, signedIntermediateArtifact)) {
    errors.push('verify-signed-aab must download exactly the signed intermediate artifact');
  }
  const postSignRuns = steps(postSign).map(stepRun).join('\n');
  if (!postSignRuns.includes(bundletoolSha256) || !/bundletool/i.test(postSignRuns) || !/-verify\s+-verbose\s+-certs\s+-strict/.test(postSignRuns)) {
    errors.push('verify-signed-aab must hash Bundletool and strictly verify the final signed AAB');
  }
  if (!postSignRuns.includes('package="app.pulseblr.twa"') || !postSignRuns.includes('android:minSdkVersion="21"') || !postSignRuns.includes('android:targetSdkVersion="36"')) {
    errors.push('verify-signed-aab must validate final package, version, and SDK metadata');
  }
  if (!expectedJobArtifacts(postSign, finalReleaseArtifact)) {
    errors.push('only verify-signed-aab may publish the final owner-facing release AAB and diagnostics');
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
}

const dependabot = load(readFileSync(path.join(root, '.github', 'dependabot.yml'), 'utf8'));
if (!isRecord(dependabot)) errors.push('dependabot.yml must parse as a YAML mapping');

const releaseWorkflow = parsedWorkflows.get('android-release.yml');
if (!releaseWorkflow) {
  errors.push('android-release.yml must be present and parse as YAML');
} else {
  validateActionPins(releaseWorkflow, 'android-release.yml', errors);
  validateReleaseWorkflow(releaseWorkflow, errors);
}

const debugWorkflow = parsedWorkflows.get('android-twa.yml');
if (!debugWorkflow) {
  errors.push('android-twa.yml must be present and parse as YAML');
} else {
  validateActionPins(debugWorkflow, 'android-twa.yml', errors);
}

if (errors.length > 0) {
  console.error(`Android release workflow boundary validation failed:\n- ${errors.join('\n- ')}`);
  process.exitCode = 1;
} else {
  console.log('Android release workflow boundary validation: PASS');
}
