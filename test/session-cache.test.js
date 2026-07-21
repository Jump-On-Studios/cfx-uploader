const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  acquireSessionCacheLock,
  decryptSession,
  encryptSession,
  loadSessionCache,
  saveSessionCache,
} = require('../src/auth/session-cache');

const session = {
  userAgent: 'Mozilla/5.0 CFX test',
  cookies: [
    {
      name: 'cfx_session',
      value: 'sensitive-cookie-value',
      domain: '.cfx.re',
      path: '/',
      expires: -1,
      httpOnly: true,
      secure: true,
    },
  ],
};

test('encrypts and decrypts a CFX session without exposing cookie values', () => {
  const serialized = encryptSession(session, 'test-encryption-key');
  assert.equal(serialized.includes('sensitive-cookie-value'), false);
  assert.deepEqual(decryptSession(serialized, 'test-encryption-key').cookies, session.cookies);
});

test('rejects a session cache with the wrong key or tampered ciphertext', () => {
  const serialized = encryptSession(session, 'test-encryption-key');
  assert.throws(
    () => decryptSession(serialized, 'wrong-key'),
    /Unable to decrypt CFX session cache/,
  );

  const envelope = JSON.parse(serialized);
  envelope.ciphertext = `${envelope.ciphertext.slice(0, -2)}aa`;
  assert.throws(
    () => decryptSession(JSON.stringify(envelope), 'test-encryption-key'),
    /Unable to decrypt CFX session cache/,
  );
});

test('saves and loads an encrypted session atomically', async () => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'cfx-session-test-'));
  const cachePath = path.join(temporaryDirectory, 'nested', 'session.enc');

  try {
    await saveSessionCache(cachePath, 'test-encryption-key', session);
    const loaded = await loadSessionCache(cachePath, 'test-encryption-key');
    assert.deepEqual(loaded.cookies, session.cookies);
    assert.equal((await fs.readFile(cachePath, 'utf8')).includes('sensitive-cookie-value'), false);
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('a second process waits for the session lock', async () => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'cfx-session-lock-test-'));
  const cachePath = path.join(temporaryDirectory, 'session.enc');
  const release = await acquireSessionCacheLock(cachePath);

  try {
    await assert.rejects(
      acquireSessionCacheLock(cachePath, { timeoutMs: 20, retryIntervalMs: 5, staleMs: 60000 }),
      /Timed out waiting for CFX session cache lock/,
    );
  } finally {
    await release();
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
});
