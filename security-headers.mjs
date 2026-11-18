// The security headers every response carries: the local server (serve.mjs) sends them, and netlify.toml repeats
// them for the hosted copy (tests/security.test.mjs fails if the two drift apart).
//
// This site has no inline scripts and loads from only two places that are not itself: the AI runtime and the
// model's host. Everything else is refused by the browser.
//
// Adding ads later: AdSense needs 'https://pagead2.googlesyndication.com' in script-src and frame-src, and
// 'https:' in img-src. Change it here and copy the same value into netlify.toml. See README.md.

const ORT = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/'; // the AI runtime (src/ai-model.js), this version only
const MODEL_HOSTS = ['https://huggingface.co', 'https://*.huggingface.co', 'https://*.hf.co']; // where the model is fetched from

const POLICY = [
  ['default-src', "'self'"],
  // our own files only; 'wasm-unsafe-eval' lets the AI runtime compile its WebAssembly
  ['script-src', "'self'", "'wasm-unsafe-eval'", ORT],
  ['style-src', "'self'", "'unsafe-inline'"], // the guide's diagrams are styled inline
  ['img-src', "'self'", 'data:', 'blob:'],
  ['font-src', "'self'"], // the two typefaces are served from fonts/
  ['connect-src', "'self'", ORT, ...MODEL_HOSTS],
  ['media-src', "'self'", 'blob:', 'data:'],
  ['frame-src', "'none'"], // nothing is embedded
  ['worker-src', "'self'"],
  ['manifest-src', "'self'"],
  ['object-src', "'none'"],
  ['base-uri', "'self'"],
  ['form-action', "'self'"],
  ['frame-ancestors', "'none'"], // no other site may put this one in a frame
];

export const CONTENT_SECURITY_POLICY = POLICY.map((parts) => parts.join(' ')).join('; ');

export const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  // the live remover needs to be handed a tab's sound; nothing else is allowed
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), bluetooth=(), display-capture=(self)',
});
