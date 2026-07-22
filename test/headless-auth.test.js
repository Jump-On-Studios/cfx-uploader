const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
  CfxLoginRateLimitedError,
  configurePageFingerprint,
  createLaunchOptions,
  normalizeEmailVerificationLink,
  normalizeHeadlessUserAgent,
  resolveEmailVerificationLink,
  sanitizeCfxUrl,
  submitTwoFactorCode,
  waitForPasswordAuthStage,
} = require('../src/auth/cfx-auth');

const VALID_EMAIL_LINK = 'https://forum.cfx.re/session/email-login/0123456789abcdef0123456789abcdef';

test('adds a persistent Chromium profile only when configured', () => {
  assert.equal(createLaunchOptions(true).userDataDir, undefined);
  assert.equal(
    createLaunchOptions(true, './runtime/cfx-profile').userDataDir,
    path.resolve('./runtime/cfx-profile'),
  );
});

test('normalizes the headless user agent without pinning its version', () => {
  assert.equal(
    normalizeHeadlessUserAgent('Mozilla/5.0 HeadlessChrome/146.0.0.0 Safari/537.36'),
    'Mozilla/5.0 Chrome/146.0.0.0 Safari/537.36',
  );
});

test('configures coherent user-agent metadata and device metrics in normalized mode', async () => {
  const commands = [];
  const logs = [];
  const page = {
    browser() {
      return { userAgent: async () => 'Mozilla/5.0 HeadlessChrome/146.0.0.0 Safari/537.36' };
    },
    async createCDPSession() {
      return { send: async (method, params) => commands.push({ method, params }) };
    },
    async evaluate() {
      return {
        userAgent: 'Mozilla/5.0 Chrome/146.0.0.0 Safari/537.36',
        brands: [{ brand: 'Chromium', version: '146' }],
        platform: 'Linux x86_64',
        webdriver: false,
        language: 'en-US',
        timezone: 'UTC',
        viewport: { width: 1280, height: 800 },
        screen: { width: 1920, height: 1080 },
      };
    },
  };

  const fingerprint = await configurePageFingerprint(page, 'normalized', (message) => logs.push(message));
  assert.equal(commands[0].method, 'Emulation.setUserAgentOverride');
  assert.equal(commands[0].params.userAgent.includes('HeadlessChrome'), false);
  assert.equal(commands[0].params.userAgentMetadata.fullVersion, '146.0.0.0');
  assert.deepEqual(commands[1].params.screenWidth, 1920);
  assert.deepEqual(fingerprint.webdriver, false);
  assert.match(logs[0], /Browser fingerprint/);
});

test('accepts only exact CFX forum email-login links', async () => {
  assert.equal(normalizeEmailVerificationLink(VALID_EMAIL_LINK), VALID_EMAIL_LINK);
  assert.equal(await resolveEmailVerificationLink(async () => VALID_EMAIL_LINK, {}, 100), VALID_EMAIL_LINK);

  for (const invalid of [
    VALID_EMAIL_LINK.replace('https:', 'http:'),
    VALID_EMAIL_LINK.replace('forum.cfx.re', 'evil.forum.cfx.re'),
    VALID_EMAIL_LINK.replace('forum.cfx.re', 'forum.cfx.re.evil.test'),
    'https://user:password@forum.cfx.re/session/email-login/0123456789abcdef0123456789abcdef',
    `${VALID_EMAIL_LINK}#secret`,
    'https://forum.cfx.re/session/email-login/not-hex',
    'https://portal.cfx.re/session/email-login/0123456789abcdef0123456789abcdef',
  ]) {
    assert.throws(() => normalizeEmailVerificationLink(invalid), /not an allowed/);
  }
});

test('redacts email-login tokens from diagnostic URLs', () => {
  assert.equal(
    sanitizeCfxUrl(VALID_EMAIL_LINK),
    'https://forum.cfx.re/session/email-login/[redacted]',
  );
});

test('opens the supplied email link in the same page and reaches 2FA without logging it', async () => {
  let phase = 'email';
  let providerCalls = 0;
  const navigations = [];
  const logs = [];
  const page = {
    async evaluate() {
      return {
        hasTwoFactor: phase === '2fa',
        twoFactorKind: phase === '2fa' ? 'email-login' : null,
        twoFactorSelector: phase === '2fa' ? 'input[data-slot="input-otp"]' : null,
        portalLoaded: false,
        pageText: phase === 'email'
          ? 'It looks like you are connecting from a new device or location. Please log in via email.'
          : '',
      };
    },
    async goto(url) {
      navigations.push(url);
      phase = '2fa';
    },
    async reload() {
      throw new Error('reload must not be used when a link provider is configured');
    },
  };

  const stage = await waitForPasswordAuthStage({
    page,
    authTimeoutMs: 1000,
    emailVerificationTimeoutMs: 1000,
    emailVerificationLinkProvider: async () => {
      providerCalls += 1;
      return VALID_EMAIL_LINK;
    },
    onLog: (message) => logs.push(message),
  });

  assert.equal(stage, 'two-factor');
  assert.equal(providerCalls, 1);
  assert.deepEqual(navigations, [VALID_EMAIL_LINK]);
  assert.equal(logs.join('\n').includes(VALID_EMAIL_LINK), false);
});

