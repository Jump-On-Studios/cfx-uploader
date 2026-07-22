const { authenticateToCfx } = require('./cfx-auth');
const {
  acquireSessionCacheLock,
  assertEncryptionKey,
  invalidateSessionCache,
  loadSessionCache,
  saveSessionCache,
} = require('./session-cache');
const {
  createCfxHttpSession,
  createCfxHttpSessionFromCookies,
} = require('../cfx/http-session');
const { listAssets } = require('../cfx/http-assets');

function resolveAuthMethod(options = {}) {
  if (options.auth?.method) {
    return options.auth.method;
  }

  if (options.passkey || options.passkeyCredentialPath) {
    return 'passkey';
  }

  return 'cached';
}

function isCfxAuthError(error) {
  return error?.isCfxAuthError === true || error?.status === 401 || error?.status === 403;
}

async function validateCfxHttpSession(session) {
  await listAssets(session);
}

async function authenticateFreshSession(options) {
  const authResult = await authenticateToCfx(options);

  try {
    const session = await createCfxHttpSession(authResult.page);
    await validateCfxHttpSession(session);

    return {
      session,
      authMethod: authResult.authMethod,
      sessionReused: false,
    };
  } finally {
    await authResult.browser.close();
  }
}

async function resolveCfxHttpSession(options = {}) {
  const {
    headless = true,
    auth,
    credential,
    passkeyCredentialPath,
    portalUrl,
    sessionCachePath,
    sessionEncryptionKey,
    authTimeoutMs,
    twoFactorTimeoutMs,
    emailVerificationTimeoutMs,
    browserProfilePath,
    headlessFingerprint,
    onLog,
  } = options;

  if (sessionCachePath) {
    assertEncryptionKey(sessionEncryptionKey);
  }

  const releaseLock = await acquireSessionCacheLock(sessionCachePath);

  try {
    if (sessionCachePath) {
      const cachedSession = await loadSessionCache(sessionCachePath, sessionEncryptionKey);

      if (cachedSession) {
        const session = createCfxHttpSessionFromCookies(
          cachedSession.cookies,
          cachedSession.userAgent,
        );

        try {
          await validateCfxHttpSession(session);
          return {
            session,
            authMethod: resolveAuthMethod(options),
            sessionReused: true,
          };
        } catch (error) {
          if (!isCfxAuthError(error)) {
            throw error;
          }

          await invalidateSessionCache(sessionCachePath);
        }
      }
    }

    const freshSession = await authenticateFreshSession({
      headless,
      auth,
      credential,
      passkeyCredentialPath,
      portalUrl,
      authTimeoutMs,
      twoFactorTimeoutMs,
      emailVerificationTimeoutMs,
      browserProfilePath,
      headlessFingerprint,
      onLog,
    });

    if (sessionCachePath) {
      await saveSessionCache(sessionCachePath, sessionEncryptionKey, freshSession.session);
    }

    return freshSession;
  } finally {
    await releaseLock();
  }
}

module.exports = {
  isCfxAuthError,
  resolveAuthMethod,
  resolveCfxHttpSession,
  validateCfxHttpSession,
};
