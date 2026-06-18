#!/usr/bin/env node
const path = require('path');

const mockConfig = require('../config/mock-config');
const { resolveGithubRepository } = require('../config/cfx-uploader-config');
const { resolvePasskeyCredential } = require('../auth/passkey-credential');
const { resolveReleaseTag } = require('../github/release-download');
const { runHttpUploadFlow } = require('../core/upload-http-flow');
const {
  parseHeadlessFromArgs,
  parseReleaseCandidateFromArgs,
  parseDeleteOldestVersionWhenCappedFromArgs,
  parseMaxPrereleaseVersionsToKeepFromArgs,
} = require('../utils/args');
const { loadProjectEnv } = require('../utils/runtime-env');

async function runHttpCli(args = process.argv.slice(2)) {
  const projectRoot = path.resolve(__dirname, '..', '..');
  loadProjectEnv(projectRoot);

  const fallbackConfig = { ...mockConfig };
  const repository = resolveGithubRepository(fallbackConfig);
  const releaseCandidate = parseReleaseCandidateFromArgs(args);
  const deleteOldestVersionWhenCapped = parseDeleteOldestVersionWhenCappedFromArgs(args);
  const maxPrereleaseVersionsToKeep = parseMaxPrereleaseVersionsToKeepFromArgs(args);
  const passkey = await resolvePasskeyCredential({ projectRoot });

  return runHttpUploadFlow({
    projectRoot,
    repository,
    releaseTag: resolveReleaseTag(args),
    githubToken: process.env.GITHUB_TOKEN,
    passkey: passkey.credential,
    passkeySource: passkey.source,
    fallbackConfig,
    allowFallbackConfig: true,
    headless: parseHeadlessFromArgs(args),
    releaseCandidate,
    deleteOldestVersionWhenCapped,
    maxPrereleaseVersionsToKeep,
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
  runHttpCli,
};
