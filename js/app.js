import { startCamera, createDemoSource } from './camera.js';
import { Effects } from './effects.js';
import { MotionEstimator } from './motion.js';
import { TextFinder, MoneyReader } from './scanner.js';
import { Tracker } from './tracker.js';
import { savePhoto, Recorder } from './capture.js';
import { IDENTITY, bounds, compose, invert, moveBox, scaleBox } from './geometry.js';

const $ = (id) => document.getElementById(id);

const canvas = $('view');
const ctx = canvas.getContext('2d', { alpha: false });
const video = $('video');

const DETECT_MAX_SIDE = 960;   // detection frame size; bigger = finds smaller text, slower
const HEADACHE_START = 20;     // seconds of wearing before the headache kicks in
const HEADACHE_FULL = 45;      // seconds until it is at its worst
const WIPE_SECONDS = 0.55;

const prefs = loadPrefs();

const state = {
  source: null,
  facing: 'environment',
  glasses: true,
  wipe: 0,               // 0 = glasses off, 1 = fully on
  glassesSince: 0,
  W: 0,
  H: 0,
  crop: null,
  camera: IDENTITY,      // total camera motion so far (see geometry.js), to place late detections
  epoch: 0,              // bumped when tracking resets; detections from before are dropped
  running: false,
  scannerStatus: 'idle', // 'idle' | 'loading' | 'ready' | 'error'
  loadProgress: 0,       // 0..1 while the lenses download
  loadStarted: 0,
  scanError: null,
};

const effects = new Effects();
const motion = new MotionEstimator();
const tracker = new Tracker();
const recorder = new Recorder();
const scanner = new TextFinder((status, progress) => {
  if (status === 'loading' && state.scannerStatus !== 'loading') state.loadStarted = performance.now();
  state.scannerStatus = status;
  if (progress !== undefined) state.loadProgress = progress;
  renderProgress();
}, DETECT_MAX_SIDE);
const moneyReader = new MoneyReader();

const detectCanvas = document.createElement('canvas');
const detectCtx = detectCanvas.getContext('2d', { willReadFrequently: true });

// ---------- Start ----------

$('start').addEventListener('click', () => begin(null));
$('demo').addEventListener('click', () => begin('photo'));

// demo: null for the real camera, or 'photo' / 'street'.
async function begin(demo) {
  $('intro-error').hidden = true;
  // Download the lenses while the camera prompt is up; errors resurface when scanning.
  scanner.init().catch(() => {});
  try {
    state.source = demo ? await createDemoSource(demo) : await startCamera(video, state.facing);
  } catch (err) {
    showIntroError(err);
    return;
  }
  $('intro').hidden = true;
  $('hud').hidden = false;
  $('credit').textContent = state.source.credit || '';
  $('credit').hidden = !state.source.credit;
  $('flip').disabled = demo;
  $('record').disabled = !Recorder.supported(canvas);
  syncChips();
  setGlasses(true);
  keepAwake();

  if (!state.running) {
    state.running = true;
    requestAnimationFrame(frame);
    detectLoop();
    readLoop();
  }
}

function showIntroError(err) {
  const el = $('intro-error');
  el.hidden = false;
  el.textContent = err.name === 'NotAllowedError'
    ? 'Camera access was blocked. Allow it in your browser settings and try again.'
    : err.message || String(err);
}

// ---------- Render loop ----------

