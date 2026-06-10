const os = require('os');
const path = require('path');

const { runHttpUploadFlow } = require('./upload-http-flow');
const {
  parsePasskeyCredentialJson,
  validatePasskeyCredential,
} = require('../auth/passkey-credential');

function resolveLibraryPasskey(options) {
  if (options.passkey) {
    return validatePasskeyCredential(options.passkey, 'passkey');
  }

  if (options.passkeyJson) {
    return parsePasskeyCredentialJson(options.passkeyJson, 'passkeyJson');
  }

  throw new Error('Missing CFX passkey. Provide passkey or passkeyJson.');
}

function validateUploadOptions(options) {
  if (!options || typeof options !== 'object') {
    throw new Error('Upload options are required.');
  }

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
}

async function upload(options = {}) {
  validateUploadOptions(options);

  const workDir = options.workDir || path.join(os.tmpdir(), 'cfx-uploader');
  const passkey = resolveLibraryPasskey(options);
  const onLog = typeof options.onLog === 'function' ? options.onLog : console.log;

  return runHttpUploadFlow({
    projectRoot: workDir,
    repository: options.repository,
    releaseTag: options.releaseTag || null,
    githubToken: options.githubToken,
    passkey,
    passkeySource: options.passkeySource || (options.passkeyJson ? 'passkeyJson' : 'passkey'),
    fallbackConfig: {},
    headless: options.headless !== false,
    releaseCandidate: options.releaseCandidate,
    changelog: options.changelog ?? null,
    releasesDir: path.join(workDir, 'releases'),
    onLog,
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
};
