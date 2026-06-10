const fs = require('fs/promises');
const { cfxJson, cfxFetch, readResponseBody } = require('./http-session');
const { getAssetDetails } = require('./http-assets');

const DEFAULT_CHUNK_COUNT = 4;
const DEFAULT_CHANGELOG = 'Automated upload from cfx-uploader.';
const DEFAULT_POLL_TIMEOUT_MS = 120000;
const DEFAULT_POLL_INTERVAL_MS = 3000;

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
  const payload = await cfxJson(session, `/v1/assets/${assetId}/re-upload`, {
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

  if (payload.errors) {
    throw new Error(`CFX re-upload rejected: ${JSON.stringify(payload.errors)}`);
  }

  if (!payload.version_id) {
    throw new Error(`CFX re-upload response missing version_id: ${JSON.stringify(payload)}`);
  }

  return payload;
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
  const createPayload = await createReUpload(session, asset.id, preparedMetadata, chunkPlan, changelog, releaseCandidate);
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
    finalAsset,
  };
}

module.exports = {
  DEFAULT_CHUNK_COUNT,
  DEFAULT_CHANGELOG,
  splitIntoChunks,
  uploadZipVersionHttp,
};
