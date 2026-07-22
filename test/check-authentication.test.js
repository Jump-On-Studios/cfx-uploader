const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { checkAuthentication } = require('../src/core/check-authentication');
const publicApi = require('../index');
const { saveSessionCache } = require('../src/auth/session-cache');

test('checks and reports a cached session without exposing it', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cfx-auth-check-'));
  const cachePath = path.join(directory, 'session.enc');
  const originalFetch = global.fetch;
  try {
    await saveSessionCache(cachePath, 'cache-key', {
      userAgent: 'Mozilla/5.0 test',
      cookies: [{ name: 'session', value: 'secret', domain: '.cfx.re', path: '/' }],
    });
    global.fetch = async () => new Response(JSON.stringify({ assets: [] }), { status: 200 });
    const result = await checkAuthentication({
      sessionCachePath: cachePath,
      sessionEncryptionKey: 'cache-key',
    });
    assert.deepEqual(result, { authMethod: 'cached', sessionReused: true });
    assert.equal('session' in result, false);
  } finally {
    global.fetch = originalFetch;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('exports the authentication check from the public package API', () => {
  assert.equal(publicApi.checkAuthentication, checkAuthentication);
});

test('validates headless authentication options without requiring an upload repository', async () => {
  await assert.rejects(
    checkAuthentication({ headlessFingerprint: 'stealth' }),
    /headlessFingerprint/,
  );
});
