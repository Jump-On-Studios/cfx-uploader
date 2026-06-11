const fs = require('fs/promises');
const { cfxJson, cfxFetch, readResponseBody } = require('./http-session');
const { getAssetDetails } = require('./http-assets');

const DEFAULT_CHUNK_COUNT = 4;
const DEFAULT_CHANGELOG = 'Automated upload from cfx-uploader.';
const DEFAULT_POLL_TIMEOUT_MS = 120000;
const DEFAULT_POLL_INTERVAL_MS = 3000;
const MAX_VERSIONS_ERROR_CODE = 'MAX_VERSIONS_REACHED';
const MAX_VERSIONS_MESSAGE = 'CFX asset has reached the maximum of 5 versions. Enable deleteOldestVersionWhenCapped to delete the oldest version automatically.';

function findVersionByValue(assetDetails, version) {
  return (assetDetails.versions || []).find((candidate) => candidate && candidate.version === version);
}

function findVersionById(assetDetails, versionId) {
  return (assetDetails.versions || []).find((candidate) => candidate && candidate.id === versionId);
}

function assertVersionDoesNotExist(assetDetails, version) {
  if (findVersionByValue(assetDetails, version)) {
    throw new Error(`Version already exists on asset "${assetDetails.name}" (${assetDetails.id}): ${version}`);
  }
}

function splitIntoChunks(buffer, targetChunkCount = DEFAULT_CHUNK_COUNT) {
  const chunkCount = Math.max(1, Math.min(targetChunkCount, buffer.length || 1));
  const chunkSize = Math.ceil(buffer.length / chunkCount);
  const chunks = [];

  for (let chunkId = 0; chunkId < chunkCount; chunkId += 1) {
    const start = chunkId * chunkSize;
    const end = Math.min(start + chunkSize, buffer.length);
    const chunk = buffer.subarray(start, end);

    if (chunk.length > 0) {
      chunks.push({ chunkId, chunk });
    }
  }

  return {
    chunks,
    chunkCount: chunks.length,
    chunkSize,
  };
}

async function createReUpload(session, assetId, metadata, chunkPlan, changelog = DEFAULT_CHANGELOG, releaseCandidate = false) {
  const path = `/v1/assets/${assetId}/re-upload`;
  const response = await cfxFetch(session, path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      name: metadata.portalName,
      chunk_count: chunkPlan.chunkCount,
      chunk_size: chunkPlan.chunkSize,
      total_size: metadata.totalSize,
      original_file_name: metadata.fileName,
      release_candidate: Boolean(releaseCandidate),
      version: metadata.version,
      changelog,
    }),
  });
  const body = await readResponseBody(response);

  if (!response.ok) {
    const error = new Error(`POST ${session.apiOrigin}${path} failed (${response.status}): ${body}`);
    error.status = response.status;
    error.body = body;

    try {
      error.payload = body ? JSON.parse(body) : {};
    } catch {
      error.payload = null;
    }

    throw error;
  }

  let payload;
  try {
    payload = body ? JSON.parse(body) : {};
  } catch {
    throw new Error(`Invalid JSON response from ${session.apiOrigin}${path}: ${body}`);
  }

  if (payload.errors) {
    throw new Error(`CFX re-upload rejected: ${JSON.stringify(payload.errors)}`);
  }

  if (!payload.version_id) {
    throw new Error(`CFX re-upload response missing version_id: ${JSON.stringify(payload)}`);
  }

  return payload;
}

function isMaxVersionsReachedError(error) {
  return (
    error &&
    error.status === 409 &&
    error.payload &&
    error.payload.error_code === MAX_VERSIONS_ERROR_CODE
  );
}

function sortVersionsByCreatedAt(versions) {
  return [...versions].sort((a, b) => {
    const aTime = Date.parse(a.created_at || '');
    const bTime = Date.parse(b.created_at || '');

    if (Number.isNaN(aTime) && Number.isNaN(bTime)) {
      return 0;
    }

    if (Number.isNaN(aTime)) {
      return 1;
    }

    if (Number.isNaN(bTime)) {
      return -1;
    }

    return aTime - bTime;
  });
}

function findOldestVersion(versions) {
  return sortVersionsByCreatedAt(versions)[0] || null;
}

