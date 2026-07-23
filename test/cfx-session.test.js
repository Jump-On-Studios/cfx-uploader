const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const puppeteer = require('puppeteer');
const {
  authenticateFreshSession,
  resolveCfxHttpSession,
} = require('../src/auth/cfx-session');
const {
  loadSessionCache,
  saveSessionCache,
} = require('../src/auth/session-cache');

const session = {
  userAgent: 'Mozilla/5.0 CFX test',
  cookies: [{ name: 'session', value: 'cached-value', domain: '.cfx.re', path: '/' }],
};

function createAuthenticationDependency() {
  let closeCalls = 0;
  let receivedOptions = null;
  return {
    authenticateToCfx: async (options) => {
      receivedOptions = options;
      return {
        page: { id: 'authenticated-forum-page' },
        browser: {
          async close() {
            closeCalls += 1;
          },
        },
        authMethod: 'password',
      };
    },
    getCloseCalls: () => closeCalls,
    getReceivedOptions: () => receivedOptions,
  };
}

test('validates a fresh Portal API session directly without an SSO handoff', async () => {
  const authentication = createAuthenticationDependency();
  let handoffCalls = 0;
  let validationCalls = 0;
  const logs = [];

  const result = await authenticateFreshSession({
    onLog: (message) => logs.push(message),
  }, {
    authenticateToCfx: authentication.authenticateToCfx,
    createCfxHttpSession: async () => session,
    validateCfxHttpSession: async () => {
      validationCalls += 1;
    },
    ensurePortalAuthenticated: async () => {
      handoffCalls += 1;
    },
  });

  assert.equal(authentication.getReceivedOptions().requirePortalPage, false);
  assert.equal(validationCalls, 1);
  assert.equal(handoffCalls, 0);
  assert.equal(authentication.getCloseCalls(), 1);
  assert.equal(result.session, session);
  assert.equal(result.sessionReused, false);
  assert.match(logs.join('\n'), /without an additional SSO handoff/);
  assert.equal(logs.join('\n').includes('cached-value'), false);
});

test('performs one SSO handoff when no Portal or API cookie is available', async () => {
  const authentication = createAuthenticationDependency();
  let createCalls = 0;
  let handoffCalls = 0;
  let validationCalls = 0;

  const result = await authenticateFreshSession({}, {
    authenticateToCfx: authentication.authenticateToCfx,
    createCfxHttpSession: async () => {
      createCalls += 1;
      if (createCalls === 1) {
        const error = new Error('No Portal/API cookies found after browser authentication');
        error.code = 'CFX_PORTAL_SESSION_UNAVAILABLE';
        error.isCfxAuthError = true;
        throw error;
      }
      return session;
    },
    validateCfxHttpSession: async () => {
      validationCalls += 1;
    },
    ensurePortalAuthenticated: async () => {
      handoffCalls += 1;
    },
  });

  assert.equal(createCalls, 2);
  assert.equal(validationCalls, 1);
  assert.equal(handoffCalls, 1);
  assert.equal(authentication.getCloseCalls(), 1);
  assert.equal(result.session, session);
});

test('performs one SSO handoff after a direct Portal API 401', async () => {
  const authentication = createAuthenticationDependency();
  let handoffCalls = 0;
  let validationCalls = 0;

  await authenticateFreshSession({}, {
    authenticateToCfx: authentication.authenticateToCfx,
    createCfxHttpSession: async () => session,
    validateCfxHttpSession: async () => {
      validationCalls += 1;
      if (validationCalls === 1) {
        const error = new Error('expired');
        error.status = 401;
        error.isCfxAuthError = true;
        throw error;
      }
    },
    ensurePortalAuthenticated: async () => {
      handoffCalls += 1;
    },
  });

  assert.equal(validationCalls, 2);
  assert.equal(handoffCalls, 1);
  assert.equal(authentication.getCloseCalls(), 1);
});

