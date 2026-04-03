/**
 * Module responsibility:
 * Resolve CFX passkey credentials from CI secrets or local files.
 */
const fs = require('fs/promises');
const path = require('path');

const ENV_FIELDS = {
  credentialId: 'CFX_UPLOADER_CREDENTIAL_ID',
  rpId: 'CFX_UPLOADER_RP_ID',
  privateKey: 'CFX_UPLOADER_PRIVATE_KEY',
  userHandle: 'CFX_UPLOADER_USER_HANDLE',
  signCount: 'CFX_UPLOADER_SIGN_COUNT',
};

const PASSKEY_JSON_ENV = 'CFX_UPLOADER_PASSKEY_JSON';

function isGitHubActions() {
  return process.env.GITHUB_ACTIONS === 'true';
}

function formatExpectedEnvSecrets() {
  return Object.values(ENV_FIELDS).join(', ');
}

async function loadPasskeyCredentialFromFile(credentialPath) {
  const raw = await fs.readFile(credentialPath, 'utf-8');
  return JSON.parse(raw);
}

function validatePasskeyCredential(credential, sourceLabel = 'passkey credential') {
  if (!credential || typeof credential !== 'object' || Array.isArray(credential)) {
    throw new Error(`Invalid ${sourceLabel}: expected an object.`);
  }

  for (const fieldName of ['credentialId', 'rpId', 'privateKey', 'userHandle']) {
    if (!credential[fieldName] || typeof credential[fieldName] !== 'string') {
      throw new Error(`Invalid ${sourceLabel}: ${fieldName} must be a non-empty string.`);
    }
  }

  if (!Number.isInteger(credential.signCount) || credential.signCount < 0) {
    throw new Error(`Invalid ${sourceLabel}: signCount must be a non-negative integer.`);
  }

  return {
    credentialId: credential.credentialId,
    rpId: credential.rpId,
    privateKey: credential.privateKey,
    userHandle: credential.userHandle,
    signCount: credential.signCount,
  };
}

function parsePasskeyCredentialJson(passkeyJson, sourceLabel = 'passkey JSON') {
  if (!passkeyJson || typeof passkeyJson !== 'string') {
    throw new Error(`Invalid ${sourceLabel}: expected a non-empty JSON string.`);
  }

  try {
    return validatePasskeyCredential(JSON.parse(passkeyJson), sourceLabel);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid ${sourceLabel}: ${error.message}`);
    }
    throw error;
  }
}

function readCredentialFromEnv() {
  const values = {};
  const missing = [];
  const present = [];

  for (const [fieldName, envName] of Object.entries(ENV_FIELDS)) {
    const value = process.env[envName];
    if (value) {
      values[fieldName] = value;
      present.push(envName);
    } else {
      missing.push(envName);
    }
  }

  if (present.length === 0) {
    return null;
  }

  if (missing.length > 0) {
    throw new Error(`Incomplete CFX passkey environment secrets. Missing: ${missing.join(', ')}`);
  }

  const signCount = Number.parseInt(values.signCount, 10);
  return validatePasskeyCredential(
    {
      ...values,
      signCount,
    },
    'CFX_UPLOADER_* environment secrets'
  );
}

function readCredentialJsonFromEnv() {
  const passkeyJson = process.env[PASSKEY_JSON_ENV];
  if (!passkeyJson) {
    return null;
  }

  return parsePasskeyCredentialJson(passkeyJson, PASSKEY_JSON_ENV);
}

async function resolvePasskeyCredential(options = {}) {
  const projectRoot = options.projectRoot || process.cwd();
  const explicitPath = process.env.PASSKEY_CREDENTIAL_PATH || options.passkeyCredentialPath;

  if (explicitPath) {
    const credentialPath = path.resolve(explicitPath);
    const credential = await loadPasskeyCredentialFromFile(credentialPath);
    return {
      credential: validatePasskeyCredential(credential, credentialPath),
      source: credentialPath,
    };
  }

  const envJsonCredential = readCredentialJsonFromEnv();
  if (envJsonCredential) {
    return {
      credential: envJsonCredential,
      source: PASSKEY_JSON_ENV,
    };
  }

  const envCredential = readCredentialFromEnv();
  if (envCredential) {
    return {
      credential: envCredential,
      source: 'CFX_UPLOADER_* environment secrets',
    };
  }

  if (isGitHubActions()) {
    throw new Error(
      `Missing CFX passkey credentials in GitHub Actions. Add organization or repository secrets: ${formatExpectedEnvSecrets()}.`
    );
  }

  const localCredentialPath = path.join(projectRoot, 'passkey-credential.json');
  const credential = await loadPasskeyCredentialFromFile(localCredentialPath);
  return {
    credential: validatePasskeyCredential(credential, localCredentialPath),
    source: localCredentialPath,
  };
}

module.exports = {
  ENV_FIELDS,
  PASSKEY_JSON_ENV,
  formatExpectedEnvSecrets,
  loadPasskeyCredentialFromFile,
  parsePasskeyCredentialJson,
  validatePasskeyCredential,
  resolvePasskeyCredential,
};
