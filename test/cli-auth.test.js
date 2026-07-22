const assert = require('node:assert/strict');
const test = require('node:test');

const { resolveTwoFactorTimeoutMs } = require('../src/cli/http-cli');
const { resolveHttpAuthMethod, resolveHttpCliAuth } = require('../src/cli/resolve-http-auth');
const { resolvePasskeySource } = require('../src/core/create-uploader');

test('selects password or passkey explicitly for the HTTP CLI', () => {
  assert.equal(resolveHttpAuthMethod(['--auth-method=password']), 'password');
  assert.equal(resolveHttpAuthMethod(['--auth-method=passkey']), 'passkey');
  assert.throws(() => resolveHttpAuthMethod(['--auth-method=unknown']), /Expected passkey or password/);
});

test('validates the CLI 2FA timeout', () => {
  assert.equal(resolveTwoFactorTimeoutMs(undefined), undefined);
  assert.equal(resolveTwoFactorTimeoutMs('600000'), 600000);
  assert.throws(() => resolveTwoFactorTimeoutMs('not-a-number'), /positive integer/);
  assert.throws(() => resolveTwoFactorTimeoutMs('0'), /positive integer/);
});

test('does not label password or cached authentication as passkey', () => {
  assert.equal(resolvePasskeySource({ auth: { method: 'password' } }), null);
  assert.equal(resolvePasskeySource({ sessionCachePath: '/tmp/cfx-session.enc' }), null);
  assert.equal(resolvePasskeySource({ passkey: { credentialId: 'credential' } }), 'passkey');
  assert.equal(resolvePasskeySource({ passkeyJson: '{"credentialId":"credential"}' }), 'passkeyJson');
});

test('configures console providers for both email verification and 2FA', async () => {
  const previousEmail = process.env.CFX_UPLOADER_EMAIL;
  const previousPassword = process.env.CFX_UPLOADER_PASSWORD;
  try {
    process.env.CFX_UPLOADER_EMAIL = 'user@example.test';
    process.env.CFX_UPLOADER_PASSWORD = 'password';
    const result = await resolveHttpCliAuth({ args: ['--auth-method=password'], projectRoot: process.cwd() });
    assert.equal(typeof result.auth.emailVerificationLinkProvider, 'function');
    assert.equal(typeof result.auth.twoFactorCodeProvider, 'function');
  } finally {
    if (previousEmail === undefined) delete process.env.CFX_UPLOADER_EMAIL;
    else process.env.CFX_UPLOADER_EMAIL = previousEmail;
    if (previousPassword === undefined) delete process.env.CFX_UPLOADER_PASSWORD;
    else process.env.CFX_UPLOADER_PASSWORD = previousPassword;
  }
});
