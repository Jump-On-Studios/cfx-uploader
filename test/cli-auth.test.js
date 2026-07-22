const assert = require('node:assert/strict');
const test = require('node:test');

const { resolveTwoFactorTimeoutMs } = require('../src/cli/http-cli');
const { resolveHttpAuthMethod } = require('../src/cli/resolve-http-auth');
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
