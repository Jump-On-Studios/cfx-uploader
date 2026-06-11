const MAX_PRERELEASE_VERSIONS_TO_KEEP = 4;

function normalizeMaxPrereleaseVersionsToKeep(value, label = 'maxPrereleaseVersionsToKeep') {
  if (value === undefined || value === null) {
    return null;
  }

  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    throw new Error(`${label} must be null or an integer >= 0.`);
  }

  return Math.min(value, MAX_PRERELEASE_VERSIONS_TO_KEEP);
}

module.exports = {
  MAX_PRERELEASE_VERSIONS_TO_KEEP,
  normalizeMaxPrereleaseVersionsToKeep,
};
