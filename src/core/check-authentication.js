const { resolveCfxHttpSession } = require('../auth/cfx-session');
const {
  resolveLibraryPasskey,
  validateAuthenticationOptions,
} = require('./create-uploader');

async function checkAuthentication(options = {}) {
  validateAuthenticationOptions(options);

  if (options.auth && (options.passkey || options.passkeyJson || options.passkeyCredentialPath)) {
    throw new Error('Provide either auth or passkey credentials, not both.');
  }

  let credential = null;
  if (options.passkey || options.passkeyJson) {
    credential = resolveLibraryPasskey(options);
  } else if (!options.auth && !options.sessionCachePath && !options.passkeyCredentialPath) {
    credential = resolveLibraryPasskey(options);
  }

  const result = await resolveCfxHttpSession({
    headless: options.headless !== false,
    auth: options.auth,
    credential,
    passkeyCredentialPath: options.passkeyCredentialPath,
    portalUrl: options.portalUrl,
    sessionCachePath: options.sessionCachePath || null,
    sessionEncryptionKey: options.sessionEncryptionKey || null,
    authTimeoutMs: options.authTimeoutMs,
    twoFactorTimeoutMs: options.twoFactorTimeoutMs,
    emailVerificationTimeoutMs: options.emailVerificationTimeoutMs,
    browserProfilePath: options.browserProfilePath || null,
    headlessFingerprint: options.headlessFingerprint || 'native',
    onLog: typeof options.onLog === 'function' ? options.onLog : console.log,
  });

  return {
    authMethod: result.sessionReused ? 'cached' : result.authMethod,
    sessionReused: result.sessionReused,
  };
}

module.exports = {
  checkAuthentication,
};
