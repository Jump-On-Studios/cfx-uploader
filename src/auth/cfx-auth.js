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
  await retryOnNavigationContext(() =>
    page.evaluate(() => {
      const button = document.querySelector('button[class*="login_noWrap"]');
      if (button) {
        button.click();
      }
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
  await retryOnNavigationContext(() =>
    page.evaluate(() => {
      const buttons = document.querySelectorAll('button');
      for (const button of buttons) {
        if (button.textContent && button.textContent.toLowerCase().includes('passkey')) {
          button.click();
          break;
        }
      }
    })
  );
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
    credential: providedCredential,
    passkeyCredentialPath,
    portalUrl = DEFAULT_PORTAL_URL,
  } = options;

  if (!providedCredential && !passkeyCredentialPath) {
    throw new Error('Missing passkey credential. Provide credential or passkeyCredentialPath.');
  }

  const credential = providedCredential
    ? validatePasskeyCredential(providedCredential, 'provided passkey credential')
    : validatePasskeyCredential(
      await loadPasskeyCredentialFromFile(path.resolve(passkeyCredentialPath)),
      path.resolve(passkeyCredentialPath)
    );
  const browser = await puppeteer.launch(createLaunchOptions(headless));

  try {
    const pages = await browser.pages();
    const page = pages[0] || (await browser.newPage());

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

    const loaded = await waitForPortalLoaded({ page, timeoutMs: 30000 });
    if (!loaded) {
      throw new Error(`Portal failed to load (timeout), last URL: ${page.url()}`);
    }

    return { browser, page };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

module.exports = {
  authenticateToCfx,
};
