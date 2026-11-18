// Tiny zero-dependency server for running BGM Mode on this computer.
// Usage: node serve.mjs   →   http://127.0.0.1:5173/
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import { pipeline } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { SECURITY_HEADERS } from './security-headers.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const HOST = '127.0.0.1'; // a loopback address, so nothing else on the network can reach it
const PORT = Number(process.env.PORT) || 5173;
const ORIGIN = new URL(`http://${HOST}:${PORT}`).origin; // as browsers write it (no ":80" on port 80)
const AUTHORITY = new URL(ORIGIN).host; // the Host header a browser sends for it
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.onnx': 'application/octet-stream',
};
// Only the app's own files are served — never tests, tools or anything outside this folder.
const PUBLIC = /^\/(?:index\.html|engine\.html|guide\.html|privacy\.html|404\.html|robots\.txt|sitemap\.xml|ads\.txt|google[0-9a-f]+\.html|sw\.js|manifest\.webmanifest|share\.jpg|src\/[\w.-]+\.(?:js|css)|icons\/[\w.-]+\.png|fonts\/[\w.-]+\.woff2|models\/[\w.-]+\.onnx)?$/;

// The AI vocal-removal model: Ultimate Vocal Remover's MDX-Net "Inst HQ 5", fetched once on request.
const MODEL = {
  file: 'UVR-MDX-NET-Inst_HQ_5.onnx',
  url: 'https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/UVR-MDX-NET-Inst_HQ_5.onnx',
  sha256: '811cb24095d865763752310848b7ec86aeede0626cb05749ab35350e46897000', // 59,074,342 bytes
};
const MODEL_PATH = join(ROOT, 'models', MODEL.file);
let download = { status: existsSync(MODEL_PATH) ? 'ready' : 'missing', received: 0, total: 0, error: null };

async function downloadModel() {
  if (download.status === 'downloading' || download.status === 'ready') return;
  download = { status: 'downloading', received: 0, total: 0, error: null };
  const partial = `${MODEL_PATH}.part`;
  let file = null;
  try {
    const response = await fetch(MODEL.url);
    if (!response.ok || !response.body) throw new Error(`download failed (HTTP ${response.status})`);
    download.total = Number(response.headers.get('content-length')) || 0;
    await mkdir(join(ROOT, 'models'), { recursive: true });
    const hash = createHash('sha256');
    file = createWriteStream(partial);
    for await (const chunk of response.body) {
      hash.update(chunk);
      download.received += chunk.length;
      if (!file.write(chunk)) await once(file, 'drain');
    }
    file.end();
    await once(file, 'close');
    file = null;
    const digest = hash.digest('hex');
    if (MODEL.sha256 && digest !== MODEL.sha256) throw new Error('the downloaded file failed its checksum');
    await rename(partial, MODEL_PATH);
    download.status = 'ready';
    console.log(`AI model saved (${download.received} bytes, sha256 ${digest})`);
  } catch (error) {
    file?.destroy();
    await rm(partial, { force: true }).catch(() => {});
    download = { ...download, status: 'error', error: error.message };
  }
}

function sendJson(response, data, status = 200) {
  response.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}

/** "Not found": the 404 page (404.html) for a browser asking for a page, a plain line for anything else. */
async function notFound(request, response) {
  const page = request.method === 'GET' ? await readFile(join(ROOT, '404.html')).catch(() => null) : null;
  response.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': page ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' });
  response.end(page ?? 'Not found');
}

createServer(async (request, response) => {
  // One address only. Refusing every other host name blocks DNS-rebinding tricks, where a page elsewhere
  // points its own name at this computer so it can talk to this server.
  if (request.headers.host !== AUTHORITY) {
    response.writeHead(307, { ...SECURITY_HEADERS, Location: `${ORIGIN}${request.url}` }).end();
    return;
  }

  let path;
  try {
    path = decodeURIComponent(new URL(request.url, ORIGIN).pathname);
  } catch {
    path = '';
  }

  if (path === '/api/model') {
    if (request.method === 'POST') {
      // Only this app may start the download: a browser always names the page a POST comes from (Origin), so one
      // from another site, or with no Origin at all, is refused.
      if (request.headers.origin !== ORIGIN) return sendJson(response, { error: 'forbidden' }, 403);
      downloadModel();
    }
    return sendJson(response, { ...download, file: MODEL.file });
  }

  if (request.method !== 'GET' || !PUBLIC.test(path) || path.includes('..')) return notFound(request, response);
  const file = join(ROOT, path === '/' ? 'index.html' : path);
  try {
    const info = await stat(file);
    response.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'no-cache',
    });
    // a file that can't be read after all (locked, removed) ends this response, never the server
    pipeline(createReadStream(file), response, () => {});
  } catch {
    notFound(request, response);
  }
}).listen(PORT, HOST, () => {
  console.log(`BGM Mode is running at ${ORIGIN}/  (Ctrl+C to stop)`);
});
