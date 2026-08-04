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
const PORTAL_ROUTE_STABILITY_MS = 2000;
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
    return `${url.origin}${url.pathname}`;
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
    .evaluate(() => {
      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const isVisible = (element) => {
        if (!element) return false;
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const hasHeading = Array.from(document.querySelectorAll('h1, h2, h3'))
        .some((element) => isVisible(element) && normalize(element.textContent) === 'created assets');
      const hasSelectedTab = Array.from(document.querySelectorAll('[role="tab"][aria-selected="true"]'))
        .some((element) => isVisible(element) && normalize(element.textContent) === 'created assets');
      return hasHeading || hasSelectedTab;
    })
    .catch(() => false);
}

function isPortalCreatedAssetsRoute(page) {
  try {
    const url = new URL(page.url());
    return url.origin === 'https://portal.cfx.re' && url.pathname === '/assets/created-assets';
  } catch {
    return false;
  }
}

async function waitForPortalLoaded(options) {
  const { page, timeoutMs = 30000 } = options;
  const deadline = Date.now() + timeoutMs;
  const routeStabilityMs = Math.min(PORTAL_ROUTE_STABILITY_MS, Math.max(0, timeoutMs / 2));
  let routeReachedAt = null;

  while (Date.now() < deadline) {
    const hasCreatedAssets = await isPortalLoaded(page);

    if (hasCreatedAssets) {
      return true;
    }
    if (isPortalCreatedAssetsRoute(page)) {
      routeReachedAt ??= Date.now();
      if (Date.now() - routeReachedAt >= routeStabilityMs) {
        return true;
      }
    } else {
      routeReachedAt = null;
    }
    await sleep(500);
  }

  return isPortalCreatedAssetsRoute(page);
}

/**
 * Click the visible and enabled CFX Portal sign-in button if it exists.
 * @param {import('puppeteer').Page} page
 * @returns {Promise<boolean>}
 */
