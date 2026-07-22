const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CfxEmailVerificationTimeoutError,
  authenticateWithPassword,
  isEmailVerificationChallengeText,
  normalizeTwoFactorCode,
  resolveTwoFactorCode,
  validatePasswordAuth,
} = require('../src/auth/cfx-auth');
const { createCfxHttpSessionFromCookies } = require('../src/cfx/http-session');

test('validates six-digit 2FA codes', () => {
  assert.equal(normalizeTwoFactorCode(' 123456 '), '123456');
  assert.throws(() => normalizeTwoFactorCode('12345'), /exactly six digits/);
  assert.throws(() => normalizeTwoFactorCode('12345a'), /exactly six digits/);
});

test('rejects an invalid provider code with the strict validation error', async () => {
  await assert.rejects(
    resolveTwoFactorCode(async () => '12-3456', { attempt: 1, timeoutMs: 1000 }, 1000),
    /exactly six digits/,
  );
});

test('resolves a 2FA provider exactly once', async () => {
  let calls = 0;
  const code = await resolveTwoFactorCode(
    async ({ attempt, timeoutMs }) => {
      calls += 1;
      assert.equal(attempt, 1);
      assert.equal(timeoutMs, 1000);
      return '654321';
    },
    { attempt: 1, timeoutMs: 1000 },
    1000,
  );

  assert.equal(code, '654321');
  assert.equal(calls, 1);
});

test('times out a 2FA provider without exposing its value', async () => {
  await assert.rejects(
    resolveTwoFactorCode(() => new Promise(() => {}), { attempt: 1, timeoutMs: 10 }, 10),
    /timed out/,
  );
});

test('requires a password and a 2FA provider', () => {
  assert.throws(() => validatePasswordAuth(null), /requires an auth object/);
  assert.throws(() => validatePasswordAuth({ method: 'password' }), /auth.email/);
  assert.throws(() => validatePasswordAuth({ method: 'password', email: 'user@example.test' }), /auth.password/);
  assert.throws(
    () => validatePasswordAuth({ method: 'password', email: 'user@example.test', password: 'password' }),
    /twoFactorCodeProvider/,
  );
});

test('detects the CFX new-device email challenge', () => {
  assert.equal(
    isEmailVerificationChallengeText(
      'It looks like you are connecting from a new device or location. Please log in via email.',
    ),
    true,
  );
  assert.equal(isEmailVerificationChallengeText('Enter your six-digit verification code.'), false);
});

test('builds an HTTP session from restored cookies', () => {
  const session = createCfxHttpSessionFromCookies([
    { name: 'session', value: 'value', domain: '.cfx.re', path: '/' },
  ], 'Mozilla/5.0 test');

  assert.equal(session.userAgent, 'Mozilla/5.0 test');
  assert.match(session.baseHeaders.cookie, /session=value/);
});

test('drives the visible password and composite 2FA fields', async () => {
  let phase = 'portal';
  const typed = [];
  const page = {
    async goto() {
      phase = 'portal';
    },
    async waitForFunction(_fn, _options, selector) {
      assert.ok(['#login-account-name', '#login-account-password', '#login-second-factor'].includes(selector));
    },
    async evaluate(fn, args) {
      const source = fn.toString();
      if (source.includes('hasTwoFactor') && source.includes('pageText')) {
        return {
          hasTwoFactor: phase === '2fa',
          portalLoaded: phase === 'portal-ready',
          pageText: '',
        };
      }
      if (source.includes("querySelectorAll('button')") && source.includes('Created Assets')) {
        phase = 'forum-login';
        return true;
      }
      if (args?.selector === '#login-form') {
        phase = '2fa';
        return true;
      }
      if (source.includes('Created Assets')) {
        return phase === 'portal-ready';
      }
      return [];
    },
    async focus(selector) {
      this.focusedSelector = selector;
    },
    keyboard: {
      async down() {},
      async press() {},
      async up() {},
      async type(value) {
        typed.push(value);
        if (value === '123456') {
          phase = 'portal-ready';
        }
      },
    },
    waitForNavigation() {
      return Promise.resolve();
    },
    url() {
      return phase === 'forum-login' || phase === '2fa'
        ? 'https://forum.cfx.re/login'
        : 'https://portal.cfx.re/assets/created-assets';
    },
  };

  let providerCalls = 0;
  await authenticateWithPassword({
    page,
    portalUrl: 'https://portal.cfx.re/assets/created-assets',
    auth: {
      email: 'test@example.test',
      password: 'test-password',
      twoFactorCodeProvider: async ({ attempt, timeoutMs }) => {
        providerCalls += 1;
        assert.equal(attempt, 1);
        assert.equal(timeoutMs, 1000);
        return '123456';
      },
    },
    authTimeoutMs: 1000,
    twoFactorTimeoutMs: 1000,
  });

  assert.equal(providerCalls, 1);
  assert.deepEqual(typed, ['test@example.test', 'test-password', '123456']);
});

