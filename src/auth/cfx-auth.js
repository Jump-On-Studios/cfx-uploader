/**
 * Module responsibility:
 * Launch Puppeteer, perform CFX passkey SSO, and return an authenticated page context.
 */
const path = require('path');
const os = require('os');
const puppeteer = require('puppeteer');
const {
  loadPasskeyCredentialFromFile,
  validatePasskeyCredential,
} = require('./passkey-credential');

const DEFAULT_PORTAL_URL = 'https://portal.cfx.re/assets/created-assets';
const DEFAULT_AUTH_TIMEOUT_MS = 30000;
const DEFAULT_TWO_FACTOR_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_EMAIL_VERIFICATION_TIMEOUT_MS = 10 * 60 * 1000;
const EMAIL_VERIFICATION_POLL_INTERVAL_MS = 2000;
const TWO_FACTOR_AUTO_SUBMIT_GRACE_MS = 1000;
const NORMALIZED_VIEWPORT = { width: 1280, height: 800 };
const NORMALIZED_SCREEN = { width: 1920, height: 1080 };
const EMAIL_LOGIN_PATH_PATTERN = /^\/session\/email-login\/[a-f0-9]{32}\/?$/i;
const TWO_FACTOR_INPUT_VARIANTS = [
  { kind: 'password-login', selector: '#login-second-factor' },
  { kind: 'email-login', selector: 'input[data-slot="input-otp"]' },
  {
    kind: 'email-login',
    selector: 'input.second-factor-token-input[autocomplete="one-time-code"][maxlength="6"]',
  },
];

/**
 * Small helper for deterministic waits in SSO transitions.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Detect transient Puppeteer errors caused by page navigation/context replacement.
 * @param {unknown} error
 * @returns {boolean}
 */
function isNavigationContextError(error) {
  const message = String(error && error.message ? error.message : error).toLowerCase();
  return (
    message.includes('execution context was destroyed') ||
    message.includes('most likely because of a navigation') ||
    message.includes('cannot find context with specified id') ||
    message.includes('detached frame')
  );
}

/**
 * Retry a small browser operation when context is briefly destroyed by navigation.
 * @template T
 * @param {() => Promise<T>} operation
 * @param {{ retries?: number, retryDelayMs?: number }} [options]
 * @returns {Promise<T>}
 */
async function retryOnNavigationContext(operation, options = {}) {
  const { retries = 4, retryDelayMs = 250 } = options;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isNavigationContextError(error) || attempt === retries) {
        throw error;
      }
      await sleep(retryDelayMs);
    }
  }

  throw new Error('Unexpected retry flow termination.');
}

/**
 * Build launch options for CFX browser automation.
 * @param {boolean} headless
 * @returns {import('puppeteer').LaunchOptions}
 */
function createLaunchOptions(headless, browserProfilePath = null) {
  const options = {
    headless,
    protocolTimeout: 120000,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1280,800',
    ],
    defaultViewport: NORMALIZED_VIEWPORT,
  };

  if (browserProfilePath) {
    options.userDataDir = path.resolve(browserProfilePath);
  }

  return options;
}

