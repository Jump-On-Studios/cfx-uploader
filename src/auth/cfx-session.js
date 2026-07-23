const { authenticateToCfx, ensurePortalAuthenticated } = require('./cfx-auth');
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

async function authenticateFreshSession(options, dependencies = {}) {
  const authenticate = dependencies.authenticateToCfx || authenticateToCfx;
  const createSession = dependencies.createCfxHttpSession || createCfxHttpSession;
  const validateSession = dependencies.validateCfxHttpSession || validateCfxHttpSession;
  const completePortalSso = dependencies.ensurePortalAuthenticated || ensurePortalAuthenticated;
  const onLog = typeof options.onLog === 'function' ? options.onLog : () => {};
  const authResult = await authenticate({
    ...options,
    requirePortalPage: false,
  });

  try {
    onLog('CFX browser authentication complete. Validating the Portal API session directly.');
    try {
      const session = await createSession(authResult.page);
      await validateSession(session);
      onLog('CFX Portal API session validated without an additional SSO handoff.');

      return {
        session,
        authMethod: authResult.authMethod,
        sessionReused: false,
      };
    } catch (error) {
      if (!isCfxAuthError(error)) {
        throw error;
      }
    }

    onLog('CFX Portal API session is unavailable. Completing one Portal SSO handoff.');
    await completePortalSso({
      page: authResult.page,
      portalUrl: options.portalUrl,
      authTimeoutMs: options.authTimeoutMs,
      onLog,
    });

    const session = await createSession(authResult.page);
    await validateSession(session);
    onLog('CFX Portal API session validated after the SSO handoff.');

    return {
      session,
      authMethod: authResult.authMethod,
      sessionReused: false,
    };
  } finally {
    await authResult.browser.close();
  }
}

async function resolveCfxHttpSession(options = {}, dependencies = {}) {
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
          const validateSession = dependencies.validateCfxHttpSession || validateCfxHttpSession;
          await validateSession(session);
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
    }, dependencies);

    if (sessionCachePath) {
      await saveSessionCache(sessionCachePath, sessionEncryptionKey, freshSession.session);
    }

    return freshSession;
  } finally {
    await releaseLock();
  }
}

module.exports = {
  authenticateFreshSession,
  isCfxAuthError,
  resolveAuthMethod,
  resolveCfxHttpSession,
  validateCfxHttpSession,
};