function normalizeDeletedVersion(version) {
  if (!version) {
    return null;
  }

  return {
    id: version.id,
    version: version.version,
    created_at: version.created_at,
    releaseCandidate: Boolean(version.is_release_candidate),
    reason: 'asset-version-cap',
  };
}

function resolveVersionToDeleteForCap(assetDetails, options = {}) {
  const { releaseCandidate = false, maxPrereleaseVersionsToKeep = null } = options;
  const versions = (assetDetails.versions || []).filter((version) => version && version.id);

  if (versions.length === 0) {
    return null;
  }

  if (maxPrereleaseVersionsToKeep === null || maxPrereleaseVersionsToKeep === undefined) {
    return findOldestVersion(versions);
  }

  const prereleaseVersions = versions.filter((version) => Boolean(version.is_release_candidate));
  const stableVersions = versions.filter((version) => !Boolean(version.is_release_candidate));

  if (releaseCandidate) {
    if (prereleaseVersions.length >= maxPrereleaseVersionsToKeep && prereleaseVersions.length > 0) {
      return findOldestVersion(prereleaseVersions);
    }

    return findOldestVersion(stableVersions) || findOldestVersion(prereleaseVersions) || findOldestVersion(versions);
  }

  return findOldestVersion(stableVersions) || findOldestVersion(prereleaseVersions) || findOldestVersion(versions);
}

async function deleteAssetVersion(session, assetId, version) {
  const response = await cfxFetch(session, `/v1/assets/${assetId}/versions/${version.id}`, {
    method: 'DELETE',
  });
  const body = await readResponseBody(response);

  if (!response.ok) {
    throw new Error(`DELETE ${session.apiOrigin}/v1/assets/${assetId}/versions/${version.id} failed (${response.status}): ${body}`);
  }

  return body ? JSON.parse(body) : {};
}