function normalizeHeadlessUserAgent(userAgent) {
  return String(userAgent || '').replace(/HeadlessChrome\//g, 'Chrome/');
}

function resolveUserAgentPlatform() {
  if (process.platform === 'win32') return { metadata: 'Windows', navigator: 'Win32' };
  if (process.platform === 'darwin') return { metadata: 'macOS', navigator: 'MacIntel' };
  return { metadata: 'Linux', navigator: 'Linux x86_64' };
}

function buildUserAgentMetadata(userAgent) {
  const fullVersion = String(userAgent).match(/Chrome\/([\d.]+)/)?.[1] || '0.0.0.0';
  const majorVersion = fullVersion.split('.')[0];
  const platform = resolveUserAgentPlatform().metadata;
  return {
    brands: [
      { brand: 'Not_A Brand', version: '99' },
      { brand: 'Chromium', version: majorVersion },
    ],
    fullVersionList: [
      { brand: 'Not_A Brand', version: '99.0.0.0' },
      { brand: 'Chromium', version: fullVersion },
    ],
    fullVersion,
    platform,
    platformVersion: os.release(),
    architecture: process.arch === 'arm64' ? 'arm' : 'x86',
    model: '',
    mobile: false,
    bitness: process.arch.includes('64') ? '64' : '32',
    wow64: false,
  };
}

async function configurePageFingerprint(page, mode = 'native', onLog = () => {}) {
  if (mode !== 'native' && mode !== 'normalized') {
    throw new Error(`Unsupported headless fingerprint mode: ${mode}`);
  }

  if (mode === 'normalized') {
    const originalUserAgent = await page.browser().userAgent();
    const userAgent = normalizeHeadlessUserAgent(originalUserAgent);
    const client = await page.createCDPSession();
    await client.send('Emulation.setUserAgentOverride', {
      userAgent,
      platform: resolveUserAgentPlatform().navigator,
      userAgentMetadata: buildUserAgentMetadata(userAgent),
    });
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: NORMALIZED_VIEWPORT.width,
      height: NORMALIZED_VIEWPORT.height,
      screenWidth: NORMALIZED_SCREEN.width,
      screenHeight: NORMALIZED_SCREEN.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
  }

  const fingerprint = await page.evaluate(() => ({
    userAgent: navigator.userAgent,
    brands: navigator.userAgentData?.brands || [],
    platform: navigator.platform,
    webdriver: navigator.webdriver,
    language: navigator.language,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    screen: { width: window.screen.width, height: window.screen.height },
  }));
  onLog(`Browser fingerprint: ${JSON.stringify(fingerprint)}`);
  return fingerprint;
}

function normalizeEmailVerificationLink(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('CFX email verification provider must return a valid login link.');
  }

  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('CFX email verification provider must return a valid login link.');
  }

  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'forum.cfx.re' ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    !EMAIL_LOGIN_PATH_PATTERN.test(url.pathname)
  ) {
    throw new Error('CFX email verification link is not an allowed forum.cfx.re email-login URL.');
  }

  return url.toString();
}

function sanitizeCfxUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.hostname === 'forum.cfx.re' && url.pathname.startsWith('/session/email-login/')) {
      return `${url.origin}/session/email-login/[redacted]`;
    }
    return url.toString();
  } catch {
    return '[invalid URL]';
  }
}

/**
 * Load passkey credential from disk.
 * @param {string} passkeyCredentialPath
 * @returns {Promise<{ credentialId: string, rpId: string, privateKey: string, userHandle: string, signCount: number }>}
 */
/**
 * Configure WebAuthn virtual authenticator and inject existing passkey.
 * @param {{ page: import('puppeteer').Page, credential: { credentialId: string, rpId: string, privateKey: string, userHandle: string, signCount: number } }} options
 * @returns {Promise<void>}
 */
async function setupVirtualAuthenticator(options) {
  const { page, credential } = options;
  const client = await page.createCDPSession();
  await client.send('WebAuthn.enable');

  const { authenticatorId } = await client.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });

  await client.send('WebAuthn.addCredential', {
    authenticatorId,
    credential: {
      credentialId: credential.credentialId,
      rpId: credential.rpId,
      privateKey: credential.privateKey,
      userHandle: credential.userHandle,
      signCount: credential.signCount,
      isResidentCredential: true,
    },
  });
}

/**
 * Wait until portal content is fully loaded after SSO redirects.
 * @param {{ page: import('puppeteer').Page, timeoutMs?: number }} options
 * @returns {Promise<boolean>}
 */
async function isPortalLoaded(page) {
  return page
    .evaluate(() => Boolean(document.body && document.body.innerText.includes('Created Assets')))
    .catch(() => false);
}

