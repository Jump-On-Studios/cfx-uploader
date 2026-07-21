const API_ORIGIN = 'https://portal-api.cfx.re';
const PORTAL_ORIGIN = 'https://portal.cfx.re';

function buildCookieHeader(cookies) {
  const cookieMap = new Map();

  for (const cookie of cookies || []) {
    if (!cookie.name || typeof cookie.value !== 'string') {
      continue;
    }

    cookieMap.set(cookie.name, cookie.value);
  }

  return Array.from(cookieMap.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

function createCfxHttpSessionFromCookies(cookies, userAgent = 'Mozilla/5.0') {
  const cookieHeader = buildCookieHeader(cookies);

  if (!cookieHeader) {
    throw new Error('No CFX cookies found after browser authentication');
  }

  return {
    apiOrigin: API_ORIGIN,
    portalOrigin: PORTAL_ORIGIN,
    userAgent,
    cookies,
    baseHeaders: {
      accept: '*/*',
      'cache-control': 'no-cache',
      origin: PORTAL_ORIGIN,
      pragma: 'no-cache',
      referer: `${PORTAL_ORIGIN}/`,
      'user-agent': userAgent,
      cookie: cookieHeader,
    },
  };
}

async function createCfxHttpSession(page) {
  const [cookies, userAgent] = await Promise.all([
    page.cookies(PORTAL_ORIGIN, API_ORIGIN),
    page.evaluate(() => navigator.userAgent).catch(() => 'Mozilla/5.0'),
  ]);

  return createCfxHttpSessionFromCookies(cookies, userAgent);
}

async function readResponseBody(response) {
  try {
    return await response.text();
  } catch (error) {
    return `<failed to read response body: ${error.message}>`;
  }
}

function resolveApiUrl(session, pathOrUrl) {
  if (/^https?:\/\//i.test(pathOrUrl)) {
    return pathOrUrl;
  }

  return `${session.apiOrigin}${pathOrUrl}`;
}

async function cfxFetch(session, pathOrUrl, options = {}) {
  const response = await fetch(resolveApiUrl(session, pathOrUrl), {
    ...options,
    headers: {
      ...session.baseHeaders,
      ...(options.headers || {}),
    },
  });

  if (response.status === 401 || response.status === 403) {
    const body = await readResponseBody(response);
    const error = new Error(`CFX HTTP auth failed (${response.status}): ${body}`);
    error.status = response.status;
    error.isCfxAuthError = true;
    throw error;
  }

  return response;
}

async function cfxJson(session, pathOrUrl, options = {}) {
  const response = await cfxFetch(session, pathOrUrl, options);
  const body = await readResponseBody(response);

  if (!response.ok) {
    const method = options.method || 'GET';
    throw new Error(`${method} ${resolveApiUrl(session, pathOrUrl)} failed (${response.status}): ${body}`);
  }

  if (!body) {
    return {};
  }

  try {
    return JSON.parse(body);
  } catch (error) {
    throw new Error(`Invalid JSON response from ${resolveApiUrl(session, pathOrUrl)}: ${body}`);
  }
}

module.exports = {
  API_ORIGIN,
  PORTAL_ORIGIN,
  buildCookieHeader,
  createCfxHttpSession,
  createCfxHttpSessionFromCookies,
  cfxFetch,
  cfxJson,
  readResponseBody,
};
