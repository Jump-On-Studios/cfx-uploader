const fs = require('fs/promises');
const path = require('path');
const AdmZip = require('adm-zip');

function parseFxManifestVersion(manifestText) {
  const match = manifestText.match(/(?:^|\s)version\s*(?:\(\s*)?['"]([^'"]+)['"]/im);
  return match ? match[1].trim() : null;
}

function detectGame(manifestText) {
  const lowerText = manifestText.toLowerCase();

  if (lowerText.includes('rdr3')) {
    return 'RedM';
  }

  if (lowerText.includes('gta5')) {
    return 'FiveM';
  }

  return null;
}

async function readZipMetadata(zipPath) {
  const stats = await fs.stat(zipPath);
  const zip = new AdmZip(zipPath);
  const manifestEntry = zip
    .getEntries()
    .find((entry) => !entry.isDirectory && path.basename(entry.entryName).toLowerCase() === 'fxmanifest.lua');

  if (!manifestEntry) {
    throw new Error(`ZIP metadata missing: no fxmanifest.lua found in ${zipPath}`);
  }

  const manifestText = manifestEntry.getData().toString('utf8');
  const version = parseFxManifestVersion(manifestText);

  if (!version) {
    throw new Error(`ZIP metadata missing: no version detected in ${manifestEntry.entryName}`);
  }

  return {
    zipPath,
    fileName: path.basename(zipPath),
    totalSize: stats.size,
    fxmanifestPath: manifestEntry.entryName,
    version,
    game: detectGame(manifestText),
  };
}

module.exports = {
  readZipMetadata,
  parseFxManifestVersion,
  detectGame,
};
