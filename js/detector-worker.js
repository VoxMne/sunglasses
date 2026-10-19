// Runs the text-detection model off the main thread, so the camera view never
// stalls while a frame is being scanned.
//
// Backend: WebGPU (the phone's graphics chip) when available, otherwise WebAssembly
// on the CPU — multi-threaded when the page is cross-origin isolated (see sw.js).
// The model and the runtime's engine are downloaded here (not by ONNX Runtime) so
// the app can show download progress.

const ORT_BASE = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';

// Unpacked byte sizes (for progress) and rough download sizes (to weight them).
const MODEL = { bytes: 4745517, transfer: 4.7e6 };
const RUNTIMES = {
  webgpu: {
    bundle: 'ort.webgpu.min.mjs',
    loader: 'ort-wasm-simd-threaded.jsep.mjs',
    wasm: 'ort-wasm-simd-threaded.jsep.wasm',
    bytes: 21663894,
    transfer: 4.2e6,
  },
  cpu: {
    bundle: 'ort.wasm.min.mjs',
    loader: 'ort-wasm-simd-threaded.mjs',
    wasm: 'ort-wasm-simd-threaded.wasm',
    bytes: 11246032,
    transfer: 2.5e6,
  },
};

// DBNet post-processing, same defaults as PaddleOCR.
const BIN_THRESH = 0.3;   // pixel counts as text above this probability
const BOX_THRESH = 0.55;  // region kept if its mean probability is above this
const UNCLIP_RATIO = 1.5; // the model predicts shrunken regions; grow them back
const MIN_PIXELS = 12;

// Tilt: a region needs a clear long side (variance ratio ≈ aspect² > 3) to have a
// direction, and steeper than this it's treated as upright (vertical text, poles).
const MIN_ELONGATION = 3;
const MAX_TILT = 0.61; // ~35°

// ImageNet normalisation, applied in BGR order like PaddleOCR (images come from cv2).
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

let ort = null;
let session = null;

self.onmessage = async ({ data: msg }) => {
  try {
    if (msg.type === 'init') {
      const report = (value) => self.postMessage({ type: 'progress', value });
      self.postMessage({ id: msg.id, ok: true, result: await init(msg, report) });
    } else if (msg.type === 'scan') {
      self.postMessage({ id: msg.id, ok: true, result: await scan(msg.pixels, msg.width, msg.height) });
    }
  } catch (err) {
    self.postMessage({ id: msg.id, ok: false, error: err?.message || String(err) });
  }
};

