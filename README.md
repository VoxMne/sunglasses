# Sunglasses (working title)

A camera-only PWA: point your phone at the world and the signs, ads and labels show
what they "really" say — OBEY, CONSUME, STAY ASLEEP… Money says THIS IS YOUR GOD.

No build step. Plain HTML/CSS/JS modules.

## Run locally

```bash
python -m http.server 5173
```

Open http://localhost:5173 (camera works on localhost). Without a camera:
http://localhost:5173/?demo (real Belgrade street photo) or `?demo=street` (drawn street).

## Run on a phone

Browsers only allow the camera over HTTPS. Easiest options:

- Deploy the folder as a static site (GitHub Pages, Netlify, Cloudflare Pages), or
- Tunnel your local server: `npx localtunnel --port 5173` and open the https URL on the phone.

Then use "Add to Home Screen" to install it as an app (works offline after the first load).

## How it works

| File | What it does |
|---|---|
| `js/app.js` | Render loop, glasses wipe, controls, detection loop (alternates full frame and zoomed quarters) |
| `js/effects.js` | Black-and-white filter, grain, vignette, headache glitch |
| `js/scanner.js` | Sends frames to the detector worker; Tesseract.js reads found signs only to spot money |
| `js/detector-worker.js` | Runs the PP-OCRv4 text detection model off the main thread: WebGPU when available, else multi-core WebAssembly |
| `js/motion.js` | Estimates camera movement so overlays follow signs between scans |
| `js/tracker.js` | Matches detections to overlays, smooths and draws the messages |
| `js/messages.js` | The message list and money detection |
| `js/capture.js` | Photo / video capture and sharing |
| `sw.js` | Offline cache; adds COOP/COEP headers so the model can use several CPU cores |

Regenerate PNG icons after editing the shapes: `node scripts/make-icons.mjs`.

### Test switches

- `?lens=cpu` — skip WebGPU and run detection on the CPU.
- `&threads=N` — cap CPU threads (e.g. `threads=1` for the slowest path).

The backend in use is logged to the console: `Text detection: webgpu|wasm, N thread(s)`.

## Third-party assets

- `models/text-det.onnx` — PaddleOCR PP-OCRv4 mobile text detection model (`ch_PP-OCRv4_det_infer.onnx`),
  Apache-2.0, ONNX export from [RapidOCR](https://huggingface.co/SWHL/RapidOCR).
- `demo/belgrade.jpg` — "Knez Mihailova Street (Belgrade)" by Jaimrsilva, CC BY-SA 4.0, via
  [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Knez_Mihailova_Street_(Belgrade).jpg).
- Loaded from jsDelivr at runtime: onnxruntime-web 1.20.1 (MIT), tesseract.js 5.1.1 (Apache-2.0).
