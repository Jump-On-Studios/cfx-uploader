/**
 * Module responsibility:
 * Launch Puppeteer, perform CFX passkey SSO, and return an authenticated page context.
 */
const path = require('path');
const puppeteer = require('puppeteer');
const {
  loadPasskeyCredentialFromFile,
  validatePasskeyCredential,
} = require('./passkey-credential');

const DEFAULT_PORTAL_URL = 'https://portal.cfx.re/assets/created-assets';
const DEFAULT_AUTH_TIMEOUT_MS = 30000;
const DEFAULT_TWO_FACTOR_TIMEOUT_MS = 10 * 60 * 1000;

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
function createLaunchOptions(headless) {
  return {
    headless,
    protocolTimeout: 120000,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1280,800',
    ],
    defaultViewport: { width: 1280, height: 800 },
  };
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
async function waitForPortalLoaded(options) {
  const { page, timeoutMs = 30000 } = options;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const hasCreatedAssets = await page
      .evaluate(() => document.body && document.body.innerText.includes('Created Assets'))
      .catch(() => false);

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

async function authenticateWithPassword(options) {
  const {
    page,
    portalUrl,
    auth,
    authTimeoutMs = DEFAULT_AUTH_TIMEOUT_MS,
    twoFactorTimeoutMs = DEFAULT_TWO_FACTOR_TIMEOUT_MS,
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

  try {
    await waitForVisibleSelector(page, '#login-second-factor', authTimeoutMs);
  } catch (error) {
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

  const twoFactorNavigation = page.waitForNavigation({ waitUntil: 'load', timeout: authTimeoutMs }).catch(() => null);
  try {
    await fillVisibleInput(page, '#login-second-factor', code);
  } catch (error) {
    if (!isNavigationContextError(error)) {
      throw error;
    }
  }
  await twoFactorNavigation;

  if (await waitForPortalLoaded({ page, timeoutMs: 2000 })) {
    return;
  }

  if (!page.url().includes('portal.cfx.re')) {
    await page.goto(portalUrl, { waitUntil: 'load' });
  }

  if (page.url().includes('/login')) {
    await clickPortalLoginButton(page);
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

  const browser = await puppeteer.launch(createLaunchOptions(headless));

  try {
    const pages = await browser.pages();
    const page = pages[0] || (await browser.newPage());

    if (resolvedAuthMethod === 'password') {
      await authenticateWithPassword({
        page,
        portalUrl,
        auth,
        authTimeoutMs,
        twoFactorTimeoutMs,
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
      throw new Error(`Portal failed to load (timeout), last URL: ${page.url()}`);
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
  normalizeTwoFactorCode,
  resolveTwoFactorCode,
  validatePasswordAuth,
};
