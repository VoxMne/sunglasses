// Finding and reading text.
//
// TextFinder: PaddleOCR's PP-OCRv4 text *detection* model (DBNet) via ONNX Runtime Web.
//   It only says where text is — which is all we need to cover a sign — and copes with
//   real-world signs: logos, stylized fonts, angles, any script.
// MoneyReader: Tesseract.js, used only to read crops of found text so banknotes can
//   get THIS IS YOUR GOD.

const ORT_VERSION = '1.20.1';
const ORT_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
const MODEL_URL = 'models/text-det.onnx';
const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';

// DBNet post-processing, same defaults as PaddleOCR.
const BIN_THRESH = 0.3;   // pixel counts as text above this probability
const BOX_THRESH = 0.55;  // region kept if its mean probability is above this
const UNCLIP_RATIO = 1.5; // the model predicts shrunken regions; grow them back
const MIN_PIXELS = 12;

// ImageNet normalisation, applied in BGR order like PaddleOCR (images come from cv2).
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

export class TextFinder {
  constructor(onStatus = () => {}, maxSide = 800) {
    this.onStatus = onStatus;
    this.maxSide = maxSide;
    this.session = null;
    this.loading = null;
    this.input = document.createElement('canvas');
    this.inputCtx = this.input.getContext('2d', { willReadFrequently: true });
  }

  init() {
    if (!this.loading) {
      this.loading = this.#load().catch((err) => {
        this.loading = null;
        throw err;
      });
    }
    return this.loading;
  }

  async #load() {
    this.onStatus('loading');
    await loadScript(`${ORT_BASE}ort.min.js`, () => window.ort);
    const { ort } = window;
    ort.env.wasm.wasmPaths = ORT_BASE;
    ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
    this.session = await ort.InferenceSession.create(MODEL_URL, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
    this.onStatus('ready');
  }

  // Returns [{ x, y, w, h }] in the canvas' pixel coordinates, one box per sign.
  async scan(canvas) {
    await this.init();
    const { ort } = window;

    // The model needs sides that are multiples of 32.
    const scale = Math.min(1, this.maxSide / Math.max(canvas.width, canvas.height));
    const rw = Math.max(32, Math.round((canvas.width * scale) / 32) * 32);
    const rh = Math.max(32, Math.round((canvas.height * scale) / 32) * 32);
    if (this.input.width !== rw || this.input.height !== rh) {
      this.input.width = rw;
      this.input.height = rh;
    }
    this.inputCtx.drawImage(canvas, 0, 0, rw, rh);
    const px = this.inputCtx.getImageData(0, 0, rw, rh).data;

    const plane = rw * rh;
    const data = new Float32Array(3 * plane);
    for (let i = 0, p = 0; i < plane; i++, p += 4) {
      data[i] = (px[p + 2] / 255 - MEAN[0]) / STD[0];             // B
      data[plane + i] = (px[p + 1] / 255 - MEAN[1]) / STD[1];     // G
      data[2 * plane + i] = (px[p] / 255 - MEAN[2]) / STD[2];     // R
    }

    const feeds = { [this.session.inputNames[0]]: new ort.Tensor('float32', data, [1, 3, rh, rw]) };
    const results = await this.session.run(feeds);
    const prob = results[this.session.outputNames[0]].data;

    const kx = canvas.width / rw;
    const ky = canvas.height / rh;
    const boxes = regions(prob, rw, rh).map((b) => ({
      x: b.x * kx, y: b.y * ky, w: b.w * kx, h: b.h * ky,
    }));
    return mergeBoxes(boxes);
  }
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

// Reads the text inside one box. Lazy: Tesseract only loads when first needed.
export class MoneyReader {
  constructor() {
    this.worker = null;
    this.loading = null;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d');
  }

  async #init() {
    if (!this.loading) {
      this.loading = (async () => {
        await loadScript(TESSERACT_URL, () => window.Tesseract);
        this.worker = await window.Tesseract.createWorker('eng');
        await this.worker.setParameters({ tessedit_pageseg_mode: '6' }); // one block of text
      })().catch((err) => {
        this.loading = null;
        throw err;
      });
    }
    return this.loading;
  }

  // Reads the region { sx, sy, sw, sh } of `el` (source pixels). Returns the text.
  async read(el, region) {
    await this.#init();
    // Scale so a line of text is ~48px tall, which Tesseract likes.
    const scale = Math.min(4, Math.max(1, 48 / region.sh));
    this.canvas.width = Math.max(8, Math.round(region.sw * scale));
    this.canvas.height = Math.max(8, Math.round(region.sh * scale));
    this.ctx.filter = 'grayscale(1) contrast(1.3)';
    this.ctx.drawImage(el, region.sx, region.sy, region.sw, region.sh, 0, 0, this.canvas.width, this.canvas.height);
    this.ctx.filter = 'none';
    const { data } = await this.worker.recognize(this.canvas);
    return (data.text || '').replace(/\s+/g, ' ').trim();
  }
}

// Joins boxes on one line, and stacked lines of one sign, into a single box,
// so each sign gets one message.
function mergeBoxes(boxes) {
  const list = boxes.map((b) => ({ ...b }));
  let changed = true;
  while (changed) {
    changed = false;
    outer:
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (shouldMerge(list[i], list[j])) {
          list[i] = union(list[i], list[j]);
          list.splice(j, 1);
          changed = true;
          break outer;
        }
      }
    }
  }
  return list;
}

function shouldMerge(a, b) {
  const hMin = Math.min(a.h, b.h);
  const hMax = Math.max(a.h, b.h);
  const vOverlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  const hOverlap = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);

  // Overlapping boxes are the same text.
  if (vOverlap > 0 && hOverlap > 0) return true;
  if (hMax > hMin * 2.2) return false;
  // Same line, close together.
  if (vOverlap > hMin * 0.5 && -hOverlap < hMin * 0.9) return true;
  // Stacked lines of the same sign.
  if (hOverlap > Math.min(a.w, b.w) * 0.4 && -vOverlap < hMin * 0.9) return true;
  return false;
}

function union(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x, y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  };
}

function loadScript(src, loaded) {
  if (loaded()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.crossOrigin = 'anonymous';
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load the lens software. Check your connection.'));
    document.head.appendChild(s);
  });
}
