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
 * @returns {{ url: string, fileName: string, version: string | null, source: 'asset' | 'zipball' } | null}
 */
function getDownloadInfoFromRelease(release) {
  if (Array.isArray(release.assets) && release.assets.length > 0) {
    const zipAsset = release.assets.find(
      (asset) => asset.name.endsWith('.zip') || asset.content_type === 'application/zip'
    );

    if (zipAsset) {
      return {
        url: zipAsset.browser_download_url,
        fileName: zipAsset.name,
        version: release.tag_name || null,
        source: 'asset',
        body: release.body || null,
      };
    }
  }

  if (!release.zipball_url) {
    return null;
  }

  return {
    url: release.zipball_url,
    fileName: `${release.tag_name || 'latest'}.zip`,
    version: release.tag_name || null,
    source: 'zipball',
    body: release.body || null,
  };
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
 * @returns {Promise<{ url: string, fileName: string, version: string | null, source: 'asset' | 'zipball' } | null>}
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
 * @returns {Promise<{ url: string, fileName: string, version: string | null, source: 'asset' | 'zipball' } | null>}
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
