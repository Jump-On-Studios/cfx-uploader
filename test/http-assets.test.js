const assert = require('node:assert/strict');
const test = require('node:test');

const { createCfxHttpSessionFromCookies } = require('../src/cfx/http-session');
const { findAssetByExactName } = require('../src/cfx/http-assets');

function mockAssetsApi(pages, { searchWorks = false } = {}) {
  const requests = [];
  global.fetch = async (url) => {
    const parsed = new URL(url);
    const page = Number(parsed.searchParams.get('page'));
    const search = parsed.searchParams.get('search');
    requests.push({ page, search });
    let assets = pages[page - 1] || [];
    if (search) {
      assets = searchWorks ? pages.flat().filter((asset) => asset.name.includes(search)) : [];
    }
    return new Response(JSON.stringify({ data: assets }), { status: 200 });
  };
  return requests;
}

const session = () => createCfxHttpSessionFromCookies([{ name: 'session', value: 'test' }]);
const pages = [
  [{ id: 3, name: 'RedM - Chest by Jump On Studios' }, { id: 2, name: 'RedM - MDT By Jump On Studios' }],
  [{ id: 1, name: 'RedM - Cash Register Robbery' }],
];

test('finds an asset beyond the first page when search returns nothing', async () => {
  const originalFetch = global.fetch;
  try {
    const requests = mockAssetsApi(pages);
    const asset = await findAssetByExactName(session(), 'RedM - Cash Register Robbery');
    assert.equal(asset.id, 1);
    assert.deepEqual(requests.map((r) => r.page), [1, 1, 2]);
    assert.equal(requests[0].search, 'RedM - Cash Register Robbery');
  } finally {
    global.fetch = originalFetch;
  }
});

test('uses the portal search result directly when available', async () => {
  const originalFetch = global.fetch;
  try {
    const requests = mockAssetsApi(pages, { searchWorks: true });
    const asset = await findAssetByExactName(session(), 'RedM - Cash Register Robbery');
    assert.equal(asset.id, 1);
    assert.equal(requests.length, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test('stops paging when a page repeats and reports not found', async () => {
  const originalFetch = global.fetch;
  try {
    global.fetch = async () => new Response(JSON.stringify({ data: pages[0] }), { status: 200 });
    await assert.rejects(
      findAssetByExactName(session(), 'Unknown asset'),
      /CFX asset not found by exact name "Unknown asset"\. First assets: RedM - Chest by Jump On Studios, RedM - MDT By Jump On Studios/,
    );
  } finally {
    global.fetch = originalFetch;
  }
});
