const { resolveLibrarySession } = require('./check-authentication');
const { getVersionStatus } = require('../cfx/http-upload');

/**
 * Read the CFX state of an uploaded version, for example after a CFX_POLL_TIMEOUT error.
 * Uses the same authentication options as upload(); a cached session avoids a new login.
 * @returns {Promise<{ found: boolean, active: boolean, assetState: string | null, versionState: string | null, version: string | null }>}
 */
async function checkVersionStatus(options = {}) {
  const assetId = Number(options.assetId);
  const versionId = Number(options.versionId);
  if (!Number.isInteger(assetId) || assetId <= 0 || !Number.isInteger(versionId) || versionId <= 0) {
    throw new Error('checkVersionStatus requires positive integer "assetId" and "versionId".');
  }

  const { session } = await resolveLibrarySession(options);
  return getVersionStatus(session, assetId, versionId);
}

module.exports = {
  checkVersionStatus,
};
