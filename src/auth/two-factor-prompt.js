const readline = require('readline/promises');

function createConsoleTwoFactorCodeProvider(options = {}) {
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;

  return async ({ attempt, timeoutMs }) => {
    if (!input.isTTY || !output.isTTY) {
      throw new Error('Interactive CFX 2FA requires a TTY. Provide auth.twoFactorCodeProvider in library mode.');
    }

    const prompt = readline.createInterface({ input, output });
    try {
      return await prompt.question(`CFX 2FA code (6 digits, attempt ${attempt}, timeout ${Math.ceil(timeoutMs / 60000)} minutes): `);
    } finally {
      prompt.close();
    }
  };
}

function createConsoleEmailVerificationLinkProvider(options = {}) {
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;

  return async ({ attempt, timeoutMs }) => {
    if (!input.isTTY || !output.isTTY) {
      throw new Error('Interactive CFX email verification requires a TTY. Provide auth.emailVerificationLinkProvider in library mode.');
    }

    const prompt = readline.createInterface({ input, output });
    try {
      return await prompt.question(`CFX email login link (attempt ${attempt}, timeout ${Math.ceil(timeoutMs / 60000)} minutes): `);
    } finally {
      prompt.close();
    }
  };
}

module.exports = {
  createConsoleEmailVerificationLinkProvider,
  createConsoleTwoFactorCodeProvider,
};
