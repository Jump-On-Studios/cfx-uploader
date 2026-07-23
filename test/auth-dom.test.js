const assert = require('node:assert/strict');
const test = require('node:test');
const puppeteer = require('puppeteer');

const {
  CfxEmailLoginLinkInvalidError,
  CfxLoginRateLimitedError,
  authenticateWithPassword,
  clickPasswordLoginButton,
  dismissPortalCookieBanner,
  ensurePortalAuthenticated,
  isPortalLoaded,
  readPasswordLoginEntryState,
  submitTwoFactorCode,
} = require('../src/auth/cfx-auth');

const PORTAL_URL = 'https://portal.cfx.re/assets/created-assets';
const FORUM_LOGIN_URL = 'https://forum.cfx.re/login';
const EMAIL_LOGIN_URL = 'https://forum.cfx.re/session/email-login/0123456789abcdef0123456789abcdef';
const AUTHENTICATED_FORUM_HTML = `
  <button id="toggle-current-user" aria-label="Notifications and account"></button>
  <button id="create-topic" aria-label="New Topic">New Topic</button>
`;

let browser;

test.before(async () => {
  browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
});

test.after(async () => {
  await browser?.close();
});

async function createRoutedPage(routes) {
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const url = new URL(request.url());
    const body = routes[`${url.origin}${url.pathname}`];
    if (body === undefined) {
      void request.abort();
      return;
    }
    void request.respond({
      status: 200,
      contentType: 'text/html',
      body: typeof body === 'function' ? body(request.url()) : body,
    });
  });
  return page;
}

function authenticateForumScript() {
  return `
    function finishForumAuthentication() {
      history.pushState({}, '', '/');
      document.body.innerHTML = ${JSON.stringify(AUTHENTICATED_FORUM_HTML)};
    }
  `;
}

test('uses the captured classic 2FA button[type=button] exactly once', async () => {
  const page = await createRoutedPage({
    [FORUM_LOGIN_URL]: `
      <form id="login-form">
        <input id="login-second-factor" data-slot="input-otp"
          class="d-otp-input second-factor-token-input"
          autocomplete="one-time-code" maxlength="6">
      </form>
      <button id="login-button" form="login-form" type="button">Log In</button>
      <script>
        window.submitClicks = 0;
        ${authenticateForumScript()}
        document.querySelector('#login-button').addEventListener('click', () => {
          window.submitClicks += 1;
          finishForumAuthentication();
        });
      </script>
    `,
  });
  try {
    await page.goto(FORUM_LOGIN_URL);
    await submitTwoFactorCode(page, '123456', 2000);
    assert.equal(await page.evaluate(() => window.submitClicks), 1);
  } finally {
    await page.close();
  }
});

test('accepts classic 2FA auto-submit without clicking Log In', async () => {
  const page = await createRoutedPage({
    [FORUM_LOGIN_URL]: `
      <form id="login-form">
        <input id="login-second-factor" data-slot="input-otp"
          class="d-otp-input second-factor-token-input"
          autocomplete="one-time-code" maxlength="6">
      </form>
      <button id="login-button" form="login-form" type="button">Log In</button>
      <script>
        window.submitClicks = 0;
        window.autoSubmits = 0;
        ${authenticateForumScript()}
        document.querySelector('#login-button').addEventListener('click', () => {
          window.submitClicks += 1;
        });
        document.querySelector('#login-second-factor').addEventListener('input', (event) => {
          if (event.target.value.length === 6) {
            window.autoSubmits += 1;
            finishForumAuthentication();
          }
        });
      </script>
    `,
  });
  try {
    await page.goto(FORUM_LOGIN_URL);
    await submitTwoFactorCode(page, '123456', 2000);
    const result = await page.evaluate(() => ({
      autoSubmits: window.autoSubmits,
      submitClicks: window.submitClicks,
    }));
    assert.deepEqual(result, { autoSubmits: 1, submitClicks: 0 });
  } finally {
    await page.close();
  }
});

