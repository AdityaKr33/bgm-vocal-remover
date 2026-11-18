// Puts your real address into the public pages, the sitemap and robots.txt, in one go.
// Run it once after the site is live:   node tools/set-domain.mjs https://your-site.example
// Run it again any time the address changes; it replaces whatever is there now.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLACEHOLDER = 'https://bgm-mode.example';
const FILES = ['index.html', 'privacy.html', 'guide.html', 'sitemap.xml', 'robots.txt'];

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

// Whatever the files hold now (the placeholder, or an older address) becomes the new one.
const CURRENT = /https:\/\/[a-z0-9.-]+(?::\d+)?(?=\/(?:vocal-remover|guide|privacy|sitemap\.xml)\b)/g;
let changed = 0;
for (const name of FILES) {
  const file = join(root, name);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    console.log(`skipped (not found)  ${name}`);
    continue;
  }
  const next = text.replaceAll(PLACEHOLDER, origin).replace(CURRENT, origin);
  if (next === text) {
    console.log(`already set          ${name}`);
    continue;
  }
  writeFileSync(file, next);
  changed++;
  console.log(`updated              ${name}`);
}
console.log(`\n${changed} file(s) now point at ${origin}`);
console.log('Next: deploy, then submit the sitemap in Google Search Console (see README.md).');
