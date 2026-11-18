// Puts the site's real address into the tags that need an absolute one: canonical links, Open Graph tags,
// the sitemap and the Sitemap line in robots.txt. Run it once after the site is live, and again if it moves:
//   node tools/set-domain.mjs https://your-site.example
// It only rewrites those tags, so ordinary links to other sites are never touched.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLACEHOLDER = 'https://bgm-mode.example';
const FILES = ['index.html', 'app.html', 'privacy.html', 'guide.html', 'sitemap.xml', 'robots.txt'];

const input = process.argv[2];
if (!input) {
  console.error('Usage: node tools/set-domain.mjs https://your-site.example');
  process.exit(1);
}
let origin;
try {
  const url = new URL(input);
  if (url.protocol !== 'https:') throw new Error('use https');
  origin = url.origin; // drops any path, query or trailing slash
} catch {
  console.error(`Not an https address: ${input}`);
  process.exit(1);
}

const ORIGIN = 'https:\\/\\/[a-z0-9.-]+(?::\\d+)?';
// Each pattern finds one of our own absolute addresses and keeps everything around the origin.
const OURS = [
  new RegExp(`(<link rel="canonical" href=")${ORIGIN}`, 'g'),
  new RegExp(`(<meta property="og:url" content=")${ORIGIN}`, 'g'),
  new RegExp(`(<loc>)${ORIGIN}`, 'g'),
  new RegExp(`(^Sitemap: )${ORIGIN}`, 'gm'),
];
// Open Graph images must be absolute for link previews (WhatsApp, LinkedIn, X) to show them.
const SHARE_IMAGE = /(<meta property="og:image" content=")(?:https:\/\/[^/"]+\/)?share\.jpg"/g;

let changed = 0;
for (const name of FILES) {
  let text;
  try {
    text = readFileSync(join(root, name), 'utf8');
  } catch {
    continue; // not every file exists in every version of the site
  }
  let next = OURS.reduce((acc, pattern) => acc.replace(pattern, `$1${origin}`), text);
  next = next.replace(SHARE_IMAGE, `$1${origin}/share.jpg"`);
  if (next === text) {
    console.log(`already set   ${name}`);
    continue;
  }
  writeFileSync(join(root, name), next);
  changed++;
  console.log(`updated       ${name}`);
}
console.log(`\n${changed} file(s) now point at ${origin}`);
for (const name of FILES) {
  try {
    if (readFileSync(join(root, name), 'utf8').includes(PLACEHOLDER)) console.log(`(${name} still mentions ${PLACEHOLDER} outside the tags above)`);
  } catch {
    // missing file: nothing to report
  }
}
