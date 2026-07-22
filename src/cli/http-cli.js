#!/usr/bin/env node
const path = require('path');

const mockConfig = require('../config/mock-config');
const { resolveGithubRepository } = require('../config/cfx-uploader-config');
const { resolveReleaseTag } = require('../github/release-download');
const { runHttpUploadFlow } = require('../core/upload-http-flow');
const { resolveHttpCliAuth } = require('./resolve-http-auth');
const {
  parseHeadlessFromArgs,
  parseReleaseCandidateFromArgs,
  parseDeleteOldestVersionWhenCappedFromArgs,
  parseMaxPrereleaseVersionsToKeepFromArgs,
} = require('../utils/args');
const { loadProjectEnv } = require('../utils/runtime-env');

function resolveTwoFactorTimeoutMs(value) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error('CFX_UPLOADER_2FA_TIMEOUT_MS must be a positive integer.');
  }

  return parsed;
}

async function runHttpCli(args = process.argv.slice(2)) {
  const projectRoot = path.resolve(__dirname, '..', '..');
  loadProjectEnv(projectRoot);

  const fallbackConfig = { ...mockConfig };
  const repository = resolveGithubRepository(fallbackConfig);
  const releaseCandidate = parseReleaseCandidateFromArgs(args);
  const deleteOldestVersionWhenCapped = parseDeleteOldestVersionWhenCappedFromArgs(args);
  const maxPrereleaseVersionsToKeep = parseMaxPrereleaseVersionsToKeepFromArgs(args);
  const authConfig = await resolveHttpCliAuth({ args, projectRoot });

  return runHttpUploadFlow({
    projectRoot,
    repository,
    releaseTag: resolveReleaseTag(args),
    githubToken: process.env.GITHUB_TOKEN,
    auth: authConfig.auth,
    passkey: authConfig.passkey,
    passkeySource: authConfig.passkeySource,
    fallbackConfig,
    allowFallbackConfig: true,
    headless: parseHeadlessFromArgs(args),
    releaseCandidate,
    deleteOldestVersionWhenCapped,
    maxPrereleaseVersionsToKeep,
    sessionCachePath: process.env.CFX_UPLOADER_SESSION_CACHE_PATH || null,
    sessionEncryptionKey: process.env.CFX_UPLOADER_SESSION_KEY || null,
    twoFactorTimeoutMs: resolveTwoFactorTimeoutMs(process.env.CFX_UPLOADER_2FA_TIMEOUT_MS),
    emailVerificationTimeoutMs: resolveTwoFactorTimeoutMs(process.env.CFX_UPLOADER_EMAIL_VERIFICATION_TIMEOUT_MS),
    browserProfilePath: process.env.CFX_UPLOADER_BROWSER_PROFILE_PATH || null,
    headlessFingerprint: process.env.CFX_UPLOADER_HEADLESS_FINGERPRINT || 'native',
  });
}

if (require.main === module) {
  runHttpCli().catch((error) => {
    console.error('\nHTTP orchestration failed:');
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  resolveTwoFactorTimeoutMs,
  runHttpCli,
};
