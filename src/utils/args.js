const { normalizeMaxPrereleaseVersionsToKeep } = require('./prerelease-retention');

function parseHeadlessFromArgs(args = process.argv.slice(2)) {
  if (args.includes('--show-browser')) {
    return false;
  }

  const explicitHeadlessArg = args.find((arg) => arg.startsWith('--headless='));
  if (explicitHeadlessArg) {
    const value = explicitHeadlessArg.split('=').slice(1).join('=').trim().toLowerCase();
    if (value === 'false' || value === '0') {
      return false;
    }
    if (value === 'true' || value === '1') {
      return true;
    }

    throw new Error(`Invalid value for --headless: ${value}`);
  }

  if (process.env.CFX_SHOW_BROWSER === 'true') {
    return false;
  }

  return true;
}

function parseAuthMethodFromArgs(args = process.argv.slice(2)) {
  const explicitArg = args.find((arg) => arg.startsWith('--auth-method='));
  if (!explicitArg) {
    return undefined;
  }

  const value = explicitArg.split('=').slice(1).join('=').trim().toLowerCase();
  if (value !== 'passkey' && value !== 'password') {
    throw new Error(`Invalid value for --auth-method: ${value}. Expected passkey or password.`);
  }

  return value;
}

function parseReleaseCandidateFromArgs(args = process.argv.slice(2)) {
  const releaseCandidate = args.includes('--release-candidate');
  const fullRelease = args.includes('--full-release');

  if (releaseCandidate && fullRelease) {
    throw new Error('Invalid release type flags: use either --release-candidate or --full-release, not both.');
  }

  if (releaseCandidate) {
    return true;
  }

  if (fullRelease) {
    return false;
  }

  return undefined;
}

function parseDeleteOldestVersionWhenCappedFromArgs(args = process.argv.slice(2)) {
  const enabled = args.includes('--delete-oldest-version-when-capped');
  const disabled = args.includes('--no-delete-oldest-version-when-capped');

  if (enabled && disabled) {
    throw new Error(
      'Invalid capped-version flags: use either --delete-oldest-version-when-capped or --no-delete-oldest-version-when-capped, not both.'
    );
  }

  if (enabled) {
    return true;
  }

  if (disabled) {
    return false;
  }

  return undefined;
}

function parseMaxPrereleaseVersionsToKeepFromArgs(args = process.argv.slice(2)) {
  if (args.includes('--no-prerelease-retention')) {
    const explicitMax = args.find((arg) => arg.startsWith('--max-prerelease-versions-to-keep='));
    if (explicitMax) {
      throw new Error(
        'Invalid prerelease retention flags: use either --max-prerelease-versions-to-keep or --no-prerelease-retention, not both.'
      );
    }

    return null;
  }

  const explicitMax = args.find((arg) => arg.startsWith('--max-prerelease-versions-to-keep='));
  if (!explicitMax) {
    return undefined;
  }

  const value = explicitMax.split('=').slice(1).join('=').trim();
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid value for --max-prerelease-versions-to-keep: ${value}. Expected an integer >= 0.`);
  }

  return normalizeMaxPrereleaseVersionsToKeep(Number(value), '--max-prerelease-versions-to-keep');
}

module.exports = {
  parseAuthMethodFromArgs,
  parseHeadlessFromArgs,
  parseReleaseCandidateFromArgs,
  parseDeleteOldestVersionWhenCappedFromArgs,
  parseMaxPrereleaseVersionsToKeepFromArgs,
};