let last = performance.now();

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;

  const src = state.source;
  if (!src || !src.ready()) return;
  src.update?.(now);
  resize();

  const { W, H } = state;
  const crop = (state.crop = coverCrop(src.width, src.height, W, H));

  const target = state.glasses ? 1 : 0;
  state.wipe += Math.sign(target - state.wipe) * Math.min(Math.abs(target - state.wipe), dt / WIPE_SECONDS);
  if (state.wipe === 0 && tracker.boxes.length) resetTracking();

  if (state.wipe > 0) {
    const m = motion.estimate(src.el, crop, W, H);
    if (m) {
      state.camera = compose(m, state.camera);
      const before = tracker.boxes.map((b) => [b, b.t.cx, b.t.cy]);
      tracker.transform(m);
      // Then let each sign settle onto where it really went (near and far signs
      // shift differently as you walk).
      for (const [b, px, py] of before) {
        if (b.dying || b.alpha < 0.5) continue;
        const r = motion.refine(px, py, b.t.cx, b.t.cy, b.t.w, b.t.h);
        if (r) tracker.nudge(b, r.dx * 0.8, r.dy * 0.8);
      }
    }
    tracker.step(dt, W, H);
  }

  // The real world.
  if (state.wipe < 1) {
    ctx.drawImage(src.el, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, W, H);
  }

  // The truth, wiping down from the top as the glasses go on.
  if (state.wipe > 0) {
    const ache = headacheLevel(now);
    const edge = easeInOut(state.wipe) * H;
    ctx.save();
    if (state.wipe < 1) {
      ctx.beginPath();
      ctx.rect(0, 0, W, edge);
      ctx.clip();
    }
    if (ache > 0) ctx.translate((Math.random() - 0.5) * 10 * ache, (Math.random() - 0.5) * 10 * ache);
    effects.drawFiltered(ctx, src.el, crop, W, H);
    tracker.draw(ctx, ache * 8);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    effects.finish(ctx, W, H);
    effects.headache(ctx, canvas, W, H, ache, now);
    ctx.restore();

    if (state.wipe < 1) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, edge - 3, W, 6);
    }
  }

  updateStatus(now);
}

function headacheLevel(now) {
  if (!prefs.headache || state.wipe < 1) return 0;
  const t = (now - state.glassesSince) / 1000;
  return clamp((t - HEADACHE_START) / (HEADACHE_FULL - HEADACHE_START), 0, 1);
}

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let W = Math.round(window.innerWidth * dpr);
  let H = Math.round(window.innerHeight * dpr);
  // Keep the per-frame work reasonable on big screens.
  const maxPixels = 2_000_000;
  if (W * H > maxPixels) {
    const s = Math.sqrt(maxPixels / (W * H));
    W = Math.round(W * s);
    H = Math.round(H * s);
  }
  if (W !== state.W || H !== state.H) {
    canvas.width = state.W = W;
    canvas.height = state.H = H;
    resetTracking();
  }
}

// Forget all overlays and motion history (glasses off, resize, camera switch).
function resetTracking() {
  tracker.clear();
  motion.reset();
  state.camera = IDENTITY;
  state.epoch++;
}

function coverCrop(srcW, srcH, W, H) {
  const s = Math.max(W / srcW, H / srcH);
  const sw = W / s;
  const sh = H / s;
  return { sx: (srcW - sw) / 2, sy: (srcH - sh) / 2, sw, sh };
}

// ---------- Text detection loop ----------

// Every other pass zooms into one overlapping quarter of the frame, so small or
// distant signs are big enough for the model. Fractions of the frame: [x, y, size].
const FULL_FRAME = [0, 0, 1];
const TILES = [[0, 0, 0.6], [0.4, 0, 0.6], [0, 0.4, 0.6], [0.4, 0.4, 0.6]];

