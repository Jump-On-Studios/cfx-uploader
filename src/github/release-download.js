/**
 * Module responsibility:
 * Fetch latest GitHub release metadata and download the source ZIP to /releases.
 */
const fs = require('fs/promises');
const { createWriteStream } = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

/**
 * Normalize potentially unsafe filenames before writing in `releases/`.
 * @param {string} name
 * @returns {string}
 */
function sanitizeFileName(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '-');
}

/**
 * Build GitHub request headers.
 * @param {string | undefined} githubToken
 * @param {string | null} [accept='application/vnd.github+json']
 * @returns {Record<string, string>}
 */
function buildGithubHeaders(githubToken, accept = 'application/vnd.github+json') {
  const headers = {
    'User-Agent': 'Jumpon Studios',
  };

  if (accept) {
    headers.Accept = accept;
  }

  if (githubToken) {
    headers.Authorization = `token ${githubToken}`;
  }

  return headers;
}

/**
 * Extract preferred downloadable ZIP info from a GitHub release payload.
 * It prefers ZIP assets and falls back to GitHub zipball when needed.
 * @param {Record<string, any>} release
 * @returns {{ url: string, fileName: string, version: string | null, source: 'asset' | 'zipball', body: string | null, prerelease: boolean } | null}
 */
function getDownloadInfoFromRelease(release) {
  const releaseFields = {
    version: release.tag_name || null,
    body: release.body || null,
    prerelease: Boolean(release.prerelease),
    releaseId: release.id || null,
    zipballUrl: release.zipball_url || null,
  };
  const zipAsset = findZipAsset(release);

  if (zipAsset) {
    return {
      ...releaseFields,
      url: zipAsset.browser_download_url,
      fileName: zipAsset.name,
      source: 'asset',
    };
  }

  return getZipballDownloadInfo(releaseFields);
}

function findZipAsset(release) {
  return (Array.isArray(release.assets) ? release.assets : []).find(
    (asset) => asset.name.endsWith('.zip') || asset.content_type === 'application/zip'
  ) || null;
}

/**
 * Switch release download info to the GitHub source zipball of the same release.
 * @param {Record<string, any>} releaseInfo
 * @returns {Record<string, any> | null}
 */
function getZipballDownloadInfo(releaseInfo) {
  if (!releaseInfo.zipballUrl) {
    return null;
  }

  return {
    ...releaseInfo,
    url: releaseInfo.zipballUrl,
    fileName: `${releaseInfo.version || 'latest'}.zip`,
    source: 'zipball',
  };
}

/**
 * Attach a ZIP to a GitHub release, unless the release already has one.
 * Needs a token with write access to the repository contents.
 * @param {{ repository: string, releaseId: number, zipPath: string, githubToken: string }} options
 * @returns {Promise<{ status: 'uploaded' | 'exists', name: string, url?: string }>}
 */
async function attachZipToRelease(options) {
  const { repository, releaseId, zipPath, githubToken } = options;
  const name = path.basename(zipPath);

  // The repository may attach its own build ZIP a few seconds after publication.
  const releaseResponse = await fetch(`https://api.github.com/repos/${repository}/releases/${releaseId}`, {
    headers: buildGithubHeaders(githubToken),
  });
  if (!releaseResponse.ok) {
    throw new Error(`GitHub API error for release ${releaseId}: ${releaseResponse.status} ${releaseResponse.statusText}`);
  }
  const existingZip = findZipAsset(await releaseResponse.json());
  if (existingZip) {
    return { status: 'exists', name: existingZip.name };
  }

  const zipBuffer = await fs.readFile(zipPath);
  const uploadResponse = await fetch(
    `https://uploads.github.com/repos/${repository}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`,
    {
      method: 'POST',
      headers: {
        ...buildGithubHeaders(githubToken),
        'Content-Type': 'application/zip',
      },
      body: zipBuffer,
    }
  );

  if (uploadResponse.status === 422) {
    return { status: 'exists', name };
  }

  if (!uploadResponse.ok) {
    throw new Error(`GitHub release asset upload failed: ${uploadResponse.status} ${await uploadResponse.text()}`);
  }

  const asset = await uploadResponse.json();
  return { status: 'uploaded', name: asset.name || name, url: asset.browser_download_url };
}

function getAlternateReleaseTag(releaseTag) {
  const normalizedTag = String(releaseTag || '').trim();
  if (!normalizedTag) {
    return null;
  }

  if (/^v/i.test(normalizedTag)) {
    return normalizedTag.slice(1);
  }

  return `v${normalizedTag}`;
}

function normalizeVersionForCompare(version) {
  return String(version || '').trim().replace(/^v(?=\d)/i, '');
}

function assertReleaseVersionMatchesManifest(releaseVersion, manifestVersion) {
  if (!releaseVersion) {
    return;
  }

  const normalizedReleaseVersion = normalizeVersionForCompare(releaseVersion);
  const normalizedManifestVersion = normalizeVersionForCompare(manifestVersion);

  if (normalizedReleaseVersion !== normalizedManifestVersion) {
    throw new Error(
      `Release tag version mismatch: release tag "${releaseVersion}" resolves to "${normalizedReleaseVersion}", but fxmanifest.lua contains "${manifestVersion}".`
    );
  }
}