async function waitForDeletedVersion(session, assetId, deletedVersionId, options = {}) {
  const timeoutMs = options.timeoutMs || 30000;
  const intervalMs = options.intervalMs || 1500;
  const startedAt = Date.now();
  let lastAssetDetails = null;

  while (Date.now() - startedAt < timeoutMs) {
    lastAssetDetails = await getAssetDetails(session, assetId);
    const versions = lastAssetDetails.versions || [];
    const deletedStillExists = versions.some((version) => version && version.id === deletedVersionId);

    if (!deletedStillExists || versions.length < 5) {
      return lastAssetDetails;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Timed out waiting for CFX version deletion: ${JSON.stringify(summarizeAssetState(lastAssetDetails || {}, deletedVersionId))}`);
}

async function deleteVersionForCap(session, assetId, options = {}) {
  const cappedAssetDetails = await getAssetDetails(session, assetId);
  const versionToDelete = resolveVersionToDeleteForCap(cappedAssetDetails, options);

  if (!versionToDelete) {
    throw new Error(`CFX asset ${assetId} is capped but no deletable version was found.`);
  }

  const deletedVersion = normalizeDeletedVersion(versionToDelete);
  await deleteAssetVersion(session, assetId, versionToDelete);
  await waitForDeletedVersion(session, assetId, versionToDelete.id);
  console.log(
    `Deleted CFX version before retry: version=${deletedVersion.version}, release_candidate=${deletedVersion.releaseCandidate}, reason=${deletedVersion.reason}`
  );

  return deletedVersion;
}

async function createReUploadWithCapHandling(session, options) {
  const {
    assetId,
    metadata,
    chunkPlan,
    changelog,
    releaseCandidate,
    deleteOldestVersionWhenCapped,
    maxPrereleaseVersionsToKeep,
  } = options;

  try {
    return {
      createPayload: await createReUpload(session, assetId, metadata, chunkPlan, changelog, releaseCandidate),
      deletedVersion: null,
    };
  } catch (error) {
    if (!isMaxVersionsReachedError(error)) {
      throw error;
    }

    if (!deleteOldestVersionWhenCapped) {
      throw new Error(MAX_VERSIONS_MESSAGE);
    }

    const deletedVersion = await deleteVersionForCap(session, assetId, {
      releaseCandidate,
      maxPrereleaseVersionsToKeep,
    });

    return {
      createPayload: await createReUpload(session, assetId, metadata, chunkPlan, changelog, releaseCandidate),
      deletedVersion,
    };
  }
}

async function uploadChunk(session, assetId, versionId, chunkId, chunk) {
  const form = new FormData();
  form.set('chunk_id', String(chunkId));
  form.set('chunk', new Blob([chunk], { type: 'application/octet-stream' }), 'blob');

  const response = await cfxFetch(session, `/v1/assets/${assetId}/versions/${versionId}/upload-chunk`, {
    method: 'POST',
    body: form,
  });

  const body = await readResponseBody(response);

  if (!response.ok) {
    throw new Error(`Chunk upload failed for chunk_id=${chunkId} (${response.status}): ${body}`);
  }

  return body ? JSON.parse(body) : {};
}

async function completeUpload(session, assetId, versionId) {
  return cfxJson(session, `/v1/assets/${assetId}/versions/${versionId}/complete-upload`, {
    method: 'POST',
  });
}

function summarizeAssetState(assetDetails, versionId) {
  const version = findVersionById(assetDetails, versionId)
    || (assetDetails.versions || [])[0]
    || null;

  return {
    state: assetDetails.state,
    chunk_status: assetDetails.chunk_status,
    latestVersion: version
      ? {
        id: version.id,
        version: version.version,
        state: version.state,
      }
      : null,
  };
}

async function pollUntilActive(session, assetId, versionId, options = {}) {
  const timeoutMs = options.timeoutMs || DEFAULT_POLL_TIMEOUT_MS;
  const intervalMs = options.intervalMs || DEFAULT_POLL_INTERVAL_MS;
  const startedAt = Date.now();
  let lastAssetDetails = null;

  while (Date.now() - startedAt < timeoutMs) {
    lastAssetDetails = await getAssetDetails(session, assetId);
    const version = findVersionById(lastAssetDetails, versionId);

    if (lastAssetDetails.state === 'active' && (!version || version.state === 'active')) {
      return lastAssetDetails;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`CFX poll timeout waiting for ACTIVE: ${JSON.stringify(summarizeAssetState(lastAssetDetails || {}, versionId))}`);
}

async function uploadZipVersionHttp(session, options) {
  const {
    asset,
    assetDetails,
    metadata,
    zipPath,
    changelog = DEFAULT_CHANGELOG,
    releaseCandidate = false,
    deleteOldestVersionWhenCapped = false,
    maxPrereleaseVersionsToKeep = null,
  } = options;

  const preparedMetadata = {
    ...metadata,
    portalName: asset.name,
  };

  const latestAssetDetails = await getAssetDetails(session, asset.id);
  assertVersionDoesNotExist(latestAssetDetails || assetDetails, preparedMetadata.version);

  const zipBuffer = await fs.readFile(zipPath);
  const chunkPlan = splitIntoChunks(zipBuffer);

  console.log(`Creating HTTP upload: version=${preparedMetadata.version}, chunks=${chunkPlan.chunkCount}, chunk_size=${chunkPlan.chunkSize}, release_candidate=${Boolean(releaseCandidate)}`);
  const { createPayload, deletedVersion } = await createReUploadWithCapHandling(session, {
    assetId: asset.id,
    metadata: preparedMetadata,
    chunkPlan,
    changelog,
    releaseCandidate,
    deleteOldestVersionWhenCapped,
    maxPrereleaseVersionsToKeep,
  });
  const versionId = createPayload.version_id;

  for (const { chunkId, chunk } of chunkPlan.chunks) {
    console.log(`Uploading chunk ${chunkId + 1}/${chunkPlan.chunkCount} (${chunk.length} bytes)`);
    await uploadChunk(session, asset.id, versionId, chunkId, chunk);
  }

  console.log('Completing HTTP upload');
  await completeUpload(session, asset.id, versionId);

  console.log('Polling CFX asset until ACTIVE');
  const finalAsset = await pollUntilActive(session, asset.id, versionId);

  return {
    assetId: asset.id,
    versionId,
    version: preparedMetadata.version,
    releaseCandidate: Boolean(releaseCandidate),
    deletedVersion,
    deletedOldestVersion: deletedVersion,
    finalAsset,
  };
}

module.exports = {
  DEFAULT_CHUNK_COUNT,
  DEFAULT_CHANGELOG,
  MAX_VERSIONS_ERROR_CODE,
  MAX_VERSIONS_MESSAGE,
  splitIntoChunks,
  resolveVersionToDeleteForCap,
  uploadZipVersionHttp,
};
