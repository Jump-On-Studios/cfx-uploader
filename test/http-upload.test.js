const assert = require('node:assert/strict');
const test = require('node:test');

const { createCfxHttpSessionFromCookies } = require('../src/cfx/http-session');
const { VERSION_EXISTS_ERROR_CODE, uploadZipVersionHttp } = require('../src/cfx/http-upload');

test('refuses to upload a version that already exists, without sending anything', async () => {
  const originalFetch = global.fetch;
  const requests = [];
  try {
    global.fetch = async (url, init = {}) => {
      requests.push(init.method || 'GET');
      return new Response(JSON.stringify({
        id: 944842,
        name: 'jo_chest',
        state: 'created',
        versions: [{ id: 1436406, version: '1.1.2', state: 'created' }],
      }), { status: 200 });
    };

    await assert.rejects(
      uploadZipVersionHttp(createCfxHttpSessionFromCookies([{ name: 'session', value: 'test' }]), {
        asset: { id: 944842, name: 'jo_chest' },
        assetDetails: null,
        metadata: { version: '1.1.2' },
        zipPath: 'missing.zip',
      }),
      (error) => {
        assert.equal(error.code, VERSION_EXISTS_ERROR_CODE);
        assert.equal(error.assetId, 944842);
        assert.equal(error.versionId, 1436406);
        assert.equal(error.version, '1.1.2');
        assert.equal(error.versionState, 'created');
        assert.match(error.message, /Version already exists on asset "jo_chest" \(944842\): 1\.1\.2/);
        return true;
      },
    );
    assert.deepEqual(requests, ['GET']);
  } finally {
    global.fetch = originalFetch;
  }
});
