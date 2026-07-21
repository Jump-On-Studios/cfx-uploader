const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const puppeteer = require('puppeteer');
const {
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
          username: 'test-user',
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
