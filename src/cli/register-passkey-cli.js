/**
 * Register a CFX forum passkey with a Chromium virtual authenticator.
 * Writes the resulting WebAuthn credential to ./passkey-credential.json.
 */
const fs = require('fs/promises');
const path = require('path');
const readline = require('readline/promises');
const puppeteer = require('puppeteer');

const FORUM_SECURITY_URL = 'https://forum.cfx.re/u/me/preferences/security';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createLaunchOptions() {
  return {
    headless: false,
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

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function setupVirtualAuthenticator(page) {
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

  return { client, authenticatorId };
}

async function getRegisteredCredentials(client, authenticatorId) {
  const { credentials } = await client.send('WebAuthn.getCredentials', { authenticatorId });

  return credentials.map((credential) => ({
    credentialId: credential.credentialId,
    rpId: credential.rpId,
    privateKey: credential.privateKey,
    userHandle: credential.userHandle || '',
    signCount: credential.signCount,
  }));
}

async function saveCredential(credential, credentialPath) {
  await fs.writeFile(credentialPath, `${JSON.stringify(credential, null, 2)}\n`, 'utf-8');
}

async function waitForEnter(message) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    await rl.question(message);
  } finally {
    rl.close();
  }
}

async function registerPasskey(args = process.argv.slice(2)) {
  const projectRoot = path.resolve(__dirname, '..', '..');
  const credentialPath = path.join(projectRoot, 'passkey-credential.json');
  const force = args.includes('--force');

  if (!force && (await fileExists(credentialPath))) {
    throw new Error(
      `passkey-credential.json already exists. Delete it first or rerun with --force. Path: ${credentialPath}`
    );
  }

  console.log('\nCFX passkey registration\n');
  console.log('A visible browser will open on the CFX forum security page.');
  console.log('In the browser:');
  console.log('1. Sign in if needed.');
  console.log('2. Open the security page if the login flow redirects elsewhere.');
  console.log('3. Click "Add passkey".');
  console.log('4. Enter a passkey name and confirm.');
  console.log('5. Return to this terminal and press Enter.\n');

  const browser = await puppeteer.launch(createLaunchOptions());

  try {
    const pages = await browser.pages();
    const page = pages[0] || (await browser.newPage());
    const { client, authenticatorId } = await setupVirtualAuthenticator(page);

    await page.goto(FORUM_SECURITY_URL, { waitUntil: 'load' });
    await sleep(2000);

    await waitForEnter('Press Enter after the passkey has been added in the browser...');

    const credentials = await getRegisteredCredentials(client, authenticatorId);
    if (credentials.length === 0) {
      throw new Error('No passkey credentials found. Registration may not have completed.');
    }

    const credential = credentials[credentials.length - 1];
    await saveCredential(credential, credentialPath);

    console.log(`\nPasskey registered successfully. rpId=${credential.rpId}`);
    console.log(`Credential saved to: ${credentialPath}\n`);
  } finally {
    await browser.close();
  }
}

module.exports = {
  registerPasskey,
};

if (require.main === module) {
  registerPasskey().catch((error) => {
    console.error('register-passkey failed:', error.message || error);
    process.exit(1);
  });
}
