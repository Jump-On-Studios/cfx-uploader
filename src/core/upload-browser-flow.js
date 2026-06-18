const fs = require('fs/promises');
const path = require('path');

const {
  getReleaseDownloadInfo,
  assertReleaseVersionMatchesManifest,
  downloadReleaseZip,
} = require('../github/release-download');
const {
  unzipDownloadedRelease,
  listTopLevelFolders,
  createFilteredZip,
  cleanupFile,
  cleanupTempExtractDir,
} = require('../zip/zip-workflow');
const { readCfxUploaderConfig } = require('../config/cfx-uploader-config');
const { readZipMetadata } = require('../zip/zip-metadata');
const { authenticateToCfx } = require('../auth/cfx-auth');
const { uploadZipToCfxAsset } = require('../cfx/browser-upload');
const { normalizeMaxPrereleaseVersionsToKeep } = require('../utils/prerelease-retention');

async function runBrowserUploadFlow(options) {
  const {
    projectRoot,
    repository,
    releaseTag = null,
    githubToken,
    passkey,
    passkeySource,
    fallbackConfig = {},
    allowFallbackConfig = false,
    headless = true,
    releaseCandidate,
    deleteOldestVersionWhenCapped,
    maxPrereleaseVersionsToKeep,
    releasesDir = path.join(projectRoot, 'releases'),
    tempExtractDir = path.join(releasesDir, '.tmp-extract'),
  } = options;

  let browser = null;
  let downloadedZipPath = null;
  let createdZipPath = null;

  try {
    console.log('Step 1/5: Resolving GitHub release...');
    console.log(`GitHub repository: ${repository}`);
    console.log(`Release target: ${releaseTag || 'latest'}`);
    const releaseInfo = await getReleaseDownloadInfo({
      repository,
      releaseTag,
      githubToken,
    });

    if (!releaseInfo) {
      throw new Error(`No downloadable release found for ${repository}${releaseTag ? ` tag ${releaseTag}` : ''}.`);
    }

    const resolvedReleaseCandidate = typeof releaseCandidate === 'boolean'
      ? releaseCandidate
      : Boolean(releaseInfo.prerelease);
    console.log(`Resolved release: ${releaseInfo.version || 'unknown'} (${releaseInfo.source})`);
    console.log(`GitHub prerelease: ${Boolean(releaseInfo.prerelease)}`);
    console.log(`CFX release candidate: ${resolvedReleaseCandidate}`);
    console.log('Step 2/5: Downloading release ZIP...');

    downloadedZipPath = await downloadReleaseZip({
      releaseInfo,
      releasesDir,
      githubToken,
    });

    console.log('Step 3/5: Reading cfx_uploader.json and preparing filtered ZIP...');
    const unzippedRootPath = await unzipDownloadedRelease({
      downloadedZipPath,
      tempExtractDir,
    });
    const topLevelFolders = await listTopLevelFolders(unzippedRootPath);
    const config = await readCfxUploaderConfig(
      unzippedRootPath,
      repository,
      fallbackConfig,
      { allowFallbackConfig },
    );
    const resolvedDeleteOldestVersionWhenCapped = typeof deleteOldestVersionWhenCapped === 'boolean'
      ? deleteOldestVersionWhenCapped
      : Boolean(config.deleteOldestVersionWhenCapped);
    const resolvedMaxPrereleaseVersionsToKeep = maxPrereleaseVersionsToKeep !== undefined
      ? normalizeMaxPrereleaseVersionsToKeep(maxPrereleaseVersionsToKeep)
      : config.maxPrereleaseVersionsToKeep;
    console.log(`Config source: ${config.configPath || config.configSource}`);
    console.log(`Portal asset: ${config.portalName}`);
    console.log(`Folders to ZIP: ${config.foldersToZip.join(', ')}`);
    console.log(`Delete oldest version when capped: ${resolvedDeleteOldestVersionWhenCapped}`);
    console.log(`Max prerelease versions to keep: ${resolvedMaxPrereleaseVersionsToKeep === null ? 'disabled' : resolvedMaxPrereleaseVersionsToKeep}`);

    createdZipPath = await createFilteredZip({
      unzippedRootPath,
      foldersToZip: config.foldersToZip,
      outputZipBaseName: config.foldersToZip[0],
      releasesDir,
    });
    if (path.resolve(downloadedZipPath).toLowerCase() !== path.resolve(createdZipPath).toLowerCase()) {
      await fs.rm(downloadedZipPath, { force: true });
      downloadedZipPath = null;
    }
    console.log(`Top-level folders in release: ${topLevelFolders.join(', ') || '(none)'}`);
    console.log(`Prepared ZIP path: ${createdZipPath}`);

    const metadata = await readZipMetadata(createdZipPath);
    console.log(`fxmanifest: ${metadata.fxmanifestPath}`);
    console.log(`Version: ${metadata.version}`);
    assertReleaseVersionMatchesManifest(releaseInfo.version, metadata.version);

    console.log(`Step 4/5: Authenticating to CFX (headless=${headless})...`);
    if (passkeySource) {
      console.log(`Passkey source: ${passkeySource}`);
    }
    const authContext = await authenticateToCfx({
      headless,
      credential: passkey,
    });
    browser = authContext.browser;

    console.log('Step 5/5: Uploading filtered ZIP to CFX asset...');
    const uploadResult = await uploadZipToCfxAsset({
      page: authContext.page,
      portalName: config.portalName,
      zipPath: createdZipPath,
      releaseCandidate: resolvedReleaseCandidate,
      deleteOldestVersionWhenCapped: resolvedDeleteOldestVersionWhenCapped,
      maxPrereleaseVersionsToKeep: resolvedMaxPrereleaseVersionsToKeep,
    });

    await new Promise((resolve) => setTimeout(resolve, 8000));

    console.log('Orchestration completed successfully.');
    return {
      success: true,
      mode: 'browser',
      repository,
      releaseTag,
      resolvedReleaseTag: releaseInfo.version,
      releaseCandidate: resolvedReleaseCandidate,
      portalName: config.portalName,
      version: metadata.version,
      deletedVersion: uploadResult.deletedVersion,
      deletedOldestVersion: uploadResult.deletedOldestVersion,
    };
  } finally {
    await cleanupTempExtractDir(tempExtractDir);
    await cleanupFile(downloadedZipPath, console.log);
    await cleanupFile(createdZipPath, console.log);

    if (browser) {
      await browser.close();
    }
  }
}

module.exports = {
  runBrowserUploadFlow,
};