/**
 * Resolve latest release download information from GitHub.
 * @param {{ repository: string, githubToken?: string }} options
 * @returns {Promise<{ url: string, fileName: string, version: string | null, source: 'asset' | 'zipball', body: string | null, prerelease: boolean } | null>}
 */
async function getLatestReleaseDownloadInfo(options) {
  const { repository, githubToken } = options;

  const response = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, {
    headers: buildGithubHeaders(githubToken),
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
  }

  return getDownloadInfoFromRelease(await response.json());
}

/**
 * Resolve release download information for a specific GitHub tag.
 * @param {{ repository: string, releaseTag: string, githubToken?: string }} options
 * @returns {Promise<{ url: string, fileName: string, version: string | null, source: 'asset' | 'zipball', body: string | null, prerelease: boolean } | null>}
 */
async function getReleaseDownloadInfoByTag(options) {
  const { repository, releaseTag, githubToken } = options;
  const encodedTag = encodeURIComponent(releaseTag);

  const response = await fetch(`https://api.github.com/repos/${repository}/releases/tags/${encodedTag}`, {
    headers: buildGithubHeaders(githubToken),
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`GitHub API error for release tag "${releaseTag}": ${response.status} ${response.statusText}`);
  }

  return getDownloadInfoFromRelease(await response.json());
}

function parseReleaseTagFromArgs(args = process.argv.slice(2)) {
  const explicitArg = args.find((arg) => arg.startsWith('--release-tag='));
  if (!explicitArg) {
    return null;
  }

  const releaseTag = explicitArg.split('=').slice(1).join('=').trim();
  if (!releaseTag) {
    throw new Error('Invalid value for --release-tag: tag cannot be empty.');
  }

  return releaseTag;
}

function resolveReleaseTag(args = process.argv.slice(2)) {
  const githubRefName = process.env.GITHUB_REF_TYPE === 'tag'
    ? process.env.GITHUB_REF_NAME
    : null;

  return (
    parseReleaseTagFromArgs(args) ||
    process.env.CFX_UPLOADER_RELEASE_TAG ||
    githubRefName ||
    null
  );
}

async function getReleaseDownloadInfo(options) {
  const { repository, githubToken, releaseTag } = options;

  if (releaseTag) {
    const primaryInfo = await getReleaseDownloadInfoByTag({
      repository,
      releaseTag,
      githubToken,
    });

    if (primaryInfo) {
      return primaryInfo;
    }

    const alternateReleaseTag = getAlternateReleaseTag(releaseTag);
    if (alternateReleaseTag && alternateReleaseTag !== releaseTag) {
      return getReleaseDownloadInfoByTag({
        repository,
        releaseTag: alternateReleaseTag,
        githubToken,
      });
    }

    return null;
  }

  return getLatestReleaseDownloadInfo({
    repository,
    githubToken,
  });
}

/**
 * Download a file URL to a local destination path.
 * @param {{ url: string, destinationPath: string, githubToken?: string }} options
 * @returns {Promise<void>}
 */
async function downloadFile(options) {
  const { url, destinationPath, githubToken } = options;

  const response = await fetch(url, {
    headers: buildGithubHeaders(githubToken, null),
    redirect: 'follow',
  });

  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }

  if (!response.body) {
    throw new Error('Download failed: empty response body.');
  }

  await pipeline(Readable.fromWeb(response.body), createWriteStream(destinationPath));
}

/**
 * Download the release ZIP into `releasesDir` and return the full path.
 * @param {{
 *   releaseInfo: { url: string, fileName: string, version: string | null },
 *   releasesDir: string,
 *   githubToken?: string
 * }} options
 * @returns {Promise<string>}
 */
async function downloadReleaseZip(options) {
  const { releaseInfo, releasesDir, githubToken } = options;

  await fs.mkdir(releasesDir, { recursive: true });

  const safeName = sanitizeFileName(
    releaseInfo.fileName.endsWith('.zip') ? releaseInfo.fileName : `${releaseInfo.fileName}.zip`
  );
  const downloadedZipPath = path.join(releasesDir, safeName);

  await downloadFile({
    url: releaseInfo.url,
    destinationPath: downloadedZipPath,
    githubToken,
  });

  return downloadedZipPath;
}

module.exports = {
  getDownloadInfoFromRelease,
  getZipballDownloadInfo,
  attachZipToRelease,
  getAlternateReleaseTag,
  normalizeVersionForCompare,
  assertReleaseVersionMatchesManifest,
  getLatestReleaseDownloadInfo,
  getReleaseDownloadInfoByTag,
  getReleaseDownloadInfo,
  parseReleaseTagFromArgs,
  resolveReleaseTag,
  downloadReleaseZip,
};
