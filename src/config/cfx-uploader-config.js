/**
 * Module responsibility:
 * Resolve runtime upload config from the downloaded repository release.
 */
const fs = require('fs/promises');
const path = require('path');
const { normalizeMaxPrereleaseVersionsToKeep } = require('../utils/prerelease-retention');

const CONFIG_FILE_NAME = 'cfx_uploader.json';

function isGitHubActions() {
  return process.env.GITHUB_ACTIONS === 'true';
}

function resolveGithubRepository(fallbackConfig = {}) {
  const githubRepository = process.env.GITHUB_REPOSITORY || fallbackConfig.githubRepository;

  if (!githubRepository || typeof githubRepository !== 'string') {
    throw new Error('Missing GitHub repository. Set GITHUB_REPOSITORY or mockConfig.githubRepository.');
  }

  return githubRepository;
}

function normalizeConfig(rawConfig, githubRepository, sourcePath) {
  if (!rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
    throw new Error(`Invalid ${CONFIG_FILE_NAME}: expected a JSON object.`);
  }

  const portalName = typeof rawConfig.portalName === 'string' ? rawConfig.portalName.trim() : '';
  if (!portalName) {
    throw new Error(`Invalid ${CONFIG_FILE_NAME}: portalName must be a non-empty string.`);
  }

  if (!Array.isArray(rawConfig.foldersToZip)) {
    throw new Error(`Invalid ${CONFIG_FILE_NAME}: foldersToZip must be a non-empty string array.`);
  }

  const foldersToZip = rawConfig.foldersToZip
    .map((folderName) => (typeof folderName === 'string' ? folderName.trim() : ''))
    .filter(Boolean);

  if (foldersToZip.length === 0) {
    throw new Error(`Invalid ${CONFIG_FILE_NAME}: foldersToZip must contain at least one folder.`);
  }

  if (
    rawConfig.deleteOldestVersionWhenCapped !== undefined &&
    typeof rawConfig.deleteOldestVersionWhenCapped !== 'boolean'
  ) {
    throw new Error(`Invalid ${CONFIG_FILE_NAME}: deleteOldestVersionWhenCapped must be a boolean when provided.`);
  }

  const maxPrereleaseVersionsToKeep = (() => {
    try {
      return normalizeMaxPrereleaseVersionsToKeep(rawConfig.maxPrereleaseVersionsToKeep);
    } catch (error) {
      throw new Error(`Invalid ${CONFIG_FILE_NAME}: ${error.message}`);
    }
  })();

  return {
    githubRepository,
    portalName,
    foldersToZip,
    deleteOldestVersionWhenCapped: Boolean(rawConfig.deleteOldestVersionWhenCapped),
    maxPrereleaseVersionsToKeep,
    configPath: sourcePath,
    configSource: sourcePath ? CONFIG_FILE_NAME : 'mock-config.js',
  };
}

async function readCfxUploaderConfig(unzippedRootPath, githubRepository, fallbackConfig = {}) {
  const configPath = path.join(unzippedRootPath, CONFIG_FILE_NAME);

  try {
    const configText = await fs.readFile(configPath, 'utf8');
    let parsedConfig;

    try {
      parsedConfig = JSON.parse(configText);
    } catch (error) {
      throw new Error(`Invalid ${CONFIG_FILE_NAME}: ${error.message}`);
    }

    return normalizeConfig(parsedConfig, githubRepository, configPath);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }

    if (isGitHubActions()) {
      throw new Error(`Missing ${CONFIG_FILE_NAME} at repository root: ${configPath}`);
    }

    return normalizeConfig(fallbackConfig, githubRepository, null);
  }
}

module.exports = {
  CONFIG_FILE_NAME,
  resolveGithubRepository,
  readCfxUploaderConfig,
  normalizeConfig,
};
