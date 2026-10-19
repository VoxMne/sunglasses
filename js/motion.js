// Works out how the picture moved since the last frame — sliding, zooming (stepping
// closer) and rolling (tilting the phone) — so overlays stay on their signs between
// the (slower) text-detection passes.
//
// It block-matches a grid of small patches between two tiny grayscale frames, then
// fits one camera motion (a similarity transform, see geometry.js) to the patches that
// agree, ignoring ones that don't (people walking by, flat sky). `refine` then checks
// each sign on its own, because near and far signs shift differently as you walk.

import { IDENTITY } from './geometry.js';

const PIXELS = 24000;   // size of the grayscale copy; it keeps the screen's aspect ratio
const PATCH = 16;       // grid patch side, in grayscale pixels
const RANGE = 6;        // search radius around the predicted motion
const MAX_SPEED = 12;   // cap on the predicted per-frame motion
const MIN_CONTRAST = 6; // patches flatter than this (sky, walls) can't be tracked
const MAX_ERROR = 22;   // mean pixel difference above which a match is rejected

export class MotionEstimator {
  constructor() {
    this.w = 0;
    this.h = 0;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.reset();
  }

  reset() {
    this.prev = null;
    this.cur = null;
    this.velocity = { x: 0, y: 0 };
  }

  // Camera motion since the last call, in screen pixels, or null on the first frame.
  estimate(el, crop, W, H) {
    const w = Math.max(48, Math.round(Math.sqrt((PIXELS * W) / H)));
    const h = Math.max(48, Math.round(PIXELS / w));
    if (w !== this.w || h !== this.h) {
      this.w = this.canvas.width = w;
      this.h = this.canvas.height = h;
      this.reset();
    }
    this.scale = (W / w + H / h) / 2; // screen pixels per grayscale pixel

    this.ctx.drawImage(el, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, w, h);
    const d = this.ctx.getImageData(0, 0, w, h).data;
    const gray = new Uint8Array(w * h);
    for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
      gray[i] = (d[p] * 77 + d[p + 1] * 150 + d[p + 2] * 29) >> 8;
    }
    this.prev = this.cur;
    this.cur = gray;
    if (!this.prev) return null;

    const m = this.#fit(this.#flow());
    return { a: m.a, b: m.b, tx: m.tx * this.scale, ty: m.ty * this.scale };
  }

  // After the camera motion moved a sign from (prevCx, prevCy) to (cx, cy): how far
  // the sign really is from there. Screen pixels in and out; null if it can't tell.
  refine(prevCx, prevCy, cx, cy, w, h) {
    if (!this.prev) return null;
    const f = this.scale;
    const hw = Math.max(3, Math.min(14, Math.round(w / f / 2)));
    const hh = Math.max(3, Math.min(10, Math.round(h / f / 2)));
    const x = Math.round(prevCx / f);
    const y = Math.round(prevCy / f);
    const px = Math.round(cx / f) - x;
    const py = Math.round(cy / f) - y;
    const range = 3;
    if (x - hw < 0 || y - hh < 0 || x + hw > this.w || y + hh > this.h) return null;
    if (x + px - hw - range < 0 || y + py - hh - range < 0) return null;
    if (x + px + hw + range > this.w || y + py + hh + range > this.h) return null;

    const m = matchPatch(this.prev, this.cur, this.w, x, y, hw, hh, px, py, range, 1);
    if (!m) return null;
    const rx = m.dx - (cx - prevCx) / f;
    const ry = m.dy - (cy - prevCy) / f;
    if (Math.hypot(rx, ry) < 0.25) return null; // within noise
    return { dx: rx * f, dy: ry * f };
  }

  // Where each grid patch moved to: [{ x, y, dx, dy }] in grayscale pixels.
  #flow() {
    const { w, h } = this;
    const half = PATCH / 2;
    const px = Math.round(this.velocity.x);
    const py = Math.round(this.velocity.y);
    const margin = half + RANGE + Math.max(Math.abs(px), Math.abs(py)) + 1;
    const cols = 4;
    const rows = Math.max(3, Math.min(6, Math.round((cols * h) / w)));
    const out = [];
    if (w - 2 * margin < cols || h - 2 * margin < rows) return out; // frame too small
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = Math.round(margin + ((w - 2 * margin) * (c + 0.5)) / cols);
        const y = Math.round(margin + ((h - 2 * margin) * (r + 0.5)) / rows);
        const m = matchPatch(this.prev, this.cur, w, x, y, half, half, px, py, RANGE, 2);
        if (m) out.push({ x, y, dx: m.dx, dy: m.dy });
      }
    }
    return out;
  }

  // One camera motion for all patches, refitted without the ones that disagree.
  #fit(flow) {
    if (!flow.length) {
      this.velocity = { x: 0, y: 0 };
      return IDENTITY; // nothing trackable in view (dark, blurry, blank wall)
    }
    if (flow.length < 4) return this.#slide(flow);

    let pts = flow;
    let m = fitSimilarity(pts);
    for (let i = 0; i < 2; i++) {
      const errors = pts.map((p) => residual(m, p));
      const limit = Math.max(0.75, 2.5 * median(errors));
      const agree = pts.filter((p, k) => errors[k] <= limit);
      if (agree.length < 4 || agree.length === pts.length) break;
      pts = agree;
      m = fitSimilarity(pts);
    }

    const zoom = Math.hypot(m.a, m.b);
    const roll = Math.atan2(m.b, m.a);
    // A real phone can't zoom 8% or roll 3.5° between two frames: a bad fit.
    if (Math.abs(zoom - 1) > 0.08 || Math.abs(roll) > 0.06) return this.#slide(pts);

    const cx = this.w / 2;
    const cy = this.h / 2;
    const vx = m.a * cx - m.b * cy + m.tx - cx;
    const vy = m.b * cx + m.a * cy + m.ty - cy;
    this.velocity = clampSpeed(vx, vy);
    // Sensor noise on a still scene would make overlays shiver.
    if (Math.abs(vx) < 0.05 && Math.abs(vy) < 0.05 && Math.abs(zoom - 1) < 0.001 && Math.abs(roll) < 0.001) {
      return IDENTITY;
    }
    return m;
  }

  // Slide only: the median patch movement.
  #slide(flow) {
    const tx = median(flow.map((p) => p.dx));
    const ty = median(flow.map((p) => p.dy));
    this.velocity = clampSpeed(tx, ty);
    if (Math.abs(tx) < 0.05 && Math.abs(ty) < 0.05) return IDENTITY;
    return { a: 1, b: 0, tx, ty };
  }
}

