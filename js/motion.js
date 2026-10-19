// Estimates how far the whole picture moved since the last frame, so overlays can
// follow signs between (slow) text-detection passes. Simple block matching on a
// tiny grayscale copy of the frame.

export class MotionEstimator {
  constructor(width = 160, height = 120, range = 8) {
    this.w = width;
    this.h = height;
    this.r = range;
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.prev = null;
    this.sad = new Float64Array((2 * range + 1) ** 2);
  }

  reset() {
    this.prev = null;
  }

  // Returns { dx, dy } in units of the small frame (multiply by canvasWidth / w), or null.
  estimate(el, crop) {
    const { w, h, r } = this;
    this.ctx.drawImage(el, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, w, h);
    const d = this.ctx.getImageData(0, 0, w, h).data;
    const cur = new Uint8Array(w * h);
    for (let i = 0, p = 0; i < cur.length; i++, p += 4) {
      cur[i] = (d[p] * 77 + d[p + 1] * 150 + d[p + 2] * 29) >> 8;
    }
    const prev = this.prev;
    this.prev = cur;
    if (!prev) return null;

    const side = 2 * r + 1;
    let best = Infinity;
    let bx = 0;
    let by = 0;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        let s = 0;
        for (let y = r; y < h - r; y += 2) {
          const row = y * w;
          const prow = (y - dy) * w - dx;
          for (let x = r; x < w - r; x += 2) {
            const diff = cur[row + x] - prev[prow + x];
            s += diff < 0 ? -diff : diff;
          }
        }
        this.sad[(dy + r) * side + (dx + r)] = s;
        if (s < best) {
          best = s;
          bx = dx;
          by = dy;
        }
      }
    }

    // Ignore tiny "improvements" caused by sensor noise on a still scene.
    const still = this.sad[r * side + r];
    if (still - best < still * 0.04) return { dx: 0, dy: 0 };

    const at = (dx, dy) => this.sad[(dy + r) * side + (dx + r)];
    const refine = (a, b, c) => {
      const denom = a - 2 * b + c;
      return denom > 0 ? (a - c) / (2 * denom) : 0;
    };
    const ox = bx > -r && bx < r ? refine(at(bx - 1, by), best, at(bx + 1, by)) : 0;
    const oy = by > -r && by < r ? refine(at(bx, by - 1), best, at(bx, by + 1)) : 0;
    return { dx: bx + ox, dy: by + oy };
  }
}
