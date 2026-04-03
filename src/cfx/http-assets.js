const { cfxJson } = require('./http-session');

const ASSETS_LIST_PATH = '/v1/me/assets?page=1&search=&sort=asset.id&direction=desc';

function withCacheBuster(path) {
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}_=${Date.now()}`;
}

function extractAssetsList(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (Array.isArray(payload.assets)) {
    return payload.assets;
  }

  if (Array.isArray(payload.items)) {
    return payload.items;
  }

  if (Array.isArray(payload.data)) {
    return payload.data;
  }

  throw new Error(`Unexpected CFX assets list shape: ${JSON.stringify(Object.keys(payload || {}))}`);
}

async function listAssets(session) {
  const payload = await cfxJson(session, withCacheBuster(ASSETS_LIST_PATH));
  return extractAssetsList(payload);
}

async function findAssetByExactName(session, assetName) {
  const assets = await listAssets(session);
  const asset = assets.find((candidate) => candidate && candidate.name === assetName);

  if (!asset) {
    const availableNames = assets
      .map((candidate) => candidate && candidate.name)
      .filter(Boolean)
      .slice(0, 20)
      .join(', ');

    throw new Error(`CFX asset not found by exact name "${assetName}". First assets: ${availableNames || '<none>'}`);
  }

  if (!asset.id) {
    throw new Error(`CFX asset "${assetName}" is missing an id in the assets list response`);
  }

  return asset;
}

async function getAssetDetails(session, assetId) {
  return cfxJson(session, withCacheBuster(`/v1/assets/${assetId}`));
}

module.exports = {
  ASSETS_LIST_PATH,
  listAssets,
  findAssetByExactName,
  getAssetDetails,
};