// Options (for testing on devices): cpuOnly skips WebGPU; maxThreads caps CPU threads.
async function init({ modelUrl, cpuOnly = false, maxThreads = 4 }, report) {
  const threads = self.crossOriginIsolated ? Math.max(1, Math.min(maxThreads, navigator.hardwareConcurrency || 1)) : 1;
  const gpu = !cpuOnly && await hasWebGPU();
  const runtime = gpu ? RUNTIMES.webgpu : RUNTIMES.cpu;

  const progress = combinedProgress([MODEL.transfer, runtime.transfer], report);
  const [model, wasm] = await Promise.all([
    download(modelUrl, MODEL.bytes, (f) => progress(0, f)),
    download(ORT_BASE + runtime.wasm, runtime.bytes, (f) => progress(1, f)),
    import(ORT_BASE + runtime.bundle).then((m) => { ort = m; }),
  ]);
  // Hand ONNX Runtime the engine we already downloaded, so it isn't fetched twice. As a
  // blob URL rather than env.wasm.wasmBinary: given raw bytes, its loader still builds
  // a path relative to its own (blob:) address and fails.
  const wasmUrl = URL.createObjectURL(new Blob([wasm], { type: 'application/wasm' }));
  ort.env.wasm.wasmPaths = { mjs: ORT_BASE + runtime.loader, wasm: wasmUrl };
  ort.env.wasm.numThreads = threads;

  try {
    if (gpu) {
      try {
        session = await ort.InferenceSession.create(model.slice(), {
          executionProviders: ['webgpu'],
          graphOptimizationLevel: 'all',
        });
        return { backend: 'webgpu', threads };
      } catch (err) {
        // The WebGPU engine can also run on the CPU, so nothing more to download.
        console.warn('WebGPU could not run the model; using the CPU instead.', err);
      }
    }
    session = await ort.InferenceSession.create(model.slice(), {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
    return { backend: 'wasm', threads };
  } finally {
    URL.revokeObjectURL(wasmUrl);
  }
}

async function hasWebGPU() {
  if (!navigator.gpu) return false;
  try {
    return Boolean(await navigator.gpu.requestAdapter());
  } catch {
    return false;
  }
}

// Fetches a file, reporting the fraction received. `expected` is its unpacked size:
// compressed responses carry no usable Content-Length.
async function download(url, expected, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not download the lenses (${res.status}). Check your connection.`);
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    onProgress(1);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress(Math.min(1, loaded / expected));
  }
  const out = new Uint8Array(loaded);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  onProgress(1);
  return out;
}

// Reports the weighted total of several downloads, at most ~10 times a second.
function combinedProgress(weights, report) {
  const parts = weights.map(() => 0);
  const sum = weights.reduce((s, w) => s + w, 0);
  let last = 0;
  return (i, fraction) => {
    parts[i] = fraction;
    const total = parts.reduce((s, p, k) => s + p * weights[k], 0) / sum;
    const now = performance.now();
    if (now - last > 100 || total >= 1) {
      last = now;
      report(total);
    }
  };
}

// pixels: RGBA bytes of a width x height image (sides are multiples of 32).
// Returns tilted text boxes [{ cx, cy, w, h, a, sure }] in that image's pixels.
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

// Connected regions of the probability map -> padded, tilted boxes.
function regions(prob, w, h) {
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  const members = new Int32Array(w * h);
  const out = [];
  for (let start = 0; start < prob.length; start++) {
    if (seen[start] || prob[start] <= BIN_THRESH) continue;
    let top = 0;
    let n = 0;
    stack[top++] = start;
    seen[start] = 1;
    let sum = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
    while (top) {
      const i = stack[--top];
      members[n++] = i;
      const x = i % w;
      const y = (i - x) / w;
      sum += prob[i];
      sx += x; sy += y;
      sxx += x * x; syy += y * y; sxy += x * y;
      if (x > 0 && !seen[i - 1] && prob[i - 1] > BIN_THRESH) { seen[i - 1] = 1; stack[top++] = i - 1; }
      if (x < w - 1 && !seen[i + 1] && prob[i + 1] > BIN_THRESH) { seen[i + 1] = 1; stack[top++] = i + 1; }
      if (y > 0 && !seen[i - w] && prob[i - w] > BIN_THRESH) { seen[i - w] = 1; stack[top++] = i - w; }
      if (y < h - 1 && !seen[i + w] && prob[i + w] > BIN_THRESH) { seen[i + w] = 1; stack[top++] = i + w; }
    }
    if (n < MIN_PIXELS || sum / n < BOX_THRESH) continue;

    // Direction of the long side, from the region's spread (principal axis).
    const mx = sx / n;
    const my = sy / n;
    const cxx = sxx / n - mx * mx;
    const cyy = syy / n - my * my;
    const cxy = sxy / n - mx * my;
    const half = (cxx + cyy) / 2;
    const disc = Math.sqrt(Math.max(0, half * half - (cxx * cyy - cxy * cxy)));
    let angle = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
    const sure = (half + disc) / Math.max(1e-6, half - disc) > MIN_ELONGATION && Math.abs(angle) <= MAX_TILT;
    if (!sure) angle = 0;

    // Extent along and across that direction.
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (let k = 0; k < n; k++) {
      const i = members[k];
      const x = (i % w) - mx;
      const y = ((i - (i % w)) / w) - my;
      const u = x * cos + y * sin;
      const v = -x * sin + y * cos;
      if (u < u0) u0 = u;
      if (u > u1) u1 = u;
      if (v < v0) v0 = v;
      if (v > v1) v1 = v;
    }
    const bw = u1 - u0 + 1;
    const bh = v1 - v0 + 1;
    const d = (bw * bh * UNCLIP_RATIO) / (2 * (bw + bh));
    const uc = (u0 + u1) / 2;
    const vc = (v0 + v1) / 2;
    const box = {
      cx: mx + 0.5 + uc * cos - vc * sin,
      cy: my + 0.5 + uc * sin + vc * cos,
      w: bw + 2 * d,
      h: bh + 2 * d,
      a: angle,
      sure,
    };
    if (box.w >= 6 && box.h >= 5) out.push(box);
  }
  return out;
}
