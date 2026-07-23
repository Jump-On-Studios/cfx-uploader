const os = require('os');
const path = require('path');

const { runHttpUploadFlow } = require('./upload-http-flow');
const {
  parsePasskeyCredentialJson,
  validatePasskeyCredential,
} = require('../auth/passkey-credential');
const { normalizeMaxPrereleaseVersionsToKeep } = require('../utils/prerelease-retention');

function resolveLibraryPasskey(options) {
  if (options.passkey) {
    return validatePasskeyCredential(options.passkey, 'passkey');
  }

  if (options.passkeyJson) {
    return parsePasskeyCredentialJson(options.passkeyJson, 'passkeyJson');
  }

  throw new Error('Missing CFX passkey. Provide passkey or passkeyJson.');
}

function validatePasswordAuth(auth) {
  if (!auth || typeof auth !== 'object' || auth.method !== 'password') {
    throw new Error('Upload auth.method must be "password" when auth is provided.');
  }

  if (!auth.email || typeof auth.email !== 'string') {
    throw new Error('Upload auth.email is required for password authentication.');
  }

  if (!auth.password || typeof auth.password !== 'string') {
    throw new Error('Upload auth.password is required for password authentication.');
  }

  if (typeof auth.twoFactorCodeProvider !== 'function') {
    throw new Error('Upload auth.twoFactorCodeProvider is required for password authentication.');
  }

  if (
    auth.emailVerificationLinkProvider !== undefined &&
    typeof auth.emailVerificationLinkProvider !== 'function'
  ) {
    throw new Error('Upload auth.emailVerificationLinkProvider must be a function when provided.');
  }
}

function resolvePasskeySource(options = {}) {
  if (options.passkeySource) {
    return options.passkeySource;
  }

  if (options.passkeyJson) {
    return 'passkeyJson';
  }

  if (options.passkey) {
    return 'passkey';
  }

  return null;
}

function validateAuthenticationOptions(options) {
  if (!options || typeof options !== 'object') {
    throw new Error('Authentication options are required.');
  }

  if (options.auth !== undefined) {
    validatePasswordAuth(options.auth);
  }

  if (options.sessionCachePath !== undefined && options.sessionCachePath !== null) {
    if (typeof options.sessionCachePath !== 'string' || !options.sessionCachePath.trim()) {
      throw new Error('Upload option "sessionCachePath" must be a non-empty string when provided.');
    }

    if (!options.sessionEncryptionKey || typeof options.sessionEncryptionKey !== 'string') {
      throw new Error('Upload option "sessionEncryptionKey" is required when sessionCachePath is provided.');
    }
  }

  if (
    options.twoFactorTimeoutMs !== undefined &&
    (!Number.isInteger(options.twoFactorTimeoutMs) || options.twoFactorTimeoutMs <= 0)
  ) {
    throw new Error('Upload option "twoFactorTimeoutMs" must be a positive integer when provided.');
  }

  if (
    options.emailVerificationTimeoutMs !== undefined &&
    (!Number.isInteger(options.emailVerificationTimeoutMs) || options.emailVerificationTimeoutMs <= 0)
  ) {
    throw new Error('Upload option "emailVerificationTimeoutMs" must be a positive integer when provided.');
  }

  if (
    options.browserProfilePath !== undefined &&
    options.browserProfilePath !== null &&
    (typeof options.browserProfilePath !== 'string' || !options.browserProfilePath.trim())
  ) {
    throw new Error('Upload option "browserProfilePath" must be a non-empty string when provided.');
  }

  if (
    options.headlessFingerprint !== undefined &&
    options.headlessFingerprint !== 'native' &&
    options.headlessFingerprint !== 'normalized'
  ) {
    throw new Error('Upload option "headlessFingerprint" must be "native" or "normalized" when provided.');
  }

  if (options.onLog !== undefined && typeof options.onLog !== 'function') {
    throw new Error('Upload option "onLog" must be a function when provided.');
  }
}

function validateUploadOptions(options) {
  validateAuthenticationOptions(options);

  if (!options.repository || typeof options.repository !== 'string') {
    throw new Error('Upload option "repository" is required.');
  }

  if (!options.githubToken || typeof options.githubToken !== 'string') {
    throw new Error('Upload option "githubToken" is required.');
  }

  if (
    options.releaseCandidate !== undefined &&
    typeof options.releaseCandidate !== 'boolean'
  ) {
    throw new Error('Upload option "releaseCandidate" must be a boolean when provided.');
  }

  if (
    options.deleteOldestVersionWhenCapped !== undefined &&
    typeof options.deleteOldestVersionWhenCapped !== 'boolean'
  ) {
    throw new Error('Upload option "deleteOldestVersionWhenCapped" must be a boolean when provided.');
  }

  if (
    options.onProgress !== undefined &&
    typeof options.onProgress !== 'function'
  ) {
    throw new Error('Upload option "onProgress" must be a function when provided.');
  }

  try {
    normalizeMaxPrereleaseVersionsToKeep(options.maxPrereleaseVersionsToKeep, 'Upload option "maxPrereleaseVersionsToKeep"');
  } catch (error) {
    throw new Error(error.message);
  }
}

async function upload(options = {}) {
  validateUploadOptions(options);

  const workDir = options.workDir || path.join(os.tmpdir(), 'cfx-uploader');
  if (options.auth && (options.passkey || options.passkeyJson)) {
    throw new Error('Provide either auth or passkey/passkeyJson, not both.');
  }

  let resolvedPasskey = null;
  if (options.passkey || options.passkeyJson) {
    resolvedPasskey = resolveLibraryPasskey(options);
  } else if (!options.auth && !options.sessionCachePath) {
    resolvedPasskey = resolveLibraryPasskey(options);
  }
  const onLog = typeof options.onLog === 'function' ? options.onLog : console.log;
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;

  return runHttpUploadFlow({
    projectRoot: workDir,
    repository: options.repository,
    releaseTag: options.releaseTag || null,
    githubToken: options.githubToken,
    auth: options.auth,
    passkey: resolvedPasskey,
    passkeySource: resolvePasskeySource(options),
    fallbackConfig: {},
    headless: options.headless !== false,
    releaseCandidate: options.releaseCandidate,
    deleteOldestVersionWhenCapped: options.deleteOldestVersionWhenCapped,
    maxPrereleaseVersionsToKeep: normalizeMaxPrereleaseVersionsToKeep(options.maxPrereleaseVersionsToKeep),
    changelog: options.changelog ?? null,
    sessionCachePath: options.sessionCachePath || null,
    sessionEncryptionKey: options.sessionEncryptionKey || null,
    twoFactorTimeoutMs: options.twoFactorTimeoutMs,
    emailVerificationTimeoutMs: options.emailVerificationTimeoutMs,
    browserProfilePath: options.browserProfilePath || null,
    headlessFingerprint: options.headlessFingerprint || 'native',
    releasesDir: path.join(workDir, 'releases'),
    onLog,
    onProgress,
  });
}

function createUploader(baseOptions = {}) {
  return {
    upload(uploadOptions = {}) {
      return upload({
        ...baseOptions,
        ...uploadOptions,
      });
    },
  };
}

module.exports = {
  createUploader,
  upload,
  resolveLibraryPasskey,
  resolvePasskeySource,
  validateAuthenticationOptions,
  validatePasswordAuth,
  validateUploadOptions,
};