test('submits the captured email-login composite OTP form exactly once', async () => {
  const page = await createRoutedPage({
    [EMAIL_LOGIN_URL]: `
      <form>
        <input data-slot="input-otp" class="d-otp-input second-factor-token-input"
          autocomplete="one-time-code" maxlength="6">
        <button class="btn btn-primary" type="submit"><span>Finish Login</span></button>
      </form>
      <script>
        window.submitClicks = 0;
        ${authenticateForumScript()}
        document.querySelector('form').addEventListener('submit', (event) => {
          event.preventDefault();
          window.submitClicks += 1;
          finishForumAuthentication();
        });
      </script>
    `,
  });
  try {
    await page.goto(EMAIL_LOGIN_URL);
    await submitTwoFactorCode(page, '123456', 2000);
    assert.equal(await page.evaluate(() => window.submitClicks), 1);
  } finally {
    await page.close();
  }
});

test('does not click Finish Login after email OTP entry starts a navigation', async () => {
  const destinationUrl = 'https://forum.cfx.re/';
  const page = await createRoutedPage({
    [EMAIL_LOGIN_URL]: `
      <form>
        <input data-slot="input-otp" class="d-otp-input second-factor-token-input"
          autocomplete="one-time-code" maxlength="6">
        <button type="submit">Finish Login</button>
      </form>
      <script>
        document.querySelector('button').addEventListener('click', () => {
          document.cookie = 'finish-login-clicked=1; path=/';
        });
        document.querySelector('input').addEventListener('input', (event) => {
          if (event.target.value.length === 6) {
            location.href = ${JSON.stringify(destinationUrl)};
          }
        });
      </script>
    `,
    [destinationUrl]: AUTHENTICATED_FORUM_HTML,
  });
  try {
    await page.goto(EMAIL_LOGIN_URL);
    await submitTwoFactorCode(page, '123456', 2000);
    assert.equal(page.url(), destinationUrl);
    assert.equal(
      (await page.cookies()).some((cookie) => cookie.name === 'finish-login-clicked'),
      false,
    );
  } finally {
    await page.close();
  }
});

test('does not resubmit a rejected 2FA code', async () => {
  const page = await createRoutedPage({
    [FORUM_LOGIN_URL]: `
      <form id="login-form">
        <input id="login-second-factor" data-slot="input-otp"
          class="d-otp-input second-factor-token-input"
          autocomplete="one-time-code" maxlength="6">
        <div role="alert">Invalid authentication code</div>
      </form>
      <button id="login-button" form="login-form" type="button">Log In</button>
      <script>
        window.submitClicks = 0;
        document.querySelector('#login-button').addEventListener('click', () => {
          window.submitClicks += 1;
        });
      </script>
    `,
  });
  try {
    await page.goto(FORUM_LOGIN_URL);
    await assert.rejects(
      submitTwoFactorCode(page, '123456', 250),
      /did not reach an authenticated Forum or Portal state/,
    );
    assert.equal(await page.evaluate(() => window.submitClicks), 1);
  } finally {
    await page.close();
  }
});

test('recognizes only visible Created Assets headings or selected tabs', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<h3 style="display:none">Created Assets</h3>');
    assert.equal(await isPortalLoaded(page), false);
    await page.setContent('<h3>Created Assets</h3>');
    assert.equal(await isPortalLoaded(page), true);
    await page.setContent('<div role="tab" aria-selected="true">Created Assets</div>');
    assert.equal(await isPortalLoaded(page), true);
    await page.setContent('<div role="tab" aria-selected="false">Created Assets</div>');
    assert.equal(await isPortalLoaded(page), false);
  } finally {
    await page.close();
  }
});

