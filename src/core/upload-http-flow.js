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
const { createCfxHttpSession } = require('../cfx/http-session');
const { findAssetByExactName, getAssetDetails } = require('../cfx/http-assets');
const { uploadZipVersionHttp } = require('../cfx/http-upload');

async function runHttpUploadFlow(options) {
  const {
    projectRoot,
    repository,
    releaseTag = null,
    githubToken,
    passkey,
    passkeySource,
    fallbackConfig = {},
    headless = true,
    changelog = null,
    releasesDir = path.join(projectRoot, 'releases'),
    tempExtractDir = path.join(releasesDir, '.tmp-extract'),
    onLog = (message) => console.log(message),
  } = options;
  const log = (message, meta) => onLog(message, meta);

  let downloadedZipPath = null;
  let createdZipPath = null;
  let browser = null;

  try {
    log('=== CFX Uploader HTTP Orchestrator ===');
    log(`GitHub repository: ${repository}`, { repository });
    log(`Release target: ${releaseTag || 'latest'}`, { releaseTag });
    log(`Browser mode: ${headless ? 'headless' : 'visible'}`, { headless });

    log('\nStep 1/6: Resolving GitHub release asset');
    const releaseInfo = await getReleaseDownloadInfo({
      repository,
      releaseTag,
      githubToken,
    });

    if (!releaseInfo) {
      throw new Error(`No downloadable release found for ${repository}${releaseTag ? ` tag ${releaseTag}` : ''}.`);
    }

    log('\nStep 2/6: Downloading release ZIP');
    downloadedZipPath = await downloadReleaseZip({
      releaseInfo,
      releasesDir,
      githubToken,
    });

    log('\nStep 3/6: Reading cfx_uploader.json and rebuilding filtered ZIP');
    const unzippedRootPath = await unzipDownloadedRelease({
      downloadedZipPath,
      tempExtractDir,
    });
    const topLevelFolders = await listTopLevelFolders(unzippedRootPath);
    const config = await readCfxUploaderConfig(unzippedRootPath, repository, fallbackConfig);
    log(`Config source: ${config.configPath || config.configSource}`);
    log(`Portal asset: ${config.portalName}`, { portalName: config.portalName });
    log(`Folders to ZIP: ${config.foldersToZip.join(', ')}`, { foldersToZip: config.foldersToZip });

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
    log(`Top-level folders in release: ${topLevelFolders.join(', ') || '(none)'}`);
    log(`Filtered ZIP ready: ${createdZipPath}`, { zipPath: createdZipPath });

    log('\nStep 4/6: Reading ZIP metadata');
    const metadata = await readZipMetadata(createdZipPath);
    log(`fxmanifest: ${metadata.fxmanifestPath}`);
    log(`Version: ${metadata.version}`, { version: metadata.version });
    assertReleaseVersionMatchesManifest(releaseInfo.version, metadata.version);
    if (metadata.game) {
      log(`Detected game: ${metadata.game}`, { game: metadata.game });
    } else {
      log('Warning: game not detected from fxmanifest.lua; upload will continue without sending game metadata', { level: 'warn' });
    }

    log('\nStep 5/6: Authenticating with CFX in browser');
    if (passkeySource) {
      log(`Passkey source: ${passkeySource}`);
    }
    const authResult = await authenticateToCfx({
      headless,
      credential: passkey,
    });
    browser = authResult.browser;
    const session = await createCfxHttpSession(authResult.page);

    log('\nStep 6/6: Uploading through CFX HTTP API');
    const asset = await findAssetByExactName(session, config.portalName);
    const assetDetails = await getAssetDetails(session, asset.id);
    const uploadResult = await uploadZipVersionHttp(session, {
      asset,
      assetDetails,
      metadata,
      zipPath: createdZipPath,
      changelog: changelog ?? releaseInfo.body,
    });

    log(`HTTP upload complete: asset=${uploadResult.assetId}, version_id=${uploadResult.versionId}, version=${uploadResult.version}`);

    return {
      success: true,
      mode: 'http',
      repository,
      releaseTag,
      resolvedReleaseTag: releaseInfo.version,
      portalName: config.portalName,
      version: uploadResult.version,
      assetId: uploadResult.assetId,
      versionId: uploadResult.versionId,
      finalAsset: uploadResult.finalAsset,
    };
  } finally {
    await cleanupTempExtractDir(tempExtractDir);
    await cleanupFile(downloadedZipPath, log);
    await cleanupFile(createdZipPath, log);

    if (browser) {
      await browser.close();
    }
  }
}

module.exports = {
  runHttpUploadFlow,
};
