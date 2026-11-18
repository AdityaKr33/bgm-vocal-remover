// Offline-capable app shell: network first (always fresh while the local server runs), falling back
// to the cache so the installed app still opens when the server is off. The server's API is never
// cached; the AI model has its own cache, filled by src/ai-model.js and kept across app updates. A page
// with no cached copy gets the error page, switched to "can't reach BGM Mode", never the browser's own.
const CACHE = 'bgm-vocal-remover-v1';
const MODEL_CACHE = 'bgm-mode-model';
const SHELL = [
  './',
  'index.html',
  'engine.html',
  'guide.html',
  'privacy.html',
  '404.html',
  'manifest.webmanifest',
  'src/studio.js',
  'src/engine.js',
  'src/live-remover.js',
  'src/crash.js',
  'src/ai-model.js',
  'src/ai-pipeline.js',
  'src/separator.js',
  'src/resampler.js',
  'src/fft.js',
  'src/playback-fifo.js',
  'src/dsp-core.js',
  'src/sound.js',
  'src/sound-panel.js',
  'src/range.js',
  'src/settings.js',
  'src/ai-io.worklet.js',
  'src/vocal-remover.worklet.js',
  'src/theme.css',
  'src/studio.css',
  'src/error.css',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-32.png',
  'fonts/fraunces-latin.woff2',
  'fonts/fraunces-latin-ext.woff2',
  'fonts/figtree-latin.woff2',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => Promise.all(SHELL.map((path) => cache.add(path).catch(() => {})))));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE && key !== MODEL_CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || /^\/(?:api|models)\//.test(url.pathname)) return;
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => offline(request)),
  );
});

/** The server can't be reached: the cached copy, else for a page the "can't reach BGM Mode" page (404.html). */
async function offline(request) {
  const cached = await caches.match(request, { ignoreSearch: true });
  if (cached) return cached;
  if (request.mode !== 'navigate') return Response.error();
  const page = await caches.match('404.html');
  if (!page) return Response.error();
  const html = (await page.text()).replace('data-reason="missing"', 'data-reason="offline"');
  return new Response(html, { status: 503, statusText: 'Service Unavailable', headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