// Finds where the patch of `prev` centered at (x, y) (half sizes hw, hh) went in `cur`,
// searching ±range around the predicted shift (px, py), sampling every `step` pixels.
// Returns the total shift { dx, dy } with sub-pixel precision, or null if unsure.
function matchPatch(prev, cur, stride, x, y, hw, hh, px, py, range, step) {
  let n = 0;
  let sum = 0;
  let sum2 = 0;
  for (let yy = -hh; yy < hh; yy += step) {
    const row = (y + yy) * stride + x;
    for (let xx = -hw; xx < hw; xx += step) {
      const v = prev[row + xx];
      sum += v;
      sum2 += v * v;
      n++;
    }
  }
  const mean = sum / n;
  if (Math.sqrt(Math.max(0, sum2 / n - mean * mean)) < MIN_CONTRAST) return null;

  const side = 2 * range + 1;
  const sad = new Float64Array(side * side);
  let best = Infinity;
  let bx = 0;
  let by = 0;
  for (let dy = -range; dy <= range; dy++) {
    for (let dx = -range; dx <= range; dx++) {
      let s = 0;
      for (let yy = -hh; yy < hh; yy += step) {
        const prow = (y + yy) * stride + x;
        const crow = (y + py + dy + yy) * stride + x + px + dx;
        for (let xx = -hw; xx < hw; xx += step) {
          const diff = prev[prow + xx] - cur[crow + xx];
          s += diff < 0 ? -diff : diff;
        }
      }
      sad[(dy + range) * side + dx + range] = s;
      if (s < best) {
        best = s;
        bx = dx;
        by = dy;
      }
    }
  }
  if (best / n > MAX_ERROR) return null;                         // nothing looks alike
  if (Math.abs(bx) === range || Math.abs(by) === range) return null; // moved past the search

  const at = (dx, dy) => sad[(dy + range) * side + dx + range];
  return {
    dx: px + bx + subpixel(at(bx - 1, by), best, at(bx + 1, by)),
    dy: py + by + subpixel(at(bx, by - 1), best, at(bx, by + 1)),
  };
}

// Vertex of the parabola through three neighbouring match scores.
function subpixel(a, b, c) {
  const d = a - 2 * b + c;
  return d > 0 ? (a - c) / (2 * d) : 0;
}

// Least-squares similarity transform taking each point (x, y) to (x + dx, y + dy).
function fitSimilarity(pts) {
  let px = 0, py = 0, qx = 0, qy = 0;
  for (const p of pts) {
    px += p.x;
    py += p.y;
    qx += p.x + p.dx;
    qy += p.y + p.dy;
  }
  const n = pts.length;
  px /= n; py /= n; qx /= n; qy /= n;
  let sxx = 0, sa = 0, sb = 0;
  for (const p of pts) {
    const Px = p.x - px;
    const Py = p.y - py;
    const Qx = p.x + p.dx - qx;
    const Qy = p.y + p.dy - qy;
    sxx += Px * Px + Py * Py;
    sa += Px * Qx + Py * Qy;
    sb += Px * Qy - Py * Qx;
  }
  const a = sa / sxx;
  const b = sb / sxx;
  return { a, b, tx: qx - (a * px - b * py), ty: qy - (b * px + a * py) };
}

function residual(m, p) {
  return Math.hypot(m.a * p.x - m.b * p.y + m.tx - p.x - p.dx, m.b * p.x + m.a * p.y + m.ty - p.y - p.dy);
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function clampSpeed(x, y) {
  return {
    x: Math.max(-MAX_SPEED, Math.min(MAX_SPEED, x)),
    y: Math.max(-MAX_SPEED, Math.min(MAX_SPEED, y)),
  };
}
