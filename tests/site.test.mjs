// The promises this site makes, as tests: that it is free of Spotify, that the browser is told to run nothing
// else, that the local server hands out only the files meant to be public, and that the offline copy is complete.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { SECURITY_HEADERS, CONTENT_SECURITY_POLICY } from '../security-headers.mjs';

const ROOT = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, ROOT), 'utf8');
const exists = (path) => existsSync(new URL(path, ROOT));

const PAGES = ['index.html', 'guide.html', 'privacy.html', 'engine.html', '404.html'];
// The worklets are loaded by name at runtime, not imported, so the walk has to be told about them.
const ENTRIES = ['studio.js', 'engine.js', 'ai-io.worklet.js', 'vocal-remover.worklet.js'];

/** Every module under src/ that the site ends up running, following imports as the browser would. */
function modulesReached() {
  const seen = new Set();
  const queue = [...ENTRIES];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const [, spec] of read(`src/${file}`).matchAll(/from '\.\/([^']+)'/g)) queue.push(spec);
  }
  return seen;
}

/* ---------- what makes this site publishable ---------- */

test('no Spotify code is shipped', () => {
  for (const name of ['auth.js', 'spotify-api.js', 'player.js', 'bgm.js', 'matcher.js', 'covers.js', 'now-playing.js', 'app.js']) {
    assert.ok(!exists(`src/${name}`), `src/${name} belongs to the Spotify player and should not be in this repo`);
  }
});

test('nothing the site runs talks to Spotify', () => {
  for (const file of modulesReached()) {
    // Comments may mention it; only whole-line "//" comments are dropped, because a rule that dropped every
    // "//" would also eat the one in "https://" and leave nothing for this test to find.
    const code = read(`src/${file}`).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/[^\n]*$/gm, '');
    for (const host of ['api.spotify.com', 'accounts.spotify.com', 'sdk.scdn.co', 'scdn.co']) {
      assert.ok(!code.includes(host), `src/${file} reaches ${host}`);
    }
  }
});