async function clickPortalLoginButton(page) {
  return retryOnNavigationContext(() =>
    page.evaluate(() => {
      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const isVisible = (element) => {
        if (!element) return false;
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const button = Array.from(document.querySelectorAll('button')).find((candidate) => {
        const accessibleName = normalize(candidate.getAttribute('aria-label') || candidate.textContent);
        return (
          accessibleName === 'sign in with' &&
          isVisible(candidate) &&
          candidate.disabled !== true &&
          candidate.getAttribute('aria-disabled') !== 'true'
        );
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

async function dismissPortalCookieBanner(page) {
  return retryOnNavigationContext(() =>
    page.evaluate(() => {
      const button = document.querySelector('#onetrust-reject-all-handler');
      if (!button) return false;
      const rect = button.getBoundingClientRect();
      const style = window.getComputedStyle(button);
      const isVisible = rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      const isDisabled = button.disabled === true || button.getAttribute('aria-disabled') === 'true';
      if (!isVisible || isDisabled) return false;
      button.click();
      return true;
    })
  ).catch(() => false);
}

async function readPortalEntryState(page) {
  return page.evaluate(() => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const isVisible = (element) => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const hasHeading = Array.from(document.querySelectorAll('h1, h2, h3'))
      .some((element) => isVisible(element) && normalize(element.textContent) === 'created assets');
    const hasSelectedTab = Array.from(document.querySelectorAll('[role="tab"][aria-selected="true"]'))
      .some((element) => isVisible(element) && normalize(element.textContent) === 'created assets');
    const loginButton = Array.from(document.querySelectorAll('button')).find((candidate) => {
      const accessibleName = normalize(candidate.getAttribute('aria-label') || candidate.textContent);
      return accessibleName === 'sign in with' && isVisible(candidate);
    });
    const loginButtonDisabled = Boolean(
      loginButton &&
      (loginButton.disabled === true || loginButton.getAttribute('aria-disabled') === 'true')
    );

    return {
      portalLoaded: hasHeading || hasSelectedTab,
      hasLoginButton: Boolean(loginButton),
      loginButtonDisabled,
    };
  }).catch(() => ({ portalLoaded: false, hasLoginButton: false, loginButtonDisabled: false }));
}

async function waitForPortalEntryState(page, timeoutMs, options = {}) {
  const { allowCreatedAssetsRoute = false } = options;
  const deadline = Date.now() + timeoutMs;
  const routeStabilityMs = Math.min(PORTAL_ROUTE_STABILITY_MS, Math.max(0, timeoutMs / 2));
  let lastState = { portalLoaded: false, hasLoginButton: false, loginButtonDisabled: false };
  let routeReachedAt = null;
  while (Date.now() < deadline) {
    const state = await readPortalEntryState(page);
    lastState = state;
    if (state.portalLoaded || (state.hasLoginButton && !state.loginButtonDisabled)) {
      return state;
    }
    if (allowCreatedAssetsRoute && isPortalCreatedAssetsRoute(page)) {
      routeReachedAt ??= Date.now();
      if (Date.now() - routeReachedAt >= routeStabilityMs) {
        return { ...state, createdAssetsRouteReached: true };
      }
    } else {
      routeReachedAt = null;
    }
    await sleep(250);
  }
  return {
    ...lastState,
    createdAssetsRouteReached: allowCreatedAssetsRoute && isPortalCreatedAssetsRoute(page),
  };
}

async function readPasswordLoginEntryState(page) {
  return page.evaluate(() => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const isVisible = (element) => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const form = document.querySelector('#login-form');
    const accountInput = form?.querySelector('#login-account-name');
    const passwordInput = form?.querySelector('#login-account-password');
    const currentUserButton = document.querySelector(
      '#toggle-current-user[aria-label="Notifications and account"]'
    );
    const newTopicButton = Array.from(document.querySelectorAll('button')).find((candidate) => {
      const accessibleName = normalize(candidate.getAttribute('aria-label') || candidate.textContent);
      return accessibleName === 'new topic' && isVisible(candidate);
    });
    const hasHeading = Array.from(document.querySelectorAll('h1, h2, h3'))
      .some((element) => isVisible(element) && normalize(element.textContent) === 'created assets');
    const hasSelectedTab = Array.from(document.querySelectorAll('[role="tab"][aria-selected="true"]'))
      .some((element) => isVisible(element) && normalize(element.textContent) === 'created assets');

    return {
      portalLoaded: hasHeading || hasSelectedTab,
      hasPasswordForm: isVisible(form) && isVisible(accountInput) && isVisible(passwordInput),
      forumAuthenticated: (
        window.location.origin === 'https://forum.cfx.re' &&
        window.location.pathname === '/' &&
        isVisible(currentUserButton)
      ),
      hasNewTopicButton: Boolean(newTopicButton),
    };
  }).catch(() => ({
    portalLoaded: false,
    hasPasswordForm: false,
    forumAuthenticated: false,
    hasNewTopicButton: false,
  }));
}

async function waitForPasswordLoginEntryState(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const routeStabilityMs = Math.min(PORTAL_ROUTE_STABILITY_MS, Math.max(0, timeoutMs / 2));
  let routeReachedAt = null;
  while (Date.now() < deadline) {
    const state = await readPasswordLoginEntryState(page);
    if (state.portalLoaded || state.hasPasswordForm || state.forumAuthenticated) {
      return state;
    }
    if (isPortalCreatedAssetsRoute(page)) {
      routeReachedAt ??= Date.now();
      if (Date.now() - routeReachedAt >= routeStabilityMs) {
        return { ...state, createdAssetsRouteReached: true };
      }
    } else {
      routeReachedAt = null;
    }
    await sleep(250);
  }
  return {
    portalLoaded: false,
    hasPasswordForm: false,
    forumAuthenticated: false,
    hasNewTopicButton: false,
    createdAssetsRouteReached: isPortalCreatedAssetsRoute(page),
  };
}

async function ensurePortalAuthenticated(options) {
  const {
    page,
    portalUrl = DEFAULT_PORTAL_URL,
    authTimeoutMs = DEFAULT_AUTH_TIMEOUT_MS,
    onLog = () => {},
  } = options;

  if (await isPortalLoaded(page)) {
    return;
  }

  await page.goto(portalUrl, { waitUntil: 'load' });
  const entryState = await waitForPortalEntryState(page, authTimeoutMs);
  if (entryState.portalLoaded) {
    return;
  }

  if (entryState.loginButtonDisabled) {
    const diagnostic = await readSafeAuthPageDiagnostic(page);
    throw new Error(`CFX Portal SSO handoff remained disabled and did not reach Created Assets. State: ${JSON.stringify(diagnostic)}`);
  }

  if (!entryState.hasLoginButton) {
    const diagnostic = await readSafeAuthPageDiagnostic(page);
    throw new Error(`CFX Portal SSO entry point was not found. State: ${JSON.stringify(diagnostic)}`);
  }

  await dismissPortalCookieBanner(page);
  const navigationAbortController = new AbortController();
  const handoffNavigation = page
    .waitForNavigation({
      waitUntil: 'load',
      timeout: authTimeoutMs,
      signal: navigationAbortController.signal,
    })
    .catch(() => null);
  try {
    const clicked = await clickPortalLoginButton(page);
    if (!clicked) {
      const diagnostic = await readSafeAuthPageDiagnostic(page);
      throw new Error(`CFX Portal SSO button was visible but could not be clicked. State: ${JSON.stringify(diagnostic)}`);
    }
    onLog('CFX Portal SSO handoff started.');
    await Promise.race([handoffNavigation, sleep(3000)]);
  } finally {
    navigationAbortController.abort();
  }

  const loaded = await waitForPortalLoaded({ page, timeoutMs: authTimeoutMs });
  if (!loaded) {
    const diagnostic = await readSafeAuthPageDiagnostic(page);
    throw new Error(`CFX Portal SSO handoff did not reach Created Assets. State: ${JSON.stringify(diagnostic)}`);
  }
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
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const isVisible = (element) => {
      if (!element) {
        return false;
      }

      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };

    const twoFactorVariant = twoFactorVariants.find(
      ({ selector }) => isVisible(document.querySelector(selector))
    ) || null;
    const hasHeading = Array.from(document.querySelectorAll('h1, h2, h3'))
      .some((element) => isVisible(element) && normalize(element.textContent) === 'created assets');
    const hasSelectedTab = Array.from(document.querySelectorAll('[role="tab"][aria-selected="true"]'))
      .some((element) => isVisible(element) && normalize(element.textContent) === 'created assets');
    const currentUserButton = document.querySelector(
      '#toggle-current-user[aria-label="Notifications and account"]'
    );

    return {
      hasTwoFactor: Boolean(twoFactorVariant),
      twoFactorKind: twoFactorVariant?.kind || null,
      twoFactorSelector: twoFactorVariant?.selector || null,
      portalLoaded: hasHeading || hasSelectedTab,
      forumAuthenticated: (
        window.location.origin === 'https://forum.cfx.re' &&
        window.location.pathname === '/' &&
        isVisible(currentUserButton)
      ),
      pageText: document.body?.innerText || '',
    };
  }, TWO_FACTOR_INPUT_VARIANTS).catch(() => ({
    hasTwoFactor: false,
    twoFactorKind: null,
    twoFactorSelector: null,
    portalLoaded: false,
    forumAuthenticated: false,
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
  return normalized.includes('new device') || normalized.includes('new location');
}

function isEmailLoginLinkInvalidText(text) {
  return String(text || '').toLowerCase().includes('oops! the link you used no longer works.');
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

class CfxEmailLoginLinkInvalidError extends Error {
  constructor() {
    super('The CFX email login link is expired, already consumed, or invalid. Request a new link and restart authentication.');
    this.name = 'CfxEmailLoginLinkInvalidError';
    this.code = 'CFX_EMAIL_LOGIN_LINK_INVALID';
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

    if (isEmailLoginLinkInvalidText(state.pageText)) {
      throw new CfxEmailLoginLinkInvalidError();
    }

    if (state.portalLoaded) {
      return 'portal';
    }

    if (state.forumAuthenticated) {
      return 'forum';
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

async function clickPasswordLoginButton(page, timeoutMs = DEFAULT_AUTH_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let clicked = false;
  while (Date.now() < deadline && !clicked) {
    clicked = await retryOnNavigationContext(() =>
      page.evaluate(() => {
        const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const isVisible = (element) => {
          if (!element) return false;
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const form = document.querySelector('#login-form');
        const button = document.querySelector('#login-button');
        const label = normalize(
          button?.textContent || button?.value || button?.getAttribute('aria-label') || button?.getAttribute('title')
        );
        if (
          !isVisible(form) ||
          !isVisible(button) ||
          button.form !== form ||
          label !== 'log in' ||
          button.disabled === true ||
          button.getAttribute('aria-disabled') === 'true'
        ) {
          return false;
        }
        button.click();
        return true;
      })
    );
    if (!clicked) {
      await sleep(250);
    }
  }

  if (!clicked) {
    throw new Error('CFX password login button #login-button was not found or was not actionable.');
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
        if (!element) return false;
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const input = document.querySelector(selector);
      const form = input?.closest('form');
      if (!input || !isVisible(input) || !form) {
        return false;
      }

      let submitButton;
      if (kind === 'password-login') {
        if (form.id !== 'login-form') return false;
        const candidate = document.querySelector('#login-button');
        const label = normalize(
          candidate?.textContent || candidate?.value || candidate?.getAttribute('aria-label') || candidate?.getAttribute('title')
        );
        if (
          candidate?.form === form &&
          label === 'log in' &&
          isVisible(candidate) &&
          candidate.disabled !== true &&
          candidate.getAttribute('aria-disabled') !== 'true'
        ) {
          submitButton = candidate;
        }
      } else {
        submitButton = Array.from(form.querySelectorAll('button[type="submit"], input[type="submit"]'))
          .find((candidate) => {
            const label = normalize(
              candidate.textContent || candidate.value || candidate.getAttribute('aria-label') || candidate.getAttribute('title')
            );
            return (
              label === 'finish login' &&
              isVisible(candidate) &&
              candidate.disabled !== true &&
              candidate.getAttribute('aria-disabled') !== 'true'
            );
          });
      }

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

async function waitForPostTwoFactorState(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await readPasswordAuthState(page);
    if (state.forumAuthenticated || state.portalLoaded) {
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
  const markNavigationRequest = (request) => {
    try {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        navigationDetected = true;
      }
    } catch {
      // A disappearing request/frame is itself evidence of a transition.
      navigationDetected = true;
    }
  };
  const markMainFrameNavigation = (frame) => {
    if (frame === page.mainFrame()) {
      navigationDetected = true;
    }
  };
  const canObservePageEvents = typeof page.on === 'function' && typeof page.off === 'function';
  if (canObservePageEvents) {
    page.on('request', markNavigationRequest);
    page.on('framenavigated', markMainFrameNavigation);
  }
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

    const submitGraceMs = variant.kind === 'password-login' ? TWO_FACTOR_AUTO_SUBMIT_GRACE_MS : 0;
    await Promise.race([navigationPromise, sleep(submitGraceMs)]);
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

    const transitioned = await waitForPostTwoFactorState(page, authTimeoutMs);
    if (!transitioned) {
      const messages = await readVisibleAuthMessages(page);
      const suffix = messages.length > 0 ? ` ${messages.join(' ')}` : '';
      const diagnostic = await readSafeAuthPageDiagnostic(page);
      throw new Error(`CFX 2FA submission did not reach an authenticated Forum or Portal state.${suffix} State: ${JSON.stringify(diagnostic)}`);
    }

    await Promise.race([navigationPromise, sleep(500)]);
  } finally {
    navigationAbortController.abort();
    if (canObservePageEvents) {
      page.off('request', markNavigationRequest);
      page.off('framenavigated', markMainFrameNavigation);
    }
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

  const portalEntryState = await waitForPortalEntryState(page, authTimeoutMs, {
    allowCreatedAssetsRoute: true,
  });
  if (portalEntryState.portalLoaded) {
    return;
  }
  if (portalEntryState.createdAssetsRouteReached) {
    onLog('CFX Portal Created Assets route reached without a recognized DOM state. Deferring authentication validation to the Portal API.');
    return;
  }
  if (portalEntryState.loginButtonDisabled) {
    const diagnostic = await readSafeAuthPageDiagnostic(page);
    throw new Error(`CFX Portal login handoff remained disabled and did not reach Created Assets. State: ${JSON.stringify(diagnostic)}`);
  }
  if (!portalEntryState.hasLoginButton) {
    const diagnostic = await readSafeAuthPageDiagnostic(page);
    throw new Error(`CFX Portal login entry point was not found. State: ${JSON.stringify(diagnostic)}`);
  }

  await dismissPortalCookieBanner(page);
  const entryNavigationAbortController = new AbortController();
  const entryNavigation = page
    .waitForNavigation({
      waitUntil: 'load',
      timeout: authTimeoutMs,
      signal: entryNavigationAbortController.signal,
    })
    .catch(() => null);
  try {
    const clicked = await clickPortalLoginButton(page);
    if (!clicked) {
      const diagnostic = await readSafeAuthPageDiagnostic(page);
      throw new Error(`CFX Portal login button was visible but could not be clicked. State: ${JSON.stringify(diagnostic)}`);
    }
    await Promise.race([entryNavigation, sleep(3000)]);
  } finally {
    entryNavigationAbortController.abort();
  }

  const loginEntryState = await waitForPasswordLoginEntryState(page, authTimeoutMs);
  if (loginEntryState.portalLoaded) {
    return;
  }
  if (loginEntryState.createdAssetsRouteReached) {
    onLog('CFX Portal Created Assets route reached after the login handoff without a recognized DOM state. Deferring authentication validation to the Portal API.');
    return;
  }
  if (loginEntryState.forumAuthenticated) {
    onLog('Existing authenticated CFX Forum profile detected.');
    return;
  }
  if (!loginEntryState.hasPasswordForm) {
    const diagnostic = await readSafeAuthPageDiagnostic(page);
    throw new Error(`CFX Forum password login form was not found. State: ${JSON.stringify(diagnostic)}`);
  }

  await fillVisibleInput(page, '#login-account-name', auth.email);
  await fillVisibleInput(page, '#login-account-password', auth.password);

  const loginNavigationAbortController = new AbortController();
  const loginNavigation = page.waitForNavigation({
    waitUntil: 'load',
    timeout: authTimeoutMs,
    signal: loginNavigationAbortController.signal,
  }).catch(() => null);
  let authStage;
  try {
    await clickPasswordLoginButton(page, authTimeoutMs);
    authStage = await waitForPasswordAuthStage({
      page,
      authTimeoutMs,
      emailVerificationTimeoutMs,
      emailVerificationLinkProvider: auth.emailVerificationLinkProvider,
      onLog,
    });
  } finally {
    loginNavigationAbortController.abort();
  }

  if (authStage === 'portal' || authStage === 'forum') {
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
    requirePortalPage = true,
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

    if (requirePortalPage) {
      await ensurePortalAuthenticated({
        page,
        portalUrl,
        authTimeoutMs,
        onLog,
      });
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
  CfxEmailLoginLinkInvalidError,
  CfxEmailVerificationTimeoutError,
  CfxLoginRateLimitedError,
  buildUserAgentMetadata,
  clickPasswordLoginButton,
  configurePageFingerprint,
  createLaunchOptions,
  dismissPortalCookieBanner,
  ensurePortalAuthenticated,
  isEmailLoginLinkInvalidText,
  isEmailVerificationChallengeText,
  isLoginRateLimitedText,
  isPortalLoaded,
  normalizeEmailVerificationLink,
  normalizeHeadlessUserAgent,
  normalizeTwoFactorCode,
  readPasswordLoginEntryState,
  readPortalEntryState,
  resolveEmailVerificationLink,
  sanitizeCfxUrl,
  resolveTwoFactorCode,
  submitTwoFactorCode,
  validatePasswordAuth,
  waitForPasswordAuthStage,
};
