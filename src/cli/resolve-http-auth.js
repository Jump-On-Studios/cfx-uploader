const { resolvePasskeyCredential } = require('../auth/passkey-credential');
const { createConsoleTwoFactorCodeProvider } = require('../auth/two-factor-prompt');
const { parseAuthMethodFromArgs } = require('../utils/args');

function resolveHttpAuthMethod(args = process.argv.slice(2)) {
  const fromArgs = parseAuthMethodFromArgs(args) || null;
  const fromEnv = process.env.CFX_UPLOADER_AUTH_METHOD?.trim().toLowerCase() || null;
  const method = fromArgs || fromEnv || 'passkey';

  if (method !== 'passkey' && method !== 'password') {
    throw new Error(`Invalid CFX authentication method: ${method}. Expected passkey or password.`);
  }

  return method;
}

async function resolveHttpCliAuth({ args, projectRoot }) {
  const method = resolveHttpAuthMethod(args);

  if (method === 'password') {
    if (!process.env.CFX_UPLOADER_EMAIL) {
      throw new Error('Missing CFX_UPLOADER_EMAIL for password authentication.');
    }

    if (!process.env.CFX_UPLOADER_PASSWORD) {
      throw new Error('Missing CFX_UPLOADER_PASSWORD for password authentication.');
    }

    return {
      auth: {
        method: 'password',
        username: process.env.CFX_UPLOADER_EMAIL,
        password: process.env.CFX_UPLOADER_PASSWORD,
        twoFactorCodeProvider: createConsoleTwoFactorCodeProvider(),
      },
      passkey: null,
      passkeySource: null,
    };
  }

  const passkey = await resolvePasskeyCredential({ projectRoot });
  return {
    auth: null,
    passkey: passkey.credential,
    passkeySource: passkey.source,
  };
}

module.exports = {
  resolveHttpAuthMethod,
  resolveHttpCliAuth,
};
