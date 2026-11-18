// The security headers every response carries: the local server (serve.mjs) sends them, and vercel.json and
// netlify.toml repeat them for the hosted copy. After changing anything here, run `node tools/host-config.mjs`;
// tests/site.test.mjs fails if the three drift apart.
//
// This site has no inline scripts and loads from three places that are not itself: the AI runtime, the model's
// host and Google's ad network. Everything else is refused by the browser.

const ORT = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/'; // the AI runtime (src/ai-model.js), this version only
const MODEL_HOSTS = ['https://huggingface.co', 'https://*.huggingface.co', 'https://*.hf.co']; // where the model is fetched from

// Google AdSense: the tag in the head of index, guide and privacy. Google publishes no list of its ad hosts (it
// only supports nonce-based policies, which a site of plain files cannot send), so these are the hosts AdSense
// loads from today: its loader, its ad-quality checks (Sodar), the consent message Google shows visitors in
// Europe, and ad identifiers. Each is Google's own. The ads themselves draw in frames from other origins, so what
// runs inside them answers to Google's policy, not this one. If ads stop showing, the browser console names the
// host this list is missing.
const AD_SCRIPTS = [
  'https://pagead2.googlesyndication.com',
  'https://tpc.googlesyndication.com',
  'https://*.adtrafficquality.google',
  'https://fundingchoicesmessages.google.com',
  'https://adservice.google.com',
  'https://www.googletagservices.com',
  'https://partner.googleadservices.com',
];
const AD_FRAMES = [
  'https://googleads.g.doubleclick.net',
  'https://*.googlesyndication.com',
  'https://*.adtrafficquality.google',
  'https://fundingchoicesmessages.google.com',
  'https://www.google.com',
];
const AD_CONNECT = [
  'https://*.googlesyndication.com',
  'https://*.adtrafficquality.google',
  'https://*.doubleclick.net',
  'https://fundingchoicesmessages.google.com',
  'https://adservice.google.com',
  'https://www.google.com',
  'https://csi.gstatic.com',
];

const POLICY = [
  ['default-src', "'self'"],
  // our own files, the AI runtime and the ad loader; 'wasm-unsafe-eval' lets the AI runtime compile its WebAssembly
  ['script-src', "'self'", "'wasm-unsafe-eval'", ORT, ...AD_SCRIPTS],
  ['style-src', "'self'", "'unsafe-inline'"], // the guide's diagrams are styled inline
  ['img-src', "'self'", 'data:', 'blob:', 'https:'], // ad images and their counting pixels come from many hosts
  ['font-src', "'self'"], // the two typefaces are served from fonts/
  ['connect-src', "'self'", ORT, ...MODEL_HOSTS, ...AD_CONNECT],
  ['media-src', "'self'", 'blob:', 'data:'],
  ['frame-src', ...AD_FRAMES], // ads only; nothing else is embedded
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
