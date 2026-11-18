// Writes the hosting config for Vercel (vercel.json) and Netlify (netlify.toml) from security-headers.mjs, so the
// headers a host sends can never drift from the ones the local server sends. Run it after changing the headers:
//   node tools/host-config.mjs
// tests/site.test.mjs fails if either file no longer matches.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { SECURITY_HEADERS } = await import(pathToFileURL(join(root, 'security-headers.mjs')).href);

// Short addresses for the two reading pages, served without a redirect so the offline copy never caches one.
export const PRETTY = { '/guide': '/guide.html', '/privacy': '/privacy.html' };
// The project's own files. They are not part of the website.
export const PRIVATE = ['/serve.mjs', '/security-headers.mjs', '/package.json', '/README.md', '/netlify.toml', '/vercel.json', '/.gitignore', '/.vercelignore', '/tests/*', '/tools/*'];

/* ---------- Vercel ---------- */

// Only what Vercel needs on top of serving the files as they are: an invalid key here fails the whole deploy.
const vercel = {
  $schema: 'https://openapi.vercel.sh/vercel.json',
  rewrites: Object.entries(PRETTY).map(([source, destination]) => ({ source, destination })),
  headers: [
    {
      source: '/(.*)',
      // Vercel already sends Strict-Transport-Security on every https response, so it isn't repeated here.
      headers: Object.entries(SECURITY_HEADERS).map(([key, value]) => ({ key, value })),
    },
  ],
};
writeFileSync(join(root, 'vercel.json'), JSON.stringify(vercel, null, 2) + '\n');

// Vercel has no "force a 404" rule, so the project's own files are kept out of the upload instead.
writeFileSync(
  join(root, '.vercelignore'),
  `# Not part of the website: kept out of the Vercel deployment, so they answer 404.
# Written by tools/host-config.mjs from its PRIVATE list; edit the list there, not here.
${PRIVATE.filter((path) => path !== '/vercel.json').map((path) => path.slice(1).replace('/*', '/')).join('\n')}
`,
);

/* ---------- Netlify ---------- */

const headers = Object.entries(SECURITY_HEADERS).map(([name, value]) => `    ${name} = "${value}"`).join('\n');
writeFileSync(
  join(root, 'netlify.toml'),
  `# Netlify: plain files, no build step. Written by tools/host-config.mjs from security-headers.mjs.
[build]
  publish = "."

[[headers]]
  for = "/*"
  [headers.values]
${headers}
    Strict-Transport-Security = "max-age=31536000"

${Object.entries(PRETTY).map(([from, to]) => `[[redirects]]\n  from = "${from}"\n  to = "${to}"\n  status = 200`).join('\n\n')}

${PRIVATE.map((path) => `[[redirects]]\n  from = "${path}"\n  to = "/404.html"\n  status = 404\n  force = true`).join('\n\n')}
`,
);

console.log(`wrote vercel.json, .vercelignore and netlify.toml (${Object.keys(SECURITY_HEADERS).length} headers, ${PRIVATE.length} private paths)`);