test('does not perform an SSO handoff for a non-authentication API failure', async () => {
  const authentication = createAuthenticationDependency();
  let handoffCalls = 0;
  const serverError = new Error('GET assets failed (500)');
  serverError.status = 500;

  await assert.rejects(
    authenticateFreshSession({}, {
      authenticateToCfx: authentication.authenticateToCfx,
      createCfxHttpSession: async () => session,
      validateCfxHttpSession: async () => {
        throw serverError;
      },
      ensurePortalAuthenticated: async () => {
        handoffCalls += 1;
      },
    }),
    /500/,
  );

  assert.equal(handoffCalls, 0);
  assert.equal(authentication.getCloseCalls(), 1);
});

test('does not save a cache when API authentication still fails after the SSO handoff', async () => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'cfx-session-fallback-failed-'));
  const cachePath = path.join(temporaryDirectory, 'session.enc');
  const authentication = createAuthenticationDependency();
  let handoffCalls = 0;
  let validationCalls = 0;

  try {
    await assert.rejects(
      resolveCfxHttpSession({
        sessionCachePath: cachePath,
        sessionEncryptionKey: 'cache-key',
      }, {
        authenticateToCfx: authentication.authenticateToCfx,
        createCfxHttpSession: async () => session,
        validateCfxHttpSession: async () => {
          validationCalls += 1;
          const error = new Error('unauthorized');
          error.status = 401;
          error.isCfxAuthError = true;
          throw error;
        },
        ensurePortalAuthenticated: async () => {
          handoffCalls += 1;
        },
      }),
      /unauthorized/,
    );

    assert.equal(validationCalls, 2);
    assert.equal(handoffCalls, 1);
    assert.equal(authentication.getCloseCalls(), 1);
    assert.equal(await loadSessionCache(cachePath, 'cache-key'), null);
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('reuses a valid cached session without launching Puppeteer', async () => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'cfx-session-resolution-'));
  const cachePath = path.join(temporaryDirectory, 'session.enc');
  const originalFetch = global.fetch;
  const originalLaunch = puppeteer.launch;

  try {
    await saveSessionCache(cachePath, 'cache-key', session);
    global.fetch = async () => new Response(JSON.stringify({ assets: [] }), { status: 200 });
    puppeteer.launch = () => {
      throw new Error('Puppeteer must not launch for a valid session cache.');
    };

    const result = await resolveCfxHttpSession({
      sessionCachePath: cachePath,
      sessionEncryptionKey: 'cache-key',
    });

    assert.equal(result.sessionReused, true);
    assert.equal(result.authMethod, 'cached');
  } finally {
    global.fetch = originalFetch;
    puppeteer.launch = originalLaunch;
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('invalidates an expired cache and attempts exactly one fresh authentication', async () => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'cfx-session-expired-'));
  const cachePath = path.join(temporaryDirectory, 'session.enc');
  const originalFetch = global.fetch;
  const originalLaunch = puppeteer.launch;
  let launchCalls = 0;

  try {
    await saveSessionCache(cachePath, 'cache-key', session);
    global.fetch = async () => new Response('expired', { status: 401 });
    puppeteer.launch = () => {
      launchCalls += 1;
      throw new Error('fresh-authentication-attempt');
    };

    await assert.rejects(
      resolveCfxHttpSession({
        sessionCachePath: cachePath,
        sessionEncryptionKey: 'cache-key',
        auth: {
          method: 'password',
          email: 'test@example.test',
          password: 'test-password',
          twoFactorCodeProvider: async () => '123456',
        },
      }),
      /fresh-authentication-attempt/,
    );

    assert.equal(launchCalls, 1);
    assert.equal(await loadSessionCache(cachePath, 'cache-key'), null);
  } finally {
    global.fetch = originalFetch;
    puppeteer.launch = originalLaunch;
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('requires an encryption key whenever a cache path is configured', async () => {
  await assert.rejects(
    resolveCfxHttpSession({ sessionCachePath: path.join(os.tmpdir(), 'cfx-session.enc') }),
    /sessionEncryptionKey/,
  );
});
