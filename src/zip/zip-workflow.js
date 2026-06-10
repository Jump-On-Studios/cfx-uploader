/**
 * Module responsibility:
 * Unzip release archives, list extracted folders, and create filtered ZIP outputs.
 */
const fs = require('fs/promises');
const path = require('path');
const AdmZip = require('adm-zip');

/**
 * Local filename sanitization for generated ZIP names.
 * @param {string} name
 * @returns {string}
 */
function sanitizeFileName(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '-');
}

/**
 * Unzip a downloaded release into a temporary directory.
 * Returns the effective unzipped root (single top-level dir or temp root).
 * @param {{ downloadedZipPath: string, tempExtractDir: string }} options
 * @returns {Promise<string>}
 */
async function unzipDownloadedRelease(options) {
  const { downloadedZipPath, tempExtractDir } = options;

  await fs.rm(tempExtractDir, { recursive: true, force: true });
  await fs.mkdir(tempExtractDir, { recursive: true });

  const zip = new AdmZip(downloadedZipPath);
  zip.extractAllTo(tempExtractDir, true);

  const rootEntries = await fs.readdir(tempExtractDir, { withFileTypes: true });
  if (rootEntries.length === 0) {
    throw new Error('Unzip produced no files.');
  }

  const topLevelDirs = rootEntries.filter((entry) => entry.isDirectory());
  if (topLevelDirs.length === 1) {
    return path.join(tempExtractDir, topLevelDirs[0].name);
  }

  return tempExtractDir;
}

/**
 * Read and list top-level folders found in the unzipped release root.
 * @param {string} unzippedRootPath
 * @returns {Promise<string[]>}
 */
async function listTopLevelFolders(unzippedRootPath) {
  const entries = await fs.readdir(unzippedRootPath, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

/**
 * Create a new ZIP containing only the requested folders.
 * @param {{
 *   unzippedRootPath: string,
 *   foldersToZip: string[],
 *   outputZipBaseName: string,
 *   releasesDir: string
 * }} options
 * @returns {Promise<string>}
 */
async function createFilteredZip(options) {
  const { unzippedRootPath, foldersToZip, outputZipBaseName, releasesDir } = options;

  if (!Array.isArray(foldersToZip) || foldersToZip.length === 0) {
    throw new Error('foldersToZip is empty.');
  }

  const normalizedFolders = foldersToZip.map((name) => String(name).trim()).filter(Boolean);
  if (normalizedFolders.length === 0) {
    throw new Error('foldersToZip only contains empty values.');
  }

  const outputZipPath = path.join(releasesDir, `${sanitizeFileName(outputZipBaseName)}.zip`);
  const zip = new AdmZip();

  for (const folderName of normalizedFolders) {
    const sourceFolder = path.join(unzippedRootPath, folderName);

    let stat;
    try {
      stat = await fs.stat(sourceFolder);
    } catch {
      throw new Error(`Folder "${folderName}" not found in unzipped release: ${unzippedRootPath}`);
    }

    if (!stat.isDirectory()) {
      throw new Error(`Path "${sourceFolder}" is not a directory.`);
    }

    zip.addLocalFolder(sourceFolder, folderName);
  }

  await fs.mkdir(releasesDir, { recursive: true });
  zip.writeZip(outputZipPath);
  return outputZipPath;
}

/**
 * Orchestrate unzip + folder listing + rezip and remove downloaded ZIP.
 * Temporary extraction cleanup is intentionally done by the caller.
 * @param {{
 *   downloadedZipPath: string,
 *   tempExtractDir: string,
 *   foldersToZip: string[],
 *   releasesDir: string
 * }} options
 * @returns {Promise<{ createdZipPath: string, unzippedRootPath: string, topLevelFolders: string[] }>}
 */
async function prepareFilteredZipFromDownloadedRelease(options) {
  const { downloadedZipPath, tempExtractDir, foldersToZip, releasesDir } = options;

  const unzippedRootPath = await unzipDownloadedRelease({
    downloadedZipPath,
    tempExtractDir,
  });
  const topLevelFolders = await listTopLevelFolders(unzippedRootPath);

  // Product rule: final zip name must be based on foldersToZip[0].
  const outputZipBaseName = String(foldersToZip[0] || '').trim();
  if (!outputZipBaseName) {
    throw new Error('foldersToZip[0] is required to name the final ZIP.');
  }

  const createdZipPath = await createFilteredZip({
    unzippedRootPath,
    foldersToZip,
    outputZipBaseName,
    releasesDir,
  });

  const samePath =
    path.resolve(downloadedZipPath).toLowerCase() === path.resolve(createdZipPath).toLowerCase();
  if (!samePath) {
    await fs.rm(downloadedZipPath, { force: true });
  }

  return {
    createdZipPath,
    unzippedRootPath,
    topLevelFolders,
  };
}

/**
 * Remove a generated/downloaded file without masking the original workflow result.
 * @param {string | null | undefined} filePath
 * @param {(message: string, meta?: object) => void} [log]
 * @returns {Promise<void>}
 */
async function cleanupFile(filePath, log = () => {}) {
  if (!filePath) {
    return;
  }

  try {
    await fs.stat(filePath);
    await fs.rm(filePath, { force: true });
    log(`Deleted local file: ${filePath}`, { filePath });
  } catch (error) {
    if (error.code === 'ENOENT') {
      return;
    }

    log(`Warning: failed to delete local file ${filePath}: ${error.message}`, {
      level: 'warn',
      filePath,
    });
  }
}

/**
 * Remove temporary extraction folder.
 * @param {string} tempExtractDir
 * @returns {Promise<void>}
 */
async function cleanupTempExtractDir(tempExtractDir) {
  await fs.rm(tempExtractDir, { recursive: true, force: true });
}

module.exports = {
  unzipDownloadedRelease,
  listTopLevelFolders,
  createFilteredZip,
  prepareFilteredZipFromDownloadedRelease,
  cleanupFile,
  cleanupTempExtractDir,
};
