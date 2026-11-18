# BGM Mode: live vocal remover

Takes the vocals out of **any browser tab, while it plays**. Point it at YouTube, YouTube Music,
SoundCloud, a radio stream or anything else that makes sound, and hear the backing track.

Nothing is uploaded. There is no account, no server and no upload limit: an AI model is fetched into
your browser once and runs on your own graphics card from then on.

```bash
npm start     # http://127.0.0.1:5173/
npm test      # 54 tests, no dependencies
```

Needs [Node.js](https://nodejs.org) 18 or newer to run it locally, and Chrome, Edge or Brave on a
computer to use it. Safari and Firefox can't share a tab's sound yet, and nor can phones.

## How to use it

1. Open the music you want in another tab.
2. Press **Start** and pick that tab. Tick **Also share tab audio** — without it there is no sound to work on.
3. A small window opens and plays the music back without the vocals. Keep it open; minimised is fine.

Two removers, chosen with the **AI / Fast** switch:

| | How it works | Quality | Delay |
| --- | --- | --- | --- |
| **AI** | UVR's MDX-Net "Inst HQ 5" model on your GPU through WebGPU | the voice drops to about 2 % of its level | about 1.3–1.5 s behind |
| **Fast** | cancels whatever sits dead centre in the stereo image, protecting bass and drum hits | reduces a centred voice, leaves more behind | almost none |

The AI model is 56 MB and downloads once, the first time you choose AI. A GPU too slow to keep up
(a model run over 2.5 s) falls back to Fast on its own. Mono recordings are left alone, because
everything in them is "centre" and removing it would leave nothing.

Then shape what is left: **Bass, Warmth, Instruments, Clarity, Treble** and stereo **Space**, with
twelve ready-made styles from *Deep focus* to *Late night*. A limiter keeps the level safe whatever
you choose.

## Why your music never leaves the computer

There is no server to send it to. The browser hands one tab's sound to the page, the page processes it
and plays it back. The only things fetched from elsewhere are the model file and the code that runs it,
and neither request says anything about what you are listening to. See [privacy.html](privacy.html).

The headers in [`security-headers.mjs`](security-headers.mjs) tell the browser to run nothing but this
site's own code, the AI runtime, and nothing else at all: no inline scripts, no frames, no other origins.
`npm test` fails if [`netlify.toml`](netlify.toml) ever stops matching them.

## How it is built

Plain JavaScript modules. No framework, no build step, no npm dependencies.

| Area | Files |
| --- | --- |
| The page | `index.html`, `src/studio.js`, `src/studio.css`, `src/theme.css` |
| Capture and the engine window | `src/live-remover.js`, `engine.html`, `src/engine.js` |
| AI remover | `src/ai-model.js`, `ai-pipeline.js`, `separator.js`, `fft.js`, `resampler.js`, `playback-fifo.js`, `ai-io.worklet.js` |
| Fast remover | `src/dsp-core.js`, `src/vocal-remover.worklet.js` |
| Sound | `src/sound.js`, `sound-panel.js`, `range.js`, `settings.js` |
| Offline and errors | `sw.js`, `404.html`, `src/error.css`, `src/crash.js`, `manifest.webmanifest` |
| Server and headers | `serve.mjs`, `security-headers.mjs`, `netlify.toml` |

Two things are worth knowing if you read the code:

- **The engine runs in its own window.** If this page played the cleaned sound itself, the tab share
  would capture that sound again and you would hear a loop. `engine.html` has its own audio output,
  outside the share.
- **The AI path crosses three threads.** An AudioWorklet posts 1024-sample blocks to the engine
  window's main thread, which resamples to 44.1 kHz, runs a short-time Fourier transform, hands a
  spectrogram to the GPU, and sends the result back to be played from a buffer. Each model run sees
  about six seconds and contributes a short step of output, cross-faded into the last.

**[Read the full guide](guide.html)** for how all of it works, with sixteen diagrams: the streaming
maths, the delay budget, the frame pacing, the offline flow and the security layers.

## Put it online

It is plain files, so any static host will do; `netlify.toml` holds the settings for Netlify.

1. Connect the repository in Netlify (no build command). Every push to `main` redeploys.
2. Point the pages at your address, once:

   ```bash
   node tools/set-domain.mjs https://your-site.netlify.app
   ```

   That rewrites the canonical links, the Open Graph tags, `sitemap.xml` and the `Sitemap:` line in
   `robots.txt`. Run it again whenever the address changes, then commit the result.
3. Add the site in [Google Search Console](https://search.google.com/search-console) and submit
   `https://your-site/sitemap.xml`.

### Paying for itself

The footer links to GitHub Sponsors and Ko-fi — replace both with your own pages, or delete them.
`index.html` also has two empty `.ad-slot` boxes, one after *How it works* and one at the foot. They
are `hidden` and take no space, so turning them on shifts nothing. To use them: get approved by an ad
network, add its script and frame hosts to `CONTENT_SECURITY_POLICY` in `security-headers.mjs`, copy
the same value into `netlify.toml` (a test fails if they drift apart), then put the ad unit inside a
slot and remove its `hidden`.

Ads never go inside the remover itself, and they receive no audio — they cannot, because the audio
never leaves the browser.

## Credits and licence

The code is MIT licensed. Two things in it are not mine:

- **The model**, Ultimate Vocal Remover's MDX-Net "Inst HQ 5". It isn't in this repository; your
  browser fetches it from a public copy and checks its SHA-256 before using it. No licence is stated
  for it, so treat it as for personal use.
- **The typefaces**, Fraunces and Figtree, both under the SIL Open Font Licence
  (`fonts/OFL.txt`, `fonts/OFL-Figtree.txt`).

Not affiliated with, or endorsed by, any music service. Removing vocals is for personal use: respect
the rights of the music you process.

Made by Aditya Kumar — [Instagram](https://www.instagram.com/aadi._.itya_/) ·
[LinkedIn](https://www.linkedin.com/in/aditya-kumar-40585142a/)