test('dismisses the OneTrust reject banner once when present', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <button id="onetrust-reject-all-handler">TOUT REFUSER</button>
      <script>
        window.rejectClicks = 0;
        document.querySelector('#onetrust-reject-all-handler').addEventListener('click', (event) => {
          window.rejectClicks += 1;
          event.currentTarget.style.display = 'none';
        });
      </script>
    `);
    assert.equal(await dismissPortalCookieBanner(page), true);
    assert.equal(await dismissPortalCookieBanner(page), false);
    assert.equal(await page.evaluate(() => window.rejectClicks), 1);
  } finally {
    await page.close();
  }
});

test('waits through a disabled SSO button without clicking it', async () => {
  const page = await createRoutedPage({
    [PORTAL_URL]: `
      <button aria-label="Sign in with" disabled>Sign in with</button>
      <script>
        window.loginClicks = 0;
        document.querySelector('button').addEventListener('click', () => {
          window.loginClicks += 1;
        });
        setTimeout(() => {
          document.body.innerHTML = '<h3>Created Assets</h3>';
        }, 100);
      </script>
    `,
  });
  try {
    await ensurePortalAuthenticated({ page, portalUrl: PORTAL_URL, authTimeoutMs: 1500 });
    assert.equal(await page.evaluate(() => window.loginClicks), 0);
  } finally {
    await page.close();
  }
});

test('dismisses cookies and clicks the exact Portal SSO button once', async () => {
  const page = await createRoutedPage({
    [PORTAL_URL]: `
      <button id="onetrust-reject-all-handler">TOUT REFUSER</button>
      <button aria-label="Sign in with">SIGN IN WITH</button>
      <script>
        window.rejectClicks = 0;
        window.loginClicks = 0;
        document.querySelector('#onetrust-reject-all-handler').addEventListener('click', (event) => {
          window.rejectClicks += 1;
          event.currentTarget.style.display = 'none';
        });
        document.querySelector('[aria-label="Sign in with"]').addEventListener('click', () => {
          window.loginClicks += 1;
          document.body.innerHTML = '<h3>Created Assets</h3>';
        });
      </script>
    `,
  });
  try {
    await ensurePortalAuthenticated({ page, portalUrl: PORTAL_URL, authTimeoutMs: 1500 });
    const result = await page.evaluate(() => ({
      rejectClicks: window.rejectClicks,
      loginClicks: window.loginClicks,
    }));
    assert.deepEqual(result, { rejectClicks: 1, loginClicks: 1 });
  } finally {
    await page.close();
  }
});

test('selects only the modern visible Forum form and its exact Log In button', async () => {
  const page = await createRoutedPage({
    [FORUM_LOGIN_URL]: `
      <button id="wrong-login-button">Log In</button>
      <form id="login-form">
        <input id="login-account-name">
        <input id="login-account-password" type="password">
      </form>
      <button id="login-button" form="login-form" type="button">Log In</button>
      <form id="hidden-login-form" style="display:none">
        <input id="signin_username">
        <input id="signin_password" type="password">
        <input id="signin-button" type="submit">
      </form>
      <script>
        window.correctClicks = 0;
        window.wrongClicks = 0;
        document.querySelector('#login-button').addEventListener('click', () => window.correctClicks += 1);
        document.querySelector('#wrong-login-button').addEventListener('click', () => window.wrongClicks += 1);
      </script>
    `,
  });
  try {
    await page.goto(FORUM_LOGIN_URL);
    assert.equal((await readPasswordLoginEntryState(page)).hasPasswordForm, true);
    await clickPasswordLoginButton(page, 500);
    assert.deepEqual(
      await page.evaluate(() => ({
        correctClicks: window.correctClicks,
        wrongClicks: window.wrongClicks,
      })),
      { correctClicks: 1, wrongClicks: 0 },
    );
    await page.evaluate(() => {
      document.querySelector('#login-form').style.display = 'none';
      document.querySelector('#hidden-login-form').style.display = 'block';
    });
    assert.equal((await readPasswordLoginEntryState(page)).hasPasswordForm, false);
  } finally {
    await page.close();
  }
});

function portalLoginHtml() {
  return `
    <button aria-label="Sign in with">SIGN IN WITH</button>
    <script>
      document.querySelector('button').addEventListener('click', () => {
        location.href = ${JSON.stringify(FORUM_LOGIN_URL)};
      });
    </script>
  `;
}

function ajaxForumLoginHtml(resultScript) {
  return `
    <form id="login-form">
      <input id="login-account-name">
      <input id="login-account-password" type="password">
    </form>
    <button id="login-button" form="login-form" type="button">Log In</button>
    <script>
      window.passwordClicks = 0;
      ${authenticateForumScript()}
      document.querySelector('#login-button').addEventListener('click', () => {
        window.passwordClicks += 1;
        ${resultScript}
      });
    </script>
  `;
}

test('detects an AJAX 2FA transition without waiting for navigation timeout', async () => {
  const page = await createRoutedPage({
    [PORTAL_URL]: portalLoginHtml(),
    [FORUM_LOGIN_URL]: ajaxForumLoginHtml(`
      const form = document.querySelector('#login-form');
      form.innerHTML = \`
        <h3>Two-Factor Authentication</h3>
        <input id="login-second-factor" data-slot="input-otp"
          class="d-otp-input second-factor-token-input"
          autocomplete="one-time-code" maxlength="6">
        <button id="login-button" type="button">Log In</button>
      \`;
      form.querySelector('#login-button').addEventListener('click', finishForumAuthentication);
    `),
  });
  try {
    const startedAt = Date.now();
    await authenticateWithPassword({
      page,
      portalUrl: PORTAL_URL,
      auth: {
        email: 'test@example.test',
        password: 'test-password',
        twoFactorCodeProvider: async () => '123456',
      },
      authTimeoutMs: 4000,
      twoFactorTimeoutMs: 1000,
    });
    assert.ok(Date.now() - startedAt < 3000);
    assert.equal(page.url(), 'https://forum.cfx.re/');
  } finally {
    await page.close();
  }
});