// The AdSense tag, exactly as Google issues it for this publisher. ads.txt must name the same publisher.
const PUBLISHER = 'pub-4372918574861739';
const AD_TAG = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-${PUBLISHER}`;
const scriptsOf = (page) => [...read(page).matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);

test('the front page needs no account and loads only its own scripts and the ad tag', () => {
  const page = read('index.html');
  assert.deepEqual(scriptsOf('index.html'), [AD_TAG, 'src/crash.js', 'src/studio.js']);
  assert.ok(!/Client ID|log in|sign in/i.test(page), 'the front page asks someone to log in');
});

test('the ad tag is on the reading pages, and never on the engine window or the error page', () => {
  // AdSense's rules forbid ads on pages with no content of their own (error pages, a window that only plays sound).
  for (const page of ['index.html', 'guide.html', 'privacy.html']) {
    const tags = scriptsOf(page).filter((src) => src.includes('googlesyndication'));
    assert.deepEqual(tags, [AD_TAG], `${page} should carry the AdSense tag once`);
    assert.match(read(page), /adsbygoogle\.js\?client=[^"]+"\s+crossorigin="anonymous"/, `${page}: the tag lost its crossorigin attribute`);
  }
  for (const page of ['engine.html', '404.html']) {
    assert.ok(!read(page).includes('googlesyndication'), `${page} must not show ads`);
  }
  assert.equal(read('ads.txt').trim(), `google.com, ${PUBLISHER}, DIRECT, f08c47fec0942fa0`, 'ads.txt names another publisher');
});

test('a page that shows the crash screen also has something that takes it down', () => {
  // crash.js waits 15 s for window.bgmStarted(). A page that loads it without anything calling that would
  // cover itself with "The music stopped" once the timer runs out, however well it had started.
  for (const page of PAGES) {
    const html = read(page);
    if (!html.includes('src/crash.js')) continue;
    const modules = [...html.matchAll(/<script type="module" src="src\/([^"]+)"/g)].map((m) => m[1]);
    assert.ok(modules.length, `${page} loads crash.js but no module that could start`);
    assert.ok(
      modules.some((file) => read(`src/${file}`).includes('bgmStarted')),
      `${page} loads crash.js, but ${modules.join(', ')} never calls window.bgmStarted()`,
    );
  }
});

/* ---------- what the browser is allowed to run ---------- */

test('the policy allows no Spotify host and nothing dangerous', () => {
  for (const host of ['spotify', 'scdn']) assert.ok(!CONTENT_SECURITY_POLICY.includes(host), `the policy still allows ${host}`);
  const scriptSrc = CONTENT_SECURITY_POLICY.match(/script-src ([^;]+)/)[1].split(' ');
  assert.ok(!scriptSrc.includes("'unsafe-inline'"), 'inline scripts would be allowed');
  assert.ok(!scriptSrc.includes("'unsafe-eval'"), 'eval would be allowed');
  for (const source of scriptSrc) {
    if (source === "'self'" || source === "'wasm-unsafe-eval'") continue;
    // Every other script source names one https host, or one Google ad domain's subdomains. A bare "*" or a
    // scheme on its own ("https:", "data:") would let a script come from anywhere.
    assert.match(source, /^https:\/\/(?:\*\.)?(?:[a-z0-9-]+\.)+[a-z]+(?:\/[\w./@-]*)?$/, `script source ${source} is too broad`);
    if (source.includes('*')) assert.match(source, /^https:\/\/\*\.(?:googlesyndication\.com|adtrafficquality\.google)$/, `wildcard script source ${source}`);
  }
  assert.match(CONTENT_SECURITY_POLICY, /frame-ancestors 'none'/, 'another site could frame this one');
  assert.match(CONTENT_SECURITY_POLICY, /object-src 'none'/);
});

test('the pages carry no inline script, which is why none is allowed', () => {
  for (const page of PAGES) {
    const inline = [...read(page).matchAll(/<script(?![^>]*\bsrc=)[^>]*>/g)]
      .filter((m) => !m[0].includes('application/ld+json')); // structured data is not executed
    assert.equal(inline.length, 0, `${page} has an inline script, which the policy would block`);
  }
});

test('vercel.json sends exactly the same headers on every response', () => {
  // On Vercel, netlify.toml means nothing: without this file the site goes out with no policy at all.
  const vercel = JSON.parse(read('vercel.json'));
  const all = vercel.headers.find((rule) => rule.source === '/(.*)');
  assert.ok(all, 'vercel.json has no rule for every path');
  const sent = Object.fromEntries(all.headers.map(({ key, value }) => [key, value]));
  assert.deepEqual(sent, { ...SECURITY_HEADERS }, 'vercel.json and security-headers.mjs disagree');
});

test("the project's own files are kept out of the Vercel deployment", () => {
  // Vercel serves every file in the repository unless told otherwise, so these would all answer 200.
  const ignored = read('.vercelignore').split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
  for (const path of ['serve.mjs', 'security-headers.mjs', 'netlify.toml', 'package.json', 'README.md', 'tests/', 'tools/']) {
    assert.ok(ignored.includes(path), `.vercelignore does not keep out ${path}`);
  }
  for (const page of ['index.html', 'guide.html', 'privacy.html', 'engine.html', '404.html', 'sw.js', 'src/', 'robots.txt', 'sitemap.xml', 'ads.txt']) {
    assert.ok(!ignored.includes(page), `.vercelignore would hide ${page}, which is part of the site`);
  }
});

test('every address in the sitemap is one both hosts can serve', () => {
  const vercel = JSON.parse(read('vercel.json'));
  const toml = read('netlify.toml');
  for (const [, path] of read('sitemap.xml').matchAll(/<loc>https:\/\/[^/]+(\/[^<]*)<\/loc>/g)) {
    if (path === '/') continue;
    assert.ok(vercel.rewrites.some((rule) => rule.source === path), `Vercel would answer 404 for ${path}`);
    assert.ok(toml.includes(`from = "${path}"`), `Netlify would answer 404 for ${path}`);
  }
});

test('netlify.toml repeats the headers exactly', () => {
  const toml = read('netlify.toml');
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    assert.ok(toml.includes(`${name} = "${value}"`), `netlify.toml and security-headers.mjs disagree about ${name}`);
  }
  assert.match(toml, /Strict-Transport-Security/, 'the hosted copy should be https-only');
});

test('the dark tool panel sets a light text colour for the controls it holds', () => {
  // The live controls are drawn for an espresso slab and take their colour from whatever holds them, so a
  // panel that sets none leaves buttons like "Download" in the page's near-black ink, invisible on the dark.
  const css = read('src/studio.css');
  assert.match(css.match(/\.st-tool \{[^}]+\}/)?.[0] ?? '', /color: var\(--on-dark\)/, '.st-tool must set a light colour');
  // The theme paints .ghost buttons for the cream page and repaints them only inside .sheet and .guide.
  assert.match(css.match(/\.st-tool \.ghost \{[^}]+\}/)?.[0] ?? '', /color: var\(--on-dark\)/,
    '.st-tool .ghost must be repainted, or Download and Sound read as empty pills on the dark slab');
});

/* ---------- the files hang together ---------- */

test('nothing published here points at the Spotify project', () => {
  // That repository is the private half of the project. A page anyone can find should not send them to it.
  for (const page of ['index.html', 'privacy.html', 'guide.html', 'README.md']) {
    assert.ok(!read(page).includes('github.com/AdityaKr33/bgm-mode'), `${page} links to the Spotify project's repository`);
  }
});