test('waits for email verification, reloads once approved, and submits the form only once', async () => {
  let phase = 'portal';
  let reloads = 0;
  const typed = [];
  const logs = [];
  const page = {
    async goto() {
      phase = 'portal';
    },
    async waitForFunction(_fn, _options, selector) {
      assert.ok(['#login-account-name', '#login-account-password', '#login-second-factor'].includes(selector));
    },
    async evaluate(fn, args) {
      const source = fn.toString();
      if (source.includes('hasTwoFactor') && source.includes('pageText')) {
        return {
          hasTwoFactor: phase === '2fa',
          portalLoaded: false,
          pageText: phase === 'email'
            ? 'It looks like you are connecting from a new device or location. Please log in via email.'
            : '',
        };
      }
      if (source.includes("querySelectorAll('button')") && source.includes('Created Assets')) {
        phase = 'forum-login';
        return true;
      }
      if (args?.selector === '#login-form') {
        phase = 'email';
        return true;
      }
      if (source.includes('Created Assets')) {
        return phase === 'portal-ready';
      }
      return [];
    },
    async reload() {
      reloads += 1;
      if (reloads >= 2) {
        phase = '2fa';
      }
    },
    async focus() {},
    keyboard: {
      async down() {},
      async press() {},
      async up() {},
      async type(value) {
        typed.push(value);
        if (value === '123456') {
          phase = 'portal-ready';
        }
      },
    },
    waitForNavigation() {
      return Promise.resolve();
    },
    url() {
      return phase === 'portal-ready'
        ? 'https://portal.cfx.re/assets/created-assets'
        : 'https://forum.cfx.re/login';
    },
  };

  let providerCalls = 0;
  await authenticateWithPassword({
    page,
    portalUrl: 'https://portal.cfx.re/assets/created-assets',
    auth: {
      email: 'test@example.test',
      password: 'test-password',
      twoFactorCodeProvider: async () => {
        providerCalls += 1;
        return '123456';
      },
    },
    authTimeoutMs: 1000,
    emailVerificationTimeoutMs: 5000,
    twoFactorTimeoutMs: 1000,
    onLog: (message) => logs.push(message),
  });

  assert.equal(reloads, 2);
  assert.equal(providerCalls, 1);
  assert.deepEqual(typed, ['test@example.test', 'test-password', '123456']);
  assert.match(logs.join('\n'), /email verification required/i);
  assert.match(logs.join('\n'), /2FA screen is now available/i);
});

test('fails clearly when email verification times out', async () => {
  const page = {
    async goto() {},
    async waitForFunction() {},
    async evaluate(fn, args) {
      const source = fn.toString();
      if (source.includes('hasTwoFactor') && source.includes('pageText')) {
        return {
          hasTwoFactor: false,
          portalLoaded: false,
          pageText: 'It looks like you are connecting from a new device or location. Please log in via email.',
        };
      }
      if (args?.selector === '#login-form') {
        return true;
      }
      if (source.includes('Created Assets')) {
        return false;
      }
      return [];
    },
    async reload() {},
    async focus() {},
    keyboard: {
      async down() {},
      async press() {},
      async up() {},
      async type() {},
    },
    waitForNavigation() {
      return Promise.resolve();
    },
  };

  await assert.rejects(
    authenticateWithPassword({
      page,
      portalUrl: 'https://portal.cfx.re/assets/created-assets',
      auth: {
        email: 'test@example.test',
        password: 'test-password',
        twoFactorCodeProvider: async () => '123456',
      },
      authTimeoutMs: 100,
      emailVerificationTimeoutMs: 1,
      twoFactorTimeoutMs: 100,
    }),
    (error) => {
      assert.ok(error instanceof CfxEmailVerificationTimeoutError);
      assert.equal(error.code, 'CFX_EMAIL_VERIFICATION_TIMEOUT');
      assert.match(error.message, /Approve the CFX email link and retry/);
      return true;
    },
  );
});