test('raises the dedicated consumed-link error before requesting 2FA', async () => {
  let emailProviderCalls = 0;
  let twoFactorProviderCalls = 0;
  const page = await createRoutedPage({
    [PORTAL_URL]: portalLoginHtml(),
    [FORUM_LOGIN_URL]: ajaxForumLoginHtml(`
      document.body.innerHTML = '<p>It looks like a new device or location.</p>';
    `),
    [EMAIL_LOGIN_URL]: `
      <p>Oops! The link you used no longer works. You can Log In now.</p>
      <a href="/login">Log In</a>
    `,
  });
  try {
    await assert.rejects(
      authenticateWithPassword({
        page,
        portalUrl: PORTAL_URL,
        auth: {
          email: 'test@example.test',
          password: 'test-password',
          emailVerificationLinkProvider: async () => {
            emailProviderCalls += 1;
            return EMAIL_LOGIN_URL;
          },
          twoFactorCodeProvider: async () => {
            twoFactorProviderCalls += 1;
            return '123456';
          },
        },
        authTimeoutMs: 2000,
        emailVerificationTimeoutMs: 2000,
        twoFactorTimeoutMs: 1000,
      }),
      (error) => (
        error instanceof CfxEmailLoginLinkInvalidError &&
        error.code === 'CFX_EMAIL_LOGIN_LINK_INVALID'
      ),
    );
    assert.equal(emailProviderCalls, 1);
    assert.equal(twoFactorProviderCalls, 0);
  } finally {
    await page.close();
  }
});

test('raises rate-limit before either authentication provider is called', async () => {
  let emailProviderCalls = 0;
  let twoFactorProviderCalls = 0;
  const page = await createRoutedPage({
    [PORTAL_URL]: portalLoginHtml(),
    [FORUM_LOGIN_URL]: ajaxForumLoginHtml(`
      document.body.innerHTML = '<p>Please wait before trying to log in again.</p>';
    `),
  });
  try {
    const startedAt = Date.now();
    await assert.rejects(
      authenticateWithPassword({
        page,
        portalUrl: PORTAL_URL,
        auth: {
          email: 'test@example.test',
          password: 'test-password',
          emailVerificationLinkProvider: async () => {
            emailProviderCalls += 1;
            return EMAIL_LOGIN_URL;
          },
          twoFactorCodeProvider: async () => {
            twoFactorProviderCalls += 1;
            return '123456';
          },
        },
        authTimeoutMs: 3000,
      }),
      (error) => error instanceof CfxLoginRateLimitedError && error.code === 'CFX_LOGIN_RATE_LIMITED',
    );
    assert.ok(Date.now() - startedAt < 1500);
    assert.equal(emailProviderCalls, 0);
    assert.equal(twoFactorProviderCalls, 0);
  } finally {
    await page.close();
  }
});