async function detectLoop() {
  let pass = 0;
  for (;;) {
    const src = state.source;
    if (!src || !src.ready() || state.wipe < 0.5 || document.hidden || !state.crop) {
      await sleep(250);
      continue;
    }

    const zoomed = pass % 2 === 1;
    const [fx, fy, fs] = zoomed ? TILES[((pass - 1) / 2) % TILES.length] : FULL_FRAME;
    pass++;

    const { W, H, crop } = state;
    const region = { x: fx * W, y: fy * H, w: fs * W, h: fs * H }; // screen pixels
    // Use the source's own resolution (not the screen's), capped for speed.
    const scale = Math.min(DETECT_MAX_SIDE / Math.max(region.w, region.h), Math.max(1, (crop.sw * fs) / region.w));
    const dw = Math.round(region.w * scale);
    const dh = Math.round(region.h * scale);
    if (detectCanvas.width !== dw || detectCanvas.height !== dh) {
      detectCanvas.width = dw;
      detectCanvas.height = dh;
    }
    detectCtx.drawImage(
      src.el,
      crop.sx + fx * crop.sw, crop.sy + fy * crop.sh, fs * crop.sw, fs * crop.sh,
      0, 0, dw, dh,
    );
    const cameraAtCapture = state.camera;
    const { epoch } = state;

    let found;
    try {
      found = await scanner.scan(detectCanvas);
      state.scanError = null;
    } catch (err) {
      console.error(err);
      state.scanError = err.message || 'Text reader failed';
      await sleep(3000);
      continue;
    }

    // The frame was captured a moment ago; move results by how the camera moved since.
    if (state.epoch === epoch && state.wipe > 0) {
      const sinceCapture = compose(state.camera, invert(cameraAtCapture));
      const kx = region.w / dw;
      const ky = region.h / dh;
      const toNow = (b) => {
        const box = scaleBox(b, kx, ky);
        box.cx += region.x;
        box.cy += region.y;
        return moveBox(sinceCapture, box);
      };
      const scanned = bounds(moveBox(sinceCapture, {
        cx: region.x + region.w / 2, cy: region.y + region.h / 2, w: region.w, h: region.h, a: 0,
      }));
      tracker.update(found.map(toNow), prefs.money, { region: scanned, zoomed });
    }
    await sleep(80);
  }
}

// Reads found signs one at a time, only to spot money (THIS IS YOUR GOD).
async function readLoop() {
  for (;;) {
    await sleep(400);
    const src = state.source;
    const box = state.wipe === 1 && !document.hidden && src?.ready() ? tracker.nextUnread() : null;
    if (!box || !state.crop) continue;

    // Box is in screen pixels; map it back to source pixels (same scale on both axes).
    const { crop, W } = state;
    const k = crop.sw / W;
    const { t } = box;
    const region = { cx: crop.sx + t.cx * k, cy: crop.sy + t.cy * k, w: t.w * k, h: t.h * k, a: t.a };
    if (region.w < 4 || region.h < 4) {
      box.text = '';
      continue;
    }
    try {
      tracker.setText(box, await moneyReader.read(src.el, region));
    } catch (err) {
      console.warn('Money reader:', err);
      box.text = '';
      await sleep(3000);
    }
  }
}

// ---------- Controls ----------

canvas.addEventListener('click', () => setGlasses(!state.glasses));
$('glasses').addEventListener('click', () => setGlasses(!state.glasses));

function setGlasses(on) {
  state.glasses = on;
  if (on) state.glassesSince = performance.now();
  const btn = $('glasses');
  btn.textContent = on ? 'TAKE OFF' : 'PUT ON';
  btn.classList.toggle('off', !on);
}

$('chip-money').addEventListener('click', () => {
  prefs.money = !prefs.money;
  tracker.setMoneyMode(prefs.money);
  savePrefs();
  syncChips();
});

$('chip-headache').addEventListener('click', () => {
  prefs.headache = !prefs.headache;
  state.glassesSince = performance.now();
  savePrefs();
  syncChips();
});

function syncChips() {
  $('chip-money').setAttribute('aria-pressed', String(prefs.money));
  $('chip-headache').setAttribute('aria-pressed', String(prefs.headache));
}

$('flip').addEventListener('click', async () => {
  if (state.source?.facing === 'demo') return;
  const next = state.facing === 'environment' ? 'user' : 'environment';
  try {
    state.source = await startCamera(video, next);
    state.facing = next;
    resetTracking();
  } catch (err) {
    toast(err.message || 'Could not switch camera');
    state.source = await startCamera(video, state.facing).catch(() => state.source);
  }
});

$('shutter').addEventListener('click', async () => {
  const saving = savePhoto(canvas); // snapshots the canvas before the flash is drawn
  flash();
  try {
    const result = await saving;
    if (result === 'saved') toast('PHOTO SAVED');
  } catch (err) {
    toast(err.message);
  }
});

$('record').addEventListener('click', async () => {
  const btn = $('record');
  if (!recorder.recording) {
    try {
      recorder.start(canvas);
      btn.classList.add('on');
      $('rec').hidden = false;
    } catch (err) {
      toast(err.message || 'Recording is not supported here');
    }
    return;
  }
  btn.classList.remove('on');
  $('rec').hidden = true;
  const result = await recorder.stop();
  if (result === 'saved') toast('VIDEO SAVED');
});

