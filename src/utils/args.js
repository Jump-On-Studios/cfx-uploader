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

module.exports = {
  parseHeadlessFromArgs,
  parseReleaseCandidateFromArgs,
};
