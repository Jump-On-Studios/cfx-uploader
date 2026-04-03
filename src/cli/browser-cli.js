const path = require('path');

const mockConfig = require('../config/mock-config');
const { resolveGithubRepository } = require('../config/cfx-uploader-config');
const { resolvePasskeyCredential } = require('../auth/passkey-credential');
const { resolveReleaseTag } = require('../github/release-download');
const { runBrowserUploadFlow } = require('../core/upload-browser-flow');
const { parseHeadlessFromArgs } = require('../utils/args');
const { loadProjectEnv } = require('../utils/runtime-env');

async function runBrowserCli(args = process.argv.slice(2)) {
  const projectRoot = path.resolve(__dirname, '..', '..');
  loadProjectEnv(projectRoot);

  const fallbackConfig = { ...mockConfig };
  const repository = resolveGithubRepository(fallbackConfig);
  const passkey = await resolvePasskeyCredential({ projectRoot });

  return runBrowserUploadFlow({
    projectRoot,
    repository,
    releaseTag: resolveReleaseTag(args),
    githubToken: process.env.GITHUB_TOKEN,
    passkey: passkey.credential,
    passkeySource: passkey.source,
    fallbackConfig,
    headless: parseHeadlessFromArgs(args),
  });
}

if (require.main === module) {
  runBrowserCli().catch((error) => {
    console.error('orchestrator failed:', error.message || error);
    process.exit(1);
  });
}

module.exports = {
  runBrowserCli,
};
