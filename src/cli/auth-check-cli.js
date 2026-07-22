#!/usr/bin/env node
const { checkAuthentication } = require('../../index');
const { parseHeadlessFromArgs } = require('../utils/args');
const { loadProjectEnv } = require('../utils/runtime-env');
const { resolveHttpCliAuth } = require('./resolve-http-auth');

function resolveTimeoutMs(name) {
  const value = process.env[name];
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

async function runAuthCheckCli(args = process.argv.slice(2)) {
  const projectRoot = process.cwd();
  loadProjectEnv(projectRoot);
  const authConfig = await resolveHttpCliAuth({ args, projectRoot });
  const result = await checkAuthentication({
    auth: authConfig.auth,
    passkey: authConfig.passkey,
    headless: parseHeadlessFromArgs(args),
    headlessFingerprint: process.env.CFX_UPLOADER_HEADLESS_FINGERPRINT || 'native',
    browserProfilePath: process.env.CFX_UPLOADER_BROWSER_PROFILE_PATH || null,
    sessionCachePath: process.env.CFX_UPLOADER_SESSION_CACHE_PATH || null,
    sessionEncryptionKey: process.env.CFX_UPLOADER_SESSION_KEY || null,
    twoFactorTimeoutMs: resolveTimeoutMs('CFX_UPLOADER_2FA_TIMEOUT_MS'),
    emailVerificationTimeoutMs: resolveTimeoutMs('CFX_UPLOADER_EMAIL_VERIFICATION_TIMEOUT_MS'),
  });
  console.log(`CFX authentication valid: method=${result.authMethod} sessionReused=${result.sessionReused}`);
  return result;
}

if (require.main === module) {
  runAuthCheckCli().catch((error) => {
    console.error(`CFX authentication check failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  resolveTimeoutMs,
  runAuthCheckCli,
};
