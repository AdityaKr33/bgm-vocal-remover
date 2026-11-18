// The AI model is kept in the browser's cache, so AI works while the local server is off, and on the
// online copy, which downloads the model itself.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, test } from 'node:test';
import { MODEL, downloadModel, modelStatus, readModel } from '../src/ai-model.js';

const BYTES = Uint8Array.from({ length: 1000 }, (_, i) => i % 251);
const TAMPERED = BYTES.map((byte, i) => (i === 500 ? byte ^ 1 : byte));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const bytesResponse = (bytes) => new Response(bytes, { headers: { 'content-length': String(bytes.length) } });
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/** fetch() answering only these URLs: the local server when it is up (or, with none, down). */
function serve(routes = {}) {
  globalThis.fetch = async (url) => {
    const route = routes[String(url)];
    if (!route) throw new TypeError('Failed to fetch');
    return route();
  };
}

/** A minimal CacheStorage (url → bytes) standing in for the browser's. */
function browserCache(initial = {}) {
  const store = new Map(Object.entries(initial));
  const cache = {
    match: async (url) => (store.has(String(url)) ? bytesResponse(store.get(String(url))) : undefined),
    put: async (url, response) => void store.set(String(url), new Uint8Array(await response.arrayBuffer())),
    add: async (url) => cache.put(url, await globalThis.fetch(url)),
  };
  globalThis.caches = { match: cache.match, open: async () => cache };
  return store;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  delete globalThis.caches;
});

test('with the server off, the model loads from the copy in this browser', async () => {
  serve();
  browserCache({ [MODEL.url]: BYTES });
  assert.equal((await modelStatus()).status, 'ready');
  assert.deepEqual(await readModel(), BYTES);
});

test('loading the model from the server keeps a copy in this browser', async () => {
  serve({ [MODEL.url]: () => bytesResponse(BYTES) });
  const store = browserCache();
  assert.deepEqual(await readModel(), BYTES);
  assert.deepEqual(store.get(MODEL.url), BYTES);
});

test('when the server reports the model ready, it is copied into this browser for later', async () => {
  serve({
    'api/model': () => new Response(JSON.stringify({ status: 'ready' })),
    [MODEL.url]: () => bytesResponse(BYTES),
  });
  const store = browserCache();
  assert.equal((await modelStatus()).status, 'ready');
  await settle(); // the copy is made in the background
  assert.deepEqual(store.get(MODEL.url), BYTES);
});

test('the online copy downloads the model into this browser, keeping only UVR’s exact file', async () => {
  globalThis.location = { hostname: 'bgm-mode.netlify.app' };
  try {
    let askedServer = false;
    serve({
      'api/model': () => {
        askedServer = true;
        return new Response('{}');
      },
      'https://copy-a/model.onnx': () => bytesResponse(TAMPERED),
      'https://copy-b/model.onnx': () => bytesResponse(BYTES),
    });
    const store = browserCache();
    assert.deepEqual(await modelStatus(), { status: 'missing', source: 'browser' });
    assert.equal(askedServer, false, 'no request to an api/model that does not exist online');
    const progress = [];
    await downloadModel({ sources: ['https://copy-a/model.onnx', 'https://copy-b/model.onnx'], sha256: sha256(BYTES), onProgress: (share) => progress.push(share) });
    assert.deepEqual(store.get(MODEL.url), BYTES, 'the copy that matches the checksum');
    assert.equal(progress.at(-1), 1);
    assert.equal((await modelStatus()).status, 'ready');
  } finally {
    delete globalThis.location;
  }
});

test('a download that fails the checksum is not kept', async () => {
  serve({ 'https://copy-a/model.onnx': () => bytesResponse(TAMPERED) });
  const store = browserCache();
  await assert.rejects(downloadModel({ sources: ['https://copy-a/model.onnx'], sha256: sha256(BYTES) }), /isn’t UVR’s model/);
  assert.equal(store.size, 0);
});

test('with no server and no copy, this browser offers to download the model itself', async () => {
  serve();
  browserCache();
  assert.deepEqual(await modelStatus(), { status: 'missing', source: 'browser' });
  await assert.rejects(readModel(), /isn’t downloaded yet/);
});

test('the local server checks its download against the same checksum', () => {
  assert.ok(readFileSync(new URL('../serve.mjs', import.meta.url), 'utf8').includes(MODEL.sha256));
});