test('no published link is a placeholder pointing at some service front page', () => {
  // "https://ko-fi.com/" with no account after it reaches Ko-fi's own homepage, which tells a visitor nothing
  // and makes the site look unfinished. Every outbound link has to go somewhere that is actually ours.
  const SERVICES = ['ko-fi.com', 'buymeacoffee.com', 'patreon.com', 'paypal.me', 'github.com/sponsors'];
  for (const page of ['index.html', 'privacy.html']) {
    for (const [, href] of read(page).matchAll(/href="(https:\/\/[^"]+)"/g)) {
      const service = SERVICES.find((name) => href.includes(name));
      if (!service) continue;
      const after = href.split(service)[1].replace(/^\//, '');
      assert.ok(after.length > 0, `${page} links to ${href}, which is ${service}'s own page, not yours`);
    }
  }
});

test('the pages reference only files that exist', () => {
  for (const page of PAGES) {
    for (const [, ref] of read(page).matchAll(/(?:src|href)="([^"]+)"/g)) {
      if (/^(?:https?:|#|mailto:|data:|\.\/$)/.test(ref)) continue;
      assert.ok(exists(ref.replace(/^\//, '')), `${page} → ${ref} is missing`);
    }
  }
});

test('every import resolves, and every module is one the site uses', () => {
  const reached = modulesReached();
  for (const file of readdirSync(new URL('src/', ROOT)).filter((name) => name.endsWith('.js'))) {
    for (const [, spec] of read(`src/${file}`).matchAll(/from '\.\/([^']+)'/g)) {
      assert.ok(exists(`src/${spec}`), `src/${file} imports missing ${spec}`);
    }
    if (file === 'crash.js') continue; // a plain script the page loads directly, not imported
    assert.ok(reached.has(file), `src/${file} is in the repo but nothing loads it`);
  }
});

test('the offline copy lists every file the site is made of', () => {
  const shell = read('sw.js');
  for (const file of [...PAGES, ...[...modulesReached()].map((n) => `src/${n}`), 'src/crash.js', 'src/theme.css', 'src/studio.css', 'src/error.css']) {
    assert.ok(shell.includes(`'${file}'`), `sw.js doesn't cache ${file}`);
  }
  for (const [, path] of shell.matchAll(/^\s+'([^']+)',$/gm)) {
    if (path !== './') assert.ok(exists(path), `sw.js caches ${path}, which doesn't exist`);
  }
});

test('robots.txt and the sitemap offer the public pages and hide the rest', () => {
  const robots = read('robots.txt');
  const sitemap = read('sitemap.xml');
  assert.match(robots, /Allow: \//);
  for (const hidden of ['/engine.html', '/tests/', '/tools/']) {
    assert.ok(robots.includes(`Disallow: ${hidden}`), `robots.txt should hide ${hidden}`);
  }
  for (const page of ['/', '/guide', '/privacy']) assert.ok(sitemap.includes(`<loc>https://`) && sitemap.includes(`${page}<`), `the sitemap is missing ${page}`);
  assert.ok(robots.includes('Sitemap: '), 'robots.txt should point at the sitemap');
});

test('one command replaces every address that is still a placeholder', () => {
  const setter = read('tools/set-domain.mjs');
  const placeholder = setter.match(/const PLACEHOLDER = '([^']+)'/)[1];
  const listed = setter.match(/const FILES = \[([^\]]+)\]/)[1].match(/'([^']+)'/g).map((name) => name.slice(1, -1));
  for (const file of ['index.html', 'guide.html', 'privacy.html', 'sitemap.xml', 'robots.txt']) {
    if (!read(file).includes(placeholder)) continue; // already pointed at a real address
    assert.ok(listed.includes(file), `${file} still has the placeholder but set-domain.mjs doesn't touch it`);
  }
});

