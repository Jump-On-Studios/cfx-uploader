const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const AdmZip = require('adm-zip');

const { attachZipToRelease, getDownloadInfoFromRelease } = require('../src/github/release-download');
const { runHttpUploadFlow } = require('../src/core/upload-http-flow');
const { createCfxHttpSessionFromCookies } = require('../src/cfx/http-session');
const { getVersionStatus } = require('../src/cfx/http-upload');

const REPOSITORY = 'Jump-On-Studios/RedM-jo_libs';
const RELEASE = {
  id: 42,
  tag_name: 'v2.17.0',
  zipball_url: 'https://api.github.com/repos/Jump-On-Studios/RedM-jo_libs/zipball/v2.17.0',
  assets: [{ name: 'jo_libs.zip', browser_download_url: 'https://github.com/download/jo_libs.zip' }],
};

async function withMockedFetch(handler, run) {
  const originalFetch = global.fetch;
  const requests = [];
  try {
    global.fetch = async (url, init = {}) => {
      const request = { url: String(url), method: init.method || 'GET', headers: init.headers || {} };
      requests.push(request);
      return handler(request);
    };
    return await run(requests);
  } finally {
    global.fetch = originalFetch;
  }
}

function zipBuffer(files) {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(files)) {
    zip.addFile(name, Buffer.from(content));
  }
  return zip.toBuffer();
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status });
}

test('always uses the source zipball, even when the release has a ZIP asset', () => {
  const info = getDownloadInfoFromRelease(RELEASE);
  assert.equal(info.source, 'zipball');
  assert.equal(info.url, RELEASE.zipball_url);
  assert.equal(info.fileName, 'v2.17.0.zip');
  assert.equal(info.releaseId, 42);
});

test('never downloads the release ZIP asset', async () => {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cfx-release-zip-'));
  const manifest = 'fx_version "cerulean"\ngame "rdr3"\nversion "1.0.0"\n';
  try {
    await withMockedFetch((request) => {
      if (request.url.endsWith('/releases/tags/v2.17.0')) return json(RELEASE);
      if (request.url === RELEASE.zipball_url) {
        return new Response(zipBuffer({
          'Jump-On-Studios-RedM-jo_libs-abc123/cfx_uploader.json': JSON.stringify({ portalName: 'RedM - jo_libs', foldersToZip: ['jo_libs'] }),
          'Jump-On-Studios-RedM-jo_libs-abc123/jo_libs/fxmanifest.lua': manifest,
        }));
      }
      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    }, async (requests) => {
      // The manifest version differs from the tag on purpose: the flow stops right after the config is read.
      await assert.rejects(
        runHttpUploadFlow({ projectRoot: workDir, repository: REPOSITORY, releaseTag: 'v2.17.0', onLog: () => {} }),
        /Release tag version mismatch/,
      );
      assert.deepEqual(requests.map((request) => request.url), [
        'https://api.github.com/repos/Jump-On-Studios/RedM-jo_libs/releases/tags/v2.17.0',
        RELEASE.zipball_url,
      ]);
    });
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
});

test('attaches the ZIP to a release that has none', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cfx-attach-'));
  const zipPath = path.join(directory, 'jo_chest.zip');
  await fs.writeFile(zipPath, zipBuffer({ 'jo_chest/fxmanifest.lua': 'version "1.0.0"' }));
  try {
    await withMockedFetch((request) => {
      if (request.method === 'GET') return json({ ...RELEASE, assets: [] });
      return json({ name: 'jo_chest.zip', browser_download_url: 'https://github.com/download/jo_chest.zip' }, 201);
    }, async (requests) => {
      const result = await attachZipToRelease({ repository: REPOSITORY, releaseId: 42, zipPath, githubToken: 'token' });
      assert.deepEqual(result, { status: 'uploaded', name: 'jo_chest.zip', url: 'https://github.com/download/jo_chest.zip' });
      assert.equal(requests[1].method, 'POST');
      assert.equal(requests[1].url, `https://uploads.github.com/repos/${REPOSITORY}/releases/42/assets?name=jo_chest.zip`);
      assert.equal(requests[1].headers['Content-Type'], 'application/zip');
    });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('does not attach a ZIP when the release got one in the meantime', async () => {
  await withMockedFetch(() => json(RELEASE), async (requests) => {
    const result = await attachZipToRelease({ repository: REPOSITORY, releaseId: 42, zipPath: 'unused.zip', githubToken: 'token' });
    assert.deepEqual(result, { status: 'exists', name: 'jo_libs.zip' });
    assert.equal(requests.length, 1);
  });
});

test('reads the CFX state of one version', async () => {
  const session = createCfxHttpSessionFromCookies([{ name: 'session', value: 'test' }]);
  const asset = (versionState) => ({
    id: 944842,
    state: versionState === 'active' ? 'active' : 'created',
    versions: [{ id: 1436406, version: '1.1.2', state: versionState }],
  });

  await withMockedFetch(() => json(asset('created')), async () => {
    assert.deepEqual(await getVersionStatus(session, 944842, 1436406), {
      found: true, active: false, assetState: 'created', versionState: 'created', version: '1.1.2',
    });
  });
  await withMockedFetch(() => json(asset('active')), async () => {
    assert.equal((await getVersionStatus(session, 944842, 1436406)).active, true);
    assert.equal((await getVersionStatus(session, 944842, 999)).found, false);
  });
});