test('does not expose the email token when browser navigation fails', async () => {
  const page = {
    async evaluate() {
      return {
        hasTwoFactor: false,
        portalLoaded: false,
        pageText: 'It looks like you are connecting from a new device or location. Please log in via email.',
      };
    },
    async goto(url) {
      throw new Error(`net::ERR_FAILED at ${url}`);
    },
  };

  await assert.rejects(
    waitForPasswordAuthStage({
      page,
      authTimeoutMs: 1000,
      emailVerificationTimeoutMs: 1000,
      emailVerificationLinkProvider: async () => VALID_EMAIL_LINK,
    }),
    (error) => {
      assert.match(error.message, /could not be opened/);
      assert.equal(error.message.includes('0123456789abcdef'), false);
      return true;
    },
  );
});

test('logs only sanitized metadata when an email-login page is not recognized', async () => {
  let phase = 'email-challenge';
  const logs = [];
  const page = {
    async evaluate(fn) {
      const source = fn.toString();
      if (source.includes('hasTwoFactor') && source.includes('pageText')) {
        return {
          hasTwoFactor: false,
          twoFactorKind: null,
          twoFactorSelector: null,
          portalLoaded: false,
          pageText: phase === 'email-challenge'
            ? 'It looks like you are connecting from a new device or location. Please log in via email.'
            : '',
        };
      }
      assert.equal(source.includes('input.value'), false);
      return {
        title: 'Log In - Cfx Forum',
        headings: ['Two-Factor Authentication'],
        inputs: [{ dataSlot: 'unexpected-otp', maxLength: 6 }],
        buttons: ['Finish Login'],
      };
    },
    async goto() {
      phase = 'unknown';
    },
    url() {
      return VALID_EMAIL_LINK;
    },
  };

  await assert.rejects(
    waitForPasswordAuthStage({
      page,
      authTimeoutMs: 50,
      emailVerificationTimeoutMs: 50,
      emailVerificationLinkProvider: async () => VALID_EMAIL_LINK,
      onLog: (message) => logs.push(message),
    }),
    /email verification was not completed/i,
  );

  const output = logs.join('\n');
  assert.match(output, /not yet recognized/);
  assert.match(output, /\/session\/email-login\/\[redacted\]/);
  assert.equal(output.includes('0123456789abcdef'), false);
});

function createTwoFactorPage({ autoSubmit, kind = 'password-login' }) {
  let navigationResolve;
  let clicks = 0;
  let phase = '2fa';
  let focusedSelector = null;
  const selector = kind === 'email-login' ? 'input[data-slot="input-otp"]' : '#login-second-factor';
  return {
    page: {
      waitForNavigation() {
        return new Promise((resolve) => {
          navigationResolve = resolve;
        });
      },
      async waitForFunction(_fn, _options, actualSelector) {
        assert.equal(actualSelector, selector);
      },
      async focus(actualSelector) {
        focusedSelector = actualSelector;
      },
      keyboard: {
        async down() {},
        async press() {},
        async up() {},
        async type() {
          if (autoSubmit) {
            phase = 'forum';
            navigationResolve();
          }
        },
      },
      async evaluate(fn, args) {
        const source = fn.toString();
        if (source.includes('hasTwoFactor') && source.includes('pageText')) {
          return {
            hasTwoFactor: phase === '2fa',
            twoFactorKind: phase === '2fa' ? kind : null,
            twoFactorSelector: phase === '2fa' ? selector : null,
            portalLoaded: false,
            pageText: '',
          };
        }
        if (args?.kind === kind && args?.selector === selector) {
          clicks += 1;
          phase = 'forum';
          navigationResolve();
          return true;
        }
        return false;
      },
      url() {
        return phase === '2fa'
          ? 'https://forum.cfx.re/login'
          : 'https://forum.cfx.re/';
      },
    },
    getClicks: () => clicks,
    getFocusedSelector: () => focusedSelector,
  };
}

test('clicks Log In exactly once when the 2FA form does not auto-submit', async () => {
  const fixture = createTwoFactorPage({ autoSubmit: false });
  await submitTwoFactorCode(fixture.page, '123456', 2000);
  assert.equal(fixture.getClicks(), 1);
  assert.equal(fixture.getFocusedSelector(), '#login-second-factor');
});

test('does not click Log In after an automatic 2FA submission', async () => {
  const fixture = createTwoFactorPage({ autoSubmit: true });
  await submitTwoFactorCode(fixture.page, '123456', 2000);
  assert.equal(fixture.getClicks(), 0);
});

test('clicks Finish Login exactly once for the email-link 2FA form', async () => {
  const fixture = createTwoFactorPage({ autoSubmit: false, kind: 'email-login' });
  await submitTwoFactorCode(fixture.page, '123456', 2000);
  assert.equal(fixture.getClicks(), 1);
  assert.equal(fixture.getFocusedSelector(), 'input[data-slot="input-otp"]');
});

test('does not click Finish Login if an email-link form starts auto-submitting', async () => {
  const fixture = createTwoFactorPage({ autoSubmit: true, kind: 'email-login' });
  await submitTwoFactorCode(fixture.page, '123456', 2000);
  assert.equal(fixture.getClicks(), 0);
});

test('fails immediately when CFX reports a login rate limit', async () => {
  let reloads = 0;
  const page = {
    async evaluate() {
      return {
        hasTwoFactor: false,
        portalLoaded: false,
        pageText: 'Please wait before trying to log in again.',
      };
    },
    async reload() {
      reloads += 1;
    },
  };

  await assert.rejects(
    waitForPasswordAuthStage({ page, authTimeoutMs: 1000 }),
    (error) => error instanceof CfxLoginRateLimitedError && error.code === 'CFX_LOGIN_RATE_LIMITED',
  );
  assert.equal(reloads, 0);
});