/* ---------- the local server ---------- */

const freePort = () => new Promise((resolve) => {
  const probe = createServer().listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

let server;
before(async () => {
  const port = await freePort();
  const child = spawn(process.execPath, ['serve.mjs'], { cwd: new URL('.', ROOT).pathname.slice(1), env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => String(chunk).includes('running') && resolve());
    child.once('exit', (code) => reject(new Error(`serve.mjs exited (${code})`)));
    setTimeout(() => reject(new Error('serve.mjs did not start')), 10000);
  });
  server = { child, port };
});
after(() => server?.child.kill());

const ask = (method, path, headers = {}) => new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port: server.port, method, path, headers: { host: `127.0.0.1:${server.port}`, ...headers } }, (res) => {
    let body = '';
    res.on('data', (chunk) => (body += chunk));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
  });
  req.on('error', reject);
  req.end();
});

test('the server hands out the public files, with the headers on every one', async () => {
  for (const path of ['/', '/index.html', '/guide.html', '/privacy.html', '/robots.txt', '/sitemap.xml', '/ads.txt', '/src/studio.js', '/src/theme.css']) {
    const res = await ask('GET', path);
    assert.equal(res.status, 200, `GET ${path}`);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      assert.equal(res.headers[name.toLowerCase()], value, `${path} is missing ${name}`);
    }
  }
});

test('the server refuses everything that is not part of the website', async () => {
  for (const path of ['/serve.mjs', '/package.json', '/README.md', '/netlify.toml', '/security-headers.mjs', '/tests/site.test.mjs', '/tools/set-domain.mjs', '/src/../serve.mjs', '/..%2fserve.mjs']) {
    assert.equal((await ask('GET', path)).status, 404, `${path} should not be served`);
  }
  assert.equal((await ask('POST', '/index.html')).status, 404, 'only GET is served');
});

test('the server answers a request for any other host name with a redirect', async () => {
  const res = await ask('GET', '/', { host: 'bgm-mode.attacker.example' });
  assert.equal(res.status, 307, 'a page elsewhere could point its own name at this server');
  assert.match(res.headers.location, /^http:\/\/127\.0\.0\.1:/);
});

test('a missing page gets the 404 page, not a bare error', async () => {
  const res = await ask('GET', '/no/such/page');
  assert.equal(res.status, 404);
  assert.match(res.body, /isn’t on the record|<title>/i);
});