async function waitForPortalLoaded(options) {
  const { page, timeoutMs = 30000 } = options;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const hasCreatedAssets = await isPortalLoaded(page);

    if (hasCreatedAssets) {
      return true;
    }
    await sleep(500);
  }

  return false;
}

/**
 * Click the CFX portal sign-in button if it exists.
 * Uses class substring on purpose because classes are hashed.
 * @param {import('puppeteer').Page} page
 * @returns {Promise<void>}
 */
async function clickPortalLoginButton(page) {
  return retryOnNavigationContext(() =>
    page.evaluate(() => {
      if (document.body && document.body.innerText.includes('Created Assets')) {
        return false;
      }

      const button = Array.from(document.querySelectorAll('button')).find((candidate) => {
        const text = candidate.textContent?.trim().toLowerCase();
        return text === 'sign in with' || candidate.matches('button[class*="login_noWrap"]');
      });

      if (!button) {
        return false;
      }

      button.click();
      return true;
    })
  );
}

/**
 * Click the forum "Log in with a passkey" button.
 * Text matching is used because static selectors are unstable.
 * @param {import('puppeteer').Page} page
 * @returns {Promise<void>}
 */
async function clickPasskeyButton(page) {
  return retryOnNavigationContext(() =>
    page.evaluate(() => {
      const buttons = document.querySelectorAll('button');
      for (const button of buttons) {
        if (button.textContent && button.textContent.toLowerCase().includes('passkey')) {
          button.click();
          return true;
        }
      }
      return false;
    })
  );
}

async function waitForVisibleSelector(page, selector, timeoutMs = DEFAULT_AUTH_TIMEOUT_MS) {
  await page.waitForFunction(
    (targetSelector) => {
      const element = document.querySelector(targetSelector);
      if (!element) {
        return false;
      }

      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    },
    { timeout: timeoutMs },
    selector,
  );
}

async function readPasswordAuthState(page) {
  return page.evaluate((twoFactorVariants) => {
    const isVisible = (selector) => {
      const element = document.querySelector(selector);
      if (!element) {
        return false;
      }

      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };

    const twoFactorVariant = twoFactorVariants.find(({ selector }) => isVisible(selector)) || null;

    return {
      hasTwoFactor: Boolean(twoFactorVariant),
      twoFactorKind: twoFactorVariant?.kind || null,
      twoFactorSelector: twoFactorVariant?.selector || null,
      portalLoaded: Boolean(document.body && document.body.innerText.includes('Created Assets')),
      pageText: document.body?.innerText || '',
    };
  }, TWO_FACTOR_INPUT_VARIANTS).catch(() => ({
    hasTwoFactor: false,
    twoFactorKind: null,
    twoFactorSelector: null,
    portalLoaded: false,
    pageText: '',
  }));
}

async function readSafeAuthPageDiagnostic(page) {
  const details = await page.evaluate(() => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    const isVisible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };

    return {
      title: normalize(document.title),
      headings: Array.from(document.querySelectorAll('h1, h2, h3'))
        .filter(isVisible)
        .map((element) => normalize(element.textContent))
        .filter(Boolean)
        .slice(0, 5),
      inputs: Array.from(document.querySelectorAll('input'))
        .filter(isVisible)
        .map((input) => ({
          id: normalize(input.id),
          name: normalize(input.name),
          type: normalize(input.type),
          inputMode: normalize(input.inputMode),
          autocomplete: normalize(input.autocomplete),
          maxLength: input.maxLength,
          ariaLabel: normalize(input.getAttribute('aria-label')),
          dataSlot: normalize(input.getAttribute('data-slot')),
        }))
        .slice(0, 10),
      buttons: Array.from(document.querySelectorAll('button, input[type="submit"]'))
        .filter(isVisible)
        .map((button) => normalize(button.textContent || button.value || button.getAttribute('aria-label')))
        .filter(Boolean)
        .slice(0, 10),
    };
  }).catch(() => ({ title: '', headings: [], inputs: [], buttons: [] }));

  return {
    url: sanitizeCfxUrl(page.url()),
    ...details,
  };
}

