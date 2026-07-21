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
const { resolveCfxHttpSession } = require('../auth/cfx-session');
const { findAssetByExactName, getAssetDetails } = require('../cfx/http-assets');
const { uploadZipVersionHttp } = require('../cfx/http-upload');
const { normalizeMaxPrereleaseVersionsToKeep } = require('../utils/prerelease-retention');

async function runHttpUploadFlow(options) {
  const {
    projectRoot,
    repository,
    releaseTag = null,
    githubToken,
    auth,
    passkey,
    passkeySource,
    fallbackConfig = {},
    allowFallbackConfig = false,
    headless = true,
    releaseCandidate,
    deleteOldestVersionWhenCapped,
    maxPrereleaseVersionsToKeep,
    changelog = null,
    sessionCachePath = null,
    sessionEncryptionKey = null,
    authTimeoutMs,
    twoFactorTimeoutMs,
    releasesDir = path.join(projectRoot, 'releases'),
    tempExtractDir = path.join(releasesDir, '.tmp-extract'),
    onLog = (message) => console.log(message),
    onProgress = null,
  } = options;
  const log = (message, meta) => onLog(message, meta);
  const progress = async (event) => {
    if (typeof onProgress !== 'function') {
      return;
    }

    try {
      await onProgress({
        scope: 'cfx-uploader',
        mode: 'http',
        status: 'running',
        meta: {},
        ...event,
        meta: event.meta || {},
      });
    } catch (error) {
      log(`Warning: onProgress handler failed: ${error?.message || String(error)}`, { level: 'warn' });
    }
  };

  let downloadedZipPath = null;
  let createdZipPath = null;

  try {
    log('=== CFX Uploader HTTP Orchestrator ===');
    log(`GitHub repository: ${repository}`, { repository });
    log(`Release target: ${releaseTag || 'latest'}`, { releaseTag });
    log(`Browser mode: ${headless ? 'headless' : 'visible'}`, { headless });

    await progress({
      step: 'resolve-release',
      label: 'Resolving GitHub release asset',
      index: 1,
      total: 6,
      meta: { repository, releaseTag },
    });
    log('\nStep 1/6: Resolving GitHub release asset');
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
    log(`GitHub prerelease: ${Boolean(releaseInfo.prerelease)}`, { githubPrerelease: Boolean(releaseInfo.prerelease) });
    log(`CFX release candidate: ${resolvedReleaseCandidate}`, { releaseCandidate: resolvedReleaseCandidate });

    await progress({
      step: 'download-release',
      label: 'Downloading release ZIP',
      index: 2,
      total: 6,
      meta: {
        resolvedReleaseTag: releaseInfo.version,
        githubPrerelease: Boolean(releaseInfo.prerelease),
        releaseCandidate: resolvedReleaseCandidate,
      },
    });
    log('\nStep 2/6: Downloading release ZIP');
    downloadedZipPath = await downloadReleaseZip({
      releaseInfo,
      releasesDir,
      githubToken,
    });

    await progress({
      step: 'prepare-zip',
      label: 'Reading cfx_uploader.json and rebuilding filtered ZIP',
      index: 3,
      total: 6,
      meta: { downloadedZipPath },
    });
    log('\nStep 3/6: Reading cfx_uploader.json and rebuilding filtered ZIP');
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
    log(`Config source: ${config.configPath || config.configSource}`);
    log(`Portal asset: ${config.portalName}`, { portalName: config.portalName });
    log(`Folders to ZIP: ${config.foldersToZip.join(', ')}`, { foldersToZip: config.foldersToZip });
    log(`Delete oldest version when capped: ${resolvedDeleteOldestVersionWhenCapped}`, {
      deleteOldestVersionWhenCapped: resolvedDeleteOldestVersionWhenCapped,
    });
    log(`Max prerelease versions to keep: ${resolvedMaxPrereleaseVersionsToKeep === null ? 'disabled' : resolvedMaxPrereleaseVersionsToKeep}`, {
      maxPrereleaseVersionsToKeep: resolvedMaxPrereleaseVersionsToKeep,
    });
    await progress({
      step: 'prepare-zip',
      label: `Config loaded for ${config.portalName}`,
      index: 3,
      total: 6,
      meta: {
        portalName: config.portalName,
        foldersToZip: config.foldersToZip,
        deleteOldestVersionWhenCapped: resolvedDeleteOldestVersionWhenCapped,
        maxPrereleaseVersionsToKeep: resolvedMaxPrereleaseVersionsToKeep,
      },
    });

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

    await progress({
      step: 'read-metadata',
      label: 'Reading ZIP metadata',
      index: 4,
      total: 6,
      meta: { zipPath: createdZipPath },
    });
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
    await progress({
      step: 'read-metadata',
      label: `Detected version ${metadata.version}`,
      index: 4,
      total: 6,
      meta: {
        fxmanifestPath: metadata.fxmanifestPath,
        version: metadata.version,
        game: metadata.game,
      },
    });

    await progress({
      step: 'authenticate-cfx',
      label: 'Authenticating with CFX',
      index: 5,
      total: 6,
      meta: { headless, authMethod: auth?.method || (passkey ? 'passkey' : 'cached') },
    });
    log('\nStep 5/6: Resolving authenticated CFX session');
    if (passkeySource) {
      log(`Passkey source: ${passkeySource}`);
    }
    const sessionResult = await resolveCfxHttpSession({
      headless,
      auth,
      credential: passkey,
      sessionCachePath,
      sessionEncryptionKey,
      authTimeoutMs,
      twoFactorTimeoutMs,
    });
    const session = sessionResult.session;
    log(`CFX authentication method: ${sessionResult.authMethod}`, { authMethod: sessionResult.authMethod });
    log(`CFX session reused: ${sessionResult.sessionReused}`, { sessionReused: sessionResult.sessionReused });
    await progress({
      step: 'authenticate-cfx',
      label: sessionResult.sessionReused ? 'Reused authenticated CFX session' : 'Authenticated CFX session ready',
      index: 5,
      total: 6,
      meta: {
        authMethod: sessionResult.authMethod,
        sessionReused: sessionResult.sessionReused,
      },
    });

    await progress({
      step: 'upload-cfx',
      label: 'Uploading through CFX HTTP API',
      index: 6,
      total: 6,
      meta: { portalName: config.portalName },
    });
    log('\nStep 6/6: Uploading through CFX HTTP API');
    const asset = await findAssetByExactName(session, config.portalName);
    await progress({
      step: 'upload-cfx',
      label: `CFX asset found: ${asset.name}`,
      index: 6,
      total: 6,
      meta: {
        assetId: asset.id,
        portalName: asset.name,
      },
    });
    const assetDetails = await getAssetDetails(session, asset.id);
    const uploadResult = await uploadZipVersionHttp(session, {
      asset,
      assetDetails,
      metadata,
      zipPath: createdZipPath,
      changelog: changelog ?? releaseInfo.body,
      releaseCandidate: resolvedReleaseCandidate,
      deleteOldestVersionWhenCapped: resolvedDeleteOldestVersionWhenCapped,
      maxPrereleaseVersionsToKeep: resolvedMaxPrereleaseVersionsToKeep,
    });

    if (uploadResult.deletedVersion) {
      await progress({
        step: 'upload-cfx',
        label: `Deleted old CFX version ${uploadResult.deletedVersion.version}`,
        index: 6,
        total: 6,
        meta: {
          deletedVersion: uploadResult.deletedVersion,
        },
      });
    }

    await progress({
      step: 'upload-cfx',
      label: `CFX upload finalized: ${uploadResult.version}`,
      index: 6,
      total: 6,
      status: 'completed',
      meta: {
        assetId: uploadResult.assetId,
        versionId: uploadResult.versionId,
        version: uploadResult.version,
      },
    });
    log(`HTTP upload complete: asset=${uploadResult.assetId}, version_id=${uploadResult.versionId}, version=${uploadResult.version}`);

    return {
      success: true,
      mode: 'http',
      repository,
      releaseTag,
      resolvedReleaseTag: releaseInfo.version,
      releaseCandidate: resolvedReleaseCandidate,
      authMethod: sessionResult.authMethod,
      sessionReused: sessionResult.sessionReused,
      portalName: config.portalName,
      version: uploadResult.version,
      assetId: uploadResult.assetId,
      versionId: uploadResult.versionId,
      deletedVersion: uploadResult.deletedVersion,
      deletedOldestVersion: uploadResult.deletedOldestVersion,
      finalAsset: uploadResult.finalAsset,
    };
  } finally {
    await cleanupTempExtractDir(tempExtractDir);
    await cleanupFile(downloadedZipPath, log);
    await cleanupFile(createdZipPath, log);

  }
}

module.exports = {
  runHttpUploadFlow,
};
