// Finding and reading text.
//
// TextFinder: PaddleOCR's PP-OCRv4 text *detection* model (DBNet) via ONNX Runtime Web.
//   It only says where text is — which is all we need to cover a sign — and copes with
//   real-world signs: logos, stylized fonts, angles, any script. The model runs in
//   js/detector-worker.js so the camera view never stalls during a scan.
// MoneyReader: Tesseract.js, used only to read crops of found text so banknotes can
//   get THIS IS YOUR GOD. Reads English plus Serbian in Cyrillic and Latin script.

import { mergeBoxes, scaleBox } from './geometry.js';

const MODEL_URL = 'models/text-det.onnx';
const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
const MONEY_LANGS = ['eng', 'srp', 'srp_latn'];

export class TextFinder {
  // onStatus(status, progress?): status is 'loading' (progress 0..1), 'ready' or 'error'.
  constructor(onStatus = () => {}, maxSide = 800) {
    this.onStatus = onStatus;
    this.maxSide = maxSide;
    this.worker = null;
    this.loading = null;
    this.pending = new Map();
    this.nextId = 1;
    this.info = null; // { backend: 'webgpu' | 'wasm', threads }
    this.input = document.createElement('canvas');
    this.inputCtx = this.input.getContext('2d', { willReadFrequently: true });
  }

  init() {
    if (!this.loading) {
      this.loading = this.#load().catch((err) => {
        this.worker?.terminate();
        this.worker = null;
        this.loading = null;
        this.onStatus('error');
        throw err;
      });
    }
    return this.loading;
  }

  async #load() {
    this.onStatus('loading', 0);
    this.worker = new Worker(new URL('./detector-worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = ({ data }) => {
      if (data.type === 'progress') {
        this.onStatus('loading', data.value);
        return;
      }
      const job = this.pending.get(data.id);
      if (!job) return;
      this.pending.delete(data.id);
      if (data.ok) job.resolve(data.result);
      else job.reject(new Error(data.error));
    };
    this.worker.onerror = (e) => {
      const err = new Error(e.message || 'The lens worker crashed.');
      for (const job of this.pending.values()) job.reject(err);
      this.pending.clear();
    };
    const modelUrl = new URL(MODEL_URL, document.baseURI).href;
    // Test switches: ?lens=cpu skips WebGPU, &threads=N caps CPU threads.
    const params = new URLSearchParams(location.search);
    const maxThreads = Number(params.get('threads')) || 4;
    this.info = await this.#call({ type: 'init', modelUrl, cpuOnly: params.get('lens') === 'cpu', maxThreads });
    console.info(`Text detection: ${this.info.backend}, ${this.info.threads} thread(s)`);
    this.onStatus('ready');
  }

  #call(msg, transfer = []) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...msg, id }, transfer);
    });
  }

  // Returns tilted boxes [{ cx, cy, w, h, a, sure }] in the canvas' pixel coordinates,
  // one box per sign.
  async scan(canvas) {
    await this.init();

    // The model needs sides that are multiples of 32.
    const scale = Math.min(1, this.maxSide / Math.max(canvas.width, canvas.height));
    const rw = Math.max(32, Math.round((canvas.width * scale) / 32) * 32);
    const rh = Math.max(32, Math.round((canvas.height * scale) / 32) * 32);
    if (this.input.width !== rw || this.input.height !== rh) {
      this.input.width = rw;
      this.input.height = rh;
    }
    this.inputCtx.drawImage(canvas, 0, 0, rw, rh);
    const pixels = this.inputCtx.getImageData(0, 0, rw, rh).data;

    const started = performance.now();
    const found = await this.#call({ type: 'scan', pixels, width: rw, height: rh }, [pixels.buffer]);
    this.lastScanMs = performance.now() - started;

    const kx = canvas.width / rw;
    const ky = canvas.height / rh;
    return mergeBoxes(found.map((b) => scaleBox(b, kx, ky)));
  }
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
        this.worker = await window.Tesseract.createWorker(MONEY_LANGS);
        await this.worker.setParameters({ tessedit_pageseg_mode: '6' }); // one block of text
      })().catch((err) => {
        this.loading = null;
        throw err;
      });
    }
    return this.loading;
  }

  // Reads the tilted box { cx, cy, w, h, a } of `el` (source pixels), straightened.
  async read(el, box) {
    await this.#init();
    // Scale so a line of text is ~48px tall, which Tesseract likes.
    const scale = Math.min(4, Math.max(1, 48 / box.h));
    const cw = Math.max(8, Math.round(box.w * scale));
    const ch = Math.max(8, Math.round(box.h * scale));
    this.canvas.width = cw; // also resets the context's transform and filter
    this.canvas.height = ch;
    const { ctx } = this;
    ctx.filter = 'grayscale(1) contrast(1.3)';
    ctx.translate(cw / 2, ch / 2);
    ctx.scale(scale, scale);
    ctx.rotate(-box.a);
    ctx.drawImage(el, -box.cx, -box.cy);
    const { data } = await this.worker.recognize(this.canvas);
    return (data.text || '').replace(/\s+/g, ' ').trim();
  }
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