function isEmailVerificationChallengeText(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const mentionsNewLocation = normalized.includes('new device') || normalized.includes('new location');
  const mentionsEmail = normalized.includes('via email') || normalized.includes('check the email');
  return mentionsNewLocation && mentionsEmail;
}

function isLoginRateLimitedText(text) {
  return String(text || '').toLowerCase().includes('please wait before trying to log in again');
}

class CfxLoginRateLimitedError extends Error {
  constructor() {
    super('CFX login is temporarily rate limited. Wait for the cooldown before starting another authentication.');
    this.name = 'CfxLoginRateLimitedError';
    this.code = 'CFX_LOGIN_RATE_LIMITED';
  }
}

class CfxEmailVerificationTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`CFX email verification was not completed within ${Math.ceil(timeoutMs / 60000)} minutes. Approve the CFX email link and retry the upload.`);
    this.name = 'CfxEmailVerificationTimeoutError';
    this.code = 'CFX_EMAIL_VERIFICATION_TIMEOUT';
    this.timeoutMs = timeoutMs;
  }
}

async function resolveEmailVerificationLink(provider, context, timeoutMs) {
  let timeoutHandle;
  try {
    const link = await Promise.race([
      Promise.resolve().then(() => provider(context)),
      new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new CfxEmailVerificationTimeoutError(timeoutMs)), timeoutMs);
      }),
    ]);
    return normalizeEmailVerificationLink(link);
  } catch (error) {
    if (error instanceof CfxEmailVerificationTimeoutError) throw error;
    if (String(error?.message || '').startsWith('CFX email verification')) throw error;
    throw new Error('CFX email verification link provider failed.');
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function waitForPasswordAuthStage(options) {
  const {
    page,
    authTimeoutMs = DEFAULT_AUTH_TIMEOUT_MS,
    emailVerificationTimeoutMs = DEFAULT_EMAIL_VERIFICATION_TIMEOUT_MS,
    emailVerificationLinkProvider,
    onLog = () => {},
  } = options;
  const initialDeadline = Date.now() + authTimeoutMs;
  let emailVerificationDeadline = null;
  let challengeLogged = false;
  let linkRequested = false;
  let unrecognizedEmailLinkStateLogged = false;

  while (Date.now() < (emailVerificationDeadline || initialDeadline)) {
    const state = await readPasswordAuthState(page);

    if (isLoginRateLimitedText(state.pageText)) {
      throw new CfxLoginRateLimitedError();
    }

    if (state.portalLoaded) {
      return 'portal';
    }

    if (state.hasTwoFactor) {
      if (challengeLogged) {
        onLog('CFX email verification detected. The 2FA screen is now available.');
      }
      return 'two-factor';
    }

    if (isEmailVerificationChallengeText(state.pageText)) {
      if (!challengeLogged) {
        challengeLogged = true;
        emailVerificationDeadline = Date.now() + emailVerificationTimeoutMs;
        onLog(`CFX email verification required. Approve the link sent by email; waiting up to ${Math.ceil(emailVerificationTimeoutMs / 60000)} minutes.`);
      }

      if (typeof emailVerificationLinkProvider === 'function' && !linkRequested) {
        linkRequested = true;
        const verificationLink = await resolveEmailVerificationLink(
          emailVerificationLinkProvider,
          { attempt: 1, timeoutMs: emailVerificationTimeoutMs },
          emailVerificationTimeoutMs,
        );
        try {
          await page.goto(verificationLink, { waitUntil: 'load' });
        } catch {
          throw new Error('CFX email verification link could not be opened in the authentication browser.');
        }
        onLog('CFX email verification link opened in the authentication browser.');
        continue;
      }

      if (Date.now() >= emailVerificationDeadline) {
        throw new CfxEmailVerificationTimeoutError(emailVerificationTimeoutMs);
      }

      await page.reload({ waitUntil: 'load' }).catch(() => {});
      await sleep(EMAIL_VERIFICATION_POLL_INTERVAL_MS);
      continue;
    }

    if (linkRequested && !unrecognizedEmailLinkStateLogged) {
      unrecognizedEmailLinkStateLogged = true;
      const diagnostic = await readSafeAuthPageDiagnostic(page);
      onLog(`CFX authentication page not yet recognized after email verification: ${JSON.stringify(diagnostic)}`);
    }

    await sleep(250);
  }

  if (emailVerificationDeadline) {
    throw new CfxEmailVerificationTimeoutError(emailVerificationTimeoutMs);
  }

  return null;
}

async function clickVisibleButtonByText(page, scopeSelector, expectedText) {
  const findButton = ({ selector, text, click }) => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const expected = normalize(text);
    const scopedRoot = document.querySelector(selector);
    const roots = scopedRoot ? [scopedRoot, document] : [document];

    for (const root of roots) {
      const candidates = Array.from(root.querySelectorAll(
        'button, input[type="submit"], input[type="button"], [role="button"]'
      ));
      const button = candidates.find((candidate) => {
        const rect = candidate.getBoundingClientRect();
        const style = window.getComputedStyle(candidate);
        const label = normalize(
          candidate.textContent || candidate.value || candidate.getAttribute('aria-label') || candidate.getAttribute('title')
        );
        return (
          label === expected &&
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== 'hidden' &&
          style.display !== 'none' &&
          candidate.disabled !== true &&
          candidate.getAttribute('aria-disabled') !== 'true'
        );
      });

      if (button) {
        if (click) {
          button.click();
        }
        return true;
      }
    }

    if (click && scopedRoot && typeof scopedRoot.requestSubmit === 'function') {
      const rect = scopedRoot.getBoundingClientRect();
      const style = window.getComputedStyle(scopedRoot);
      if (rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none') {
        scopedRoot.requestSubmit();
        return true;
      }
    }

    return false;
  };

  const deadline = Date.now() + DEFAULT_AUTH_TIMEOUT_MS;
  let clicked = false;
  while (Date.now() < deadline && !clicked) {
    clicked = await retryOnNavigationContext(() =>
      page.evaluate(findButton, { selector: scopeSelector, text: expectedText, click: true })
    );
    if (!clicked) {
      await sleep(250);
    }
  }

  if (!clicked) {
    throw new Error(`CFX authentication button not found: ${expectedText}`);
  }
}