// ---------- Status & helpers ----------

let lastStatus = '';
let lastStatusAt = 0;

function updateStatus(now) {
  if (now - lastStatusAt < 200) return;
  lastStatusAt = now;
  let text;
  if (state.wipe < 1) text = state.glasses ? '' : 'NORMAL VIEW';
  else if (state.scanError) text = state.scanError.toUpperCase();
  else if (state.scannerStatus === 'loading' || state.scannerStatus === 'idle') {
    text = state.loadProgress < 1 ? `TUNING THE LENSES… ${Math.round(state.loadProgress * 100)}%` : 'TUNING THE LENSES…';
  }
  else if (headacheLevel(now) > 0.6) text = 'TAKE THEM OFF';
  else {
    const n = tracker.count;
    text = n ? `${n} MESSAGE${n === 1 ? '' : 'S'} REVEALED` : 'SCANNING';
  }
  if (text !== lastStatus) {
    $('status').textContent = text;
    lastStatus = text;
  }
}

// Download progress of the lenses (detection model + engine): a bar along the top,
// and a line under the intro buttons. Hidden for quick loads (already cached).
function renderProgress() {
  const shown = state.scannerStatus === 'loading' && performance.now() - state.loadStarted > 250;
  const bar = $('progress');
  bar.hidden = !shown;
  bar.style.setProperty('--p', state.loadProgress.toFixed(3));
  const line = $('intro-progress');
  line.hidden = !shown;
  line.textContent = state.loadProgress < 1
    ? `DOWNLOADING THE LENSES… ${Math.round(state.loadProgress * 100)}%`
    : 'POLISHING THE LENSES…';
}

let toastTimer = 0;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
}

function flash() {
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, state.W, state.H);
}

async function keepAwake() {
  try {
    const lock = await navigator.wakeLock?.request('screen');
    lock?.addEventListener('release', () => {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') keepAwake();
      }, { once: true });
    });
  } catch {
    // Not supported or not allowed; the screen may dim. Fine.
  }
}

function loadPrefs() {
  const defaults = { money: false, headache: true };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem('sunglasses.prefs') || '{}') };
  } catch {
    return defaults;
  }
}

function savePrefs() {
  try {
    localStorage.setItem('sunglasses.prefs', JSON.stringify(prefs));
  } catch {
    // Storage unavailable (private mode); prefs just won't persist.
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

// ---------- PWA ----------

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js')
    .then(() => {
      // The service worker adds the headers that let the text model use several CPU
      // cores. They only apply from the next page load, so reload once — but never
      // after the glasses are on (that would drop the camera) and never in a loop.
      if (window.crossOriginIsolated) {
        preloadLenses();
        return;
      }
      const reloadOnce = async () => {
        if (state.running || window.crossOriginIsolated) return;
        try {
          // An older service worker (from before this feature) may still be in charge;
          // only reload once the one in control actually adds the headers.
          const probe = await fetch('manifest.webmanifest', { cache: 'no-store' });
          if (probe.headers.get('cross-origin-embedder-policy') !== 'require-corp') return;
          if (sessionStorage.getItem('sunglasses.isolationReload')) return;
          sessionStorage.setItem('sunglasses.isolationReload', '1');
        } catch {
          return;
        }
        if (!state.running) location.reload();
      };
      if (navigator.serviceWorker.controller) reloadOnce();
      navigator.serviceWorker.addEventListener('controllerchange', reloadOnce);
    })
    .catch((err) => console.warn('Service worker:', err));
} else {
  preloadLenses();
}

// Start downloading the lenses on the intro screen, so they're ready sooner.
function preloadLenses() {
  scanner.init().catch(() => {}); // errors resurface (and retry) when scanning starts
}

// ?debug exposes the internals to the console (e.g. remote-debugging a phone).
if (new URLSearchParams(location.search).has('debug')) window.sunglasses = { state, tracker, scanner };

const demoParam = new URLSearchParams(location.search).get('demo');
if (demoParam !== null) begin(demoParam === 'street' ? 'street' : 'photo');
