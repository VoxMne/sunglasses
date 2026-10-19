// Runs the text-detection model off the main thread, so the camera view never
// stalls while a frame is being scanned.
//
// Backend: WebGPU (the phone's graphics chip) when available, otherwise WebAssembly
// on the CPU — multi-threaded when the page is cross-origin isolated (see sw.js).

const ORT_BASE = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';

// DBNet post-processing, same defaults as PaddleOCR.
const BIN_THRESH = 0.3;   // pixel counts as text above this probability
const BOX_THRESH = 0.55;  // region kept if its mean probability is above this
const UNCLIP_RATIO = 1.5; // the model predicts shrunken regions; grow them back
const MIN_PIXELS = 12;

// ImageNet normalisation, applied in BGR order like PaddleOCR (images come from cv2).
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

let ort = null;
let session = null;

self.onmessage = async ({ data: msg }) => {
  try {
    if (msg.type === 'init') {
      self.postMessage({ id: msg.id, ok: true, result: await init(msg.modelUrl, msg) });
    } else if (msg.type === 'scan') {
      self.postMessage({ id: msg.id, ok: true, result: await scan(msg.pixels, msg.width, msg.height) });
    }
  } catch (err) {
    self.postMessage({ id: msg.id, ok: false, error: err?.message || String(err) });
  }
};

// Options (for testing on devices): cpuOnly skips WebGPU; maxThreads caps CPU threads.
async function init(modelUrl, { cpuOnly = false, maxThreads = 4 } = {}) {
  const res = await fetch(modelUrl);
  if (!res.ok) throw new Error(`Could not load the lens model (${res.status}).`);
  const model = new Uint8Array(await res.arrayBuffer());
  const threads = self.crossOriginIsolated ? Math.max(1, Math.min(maxThreads, navigator.hardwareConcurrency || 1)) : 1;

  if (!cpuOnly && await hasWebGPU()) {
    try {
      ort = await import(`${ORT_BASE}ort.webgpu.min.mjs`);
      configure(threads);
      session = await ort.InferenceSession.create(model.slice(), {
        executionProviders: ['webgpu'],
        graphOptimizationLevel: 'all',
      });
      return { backend: 'webgpu', threads };
    } catch (err) {
      console.warn('WebGPU could not run the model; using the CPU instead.', err);
    }
  }

  // The WebGPU bundle can also run on the CPU, so only load the CPU bundle if needed.
  if (!ort) {
    ort = await import(`${ORT_BASE}ort.wasm.min.mjs`);
    configure(threads);
  }
  session = await ort.InferenceSession.create(model.slice(), {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });
  return { backend: 'wasm', threads };
}

function configure(threads) {
  ort.env.wasm.wasmPaths = ORT_BASE;
  ort.env.wasm.numThreads = threads;
}

async function hasWebGPU() {
  if (!navigator.gpu) return false;
  try {
    return Boolean(await navigator.gpu.requestAdapter());
  } catch {
    return false;
  }
}

// pixels: RGBA bytes of a width x height image (sides are multiples of 32).
// Returns text boxes [{ x, y, w, h }] in that image's pixels.
async function scan(pixels, w, h) {
  const plane = w * h;
  const data = new Float32Array(3 * plane);
  for (let i = 0, p = 0; i < plane; i++, p += 4) {
    data[i] = (pixels[p + 2] / 255 - MEAN[0]) / STD[0];            // B
    data[plane + i] = (pixels[p + 1] / 255 - MEAN[1]) / STD[1];    // G
    data[2 * plane + i] = (pixels[p] / 255 - MEAN[2]) / STD[2];    // R
  }

  const input = new ort.Tensor('float32', data, [1, 3, h, w]);
  const results = await session.run({ [session.inputNames[0]]: input });
  const output = results[session.outputNames[0]];
  const prob = output.location === 'gpu-buffer' ? await output.getData() : output.data;
  return regions(prob, w, h);
}

// Connected regions of the probability map -> padded bounding boxes.
function regions(prob, w, h) {
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  const out = [];
  for (let start = 0; start < prob.length; start++) {
    if (seen[start] || prob[start] <= BIN_THRESH) continue;
    let top = 0;
    stack[top++] = start;
    seen[start] = 1;
    let minX = w, minY = h, maxX = 0, maxY = 0, count = 0, sum = 0;
    while (top) {
      const i = stack[--top];
      const x = i % w;
      const y = (i - x) / w;
      count++;
      sum += prob[i];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x > 0 && !seen[i - 1] && prob[i - 1] > BIN_THRESH) { seen[i - 1] = 1; stack[top++] = i - 1; }
      if (x < w - 1 && !seen[i + 1] && prob[i + 1] > BIN_THRESH) { seen[i + 1] = 1; stack[top++] = i + 1; }
      if (y > 0 && !seen[i - w] && prob[i - w] > BIN_THRESH) { seen[i - w] = 1; stack[top++] = i - w; }
      if (y < h - 1 && !seen[i + w] && prob[i + w] > BIN_THRESH) { seen[i + w] = 1; stack[top++] = i + w; }
    }
    if (count < MIN_PIXELS || sum / count < BOX_THRESH) continue;

    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    const d = (bw * bh * UNCLIP_RATIO) / (2 * (bw + bh));
    const box = {
      x: Math.max(0, minX - d),
      y: Math.max(0, minY - d),
      w: Math.min(w, maxX + 1 + d) - Math.max(0, minX - d),
      h: Math.min(h, maxY + 1 + d) - Math.max(0, minY - d),
    };
    if (box.w >= 6 && box.h >= 5) out.push(box);
  }
  return out;
}