async function readVisibleAuthMessages(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('[role="alert"], .alert, .error, .form-errors, .alert-error'))
    .map((element) => element.textContent?.trim())
    .filter(Boolean)
    .slice(0, 5)).catch(() => []);
}

function validatePasswordAuth(auth) {
  if (!auth || typeof auth !== 'object') {
    throw new Error('Password authentication requires an auth object.');
  }

  if (!auth.email || typeof auth.email !== 'string') {
    throw new Error('Password authentication requires auth.email.');
  }

  if (!auth.password || typeof auth.password !== 'string') {
    throw new Error('Password authentication requires auth.password.');
  }

  if (typeof auth.twoFactorCodeProvider !== 'function') {
    throw new Error('Password authentication requires auth.twoFactorCodeProvider.');
  }

  if (
    auth.emailVerificationLinkProvider !== undefined &&
    typeof auth.emailVerificationLinkProvider !== 'function'
  ) {
    throw new Error('Password authentication requires auth.emailVerificationLinkProvider to be a function when provided.');
  }
}

function normalizeTwoFactorCode(code) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code.trim())) {
    throw new Error('CFX 2FA provider must return exactly six digits.');
  }

  return code.trim();
}

async function resolveTwoFactorCode(provider, context, timeoutMs) {
  let timeoutHandle;
  try {
    const code = await Promise.race([
      Promise.resolve().then(() => provider(context)),
      new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error('CFX 2FA code provider timed out.')), timeoutMs);
      }),
    ]);

    return normalizeTwoFactorCode(code);
  } catch (error) {
    if (error.message === 'CFX 2FA code provider timed out.') {
      throw error;
    }
    if (error.message === 'CFX 2FA provider must return exactly six digits.') {
      throw error;
    }
    throw new Error('CFX 2FA code provider failed.');
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function fillVisibleInput(page, selector, value) {
  await waitForVisibleSelector(page, selector);
  await page.focus(selector);
  await page.keyboard.down('Control');
  await page.keyboard.press('A');
  await page.keyboard.up('Control');
  await page.keyboard.type(value);
}

async function clickTwoFactorSubmit(page, variant) {
  try {
    return await page.evaluate(({ kind, selector }) => {
      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const isVisible = (element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const input = document.querySelector(selector);
      const form = input?.closest('form');
      if (!input || !isVisible(input) || !form) {
        return false;
      }

      const expectedLabel = kind === 'email-login' ? 'finish login' : 'log in';
      const submitButton = Array.from(form.querySelectorAll('button[type="submit"], input[type="submit"]'))
        .find((candidate) => {
          const label = normalize(
            candidate.textContent || candidate.value || candidate.getAttribute('aria-label') || candidate.getAttribute('title')
          );
          return (
            label === expectedLabel &&
            isVisible(candidate) &&
            candidate.disabled !== true &&
            candidate.getAttribute('aria-disabled') !== 'true'
          );
        });

      if (!submitButton) {
        return false;
      }

      submitButton.click();
      return true;
    }, variant);
  } catch (error) {
    if (isNavigationContextError(error)) {
      return true;
    }
    throw error;
  }
}

async function waitForTwoFactorExit(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await readPasswordAuthState(page);
    if (!state.hasTwoFactor) {
      return true;
    }
    await sleep(100);
  }
  return false;
}

async function submitTwoFactorCode(page, code, authTimeoutMs = DEFAULT_AUTH_TIMEOUT_MS) {
  const initialState = await readPasswordAuthState(page);
  if (!initialState.hasTwoFactor || !initialState.twoFactorSelector || !initialState.twoFactorKind) {
    const diagnostic = await readSafeAuthPageDiagnostic(page);
    throw new Error(`CFX 2FA input was not found. State: ${JSON.stringify(diagnostic)}`);
  }

  const variant = {
    kind: initialState.twoFactorKind,
    selector: initialState.twoFactorSelector,
  };
  let navigationDetected = false;
  const navigationAbortController = new AbortController();
  const navigationPromise = page
    .waitForNavigation({
      waitUntil: 'load',
      timeout: authTimeoutMs,
      signal: navigationAbortController.signal,
    })
    .then(() => {
      navigationDetected = true;
      return true;
    })
    .catch(() => false);

  try {
    try {
      await fillVisibleInput(page, variant.selector, code);
    } catch (error) {
      if (!isNavigationContextError(error)) throw error;
    }

    await Promise.race([navigationPromise, sleep(TWO_FACTOR_AUTO_SUBMIT_GRACE_MS)]);
    if (!navigationDetected) {
      const state = await readPasswordAuthState(page);
      if (state.hasTwoFactor) {
        const clicked = await clickTwoFactorSubmit(page, {
          kind: state.twoFactorKind || variant.kind,
          selector: state.twoFactorSelector || variant.selector,
        });
        if (!clicked) {
          throw new Error(`CFX 2FA submit button was not found for the ${variant.kind} flow.`);
        }
      }
    }

    const transitioned = await waitForTwoFactorExit(page, authTimeoutMs);
    if (!transitioned) {
      const messages = await readVisibleAuthMessages(page);
      const suffix = messages.length > 0 ? ` ${messages.join(' ')}` : '';
      const diagnostic = await readSafeAuthPageDiagnostic(page);
      throw new Error(`CFX 2FA submission did not leave the 2FA screen.${suffix} State: ${JSON.stringify(diagnostic)}`);
    }

    await Promise.race([navigationPromise, sleep(500)]);
  } finally {
    navigationAbortController.abort();
  }
}

async function authenticateWithPassword(options) {
  const {
    page,
    portalUrl,
    auth,
    authTimeoutMs = DEFAULT_AUTH_TIMEOUT_MS,
    twoFactorTimeoutMs = DEFAULT_TWO_FACTOR_TIMEOUT_MS,
    emailVerificationTimeoutMs = DEFAULT_EMAIL_VERIFICATION_TIMEOUT_MS,
    onLog = () => {},
  } = options;

  validatePasswordAuth(auth);

  await page.goto(portalUrl, { waitUntil: 'load' });

  if (await waitForPortalLoaded({ page, timeoutMs: 2000 })) {
    return;
  }

  await clickPortalLoginButton(page);
  await waitForVisibleSelector(page, '#login-account-name', authTimeoutMs);
  await fillVisibleInput(page, '#login-account-name', auth.email);
  await fillVisibleInput(page, '#login-account-password', auth.password);

  const loginNavigation = page.waitForNavigation({ waitUntil: 'load', timeout: authTimeoutMs }).catch(() => null);
  await clickVisibleButtonByText(page, '#login-form', 'Log In');
  await loginNavigation;

  const authStage = await waitForPasswordAuthStage({
    page,
    authTimeoutMs,
    emailVerificationTimeoutMs,
    emailVerificationLinkProvider: auth.emailVerificationLinkProvider,
    onLog,
  });

  if (authStage === 'portal') {
    return;
  }

  if (authStage !== 'two-factor') {
    const messages = await readVisibleAuthMessages(page);
    const suffix = messages.length > 0 ? ` ${messages.join(' ')}` : '';
    throw new Error(`CFX password login did not reach the 2FA screen.${suffix}`);
  }

  const code = await resolveTwoFactorCode(
    auth.twoFactorCodeProvider,
    {
      attempt: 1,
      timeoutMs: twoFactorTimeoutMs,
    },
    twoFactorTimeoutMs,
  );

  await submitTwoFactorCode(page, code, authTimeoutMs);

  if (await isPortalLoaded(page)) {
    return;
  }

  await page.goto(portalUrl, { waitUntil: 'load' });

  let isPortalLogin = false;
  try {
    const currentUrl = new URL(page.url());
    isPortalLogin = currentUrl.origin === 'https://portal.cfx.re' && currentUrl.pathname === '/login';
  } catch {
    isPortalLogin = false;
  }

  if (isPortalLogin) {
    const handoffAbortController = new AbortController();
    const handoffNavigation = page
      .waitForNavigation({
        waitUntil: 'load',
        timeout: authTimeoutMs,
        signal: handoffAbortController.signal,
      })
      .catch(() => null);
    try {
      await clickPortalLoginButton(page);
      await Promise.race([handoffNavigation, sleep(3000)]);
    } finally {
      handoffAbortController.abort();
    }
  }

  const loaded = await waitForPortalLoaded({ page, timeoutMs: authTimeoutMs });
  if (!loaded) {
    const messages = await readVisibleAuthMessages(page);
    const suffix = messages.length > 0 ? ` ${messages.join(' ')}` : '';
    throw new Error(`Portal failed to load after password authentication.${suffix}`);
  }
}

/**
 * Authenticate to CFX portal and return a ready browser/page context.
 * @param {{
 *   headless: boolean,
 *   credential?: { credentialId: string, rpId: string, privateKey: string, userHandle: string, signCount: number },
 *   passkeyCredentialPath?: string,
 *   portalUrl?: string
 * }} options
 * @returns {Promise<{ browser: import('puppeteer').Browser, page: import('puppeteer').Page }>}
 */
async function authenticateToCfx(options) {
  const {
    headless,
    auth,
    credential: providedCredential,
    passkeyCredentialPath,
    portalUrl = DEFAULT_PORTAL_URL,
    authTimeoutMs = DEFAULT_AUTH_TIMEOUT_MS,
    twoFactorTimeoutMs = DEFAULT_TWO_FACTOR_TIMEOUT_MS,
    emailVerificationTimeoutMs = DEFAULT_EMAIL_VERIFICATION_TIMEOUT_MS,
    browserProfilePath = null,
    headlessFingerprint = 'native',
    onLog = () => {},
  } = options;

  const resolvedAuthMethod = auth?.method || (providedCredential || passkeyCredentialPath ? 'passkey' : null);

  if (!resolvedAuthMethod) {
    throw new Error('Missing CFX authentication. Provide auth, credential, passkeyCredentialPath, or a valid session cache.');
  }

  if (resolvedAuthMethod !== 'password' && resolvedAuthMethod !== 'passkey') {
    throw new Error(`Unsupported CFX authentication method: ${resolvedAuthMethod}`);
  }

  if (resolvedAuthMethod === 'password') {
    validatePasswordAuth(auth);
  }

  const browser = await puppeteer.launch(createLaunchOptions(headless, browserProfilePath));

  try {
    const pages = await browser.pages();
    const page = pages[0] || (await browser.newPage());
    await configurePageFingerprint(page, headlessFingerprint, onLog);

    if (resolvedAuthMethod === 'password') {
      await authenticateWithPassword({
        page,
        portalUrl,
        auth,
        authTimeoutMs,
        twoFactorTimeoutMs,
        emailVerificationTimeoutMs,
        onLog,
      });
    } else if (resolvedAuthMethod === 'passkey') {
      if (!providedCredential && !passkeyCredentialPath) {
        throw new Error('Missing passkey credential. Provide credential or passkeyCredentialPath.');
      }

      const credential = providedCredential
        ? validatePasskeyCredential(providedCredential, 'provided passkey credential')
        : validatePasskeyCredential(
          await loadPasskeyCredentialFromFile(path.resolve(passkeyCredentialPath)),
          path.resolve(passkeyCredentialPath)
        );

      await setupVirtualAuthenticator({ page, credential });

      await page.goto(portalUrl, { waitUntil: 'load' });
      await sleep(2000);

      // First portal entry point. If already authenticated, this click is a no-op.
      await clickPortalLoginButton(page);
      await sleep(2000);

      // Forum passkey click usually triggers the SSO handoff to portal.
      await clickPasskeyButton(page);
      await sleep(2000);

      // Some runs land on forum home after passkey; force return to portal.
      if (!page.url().includes('portal.cfx.re')) {
        await page.goto(portalUrl, { waitUntil: 'load' });
        await sleep(2000);
      }

      // Occasionally portal still shows /login once; click login again.
      if (page.url().includes('/login')) {
        await clickPortalLoginButton(page);
        await sleep(3000);
      }
    }

    const loaded = await waitForPortalLoaded({ page, timeoutMs: 30000 });
    if (!loaded) {
      throw new Error(`Portal failed to load (timeout), last URL: ${sanitizeCfxUrl(page.url())}`);
    }

    return { browser, page, authMethod: resolvedAuthMethod };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

module.exports = {
  DEFAULT_TWO_FACTOR_TIMEOUT_MS,
  authenticateToCfx,
  authenticateWithPassword,
  CfxEmailVerificationTimeoutError,
  CfxLoginRateLimitedError,
  buildUserAgentMetadata,
  configurePageFingerprint,
  createLaunchOptions,
  isEmailVerificationChallengeText,
  isLoginRateLimitedText,
  normalizeEmailVerificationLink,
  normalizeHeadlessUserAgent,
  normalizeTwoFactorCode,
  resolveEmailVerificationLink,
  sanitizeCfxUrl,
  resolveTwoFactorCode,
  submitTwoFactorCode,
  validatePasswordAuth,
  waitForPasswordAuthStage,
};
