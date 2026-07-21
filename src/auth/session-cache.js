const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

const SESSION_CACHE_VERSION = 1;
const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const LOCK_TIMEOUT_MS = 120000;
const LOCK_RETRY_INTERVAL_MS = 250;
const LOCK_STALE_MS = 15 * 60 * 1000;

function assertEncryptionKey(encryptionKey) {
  if (!encryptionKey || typeof encryptionKey !== 'string') {
    throw new Error('CFX session cache requires a non-empty sessionEncryptionKey.');
  }
}

function deriveEncryptionKey(encryptionKey, salt) {
  assertEncryptionKey(encryptionKey);
  return crypto.scryptSync(encryptionKey, salt, KEY_LENGTH);
}

function normalizeCookie(cookie) {
  if (!cookie || typeof cookie !== 'object' || typeof cookie.name !== 'string' || typeof cookie.value !== 'string') {
    return null;
  }

  const normalized = {
    name: cookie.name,
    value: cookie.value,
    httpOnly: cookie.httpOnly === true,
    secure: cookie.secure === true,
  };

  if (cookie.domain) {
    normalized.domain = cookie.domain;
  }
  if (cookie.path) {
    normalized.path = cookie.path;
  }
  if (Number.isFinite(cookie.expires)) {
    normalized.expires = cookie.expires;
  }
  if (cookie.sameSite) {
    normalized.sameSite = cookie.sameSite;
  }

  return normalized;
}

function normalizeSession(session) {
  if (!session || typeof session !== 'object') {
    throw new Error('Invalid CFX session cache payload: expected an object.');
  }

  if (!session.userAgent || typeof session.userAgent !== 'string') {
    throw new Error('Invalid CFX session cache payload: missing userAgent.');
  }

  const cookies = Array.isArray(session.cookies)
    ? session.cookies.map(normalizeCookie).filter(Boolean)
    : [];

  if (cookies.length === 0) {
    throw new Error('Invalid CFX session cache payload: missing cookies.');
  }

  return {
    version: SESSION_CACHE_VERSION,
    createdAt: session.createdAt || new Date().toISOString(),
    updatedAt: session.updatedAt || new Date().toISOString(),
    userAgent: session.userAgent,
    cookies,
  };
}

function encryptSession(session, encryptionKey) {
  const normalizedSession = normalizeSession(session);
  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = deriveEncryptionKey(encryptionKey, salt);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
  const plaintext = Buffer.from(JSON.stringify(normalizedSession), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return JSON.stringify({
    version: SESSION_CACHE_VERSION,
    algorithm: ENCRYPTION_ALGORITHM,
    kdf: 'scrypt',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  });
}

function decryptSession(serialized, encryptionKey) {
  assertEncryptionKey(encryptionKey);

  let envelope;
  try {
    envelope = JSON.parse(serialized);
  } catch (error) {
    throw new Error(`Invalid CFX session cache envelope: ${error.message}`);
  }

  if (
    !envelope ||
    envelope.version !== SESSION_CACHE_VERSION ||
    envelope.algorithm !== ENCRYPTION_ALGORITHM ||
    envelope.kdf !== 'scrypt'
  ) {
    throw new Error('Unsupported CFX session cache envelope.');
  }

  let salt;
  let iv;
  let authTag;
  let ciphertext;
  try {
    salt = Buffer.from(envelope.salt, 'base64');
    iv = Buffer.from(envelope.iv, 'base64');
    authTag = Buffer.from(envelope.authTag, 'base64');
    ciphertext = Buffer.from(envelope.ciphertext, 'base64');
  } catch (error) {
    throw new Error(`Invalid CFX session cache envelope encoding: ${error.message}`);
  }

  if (
    salt.length !== SALT_LENGTH ||
    iv.length !== IV_LENGTH ||
    authTag.length !== AUTH_TAG_LENGTH ||
    ciphertext.length === 0
  ) {
    throw new Error('Invalid CFX session cache envelope fields.');
  }

  try {
    const key = deriveEncryptionKey(encryptionKey, salt);
    const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    return normalizeSession(JSON.parse(plaintext));
  } catch (error) {
    if (error.message.startsWith('Invalid CFX session cache payload')) {
      throw error;
    }
    throw new Error('Unable to decrypt CFX session cache. Check the sessionEncryptionKey.');
  }
}

async function loadSessionCache(sessionCachePath, encryptionKey) {
  if (!sessionCachePath) {
    return null;
  }

  assertEncryptionKey(encryptionKey);

  try {
    const serialized = await fs.readFile(sessionCachePath, 'utf8');
    return decryptSession(serialized, encryptionKey);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function saveSessionCache(sessionCachePath, encryptionKey, session) {
  if (!sessionCachePath) {
    return;
  }

  assertEncryptionKey(encryptionKey);
  const absolutePath = path.resolve(sessionCachePath);
  const directory = path.dirname(absolutePath);
  const temporaryPath = `${absolutePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;

  await fs.mkdir(directory, { recursive: true });
  const serialized = encryptSession({
    ...session,
    updatedAt: new Date().toISOString(),
  }, encryptionKey);

  try {
    await fs.writeFile(temporaryPath, serialized, { encoding: 'utf8', mode: 0o600 });
    await fs.chmod(temporaryPath, 0o600).catch(() => {});

    try {
      await fs.rename(temporaryPath, absolutePath);
    } catch (error) {
      if (!['EEXIST', 'EPERM'].includes(error.code)) {
        throw error;
      }
      await fs.rm(absolutePath, { force: true });
      await fs.rename(temporaryPath, absolutePath);
    }

    await fs.chmod(absolutePath, 0o600).catch(() => {});
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

async function invalidateSessionCache(sessionCachePath) {
  if (!sessionCachePath) {
    return;
  }

  await fs.rm(sessionCachePath, { force: true });
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireSessionCacheLock(sessionCachePath, options = {}) {
  if (!sessionCachePath) {
    return async () => {};
  }

  const timeoutMs = options.timeoutMs || LOCK_TIMEOUT_MS;
  const retryIntervalMs = options.retryIntervalMs || LOCK_RETRY_INTERVAL_MS;
  const staleMs = options.staleMs || LOCK_STALE_MS;
  const lockPath = `${path.resolve(sessionCachePath)}.lock`;
  const startedAt = Date.now();

  await fs.mkdir(path.dirname(lockPath), { recursive: true });

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const handle = await fs.open(lockPath, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      await handle.close();

      return async () => {
        await fs.rm(lockPath, { force: true });
      };
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }

      try {
        const stats = await fs.stat(lockPath);
        if (Date.now() - stats.mtimeMs > staleMs) {
          await fs.rm(lockPath, { force: true });
          continue;
        }
      } catch (statError) {
        if (statError.code !== 'ENOENT') {
          throw statError;
        }
      }

      await sleep(retryIntervalMs);
    }
  }

  throw new Error(`Timed out waiting for CFX session cache lock: ${lockPath}`);
}

module.exports = {
  SESSION_CACHE_VERSION,
  acquireSessionCacheLock,
  assertEncryptionKey,
  decryptSession,
  encryptSession,
  invalidateSessionCache,
  loadSessionCache,
  normalizeSession,
  saveSessionCache,
};
