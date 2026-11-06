const { cfxJson } = require('./http-session');

const ASSETS_LIST_PATH = '/v1/me/assets?page=1&search=&sort=asset.id&direction=desc';
const MAX_ASSET_PAGES = 50;

function assetsListPath({ page = 1, search = '' } = {}) {
  return `/v1/me/assets?page=${page}&search=${encodeURIComponent(search)}&sort=asset.id&direction=desc`;
}

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

async function listAssets(session, options = {}) {
  const payload = await cfxJson(session, withCacheBuster(assetsListPath(options)));
  return extractAssetsList(payload);
}

function findExact(assets, assetName) {
  return assets.find((candidate) => candidate && candidate.name === assetName);
}

async function findAssetByExactName(session, assetName) {
  // The assets list is paginated: page 1 alone misses older assets.
  // Try the portal search first, then walk every page as a fallback.
  let asset = findExact(await listAssets(session, { search: assetName }), assetName);

  const seenIds = new Set();
  const assets = [];
  for (let page = 1; !asset && page <= MAX_ASSET_PAGES; page += 1) {
    const pageAssets = await listAssets(session, { page });
    const fresh = pageAssets.filter((candidate) => candidate && !seenIds.has(candidate.id));
    if (fresh.length === 0) break;
    fresh.forEach((candidate) => seenIds.add(candidate.id));
    assets.push(...fresh);
    asset = findExact(fresh, assetName);
  }

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

async function getAssetDetails(session, assetId, options = {}) {
  return cfxJson(session, withCacheBuster(`/v1/assets/${assetId}`), options);
}

module.exports = {
  ASSETS_LIST_PATH,
  assetsListPath,
  listAssets,
  findAssetByExactName,
  getAssetDetails,
};
