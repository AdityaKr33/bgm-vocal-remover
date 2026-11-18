// The AI vocal-removal model and the GPU runtime (ONNX Runtime Web + WebGPU) that runs it.
const ORT_URL = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/ort.webgpu.min.mjs';
// This browser's copy of the model, so AI works without the local server (and on the online copy).
// sw.js keeps this cache when the app updates.
const MODEL_CACHE = 'bgm-mode-model';

/**
 * Ultimate Vocal Remover's MDX-Net "Inst HQ 5". The STFT settings come from UVR's model data
 * for this exact file (looked up by its hash): n_fft 5120, dim_f 2560, dim_t 2^8, compensate 1.01.
 */
export const MODEL = Object.freeze({
  url: 'models/UVR-MDX-NET-Inst_HQ_5.onnx',
  sha256: '811cb24095d865763752310848b7ec86aeede0626cb05749ab35350e46897000', // UVR's file; serve.mjs checks the same
  bytes: 59_074_342,
  sampleRate: 44100,
  nFft: 5120,
  hop: 1024,
  dimF: 2560,
  dimT: 256,
  compensate: 1.01,
});

/**
 * Where a browser downloads the model itself: byte-for-byte copies of UVR's file on Hugging Face, which,
 * unlike UVR's GitHub releases, lets web pages download it. The checksum makes sure the bytes are UVR's.
 */
export const MODEL_SOURCES = Object.freeze([
  'https://huggingface.co/nomadkaraoke/public_uvr_models/resolve/main/UVR-MDX-NET-Inst_HQ_5.onnx',
  'https://huggingface.co/Politrees/UVR_resources/resolve/main/models/MDXNet/UVR-MDX-NET-Inst_HQ_5.onnx',
]);

export function aiSupported() {
  return Boolean(globalThis.navigator?.gpu);
}

/**
 * Whether the model can be loaded: { status: missing | downloading | ready | error, source }. A copy in
 * this browser is ready. Otherwise the local server (npm start) downloads it (source 'server'), or, with
 * no server at hand (the online copy, or the installed app with the server off), this browser does.
 */
export async function modelStatus() {
  if (await cachedModel()) return { status: 'ready', source: 'browser' };
  if (!servedLocally()) return { status: 'missing', source: 'browser' };
  let server;
  try {
    server = await (await fetch('api/model', { cache: 'no-store' })).json();
  } catch {
    return { status: 'missing', source: 'browser' }; // the installed app opened without the server
  }
  if (server.status === 'ready') cacheModel().catch(() => {}); // for the next time the server is off
  return { ...server, source: 'server' };
}

/** Downloads the model into this browser from the first source that has UVR's exact file. */
export async function downloadModel({ onProgress, sources = MODEL_SOURCES, sha256 = MODEL.sha256 } = {}) {
  const cache = await globalThis.caches?.open(MODEL_CACHE);
  if (!cache) throw new Error('this browser can’t keep it — open BGM Mode over https');
  let failure;
  for (const url of sources) {
    let bytes;
    try {
      bytes = await download(url, onProgress);
      if ((await sha256Hex(bytes)) !== sha256) throw new Error('the file that arrived isn’t UVR’s model');
    } catch (error) {
      failure = error; // try the next copy
      continue;
    }
    await cache.put(MODEL.url, new Response(bytes, { headers: { 'content-length': String(bytes.length) } }));
    return;
  }
  throw failure;
}

/** Loads the model onto the GPU. Resolves to { run(input) → Float32Array, release() }. */
export async function loadModel({ onProgress } = {}) {
  if (!aiSupported()) throw new Error('AI mode needs WebGPU — use an up-to-date Chrome or Edge.');
  const [ort, bytes] = await Promise.all([import(ORT_URL), readModel(onProgress)]);
  ort.env.wasm.numThreads = 1; // the page isn't cross-origin isolated; the GPU does the heavy lifting
  const session = await ort.InferenceSession.create(bytes, {
    executionProviders: ['webgpu'],
    graphOptimizationLevel: 'all',
  });
  const [input] = session.inputNames;
  const [output] = session.outputNames;
  const dims = [1, 4, MODEL.dimF, MODEL.dimT];
  return {
    async run(data) {
      const result = await session.run({ [input]: new ort.Tensor('float32', data, dims) });
      return result[output].data;
    },
    release: () => session.release(),
  };
}

/** The model's bytes: from this browser's copy, else from the local server (keeping a copy). */
export async function readModel(onProgress) {
  let response = await cachedModel();
  let stored;
  if (!response) {
    response = await fetch(MODEL.url).catch(() => null);
    if (!response?.ok) throw new Error('the AI model isn’t downloaded yet — click Download under “Live vocal remover”');
    const copy = response.clone(); // before the body is read below
    stored = globalThis.caches?.open(MODEL_CACHE).then((cache) => cache.put(MODEL.url, copy)).catch(() => {});
  }
  const bytes = await readBody(response, onProgress);
  await stored;
  return bytes;
}

async function download(url, onProgress) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`the download failed (HTTP ${response.status})`);
  return readBody(response, onProgress, MODEL.bytes);
}

/** A response's bytes, reporting progress against its length (or `expected` when it doesn't say). */
async function readBody(response, onProgress, expected = 0) {
  const total = Number(response.headers.get('content-length')) || expected;
  if (!total || !response.body) return new Uint8Array(await response.arrayBuffer());
  let bytes = new Uint8Array(total);
  let received = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (received + value.length > bytes.length) {
      const larger = new Uint8Array(Math.max(2 * bytes.length, received + value.length)); // the length was wrong
      larger.set(bytes.subarray(0, received));
      bytes = larger;
    }
    bytes.set(value, received);
    received += value.length;
    onProgress?.(Math.min(1, received / total));
  }
  return received === bytes.length ? bytes : bytes.slice(0, received);
}

async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Whether this page comes from BGM Mode's own server on this computer (npm start), which can download the model. */
function servedLocally() {
  return !globalThis.location || location.hostname === '127.0.0.1';
}

async function cachedModel() {
  return (await globalThis.caches?.match(MODEL.url)) ?? null;
}

async function cacheModel() {
  const cache = await globalThis.caches?.open(MODEL_CACHE);
  if (cache && !(await cache.match(MODEL.url))) await cache.add(MODEL.url);
}
